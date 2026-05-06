#!/usr/bin/env python3
"""
Validate and auto-fix structural gaps in USDM conversions.

All fixes are protocol-agnostic — no study-specific IDs are hardcoded.

Gaps addressed:
  STR-001   Root-level field duplication (arrays/strings duplicated at study vs versions[0])
  STR-002   Duplicate USDM element IDs
  STR-003   Scheduled-instance → encounter reference integrity
  STR-004   studyRoles inline organizations → organizationId normalisation
  ICE-001   ICE 'description' field renamed to 'intercurrentEvent'
  ICE-002   ICE missing strategyCode (default: Treatment Policy C187302)
  ICE-003   PK-endpoint ICE using C187301 "While on Treatment" → C187302 "Treatment Policy"
  PHASE-001 studyPhase spurious flat code/decode alongside standardCode
  ACT-001   Group activities (childIds) must not carry nextId/previousId
  DOSE-001  AdministrableProduct doseForm.code missing codeSystem
  EST-001   PK endpoint not covered by all active interventions (report; opt-in auto-stub via --fix-coverage)
"""
import argparse
import copy
import json
import re
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Set, Tuple

RUNTIME_URL = "http://localhost:8004"
GRAPHQL_URL = "http://localhost:4000/graphql"
CONTEXT_URL = "http://localhost:8008/context/query"

ROOT_ALLOWED_KEYS = {"id", "instanceType", "versions"}

# Default ICE strategy when none is specified — Treatment Policy Strategy (CDISC CT)
_DEFAULT_STRATEGY_CODE: Dict[str, str] = {
    "code": "C187302",
    "decode": "Treatment Policy Strategy",
    "codeSystem": "C71620",
}

# Keywords that identify a PK-type endpoint from its name/label/text/purpose fields
_PK_KEYWORDS = frozenset(
    ["pharmacokinetic", "pk", "plasma concentration", "concentration", "cmax", "auc", "tmax", "t1/2"]
)

# Keywords that identify a placebo / comparator arm (not an active intervention)
_PLACEBO_KEYWORDS = frozenset(["placebo", "vehicle", "comparator", "sham"])


def _get_json(url: str) -> Dict[str, Any]:
    with urllib.request.urlopen(url) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _post_json(url: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _extract_visit_tokens(org_id: str, doc_id: str) -> Set[str]:
    if not org_id or not doc_id:
        return set()
    tokens: Set[str] = set()
    queries = [
        "schedule of activities visit",
        "screening baseline week",
        "end of treatment follow-up",
    ]
    pattern = re.compile(r"(screening|baseline|end of treatment|eot|follow[- ]?up|week\s*\d+|visit\s*\d+)", re.IGNORECASE)
    for q in queries:
        try:
            payload = {"query": q, "org_id": org_id, "document_id": doc_id, "top_k": 8}
            result = _post_json(CONTEXT_URL, payload)
            hits = result.get("sources_cited") or result.get("sources") or []
            for hit in hits:
                excerpt = str(hit.get("excerpt") or hit.get("content") or "")
                for m in pattern.findall(excerpt):
                    tokens.add(m.lower())
        except Exception:
            continue
    return tokens


# ── Helpers ──────────────────────────────────────────────────────────────────

def _collect_ids(node: Any, ids: List[str]) -> None:
    if isinstance(node, dict):
        _id = node.get("id")
        if isinstance(_id, str) and _id:
            ids.append(_id)
        for value in node.values():
            _collect_ids(value, ids)
    elif isinstance(node, list):
        for item in node:
            _collect_ids(item, ids)


def _normalize_name(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (text or "").lower())


def _is_pk_endpoint(ep: Dict[str, Any]) -> bool:
    """Detect a pharmacokinetics endpoint from its semantic fields — no hardcoded IDs."""
    blob = " ".join([
        str(ep.get("name") or "").lower(),
        str(ep.get("label") or "").lower(),
        str(ep.get("text") or "").lower(),
        str((ep.get("purpose") or {}).get("decode") or "").lower() if isinstance(ep.get("purpose"), dict) else "",
    ])
    return any(kw in blob for kw in _PK_KEYWORDS)


def _is_placebo_intervention(itv: Dict[str, Any]) -> bool:
    """Detect a non-active (placebo/comparator) intervention from its semantic fields."""
    blob = " ".join([
        str(itv.get("name") or "").lower(),
        str(itv.get("description") or "").lower(),
        str((itv.get("role") or {}).get("decode") or "").lower() if isinstance(itv.get("role"), dict) else "",
    ])
    return any(kw in blob for kw in _PLACEBO_KEYWORDS)


def _normalize_org_ref(oid: str, canonical_ids: Set[str]) -> str:
    """Map a potentially-malformed org ID to its canonical form using the version's org registry.

    Two cases are handled generically:
    1. The ID already exists in canonical_ids → return as-is.
    2. The ID ends in a "-DUPFIX"-style suffix → strip it and look for the canonical base ID.
    Any other unrecognised ID is returned unchanged (logged by caller).
    """
    oid = str(oid or "").strip()
    if not oid:
        return oid
    if oid in canonical_ids:
        return oid
    # Strip any trailing "-<SUFFIX>" where the base resolves to a canonical ID
    m = re.match(r"^(.+)-[A-Z0-9]+$", oid)
    if m and m.group(1) in canonical_ids:
        return m.group(1)
    return oid


def _get_design_endpoints(design: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Return the endpoint list regardless of which schema key was used."""
    eps = design.get("studyEndpoints")
    if isinstance(eps, list) and eps:
        return eps
    eps = design.get("endpoints")
    if isinstance(eps, list):
        return eps
    return []


# ── Main validation / fix logic ──────────────────────────────────────────────

def validate_and_fix(
    conversion: Dict[str, Any],
    apply_fixes: bool,
    fix_coverage: bool = False,
) -> Dict[str, Any]:
    usdm = conversion.get("usdm_json") or {}
    study = (usdm.get("study") or {}) if isinstance(usdm, dict) else {}
    versions = study.get("versions") if isinstance(study.get("versions"), list) else []
    version0 = versions[0] if versions and isinstance(versions[0], dict) else {}
    design_list = version0.get("studyDesigns") if isinstance(version0.get("studyDesigns"), list) else []
    design = design_list[0] if design_list and isinstance(design_list[0], dict) else {}

    findings: Dict[str, List[str]] = {
        "STR-001_root_duplication": [],
        "STR-002_duplicate_ids": [],
        "STR-003_visit_ref_integrity": [],
        "STR-004_org_ref_normalisation": [],
        "ICE-001_description_field": [],
        "ICE-002_missing_strategy_code": [],
        "ICE-003_pk_wrong_strategy": [],
        "PHASE-001_spurious_flat_fields": [],
        "ACT-001_group_activity_ordering": [],
        "DOSE-001_doseform_no_codesystem": [],
        "EST-001_pk_coverage_gap": [],
    }
    fixes: List[str] = []

    # ── STR-001: Root-level field duplication ────────────────────────────────
    for key in list(study.keys()):
        if key in ROOT_ALLOWED_KEYS:
            continue
        in_version = key in version0
        in_version_str = isinstance(study.get(key), str)
        if in_version or in_version_str:
            findings["STR-001_root_duplication"].append(key)
            if apply_fixes:
                study.pop(key, None)
                fixes.append(f"STR-001: removed duplicated/flat root key study.{key}")

    # ── STR-002: Duplicate USDM element IDs ─────────────────────────────────
    all_ids: List[str] = []
    _collect_ids(usdm, all_ids)
    seen_ids: Set[str] = set()
    duplicates: Set[str] = set()
    for _id in all_ids:
        if _id in seen_ids:
            duplicates.add(_id)
        seen_ids.add(_id)
    if duplicates:
        findings["STR-002_duplicate_ids"] = sorted(duplicates)
        if apply_fixes:
            counters: Dict[str, int] = {}

            def _rename_dups(node: Any) -> None:
                if isinstance(node, dict):
                    val = node.get("id")
                    if isinstance(val, str) and val in duplicates:
                        counters[val] = counters.get(val, 0) + 1
                        if counters[val] > 1:
                            node["id"] = f"{val}-DUP{counters[val] - 1}"
                    for v in node.values():
                        _rename_dups(v)
                elif isinstance(node, list):
                    for item in node:
                        _rename_dups(item)

            _rename_dups(usdm)
            fixes.append("STR-002: renamed duplicate IDs with -DUP suffix")

    # ── STR-003: Schedule-instance → encounter reference integrity ───────────
    encounters = design.get("encounters") if isinstance(design.get("encounters"), list) else []
    timelines = design.get("scheduleTimelines") if isinstance(design.get("scheduleTimelines"), list) else []
    scheduled_instances: List[Dict[str, Any]] = []
    for tl in timelines:
        if isinstance(tl, dict):
            sis = tl.get("scheduledInstances") if isinstance(tl.get("scheduledInstances"), list) else []
            scheduled_instances.extend([x for x in sis if isinstance(x, dict)])

    encounter_ids = {str(e.get("id")) for e in encounters if isinstance(e, dict) and e.get("id")}
    encounter_names = [
        str(e.get("name") or e.get("label") or e.get("text") or "")
        for e in encounters
        if isinstance(e, dict)
    ]
    encounter_norm = {_normalize_name(n) for n in encounter_names if n}

    missing_enc_refs: List[str] = []
    for si in scheduled_instances:
        eid = str(si.get("encounterId") or "")
        if eid and eid not in encounter_ids:
            missing_enc_refs.append(eid)
    if missing_enc_refs:
        findings["STR-003_visit_ref_integrity"].append(
            f"Scheduled instances reference missing encounters: {sorted(set(missing_enc_refs))}"
        )

    if len(encounter_norm) != len([n for n in encounter_names if n]):
        findings["STR-003_visit_ref_integrity"].append("Encounter names appear duplicated/ambiguous")

    # Protocol context-based visit alignment (soft check)
    org_id = conversion.get("org_id") or "00000000-0000-0000-0000-000000000000"
    doc_id = conversion.get("protocol_doc_id")
    protocol_tokens = _extract_visit_tokens(org_id, doc_id)
    semantic_expectations = {
        "screening": {"screening"},
        "baseline": {"baseline"},
        "eot": {"eot", "endoftreatment", "eos", "endofstudy"},
        "end of treatment": {"eot", "endoftreatment", "eos", "endofstudy"},
    }
    for token, aliases in semantic_expectations.items():
        if token in protocol_tokens and not (encounter_norm & aliases):
            findings["STR-003_visit_ref_integrity"].append(
                f"Protocol mentions '{token}' but no matching encounter found"
            )

    # ── STR-004: studyRoles org-ref normalisation ────────────────────────────
    canonical_org_ids: Set[str] = {
        str(o.get("id"))
        for o in (version0.get("organizations") or [])
        if isinstance(o, dict) and o.get("id")
    }
    for role in (version0.get("studyRoles") or []):
        if not isinstance(role, dict):
            continue
        # Inline organizations list (legacy duplication pattern)
        for org in (role.get("organizations") or []):
            if not isinstance(org, dict) or not org.get("id"):
                continue
            original = str(org["id"])
            canonical = _normalize_org_ref(original, canonical_org_ids)
            if canonical != original:
                findings["STR-004_org_ref_normalisation"].append(
                    f"role={role.get('id')} org id {original!r} → {canonical!r}"
                )
                if apply_fixes:
                    org["id"] = canonical
                    fixes.append(f"STR-004: normalised org ref {original!r} → {canonical!r} in role {role.get('id')}")
        # Scalar organizationId (alternative field)
        oid_scalar = role.get("organizationId")
        if isinstance(oid_scalar, str) and oid_scalar:
            canonical = _normalize_org_ref(oid_scalar, canonical_org_ids)
            if canonical != oid_scalar:
                findings["STR-004_org_ref_normalisation"].append(
                    f"role={role.get('id')} organizationId {oid_scalar!r} → {canonical!r}"
                )
                if apply_fixes:
                    role["organizationId"] = canonical
                    fixes.append(f"STR-004: normalised scalar organizationId {oid_scalar!r} → {canonical!r}")

    # ── Build endpoint lookup for ICE and estimand gap checks ────────────────
    endpoints = _get_design_endpoints(design)
    endpoint_by_id: Dict[str, Dict[str, Any]] = {
        str(ep.get("id")): ep for ep in endpoints if isinstance(ep, dict) and ep.get("id")
    }

    # ── ICE-001/002/003: Intercurrent event field & strategy checks ──────────
    estimands = design.get("estimands") if isinstance(design.get("estimands"), list) else []
    for est in estimands:
        if not isinstance(est, dict):
            continue
        voi = str(est.get("variableOfInterestId") or "")
        is_pk = _is_pk_endpoint(endpoint_by_id.get(voi, {}))
        for ice in (est.get("intercurrentEvents") or []):
            if not isinstance(ice, dict):
                continue
            ice_id = ice.get("id", "<unknown>")
            # ICE-001: wrong field name
            if "description" in ice and "intercurrentEvent" not in ice:
                findings["ICE-001_description_field"].append(
                    f"est={est.get('id')} ice={ice_id}: uses 'description' instead of 'intercurrentEvent'"
                )
                if apply_fixes:
                    ice["intercurrentEvent"] = ice.pop("description")
                    fixes.append(f"ICE-001: est={est.get('id')} ice={ice_id} renamed 'description' → 'intercurrentEvent'")
            # ICE-002: missing strategyCode
            if not ice.get("strategyCode"):
                findings["ICE-002_missing_strategy_code"].append(
                    f"est={est.get('id')} ice={ice_id}: missing strategyCode"
                )
                if apply_fixes:
                    ice["strategyCode"] = dict(_DEFAULT_STRATEGY_CODE)
                    fixes.append(f"ICE-002: est={est.get('id')} ice={ice_id} added default strategyCode C187302")
            # ICE-003: PK estimand must not use C187301 "While on Treatment"
            sc = ice.get("strategyCode") if isinstance(ice.get("strategyCode"), dict) else {}
            if is_pk and sc.get("code") == "C187301":
                findings["ICE-003_pk_wrong_strategy"].append(
                    f"est={est.get('id')} ice={ice_id}: PK estimand uses C187301; must be C187302"
                )
                if apply_fixes:
                    sc["code"] = "C187302"
                    sc["decode"] = "Treatment Policy Strategy"
                    fixes.append(f"ICE-003: est={est.get('id')} ice={ice_id} corrected PK strategy C187301 → C187302")

    # ── PHASE-001: studyPhase spurious flat code/decode alongside standardCode ─
    study_phase = design.get("studyPhase") if isinstance(design.get("studyPhase"), dict) else {}
    if study_phase and isinstance(study_phase.get("standardCode"), dict) and study_phase.get("standardCode"):
        spurious = [k for k in ("code", "decode") if study_phase.get(k)]
        if spurious:
            findings["PHASE-001_spurious_flat_fields"].append(
                f"studyPhase has flat {spurious} alongside standardCode"
            )
            if apply_fixes:
                for k in spurious:
                    study_phase.pop(k, None)
                fixes.append(f"PHASE-001: removed flat {spurious} from studyPhase (standardCode already present)")

    # ── ACT-001: Group activities must not have nextId/previousId ─────────────
    activities = design.get("activities") if isinstance(design.get("activities"), list) else []
    for act in activities:
        if not isinstance(act, dict):
            continue
        if (act.get("childIds") or act.get("children")) and (act.get("nextId") or act.get("previousId")):
            seq_keys = [k for k in ("nextId", "previousId") if act.get(k) is not None]
            findings["ACT-001_group_activity_ordering"].append(
                f"activity={act.get('id')} has childIds AND {seq_keys}"
            )
            if apply_fixes:
                for k in seq_keys:
                    act.pop(k, None)
                fixes.append(f"ACT-001: removed {seq_keys} from group activity {act.get('id')}")

    # ── DOSE-001: doseForm.code missing codeSystem ────────────────────────────
    interventions = design.get("studyInterventions") if isinstance(design.get("studyInterventions"), list) else []
    for itv in interventions:
        if not isinstance(itv, dict):
            continue
        for ap in (itv.get("administrableProducts") or []):
            if not isinstance(ap, dict):
                continue
            df = ap.get("doseForm") if isinstance(ap.get("doseForm"), dict) else {}
            if df and df.get("code") and not df.get("codeSystem"):
                findings["DOSE-001_doseform_no_codesystem"].append(
                    f"itv={itv.get('id')} ap={ap.get('id')} doseForm.code present but codeSystem missing"
                )
                if apply_fixes:
                    df["codeSystem"] = "C71620"
                    fixes.append(f"DOSE-001: added codeSystem=C71620 to doseForm on ap={ap.get('id')}")

    # ── EST-001: PK endpoint estimand coverage gap ────────────────────────────
    # Detect PK endpoints from semantic content; check all non-placebo interventions are covered.
    pk_endpoint_ids = {
        str(ep.get("id"))
        for ep in endpoints
        if isinstance(ep, dict) and ep.get("id") and _is_pk_endpoint(ep)
    }
    active_intervention_ids = {
        str(itv.get("id"))
        for itv in interventions
        if isinstance(itv, dict) and itv.get("id") and not _is_placebo_intervention(itv)
    }
    if pk_endpoint_ids and active_intervention_ids:
        covered: Set[Tuple[str, str]] = set()
        for est in estimands:
            if not isinstance(est, dict):
                continue
            iv = str(est.get("interventionId") or "")
            voi = str(est.get("variableOfInterestId") or "")
            if voi in pk_endpoint_ids and iv in active_intervention_ids:
                covered.add((iv, voi))

        for pk_ep_id in sorted(pk_endpoint_ids):
            for iv_id in sorted(active_intervention_ids):
                if (iv_id, pk_ep_id) not in covered:
                    findings["EST-001_pk_coverage_gap"].append(
                        f"No estimand covers PK endpoint {pk_ep_id!r} for intervention {iv_id!r}"
                    )
                    if fix_coverage and apply_fixes:
                        # Build a minimal stub estimand — no hardcoded IDs, only detected references
                        pop_ids = [
                            str(p.get("id"))
                            for p in (design.get("studyPopulations") or [])
                            if isinstance(p, dict) and p.get("id")
                        ]
                        pk_ep = endpoint_by_id.get(pk_ep_id, {})
                        new_id = f"ESTIMAND-AUTO-{iv_id}-{pk_ep_id}"
                        stub: Dict[str, Any] = {
                            "id": new_id,
                            "instanceType": "Estimand",
                            "interventionId": iv_id,
                            "variableOfInterestId": pk_ep_id,
                            "summaryMeasure": (
                                f"Summary statistics for {pk_ep.get('name') or pk_ep_id}"
                                f" for intervention {iv_id}"
                            ),
                            "intercurrentEvents": [
                                {
                                    "id": f"ICE-AUTO-{new_id}",
                                    "instanceType": "IntercurrentEvent",
                                    "intercurrentEvent": "Discontinuation of study treatment",
                                    "strategyCode": dict(_DEFAULT_STRATEGY_CODE),
                                }
                            ],
                        }
                        if pop_ids:
                            stub["analysisPopulationId"] = pop_ids[0]
                        estimands.append(stub)
                        design["estimands"] = estimands
                        fixes.append(
                            f"EST-001: added stub estimand {new_id!r} for {pk_ep_id!r} × {iv_id!r}"
                        )

    # ── Write patched objects back into the graph ─────────────────────────────
    if apply_fixes:
        if design_list and isinstance(design_list[0], dict):
            design_list[0] = design
        if versions and isinstance(versions[0], dict):
            versions[0]["studyDesigns"] = design_list
        study["versions"] = versions
        usdm["study"] = study

    return {
        "findings": findings,
        "fixes": fixes,
        "usdm": usdm,
    }


def update_conversion(conv_id: str, usdm_json: Dict[str, Any]) -> Dict[str, Any]:
    mutation = {
        "query": "mutation($id: ID!, $usdmJson: JSON!, $corrections: JSON){ updateUsdmConversion(id:$id, usdmJson:$usdmJson, corrections:$corrections){ id status runId approvalId } }",
        "variables": {
            "id": conv_id,
            "usdmJson": usdm_json,
            "corrections": [
                {
                    "source": "auto-validator",
                    "action": "structural-normalisation",
                }
            ],
        },
    }
    return _post_json(GRAPHQL_URL, mutation)


def count_findings(findings: Dict[str, List[str]]) -> int:
    return sum(len(v) for v in findings.values())


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate and optionally fix USDM conversion structure. All fixes are protocol-agnostic."
    )
    parser.add_argument("--conversion-id", required=True, help="USDM conversion UUID")
    parser.add_argument("--apply", action="store_true", help="Apply auto-fixes to the conversion")
    parser.add_argument(
        "--fix-coverage",
        action="store_true",
        help="Also add stub estimands for PK coverage gaps (requires --apply)",
    )
    parser.add_argument("--recheck", action="store_true", help="Re-run validation after applying fixes")
    args = parser.parse_args()

    conv = _get_json(f"{RUNTIME_URL}/usdm/{args.conversion_id}")
    result = validate_and_fix(conv, apply_fixes=args.apply, fix_coverage=args.fix_coverage)

    output: Dict[str, Any] = {
        "conversion_id": args.conversion_id,
        "status": conv.get("status"),
        "protocol_filename": conv.get("protocol_filename") or conv.get("protocolFilename"),
        "findings_before": result["findings"],
        "total_findings_before": count_findings(result["findings"]),
        "fixes_applied": result["fixes"],
    }

    if args.apply and result["fixes"]:
        save_resp = update_conversion(args.conversion_id, result["usdm"])
        output["save_response"] = save_resp

    if args.recheck:
        conv2 = _get_json(f"{RUNTIME_URL}/usdm/{args.conversion_id}")
        result2 = validate_and_fix(conv2, apply_fixes=False)
        output["findings_after"] = result2["findings"]
        output["total_findings_after"] = count_findings(result2["findings"])

    print(json.dumps(output, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
