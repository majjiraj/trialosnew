#!/usr/bin/env python3
"""End-to-end validation of USDM conversion aaa641d0-0e00-4f60-9a60-a7ebd8075702"""
import json, re, urllib.request, urllib.error
from pathlib import Path
from datetime import datetime

CONV_ID = 'aaa641d0-0e00-4f60-9a60-a7ebd8075702'
BASE = 'http://localhost:8004'

# ── 1. Fetch conversion ─────────────────────────────────────────────────────
try:
    conv = json.load(urllib.request.urlopen(f'{BASE}/usdm/{CONV_ID}', timeout=30))
except Exception as e:
    raise SystemExit(f'ERROR: fetch failed: {e}')

usdm = conv.get('usdm_json') or {}
study = usdm.get('study') or {}
sv = (study.get('versions') or [{}])[0]
d = (sv.get('studyDesigns') or [{}])[0]

endpoints = (d.get('studyEndpoints') if isinstance(d.get('studyEndpoints'), list) and d.get('studyEndpoints')
             else d.get('endpoints') or [])
objectives  = d.get('objectives') or []
estimands   = d.get('estimands') or []
interventions = d.get('studyInterventions') or []
arms        = d.get('studyArms') or []
epochs      = d.get('studyEpochs') or []
encounters  = d.get('encounters') or []

print('=== STEP 1: COUNTS ===')
print(f'objectives={len(objectives)} endpoints={len(endpoints)} estimands={len(estimands)}')
print(f'interventions={len(interventions)} arms={len(arms)} epochs={len(epochs)} encounters={len(encounters)}')

phase = d.get('studyPhase') if isinstance(d.get('studyPhase'), dict) else {}
phase_sc = phase.get('standardCode') if isinstance(phase.get('standardCode'), dict) else {}
phase_code = (phase.get('code') or phase_sc.get('code') or '').strip()
phase_decode = (phase.get('decode') or phase_sc.get('decode') or '').strip()
print(f'phase_code={phase_code!r} phase_decode={phase_decode!r}')

# ── 2. Structural integrity ─────────────────────────────────────────────────
print('\n=== STEP 2: STRUCTURAL INTEGRITY ===')

# Duplicate IDs
all_ids = []
def walk(n):
    if isinstance(n, dict):
        i = n.get('id')
        if isinstance(i, str) and i:
            all_ids.append(i)
        for v in n.values():
            walk(v)
    elif isinstance(n, list):
        for x in n:
            walk(x)
walk(usdm)
seen = set(); dup = []
for i in all_ids:
    if i in seen and i not in dup:
        dup.append(i)
    seen.add(i)
print(f'duplicate_ids={dup[:10] if dup else "NONE"}')

# Reference integrity
endpoint_ids = {str(e.get('id')) for e in endpoints if isinstance(e, dict) and e.get('id')}
intervention_ids = {str(i.get('id')) for i in interventions if isinstance(i, dict) and i.get('id')}

obj_ref_err = []
for o in objectives:
    if isinstance(o, dict):
        for eid in (o.get('endpointIds') or []):
            if str(eid) not in endpoint_ids:
                obj_ref_err.append(f'{o.get("id")}→{eid}')
print(f'obj_endpoint_ref_errors={obj_ref_err or "NONE"}')

est_ref_err = []
for e in estimands:
    if not isinstance(e, dict):
        continue
    iv = str(e.get('interventionId') or '')
    voi = str(e.get('variableOfInterestId') or '')
    if iv and iv not in intervention_ids:
        est_ref_err.append(f'{e.get("id")}:intervention_missing:{iv}')
    if voi and voi not in endpoint_ids:
        est_ref_err.append(f'{e.get("id")}:endpoint_missing:{voi}')
print(f'est_ref_errors={est_ref_err or "NONE"}')

# Root-level anti-patterns
root_non_version = ['studyTitle','studyVersion','studyRationale','studyProtocolVersions','studyPhase','studyType']
root_bad = [k for k in root_non_version if study.get(k)]
print(f'root_non_version_fields={root_bad or "NONE"}')

# ICE field checks
ice_issues = []
for est in estimands:
    if not isinstance(est, dict):
        continue
    is_pk = str(est.get('variableOfInterestId', '')) == 'ENDPOINT-014'
    for ice in (est.get('intercurrentEvents') or []):
        if not isinstance(ice, dict):
            continue
        if 'description' in ice and 'intercurrentEvent' not in ice:
            ice_issues.append(f'{ice.get("id")}:uses_description_not_intercurrentEvent')
        if not ice.get('strategyCode'):
            ice_issues.append(f'{ice.get("id")}:missing_strategyCode')
        sc = ice.get('strategyCode') if isinstance(ice.get('strategyCode'), dict) else {}
        if is_pk and sc.get('code') == 'C187301':
            ice_issues.append(f'{ice.get("id")}:pk_wrong_strategyCode_C187301')
print(f'ice_field_issues={ice_issues or "NONE"}')

# ── 3. Provenance manifest quality checks ──────────────────────────────────
print('\n=== STEP 3: PROVENANCE MANIFEST QUALITY CHECKS ===')
run_id = conv.get('run_id') or conv.get('runId')
print(f'run_id={run_id}')
try:
    manifest = json.load(urllib.request.urlopen(f'{BASE}/runs/{run_id}/provenance-manifest', timeout=30))
    qc = manifest.get('quality_checks') or []
    print(f'total_quality_checks={len(qc)}')
    bad = []
    for c in qc:
        st = str(c.get('status', '')).lower()
        sc = c.get('score', 1)
        if st in ('fail', 'human_required') or (isinstance(sc, (int, float)) and sc < 1):
            bad.append(c)
    print(f'failing_checks={len(bad)}')
    for c in bad:
        print(f'  [{c.get("check_id")}] {c.get("description","")[:70]} status={c.get("status")} score={c.get("score")}')
        detail = c.get('detail') or ''
        if detail:
            print(f'    detail: {str(detail)[:250]}')
except Exception as e:
    print(f'manifest_err={e}')

# ── 4. Targeted semantic grounding ─────────────────────────────────────────
print('\n=== STEP 4: SEMANTIC GROUNDING (PDF) ===')
protocol_filename = conv.get('protocol_filename') or conv.get('protocolFilename') or 'Clinical Protocol - 0 (18Jun2024).pdf'
pdf_path = Path('protocols') / protocol_filename
if not pdf_path.exists():
    pdfs = sorted(Path('protocols').glob('*.pdf'))
    pdf_path = pdfs[0] if pdfs else None

if pdf_path:
    try:
        from pypdf import PdfReader
        text = '\n'.join((p.extract_text() or '') for p in PdfReader(str(pdf_path)).pages)
        loader = 'pypdf'
    except Exception:
        from PyPDF2 import PdfReader
        text = '\n'.join((p.extract_text() or '') for p in PdfReader(str(pdf_path)).pages)
        loader = 'PyPDF2'
    low = text.lower()
    print(f'pdf_loader={loader} pages={len(text.splitlines())}')
    tokens = ['ritlecitinib', 'placebo', '45 mg', '25 mg', 'salt', 'week 24', 'week 4', 'week 8', 'primary objective', 'alopecia']
    for t in tokens:
        print(f'  {t}: {t.lower() in low}')
    # Intervention grounding
    print('\nIntervention grounding:')
    for itv in interventions:
        if not isinstance(itv, dict):
            continue
        name = (itv.get('name') or '').lower()
        desc = (itv.get('description') or '').lower()
        doses = re.findall(r'\b(\d{1,3})\s*mg\b', name + ' ' + desc)
        has_drug = 'ritlecitinib' in name or 'ritlecitinib' in desc
        has_placebo = 'placebo' in name or 'placebo' in desc
        dose_ok = all(bool(re.search(rf'\b{dos}\s*mg\b', low)) for dos in doses) if doses else True
        semantic_ok = (has_drug and 'ritlecitinib' in low and dose_ok) or (has_placebo and 'placebo' in low)
        print(f'  {itv.get("id")} {itv.get("name")}: grounded={semantic_ok} doses={doses}')
else:
    print('WARNING: No protocol PDF found')
    low = ''

# ── 5. Strict traceability matrix ──────────────────────────────────────────
print('\n=== STEP 5: STRICT TRACEABILITY MATRIX ===')
if not pdf_path:
    print('SKIP: no protocol PDF')
else:
    pages = [(p.extract_text() or '') for p in (PdfReader(str(pdf_path)).pages)]

    def normalize_ws(s):
        return ' '.join((s or '').split())

    def find_quote(candidates):
        for cand in candidates:
            if not cand:
                continue
            c = normalize_ws(cand)
            if len(c) < 4:
                continue
            pat = re.compile(re.escape(c), re.IGNORECASE)
            for i, txt in enumerate(pages, start=1):
                m = pat.search(normalize_ws(txt))
                if m:
                    t = normalize_ws(txt)
                    a = max(0, m.start() - 80)
                    b = min(len(t), m.end() + 100)
                    return {'matched': True, 'page': i, 'quote': t[m.start():m.end()], 'snippet': t[a:b]}
        return {'matched': False, 'page': None, 'quote': '', 'snippet': ''}

    rows = []
    def add(section, eid, value, candidates):
        ev = find_quote(candidates)
        rows.append({'section': section, 'element_id': eid, 'value': value, **ev})

    # Study title/phase
    title = ((sv.get('titles') or [{}])[0].get('text') if (sv.get('titles') or []) else study.get('studyTitle') or '')
    add('study', 'studyTitle', title, [title])

    phase_candidates = [phase_decode]
    add('study', 'studyPhase', {'code': phase_code, 'decode': phase_decode}, phase_candidates)

    # Interventions
    for itv in interventions:
        if not isinstance(itv, dict):
            continue
        name = itv.get('name') or ''
        desc = itv.get('description') or ''
        cands = [name, desc]
        if '45' in name:
            cands += ['ritlecitinib 45 mg']
        if '25' in name:
            cands += ['ritlecitinib 25 mg']
        if re.search(r'(?i)placebo', name + ' ' + desc):
            cands += ['placebo']
        add('interventions', itv.get('id') or '', {'name': name}, cands)

    # Arms
    for arm in arms:
        if not isinstance(arm, dict):
            continue
        nm = arm.get('name') or arm.get('label') or ''
        add('arms', arm.get('id') or '', nm, [nm, 'placebo' if 'placebo' in nm.lower() else ''])

    # Objectives
    for obj in objectives:
        if not isinstance(obj, dict):
            continue
        txt = obj.get('text') or obj.get('description') or obj.get('label') or ''
        add('objectives', obj.get('id') or '', txt, [txt])

    # Endpoints
    for ep in endpoints:
        if not isinstance(ep, dict):
            continue
        nm = ep.get('name') or ep.get('label') or ''
        desc = ep.get('description') or ''
        cands = [nm, desc, nm.replace('_', ' ')]
        if re.match(r'(?i)SALT20', nm):
            cands += ['SALT <=20 at Week 24', 'SALT 20 at Week 24']
        if re.match(r'(?i)SALT10', nm):
            cands += ['SALT <=10 at Week 24', 'SALT 10 at Week 24']
        if re.match(r'(?i)PK', nm):
            cands += ['concentration', 'pharmacokinetic']
        if re.match(r'(?i)TEAE', nm):
            cands += ['TEAE incidence', 'treatment-emergent adverse event']
        if re.match(r'(?i)Palatability', nm):
            cands += ['palatability']
        add('endpoints', ep.get('id') or '', {'name': nm}, cands)

    # Estimands
    for est in estimands:
        if not isinstance(est, dict):
            continue
        sm = est.get('summaryMeasure') or ''
        add('estimands', est.get('id') or '', sm, [sm])

    # Encounters
    for enc in encounters:
        if not isinstance(enc, dict):
            continue
        nm = enc.get('name') or enc.get('label') or enc.get('text') or ''
        cands = [nm]
        m = re.match(r'(?i)week\s*(\d+)$', nm)
        if m:
            cands.append(f'Week {m.group(1)}')
        if nm.upper() == 'EOS':
            cands += ['End of Study', 'EOS']
        add('encounters', enc.get('id') or '', nm, cands)

    checked = len(rows)
    matched = sum(1 for r in rows if r['matched'])
    missing = [r for r in rows if not r['matched']]

    import collections
    by_section = collections.Counter(r['section'] for r in missing)
    print(f'checked={checked} matched={matched} missing={len(missing)} match_rate={round(matched/checked*100,2) if checked else 0}%')
    print('Missing by section:')
    for sec, cnt in sorted(by_section.items()):
        print(f'  {sec}: {cnt}')

    # ── 6. Save artifacts ─────────────────────────────────────────────────
    print('\n=== STEP 6: SAVING ARTIFACTS ===')
    result = {
        'generated_at': datetime.utcnow().isoformat() + 'Z',
        'conversion_id': CONV_ID,
        'protocol_file': str(pdf_path),
        'structural_integrity': {
            'duplicate_id_count': len(dup),
            'obj_endpoint_ref_errors': obj_ref_err,
            'est_ref_errors': est_ref_err,
            'ice_field_issues': ice_issues,
            'root_non_version_fields': root_bad,
        },
        'provenance_manifest': {'run_id': run_id},
        'summary': {
            'checked': checked,
            'matched': matched,
            'missing': len(missing),
            'match_rate_pct': round(matched / checked * 100.0, 2) if checked else 0.0,
            'by_section': dict(by_section)
        },
        'rows': rows,
        'evidence_backed_gaps': [{'section': r['section'], 'element_id': r['element_id'], 'value': r['value']} for r in missing]
    }

    out_dir = Path('generated')
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / f'traceability_{CONV_ID}.json'
    md_path = out_dir / f'traceability_{CONV_ID}.md'

    json_path.write_text(json.dumps(result, indent=2, default=str))

    lines = [
        f'# Traceability Matrix – {CONV_ID}',
        '',
        f'- Protocol: {pdf_path}',
        f'- Generated: {result["generated_at"]}',
        f'- Checked: {checked}  Matched: {matched}  Missing: {len(missing)}  Match rate: {result["summary"]["match_rate_pct"]}%',
        '',
        '## Structural Integrity',
        f'- Duplicate IDs: {len(dup)}',
        f'- Objective/endpoint ref errors: {len(obj_ref_err)}',
        f'- Estimand ref errors: {len(est_ref_err)}',
        f'- ICE field issues: {len(ice_issues)}',
        '',
        '## Evidence-Backed Gaps by Section',
    ]
    for sec, cnt in sorted(by_section.items()):
        lines.append(f'- {sec}: {cnt}')
    lines += ['', '## All Missing Items']
    for r in missing:
        lines.append(f'- {r["section"]} | {r["element_id"]} | {str(r["value"])[:160]}')
    lines += ['', '## Matched Items (with protocol evidence)']
    for r in rows:
        if r['matched']:
            lines.append(f'- {r["section"]} | {r["element_id"]} | p.{r["page"]} | "{r["quote"]}"')

    md_path.write_text('\n'.join(lines))
    print(f'JSON: {json_path}')
    print(f'Markdown: {md_path}')

    # ── 7. Compare to baseline ──────────────────────────────────────────────
    print('\n=== STEP 7: BASELINE COMPARISON ===')
    baseline_path = Path('generated/traceability_4bedf082-0404-4c12-8e3a-1f5d93e945ac.json')
    if baseline_path.exists():
        baseline = json.load(open(baseline_path))
        b_sum = baseline.get('summary', {})
        print(f'Baseline (4bedf082): checked={b_sum.get("checked")} matched={b_sum.get("matched")} missing={b_sum.get("missing")} rate={b_sum.get("match_rate_pct")}%')
        print(f'Current  (aaa641d0): checked={checked} matched={matched} missing={len(missing)} rate={result["summary"]["match_rate_pct"]}%')
        delta = result["summary"]["match_rate_pct"] - (b_sum.get("match_rate_pct") or 0)
        print(f'Delta: {delta:+.2f}% (positive = improvement)')
        b_by_sec = b_sum.get('by_section') or {}
        print('Section delta (current-baseline):')
        all_secs = sorted(set(list(by_section.keys()) + list(b_by_sec.keys())))
        for sec in all_secs:
            cur = by_section.get(sec, 0)
            bas = b_by_sec.get(sec, 0)
            print(f'  {sec}: baseline={bas} current={cur} delta={cur-bas:+d}')
    else:
        print('Baseline file not found – skipping comparison')
