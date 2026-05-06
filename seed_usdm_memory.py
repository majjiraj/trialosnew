#!/usr/bin/env python3
"""
seed_usdm_memory.py — Seed the Trialo Memory Engine with comprehensive USDM
validation rules, protocol→USDM section mappings (context graph), and
therapeutic-area learning patterns.

Sources:
  1. USDM_Validation_Rules_Comprehensive.xlsx  (206 rules, R-001–R-206)
    2. feedback/USDM_Gap_Analysis_B7981027*.xlsx (v1–v6, ~280 feedback gaps)
  3. ICH M11 / USDM IG section mappings (hardcoded from authoritative sources)
  4. Therapeutic-area context graph (Oncology / Immunology / Dermatology patterns)

Storage model:
  • validation rules   → semantic memory  (fact_type="usdm_validation_rule")
  • gap rules          → semantic memory  (fact_type="usdm_gap_rule")
  • ICH M11 mappings   → semantic memory  (fact_type="ich_m11_mapping")
  • TA context graph   → semantic memory  (fact_type="ta_context_graph")
  • Section mapping    → semantic memory  (fact_type="protocol_section_mapping")
  • How-to procedures  → procedural memory (task_type="usdm_conversion")
  • HITL learnings     → learnings/task endpoint (learning_type="gold_pattern")

Usage:
  python seed_usdm_memory.py
  python seed_usdm_memory.py --dry-run        # print what would be stored
  python seed_usdm_memory.py --org 00000000-0000-0000-0000-000000000001
"""

import sys
import os
import re
import json
import time
import argparse
import hashlib
from pathlib import Path

import requests
import openpyxl

# ─── Config ──────────────────────────────────────────────────────────────────

MEMORY_URL    = os.getenv("MEMORY_ENGINE_URL", "http://localhost:8014")
ORG_ID        = os.getenv("SEED_ORG_ID",        "00000000-0000-0000-0000-000000000001")
AGENT_DEF_ID  = os.getenv("USDM_AGENT_DEF_ID",  "00000000-0000-0000-0000-000000000020")
ROOT          = Path(__file__).parent

EXCEL_RULES   = ROOT / "USDM_Validation_Rules_Comprehensive.xlsx"
FEEDBACK_DIR  = ROOT / "feedback"

# ─── Helpers ─────────────────────────────────────────────────────────────────

def _post(path: str, body: dict, dry: bool) -> dict:
    if dry:
        print(f"  DRY  POST {path}  subject={body.get('subject','')[:60]}")
        return {"action": "dry-run"}
    try:
        r = requests.post(f"{MEMORY_URL}{path}", json=body, timeout=30)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"  WARN POST {path} failed: {e}")
        return {"error": str(e)}


def _rule_fingerprint(text: str) -> str:
    """Normalise & hash to detect near-duplicate rules."""
    cleaned = re.sub(r"[^a-z0-9]", "", text.lower())
    return hashlib.md5(cleaned.encode()).hexdigest()[:12]


def _sem(org_id: str, fact_type: str, subject: str, predicate: str, obj: str,
         confidence: float = 1.0) -> dict:
    return {
        "org_id": org_id, "scope": "org", "fact_type": fact_type,
        "subject": subject, "predicate": predicate, "object": obj,
        "confidence": confidence, "source_episode_ids": [],
    }


# ─── Load Excel rules ─────────────────────────────────────────────────────────

def load_excel_rules() -> list[dict]:
    wb = openpyxl.load_workbook(EXCEL_RULES, data_only=True)
    ws = wb["USDM Validation Rules"]
    header = None
    rules = []
    for row in ws.iter_rows(values_only=True):
        vals = [str(v).strip() if v else "" for v in row]
        if vals[0] == "Rule ID":
            header = vals
            continue
        if header and vals[0].startswith("R-"):
            rules.append({header[i]: vals[i] for i in range(min(len(header), len(vals)))})
    wb.close()
    return rules


# ─── Load feedback gaps ───────────────────────────────────────────────────────

def load_feedback_gaps() -> list[dict]:
    gaps = []
    for v in range(1, 7):
        fname = FEEDBACK_DIR / ("USDM_Gap_Analysis_B7981027.xlsx" if v == 1
                                else f"USDM_Gap_Analysis_B7981027_v{v}.xlsx")
        if not fname.exists():
            continue
        wb = openpyxl.load_workbook(fname, data_only=True)
        ws = wb[wb.sheetnames[0]]
        header = None
        for row in ws.iter_rows(values_only=True):
            vals = [str(v).strip() if v else "" for v in row]
            if vals[0] == "#":
                header = vals
                continue
            if header and vals[0].strip().isdigit():
                gap = {header[i]: vals[i] for i in range(min(len(header), len(vals)))}
                gap["_source"] = f"feedback_v{v}"
                gap["_version"] = v
                gaps.append(gap)
        wb.close()
    return gaps


# ─── Deduplication ────────────────────────────────────────────────────────────

def deduplicate_rules(excel_rules: list[dict], feedback_gaps: list[dict]) -> tuple[list, list]:
    """
    Return (unique_excel_rules, unique_gap_rules) with duplicates removed.
    A feedback gap is a duplicate if its description fingerprint matches an
    existing Excel rule's description or rule name.
    """
    seen_fps = set()
    clean_excel = []
    for r in excel_rules:
        fp = _rule_fingerprint(r.get("Rule Description", "") + r.get("Rule Name", ""))
        if fp not in seen_fps:
            seen_fps.add(fp)
            clean_excel.append(r)

    clean_gaps = []
    dup_count = 0
    for g in feedback_gaps:
        desc = g.get("Gap Description", "") + g.get("Class / Field", "")
        fp = _rule_fingerprint(desc)
        if fp not in seen_fps:
            seen_fps.add(fp)
            clean_gaps.append(g)
        else:
            dup_count += 1

    print(f"  Dedup: {len(excel_rules)} Excel rules → {len(clean_excel)} unique")
    print(f"  Dedup: {len(feedback_gaps)} feedback gaps → {len(clean_gaps)} unique "
          f"({dup_count} duplicates removed)")
    return clean_excel, clean_gaps


# ─── Seed 1: USDM Validation Rules (from Excel) ──────────────────────────────

SEVERITY_CONFIDENCE = {"ERROR": 1.0, "WARNING": 0.85, "INFO": 0.70}

def seed_validation_rules(rules: list[dict], org_id: str, dry: bool):
    print(f"\n[1/6] Seeding {len(rules)} USDM validation rules → semantic memory ...")
    stored = skipped = 0
    for r in rules:
        rule_id   = r.get("Rule ID", "")
        category  = r.get("Category", "")
        severity  = r.get("Severity", "ERROR")
        name      = r.get("Rule Name", "")
        desc      = r.get("Rule Description", "")
        path      = r.get("Path to Check", "")
        expected  = r.get("Expected Value / Pattern", "")
        error_msg = r.get("Error Message Template", "")
        conf      = SEVERITY_CONFIDENCE.get(severity, 0.85)

        # Semantic triple: rule_id IS (structured JSON payload)
        payload = json.dumps({
            "rule_id": rule_id, "category": category, "severity": severity,
            "name": name, "description": desc, "path": path,
            "expected": expected, "error_template": error_msg,
            "source": "USDM_Validation_Rules_Comprehensive.xlsx",
        })
        body = _sem(org_id, "usdm_validation_rule", rule_id, "validates", payload, conf)
        resp = _post("/memory/semantic", body, dry)
        if resp.get("action") in ("created", "reinforced", "dry-run"):
            stored += 1
        else:
            skipped += 1
        time.sleep(0.02)  # rate-limit embeddings

    print(f"  ✓ {stored} stored / {skipped} errors")


# ─── Seed 2: Feedback Gap Rules ───────────────────────────────────────────────

def seed_gap_rules(gaps: list[dict], org_id: str, dry: bool):
    print(f"\n[2/6] Seeding {len(gaps)} unique feedback gap rules → semantic memory ...")
    stored = 0
    for i, g in enumerate(gaps):
        gap_id     = f"GAP-FB-{i+1:03d}"
        section    = g.get("USDM Section", "")
        field      = g.get("Class / Field", "")
        severity   = g.get("Severity", "Major")
        desc       = g.get("Gap Description", "")
        expected   = g.get("Expected Value / Correct USDM Representation", "")
        source     = g.get("_source", "feedback")
        version    = g.get("_version", 1)

        # Severity → confidence mapping
        sev_map = {"Critical": 1.0, "Major": 0.90, "Minor": 0.75, "Fixed": 0.60}
        conf = sev_map.get(severity, 0.80)

        payload = json.dumps({
            "gap_id": gap_id, "section": section, "field": field,
            "severity": severity, "description": desc, "expected": expected,
            "source": source, "feedback_version": version,
        })
        body = _sem(org_id, "usdm_gap_rule", gap_id, "gap_check", payload, conf)
        resp = _post("/memory/semantic", body, dry)
        if resp.get("action") in ("created", "reinforced", "dry-run"):
            stored += 1
        time.sleep(0.02)

    print(f"  ✓ {stored} gap rules stored")


# ─── Seed 3: ICH M11 → USDM Section Mappings ─────────────────────────────────

# Authoritative mapping from ICH M11 Clinical Protocol Template sections
# to USDM v4.0 model paths (based on ICH_M11_Clinical_Protocol_Template.pdf
# and USDM-IG v4.0.pdf)

ICH_M11_TO_USDM_MAPPINGS = [
    # (ich_section, ich_label, usdm_path, usdm_class, notes)
    ("M11.1",  "Title Page / Cover",           "study.versions[0].titles",             "StudyTitle",        "officialTitle field required"),
    ("M11.2",  "Version & Dates",              "study.versions[0].versionIdentifier",  "StudyVersion",      "ISO 8601 date in governanceDate"),
    ("M11.3",  "Protocol Synopsis",            "study.versions[0].documentVersions",   "DocumentVersion",   "synopsis as documentVersions[0]"),
    ("M11.4",  "Table of Contents",            "study.versions[0].documentVersions",   "DocumentVersion",   "TOC in unstructuredContent"),
    ("M11.5",  "List of Abbreviations",        "study.versions[0].abbreviations",      "Abbreviation",      "abbreviationText + expandedText"),
    ("M11.6",  "Introduction / Background",    "study.versions[0].studyDesigns[0].description", "StudyDesign", "rationale in description"),
    ("M11.7",  "Trial Objectives / Endpoints", "study.versions[0].studyDesigns[0].objectives", "Objective",  "list of Objective objects"),
    ("M11.8",  "Trial Design",                 "study.versions[0].studyDesigns[0]",    "StudyDesign",       "trialType, interventionModel, blinding"),
    ("M11.9",  "Selection of Participants",    "study.versions[0].studyDesigns[0].population", "StudyDesign","inclusion/exclusion criteria"),
    ("M11.10", "Treatments / Interventions",   "study.versions[0].studyDesigns[0].studyCells[0].studyElements", "StudyElement", "interventions list"),
    ("M11.11", "Discontinuation",              "study.versions[0].studyDesigns[0].description", "StudyDesign", "discontinuation criteria in description"),
    ("M11.12", "Trial Assessments",            "study.versions[0].studyDesigns[0].activities", "Activity",   "schedule of activities"),
    ("M11.13", "Safety Assessments",           "study.versions[0].studyDesigns[0].activities", "Activity",   "safety procedure activities"),
    ("M11.14", "Statistical Considerations",   "study.versions[0].studyDesigns[0].estimands", "Estimand",   "estimands + sample size"),
    ("M11.15", "Regulatory / Ethical",         "study.versions[0].studyDesigns[0].studyIdentifiers", "StudyIdentifier", "EudraCT / IND numbers"),
    ("M11.16", "Informed Consent",             "study.versions[0].studyDesigns[0].description", "StudyDesign", "ICF process in description"),
    ("M11.17", "Financing / Insurance",        "study.versions[0].documentVersions",   "DocumentVersion",   "in unstructuredContent"),
    ("M11.18", "Publication Policy",           "study.versions[0].documentVersions",   "DocumentVersion",   "in unstructuredContent"),
    ("M11.19", "Data Handling",                "study.versions[0].documentVersions",   "DocumentVersion",   "DMP in unstructuredContent"),
    ("M11.20", "End of Trial Definition",      "study.versions[0].studyDesigns[0].description", "StudyDesign", "primary completion criteria"),
    ("M11.A1", "Protocol Amendment History",   "study.versions[0].documentVersions",   "DocumentVersion",   "amendments as documentVersions[]"),
    ("M11.A2", "Signature Page",               "study.versions[0].studyRoles",         "StudyRole",         "principal investigator role"),
]

def seed_ich_m11_mappings(org_id: str, dry: bool):
    print(f"\n[3/6] Seeding {len(ICH_M11_TO_USDM_MAPPINGS)} ICH M11 → USDM mappings ...")
    stored = 0
    for (ich_sec, ich_label, usdm_path, usdm_class, notes) in ICH_M11_TO_USDM_MAPPINGS:
        subject = f"ICH_M11_{ich_sec}"
        payload = json.dumps({
            "ich_section": ich_sec, "ich_label": ich_label,
            "usdm_path": usdm_path, "usdm_class": usdm_class,
            "notes": notes, "standard": "ICH M11 Clinical Protocol Template",
            "usdm_version": "4.0",
        })
        body = _sem(org_id, "ich_m11_mapping", subject, "maps_to_usdm", payload, 1.0)
        resp = _post("/memory/semantic", body, dry)
        if resp.get("action") in ("created", "reinforced", "dry-run"):
            stored += 1
        time.sleep(0.02)
    print(f"  ✓ {stored} ICH M11 mappings stored")


# ─── Seed 4: USDM IG Validation Context ──────────────────────────────────────

USDM_IG_RULES = [
    # (section, rule_label, requirement)
    ("Root",           "single-study-wrapper",         "JSON must have exactly one root key 'study'; no array at root"),
    ("Root",           "no-array-duplication",          "arrays (studyDesigns, titles, arms, epochs, estimands etc.) must appear ONLY inside versions[], never at study root"),
    ("Root",           "no-non-usdm-fields",            "fields studyTitle, studyVersion, studyRationale, studyProtocolVersions must not appear at study root"),
    ("StudyVersion",   "id-required",                   "every object including StudyVersion must have a non-empty 'id' string"),
    ("StudyVersion",   "instanceType-required",         "every object must have 'instanceType' matching its USDM class name"),
    ("StudyVersion",   "versionIdentifier-required",    "study.versions[].versionIdentifier must be a non-empty string"),
    ("StudyVersion",   "titles-in-version",             "titles array belongs in study.versions[n], not at study root"),
    ("StudyVersion",   "governanceDate-iso8601",        "governanceDate must be ISO 8601 format YYYY-MM-DD"),
    ("StudyDesign",    "at-least-one-arm",              "studyDesigns[].arms must contain at least one StudyArm"),
    ("StudyDesign",    "at-least-one-epoch",            "studyDesigns[].epochs must contain at least one StudyEpoch"),
    ("StudyDesign",    "studyCells-required",           "studyCells must bridge every arm×epoch combination"),
    ("StudyDesign",    "trialIntentType-coded",         "trialIntentType must be a Code object with code + decode + codeSystem"),
    ("StudyDesign",    "blinding-coded",                "blinding must be a Code object"),
    ("Code",           "code-decode-codesystem",        "every Code object must have code, decode, and codeSystem all non-empty"),
    ("Code",           "timing-code-type",              "Timing objects must use codeSystem 'CDISC' or 'ISO 8601'"),
    ("Estimand",       "estimand-ice-structured",       "intercurrentEvents must be a list of objects with description field, not bare strings"),
    ("Estimand",       "population-defined",            "each Estimand must reference a defined population via populationId or population object"),
    ("Activity",       "activity-chain-order",          "activities must have valid nextActivityId / previousActivityId references forming a DAG"),
    ("Population",     "incl-excl-criteria",            "StudyDesign.population must include inclusion and exclusion criteria objects"),
    ("Identifier",     "studyIdentifier-type",          "each StudyIdentifier must have a typeCode (Code) indicating NCT, EudraCT, IND etc."),
    ("Organization",   "org-role-coded",                "StudyRole.role must be a coded value from CDISC C99074 sponsor/investigator/CRO"),
    ("Global",         "id-uniqueness",                 "every id value across the entire JSON tree must be globally unique"),
    ("Global",         "no-orphan-references",          "every reference id (armId, epochId, elementId etc.) must resolve to an existing object"),
]

def seed_usdm_ig_rules(org_id: str, dry: bool):
    print(f"\n[3b/6] Seeding {len(USDM_IG_RULES)} USDM IG validation rules ...")
    stored = 0
    for i, (section, label, requirement) in enumerate(USDM_IG_RULES):
        rule_id = f"USDM-IG-{i+1:03d}"
        payload = json.dumps({
            "rule_id": rule_id, "section": section, "label": label,
            "requirement": requirement, "source": "USDM Implementation Guide v4.0",
            "usdm_version": "4.0",
        })
        body = _sem(org_id, "usdm_ig_rule", rule_id, "ig_requirement", payload, 1.0)
        resp = _post("/memory/semantic", body, dry)
        if resp.get("action") in ("created", "reinforced", "dry-run"):
            stored += 1
        time.sleep(0.02)
    print(f"  ✓ {stored} USDM IG rules stored")


# ─── Seed 5: Protocol Section → USDM Context Graph ───────────────────────────

# Per MaxisAI Context Graph Design (L2.E1 Study Design Graph):
# Protocol sections (as they appear in clinical protocol documents) mapped to
# USDM paths. Structured as "context graph" memories so the agent can look up
# "which USDM path should I populate from protocol section X?"

PROTOCOL_SECTION_MAPPINGS = {
    # Generic / ICH-harmonised protocol sections
    "Title Page": {
        "usdm_paths": ["study.versions[0].titles[0].text"],
        "usdm_classes": ["StudyTitle"],
        "protocol_keywords": ["title", "protocol title", "study title", "official title"],
        "notes": "Extract officialTitle and acronym from cover page",
    },
    "Protocol Synopsis": {
        "usdm_paths": ["study.versions[0].documentVersions[0]"],
        "usdm_classes": ["DocumentVersion"],
        "protocol_keywords": ["synopsis", "summary", "brief summary"],
        "notes": "Map to documentVersions[type=synopsis]",
    },
    "Background / Rationale": {
        "usdm_paths": ["study.versions[0].studyDesigns[0].description",
                       "study.versions[0].studyDesigns[0].rationale"],
        "usdm_classes": ["StudyDesign"],
        "protocol_keywords": ["background", "rationale", "introduction", "scientific justification"],
        "notes": "Free text in StudyDesign.description or rationale field",
    },
    "Study Objectives": {
        "usdm_paths": ["study.versions[0].studyDesigns[0].objectives"],
        "usdm_classes": ["Objective"],
        "protocol_keywords": ["objectives", "primary objective", "secondary objective", "exploratory"],
        "notes": "Each objective as Objective object with level (primary/secondary/exploratory)",
    },
    "Endpoints": {
        "usdm_paths": ["study.versions[0].studyDesigns[0].objectives[].endpoints"],
        "usdm_classes": ["Endpoint"],
        "protocol_keywords": ["endpoint", "primary endpoint", "secondary endpoint", "outcome measure"],
        "notes": "Endpoints nested within Objectives; link endpoint to estimand",
    },
    "Estimands": {
        "usdm_paths": ["study.versions[0].studyDesigns[0].estimands"],
        "usdm_classes": ["Estimand"],
        "protocol_keywords": ["estimand", "intercurrent event", "population-level summary", "ICH E9(R1)"],
        "notes": "Each estimand has: population, variable, populationLevelSummary, intercurrentEvents[]",
    },
    "Study Design Overview": {
        "usdm_paths": ["study.versions[0].studyDesigns[0]"],
        "usdm_classes": ["StudyDesign"],
        "protocol_keywords": ["study design", "trial design", "phase", "randomization", "blinding", "open-label"],
        "notes": "trialType, interventionModel, blinding, phase all in StudyDesign",
    },
    "Arms and Cohorts": {
        "usdm_paths": ["study.versions[0].studyDesigns[0].arms"],
        "usdm_classes": ["StudyArm"],
        "protocol_keywords": ["arm", "cohort", "treatment group", "placebo arm", "active arm"],
        "notes": "Each arm: name, type (experimental/comparator/placebo), description",
    },
    "Epochs": {
        "usdm_paths": ["study.versions[0].studyDesigns[0].epochs"],
        "usdm_classes": ["StudyEpoch"],
        "protocol_keywords": ["epoch", "screening", "treatment period", "follow-up", "washout"],
        "notes": "Ordered list of epochs; StudyCells bridge arms×epochs",
    },
    "Eligibility Criteria": {
        "usdm_paths": ["study.versions[0].studyDesigns[0].population.criteria"],
        "usdm_classes": ["EligibilityCriterion"],
        "protocol_keywords": ["inclusion criteria", "exclusion criteria", "eligibility", "key eligibility"],
        "notes": "Each criterion: text + criterionType (inclusion/exclusion) + optional SNOMED code",
    },
    "Interventions / Treatments": {
        "usdm_paths": ["study.versions[0].studyDesigns[0].studyCells[0].studyElements"],
        "usdm_classes": ["StudyElement", "StudyIntervention"],
        "protocol_keywords": ["intervention", "treatment", "investigational product", "IMP", "drug", "dose", "regimen"],
        "notes": "Interventions in StudyElement.transitions → StudyIntervention",
    },
    "Schedule of Assessments": {
        "usdm_paths": ["study.versions[0].studyDesigns[0].activities",
                       "study.versions[0].studyDesigns[0].encounters"],
        "usdm_classes": ["Activity", "Encounter"],
        "protocol_keywords": ["schedule of assessments", "SOA", "visit schedule", "assessment schedule"],
        "notes": "Activities chained by nextActivityId; grouped into Encounters (visits)",
    },
    "Study Visits / Encounters": {
        "usdm_paths": ["study.versions[0].studyDesigns[0].encounters"],
        "usdm_classes": ["Encounter"],
        "protocol_keywords": ["visit", "clinic visit", "telephone contact", "screening visit", "follow-up visit"],
        "notes": "Each Encounter: name, description, timing (windowBefore/After), activities[]",
    },
    "Safety Assessments": {
        "usdm_paths": ["study.versions[0].studyDesigns[0].activities"],
        "usdm_classes": ["Activity"],
        "protocol_keywords": ["adverse event", "AE monitoring", "safety assessment", "laboratory test", "ECG"],
        "notes": "Safety procedures modeled as Activity objects linked to Encounters",
    },
    "Statistical Methods": {
        "usdm_paths": ["study.versions[0].studyDesigns[0].estimands",
                       "study.versions[0].studyDesigns[0].description"],
        "usdm_classes": ["Estimand"],
        "protocol_keywords": ["statistical analysis", "sample size", "power calculation", "ANCOVA", "mixed model"],
        "notes": "Statistical context in Estimand.populationLevelSummary; sample size in description",
    },
    "Study Identifiers": {
        "usdm_paths": ["study.versions[0].studyIdentifiers"],
        "usdm_classes": ["StudyIdentifier"],
        "protocol_keywords": ["protocol number", "EudraCT", "NCT number", "IND number", "ClinicalTrials.gov"],
        "notes": "Each identifier: studyIdentifierId (Code) + studyIdentifier (string)",
    },
    "Organizations / Sponsor": {
        "usdm_paths": ["study.versions[0].organizations",
                       "study.versions[0].studyRoles"],
        "usdm_classes": ["Organization", "StudyRole"],
        "protocol_keywords": ["sponsor", "CRO", "investigator", "organisation", "contract research"],
        "notes": "Organization linked to study via StudyRole with coded role type",
    },
    "Abbreviations": {
        "usdm_paths": ["study.versions[0].abbreviations"],
        "usdm_classes": ["Abbreviation"],
        "protocol_keywords": ["abbreviations", "acronyms", "list of abbreviations", "glossary"],
        "notes": "Each Abbreviation: abbreviationText + expandedText",
    },
    "References": {
        "usdm_paths": ["study.versions[0].documentVersions"],
        "usdm_classes": ["DocumentVersion"],
        "protocol_keywords": ["references", "bibliography", "cited literature"],
        "notes": "References captured in unstructuredContent or documentVersions",
    },
}

# ─── Therapeutic Area Context Graphs ─────────────────────────────────────────

TA_CONTEXT_GRAPHS = {
    "Oncology": {
        "typical_endpoints": [
            "Overall Survival (OS)", "Progression-Free Survival (PFS)",
            "Objective Response Rate (ORR)", "Duration of Response (DOR)",
            "Disease Control Rate (DCR)", "Time to Response (TTR)",
        ],
        "typical_eligibility": [
            "Histologically confirmed diagnosis", "ECOG performance status 0-2",
            "Measurable disease per RECIST 1.1", "Adequate organ function (renal/hepatic/hematologic)",
            "No prior immunotherapy (for checkpoint inhibitor trials)",
        ],
        "estimand_considerations": [
            "Intercurrent events: death, subsequent therapy, dose reduction",
            "Use composite strategy for early discontinuation",
            "RECIST 1.1 for solid tumor response assessment",
        ],
        "protocol_sections_specific": [
            "Tumor assessments (RECIST/iRECIST)", "Biomarker assessments (PD-L1, TMB, MSI)",
            "Radiation history", "Prior anti-cancer therapy",
        ],
        "usdm_notes": "Population criteria typically reference ECOG score as coded value; "
                      "endpoints reference RECIST as codeSystem; activities include radiology scans",
    },
    "Immunology_Dermatology": {
        "typical_endpoints": [
            "Investigator Global Assessment (IGA)", "Eczema Area and Severity Index (EASI)",
            "SCORing Atopic Dermatitis (SCORAD)", "Peak Pruritus NRS",
            "DLQI (Dermatology Life Quality Index)", "POEM score",
        ],
        "typical_eligibility": [
            "Diagnosis of moderate-to-severe atopic dermatitis (e.g. IGA ≥ 3)",
            "Inadequate response to topical therapy",
            "Age ≥ 12 or ≥ 18 years (study dependent)",
            "No active skin infections",
        ],
        "estimand_considerations": [
            "Intercurrent events: rescue medication use, treatment discontinuation",
            "Hypothetical strategy for rescue medication",
            "While-on-treatment for primary endpoint",
        ],
        "protocol_sections_specific": [
            "Disease severity scoring (IGA, EASI, SCORAD)",
            "Topical medication washout periods",
            "Photography assessments (body surface area)",
        ],
        "usdm_notes": "IGA/EASI scores as Activity outcomes; ritlecitinib/dupilumab as StudyIntervention; "
                      "washout encoded as StudyEpoch with timing constraints",
    },
    "Cardiovascular": {
        "typical_endpoints": [
            "Major Adverse Cardiovascular Events (MACE)", "All-cause mortality",
            "CV death", "Non-fatal MI", "Non-fatal stroke", "Hospitalization for HF",
        ],
        "typical_eligibility": [
            "Established cardiovascular disease or high risk", "HbA1c criteria (for cardiometabolic)",
            "Adequate renal function (eGFR threshold)", "No recent cardiac events (within X months)",
        ],
        "estimand_considerations": [
            "Competing risks (all-cause mortality vs. CV death)",
            "Time-to-event primary endpoint uses hazard ratio",
            "Adjudication committee for endpoint classification",
        ],
        "protocol_sections_specific": [
            "Cardiac safety monitoring (ECG, troponin, BNP)",
            "Event adjudication committee charter reference",
            "Cardiovascular risk factor management",
        ],
        "usdm_notes": "MACE components as composite endpoint; adjudication as StudyRole; "
                      "survival analysis estimands with competing risk handling",
    },
    "Infectious_Disease": {
        "typical_endpoints": [
            "Sustained Virologic Response (SVR)", "Time to clinical cure",
            "Microbiological eradication rate", "Viral load reduction (log10)",
        ],
        "typical_eligibility": [
            "Confirmed pathogen identification", "Appropriate culture/sensitivity",
            "No prior exposure to study drug class", "Adequate immune function",
        ],
        "estimand_considerations": [
            "Cure definition per regulatory guidance", "Microbiological vs. clinical cure distinction",
        ],
        "protocol_sections_specific": [
            "Microbiological sampling procedures", "Antibiotic resistance screening",
            "Infection site classification",
        ],
        "usdm_notes": "Microbiological outcomes as Activity biomarkers; pathogen as coded terminology",
    },
}

def seed_protocol_section_mappings(org_id: str, dry: bool):
    print(f"\n[4/6] Seeding {len(PROTOCOL_SECTION_MAPPINGS)} protocol→USDM section mappings ...")
    stored = 0
    for section_name, mapping in PROTOCOL_SECTION_MAPPINGS.items():
        payload = json.dumps({
            "protocol_section": section_name,
            "usdm_paths": mapping["usdm_paths"],
            "usdm_classes": mapping["usdm_classes"],
            "protocol_keywords": mapping["protocol_keywords"],
            "notes": mapping["notes"],
            "source": "ICH_M11 + USDM_IG_v4.0",
        })
        body = _sem(org_id, "protocol_section_mapping", section_name,
                    "maps_to_usdm_path", payload, 1.0)
        resp = _post("/memory/semantic", body, dry)
        if resp.get("action") in ("created", "reinforced", "dry-run"):
            stored += 1
        time.sleep(0.02)
    print(f"  ✓ {stored} section mappings stored")


def seed_ta_context_graphs(org_id: str, dry: bool):
    print(f"\n[5/6] Seeding {len(TA_CONTEXT_GRAPHS)} therapeutic-area context graphs ...")
    stored = 0
    for ta_name, graph in TA_CONTEXT_GRAPHS.items():
        payload = json.dumps({
            "therapeutic_area": ta_name,
            "typical_endpoints": graph["typical_endpoints"],
            "typical_eligibility": graph["typical_eligibility"],
            "estimand_considerations": graph["estimand_considerations"],
            "protocol_sections_specific": graph["protocol_sections_specific"],
            "usdm_notes": graph["usdm_notes"],
            "source": "MaxisAI Context Graph + Clinical Practice",
        })
        body = _sem(org_id, "ta_context_graph", ta_name,
                    "protocol_pattern", payload, 0.95)
        resp = _post("/memory/semantic", body, dry)
        if resp.get("action") in ("created", "reinforced", "dry-run"):
            stored += 1
        time.sleep(0.02)
    print(f"  ✓ {stored} TA context graphs stored")


# ─── Seed 6: Procedural Memory (how-to for USDM conversion) ──────────────────

USDM_CONVERSION_PROCEDURES = [
    {
        "procedure_name": "usdm_v4_json_construction",
        "expected_outcome": "Valid USDM v4.0 JSON with all mandatory sections populated",
        "steps": [
            {"step": 1, "name": "Parse root",
             "action": "Ensure JSON root has exactly {'study': {...}}; instanceType='Study'"},
            {"step": 2, "name": "StudyVersion skeleton",
             "action": "Create study.versions[0] with id, instanceType='StudyVersion', versionIdentifier, titles[], governanceDate"},
            {"step": 3, "name": "Study identifiers",
             "action": "Add studyIdentifiers[] inside versions[0]; each with id, studyIdentifier, studyIdentifierScope (Code)"},
            {"step": 4, "name": "Organizations and roles",
             "action": "Add organizations[] and studyRoles[] inside versions[0]; link sponsor via StudyRole.role (coded)"},
            {"step": 5, "name": "Study design",
             "action": "Create studyDesigns[] inside versions[0]; each design has arms[], epochs[], studyCells[], activities[], encounters[]"},
            {"step": 6, "name": "Objectives and endpoints",
             "action": "Populate objectives[] with Objective objects; each Objective has endpoints[]; link to estimands"},
            {"step": 7, "name": "Estimands",
             "action": "Add estimands[] to studyDesigns[0]; each has population, variable, populationLevelSummary, intercurrentEvents[{dict}]"},
            {"step": 8, "name": "Population",
             "action": "Define population object in studyDesigns[0]; add criteria[] with type inclusion/exclusion"},
            {"step": 9, "name": "Schedule of activities",
             "action": "Add activities[] and encounters[]; chain activities via nextActivityId; group into encounters"},
            {"step": 10, "name": "Run validation",
             "action": "Apply all R-001 to R-206 rules; then apply USDM-IG-001 to USDM-IG-023 rules; report violations"},
        ],
        "preconditions": {
            "protocol_text": "Protocol document text available",
            "usdm_version": "4.0",
        },
    },
    {
        "procedure_name": "usdm_auto_correction",
        "expected_outcome": "USDM JSON corrected to remove structural violations",
        "steps": [
            {"step": 1, "name": "Remove root duplicates",
             "action": "Remove arrays studyDesigns, titles, arms, epochs, estimands, studyIdentifiers, organizations, studyRoles, abbreviations from study root if they also exist in versions[0]"},
            {"step": 2, "name": "Remove non-USDM fields",
             "action": "Delete studyTitle, studyVersion, studyRationale, studyProtocolVersions from study root"},
            {"step": 3, "name": "Normalize section types",
             "action": "Convert studyProtocols from list to dict if needed; ensure studyDesigns is a list"},
            {"step": 4, "name": "Inject missing mandatory sections",
             "action": "Add empty placeholders for any missing mandatory sections (populations, arms, activities, epochs, encounters, procedures, estimands, studyIdentifiers)"},
            {"step": 5, "name": "Fix Code objects",
             "action": "For every Code object missing decode or codeSystem, add defaults: codeSystem='sponsor-defined', decode=code value"},
            {"step": 6, "name": "Normalize estimand ICE",
             "action": "Convert intercurrentEvents string entries to objects: {id, instanceType='InterCurrentEvent', description: string_value}"},
            {"step": 7, "name": "Validate IDs",
             "action": "Ensure every object has a non-empty id string; generate UUID if missing"},
        ],
        "preconditions": {"usdm_json": "USDM JSON dict present"},
    },
    {
        "procedure_name": "hitl_feedback_to_rule",
        "expected_outcome": "HITL correction converted to reusable validation rule in memory",
        "steps": [
            {"step": 1, "name": "Capture correction",
             "action": "Record what the human reviewer changed: field path, original value, corrected value, rationale"},
            {"step": 2, "name": "Validate correction",
             "action": "Verify correction is consistent with USDM IG and ICH M11; flag contradictions"},
            {"step": 3, "name": "Extract rule",
             "action": "Formulate rule as: IF [path] has [pattern] THEN [correction_action] (severity based on reviewer's confidence)"},
            {"step": 4, "name": "Dedup check",
             "action": "Check if a semantically equivalent rule already exists in memory; reinforce existing rule or add new"},
            {"step": 5, "name": "Store in memory",
             "action": "POST to /memory/semantic with fact_type='hitl_derived_rule'; POST to /learnings/task with learning_type='gold_pattern'"},
            {"step": 6, "name": "Propagate to agent",
             "action": "Agent queries /memory/semantic?fact_type=hitl_derived_rule before each conversion run"},
        ],
        "preconditions": {"hitl_event": "HITL review event with reviewer_id and corrections"},
    },
]

def seed_procedural_memory(org_id: str, dry: bool):
    print(f"\n[6/6] Seeding {len(USDM_CONVERSION_PROCEDURES)} procedural memories ...")
    stored = 0
    for proc in USDM_CONVERSION_PROCEDURES:
        body = {
            "org_id": org_id,
            "task_type": "usdm_conversion",
            "procedure_name": proc["procedure_name"],
            "steps": proc["steps"],
            "preconditions": proc["preconditions"],
            "expected_outcome": proc["expected_outcome"],
        }
        resp = _post("/memory/procedural", body, dry)
        if resp.get("id") or dry:
            stored += 1
        time.sleep(0.05)
    print(f"  ✓ {stored} procedures stored")


# ─── Seed HITL integration learning ──────────────────────────────────────────

def seed_hitl_gold_patterns(org_id: str, dry: bool):
    """Seed the foundational HITL feedback loop patterns as learnings."""
    print("\n[bonus] Seeding HITL gold-pattern learnings ...")
    patterns = [
        {
            "description": "USDM root duplication: when arrays appear at study root AND inside versions[0], "
                           "always remove from root — versions[0] is authoritative",
            "learning_type": "gold_pattern",
            "evidence": {"source": "feedback_v2_v3_v4_v5", "frequency": 4, "severity": "Critical"},
        },
        {
            "description": "intercurrentEvents must be list of objects with {id, instanceType, description}; "
                           "never bare strings — convert string entries to dict during auto-correction",
            "learning_type": "gold_pattern",
            "evidence": {"source": "feedback_v1_gap_analysis", "frequency": 3, "severity": "Critical"},
        },
        {
            "description": "Every Code object in USDM must have code, decode, AND codeSystem — "
                           "incomplete Code objects fail R-036 through R-054; add codeSystem='sponsor-defined' as fallback",
            "learning_type": "gold_pattern",
            "evidence": {"source": "USDM_Validation_Rules_Comprehensive", "rule_range": "R-036:R-054"},
        },
        {
            "description": "studyProtocols should be a dict (single object), not a list — "
                           "convert list[0] to dict if agent generates it as array",
            "learning_type": "gold_pattern",
            "evidence": {"source": "USDM_IG_v4.0", "section": "StudyProtocol"},
        },
        {
            "description": "Global id uniqueness (R-197): generate UUID v4 for every USDM object; "
                           "reusing ids across arms/epochs/activities causes reference resolution failures",
            "learning_type": "anti_pattern",
            "evidence": {"source": "USDM_Validation_Rules_Comprehensive", "rule": "R-197"},
        },
        {
            "description": "When converting ritlecitinib / JAK inhibitor immunology protocols: "
                           "IGA score and EASI score map to Activity outcomes, not to Objective text; "
                           "washout period maps to StudyEpoch with timing.value and timing.unitCode",
            "learning_type": "gold_pattern",
            "evidence": {"source": "feedback_B7981027_v1", "therapeutic_area": "Immunology_Dermatology"},
        },
    ]
    stored = 0
    for p in patterns:
        body = {
            "org_id": org_id,
            "scope": "agent",
            "agent_definition_id": AGENT_DEF_ID,
            "task_type": "usdm_conversion",
            "learning_type": p["learning_type"],
            "description": p["description"],
            "evidence": p["evidence"],
            "confidence": 0.95 if p["learning_type"] == "gold_pattern" else 0.80,
        }
        resp = _post("/learnings/task", body, dry)
        if resp.get("id") or dry:
            stored += 1
        time.sleep(0.05)
    print(f"  ✓ {stored} HITL gold patterns stored")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Seed USDM validation memory")
    parser.add_argument("--dry-run", action="store_true", help="Print without writing")
    parser.add_argument("--org", default=ORG_ID, help="org_id to seed under")
    parser.add_argument("--only", help="Run only specific step: rules|gaps|ich|ig|sections|ta|procedures|hitl")
    args = parser.parse_args()

    org_id = args.org
    dry    = args.dry_run
    only   = args.only

    print(f"\n{'='*60}")
    print(f"USDM Memory Seed  |  org={org_id}  |  dry={dry}")
    print(f"Memory Engine: {MEMORY_URL}")
    print(f"{'='*60}")

    # Load and deduplicate
    excel_rules  = load_excel_rules()
    feedback_gaps = load_feedback_gaps()
    clean_rules, clean_gaps = deduplicate_rules(excel_rules, feedback_gaps)

    steps = {
        "rules":      lambda: seed_validation_rules(clean_rules, org_id, dry),
        "gaps":       lambda: seed_gap_rules(clean_gaps, org_id, dry),
        "ich":        lambda: seed_ich_m11_mappings(org_id, dry),
        "ig":         lambda: seed_usdm_ig_rules(org_id, dry),
        "sections":   lambda: seed_protocol_section_mappings(org_id, dry),
        "ta":         lambda: seed_ta_context_graphs(org_id, dry),
        "procedures": lambda: seed_procedural_memory(org_id, dry),
        "hitl":       lambda: seed_hitl_gold_patterns(org_id, dry),
    }

    if only:
        if only not in steps:
            print(f"Unknown step '{only}'. Valid: {list(steps)}")
            sys.exit(1)
        steps[only]()
    else:
        for fn in steps.values():
            fn()

    print(f"\n{'='*60}")
    print("✓ Memory seed complete.")
    print(f"  • Validation rules available at: GET {MEMORY_URL}/memory/semantic/search?q=usdm&org_id={org_id}&fact_type=usdm_validation_rule")
    print(f"  • ICH M11 mappings:              GET {MEMORY_URL}/memory/semantic/search?q=ICH_M11&org_id={org_id}&fact_type=ich_m11_mapping")
    print(f"  • Protocol section mappings:     GET {MEMORY_URL}/memory/semantic/search?q=protocol&org_id={org_id}&fact_type=protocol_section_mapping")
    print(f"  • TA context graphs:             GET {MEMORY_URL}/memory/semantic/search?q=oncology&org_id={org_id}&fact_type=ta_context_graph")
    print(f"  • HITL gold patterns:            GET {MEMORY_URL}/learnings/gold-patterns?org_id={org_id}")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
