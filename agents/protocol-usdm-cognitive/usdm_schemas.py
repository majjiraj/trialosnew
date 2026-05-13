"""
USDM v4.0 schema constants, ICH M11 section map, and confidence weights.
Used by evaluators.py and agent.py — no external dependencies.
"""

# 10 mandatory USDM v4.0 top-level sections
USDM_MANDATORY_SECTIONS = [
    "meta",
    "studyIdentifiers",
    "studyProtocols",
    "therapeuticAreas",
    "objectives",
    "estimands",
    "populations",
    "arms",
    "epochs",
    "activities",
]

# USDM implementation guideline expectations used for quality checks.
# Values are intentionally pragmatic for generated payload quality gates.
USDM_IG_SECTION_TYPES: dict[str, str] = {
    "meta": "dict",
    "studyIdentifiers": "list",
    "studyProtocols": "dict",
    "therapeuticAreas": "list",
    "objectives": "list",
    "estimands": "list",
    "populations": "list",
    "arms": "list",
    "epochs": "list",
    "activities": "list",
}

USDM_IG_REQUIRED_FIELDS: dict[str, list[str]] = {
    "meta": ["version", "generatedAt", "generatedBy"],
    "studyProtocols": ["officialTitle", "version", "date"],
    "studyIdentifiers[]": ["type", "value"],
    "arms[]": ["name"],
    "objectives[]": ["description"],
    "activities[]": ["name"],
}

# Gap rule catalog used by standards evaluation and auto-correction.
# These map common conversion gaps into deterministic checks/fixes.
USDM_GAP_RULES: list[dict[str, str]] = [
    {"id": "GAP-USDM-001", "target": "meta", "check": "dict_non_empty", "severity": "high"},
    {"id": "GAP-USDM-002", "target": "studyIdentifiers", "check": "list_non_empty", "severity": "high"},
    {"id": "GAP-USDM-003", "target": "studyProtocols.officialTitle", "check": "string_non_empty", "severity": "high"},
    {"id": "GAP-USDM-004", "target": "objectives", "check": "list_non_empty", "severity": "medium"},
    {"id": "GAP-USDM-005", "target": "arms", "check": "list_non_empty", "severity": "high"},
    {"id": "GAP-USDM-006", "target": "activities", "check": "list_non_empty", "severity": "high"},
    {"id": "GAP-USDM-007", "target": "meta.version", "check": "string_non_empty", "severity": "medium"},
    {"id": "GAP-USDM-008", "target": "studyProtocols.date", "check": "string_non_empty", "severity": "medium"},
    {"id": "GAP-USDM-009", "target": "studyDesigns", "check": "no_root_duplication", "severity": "high"},
    {"id": "GAP-USDM-010", "target": "studyIdentifiers", "check": "no_root_duplication", "severity": "high"},
    {"id": "GAP-USDM-011", "target": "organizations", "check": "no_root_duplication", "severity": "high"},
    {"id": "GAP-USDM-012", "target": "studyRoles", "check": "no_root_duplication", "severity": "high"},
    {"id": "GAP-USDM-013", "target": "abbreviations", "check": "no_root_duplication", "severity": "medium"},
    {"id": "GAP-USDM-014", "target": "unstructuredContents", "check": "no_root_duplication", "severity": "high"},
    {"id": "GAP-USDM-015", "target": "studyTitle", "check": "absent_root_field", "severity": "medium"},
    {"id": "GAP-USDM-016", "target": "studyVersion", "check": "absent_root_field", "severity": "medium"},
    {"id": "GAP-USDM-017", "target": "studyRationale", "check": "absent_root_field", "severity": "medium"},
    {"id": "GAP-USDM-018", "target": "studyProtocolVersions", "check": "absent_root_field", "severity": "medium"},
    {"id": "GAP-USDM-019", "target": "estimands", "check": "estimand_ice_structured", "severity": "high"},
]

# ICH M11 CeSHarP 14 sections → USDM dotted-path targets
ICH_M11_TO_USDM: dict[str, str] = {
    "title_page":              "studyProtocols.officialTitle",
    "introduction":            "meta.rationale",
    "study_objectives":        "objectives",
    "estimands":               "estimands",
    "study_design":            "arms",
    "populations":             "populations",
    "interventions":           "arms",
    "discontinuation":         "arms",
    "study_assessments":       "activities",
    "statistical_methods":     "estimands",
    "adverse_event_reporting": "meta",
    "ethics":                  "meta",
    "informed_consent":        "meta",
    "appendices":              "meta",
}

# Regex patterns for section-boundary detection (ICH M11 heading anchors)
SECTION_PATTERNS: dict[str, list[str]] = {
    "title_page":              [r"(?i)title\s+page", r"(?i)study\s+title", r"(?i)protocol\s+title"],
    "introduction":            [r"(?i)\bintroduction\b", r"(?i)\brationale\b", r"(?i)background"],
    "study_objectives":        [r"(?i)study\s+objective", r"(?i)primary\s+objective", r"(?i)secondary\s+objective"],
    "estimands":               [r"(?i)\bestirand\b", r"(?i)\bestirand\b", r"(?i)estimand"],
    "study_design":            [r"(?i)study\s+design", r"(?i)overview\s+of\s+(study|design)"],
    "populations":             [r"(?i)study\s+population", r"(?i)inclusion\s+criter", r"(?i)exclusion\s+criter",
                                 r"(?i)eligibility\s+criter"],
    "interventions":           [r"(?i)study\s+(treatment|intervention|drug|compound)", r"(?i)dosing\s+regimen"],
    "discontinuation":         [r"(?i)discontinu", r"(?i)withdrawal\s+criter"],
    "study_assessments":       [r"(?i)assessment", r"(?i)visit\s+schedule", r"(?i)schedule\s+of\s+(event|assess)",
                                 r"(?i)time\s+and\s+event", r"(?i)study\s+visit"],
    "statistical_methods":     [r"(?i)statistical\s+method", r"(?i)statistical\s+analysis", r"(?i)sample\s+size"],
    "adverse_event_reporting": [r"(?i)adverse\s+event", r"(?i)safety\s+report", r"(?i)pharmacovigilan"],
    "ethics":                  [r"(?i)ethics\b", r"(?i)ethical\s+consider", r"(?i)irb\b", r"(?i)iec\b"],
    "informed_consent":        [r"(?i)informed\s+consent", r"(?i)consent\s+process"],
    "appendices":              [r"(?i)\bappendix\b", r"(?i)\bappendices\b"],
}

# SNOMED-CT coded conditions (extend as needed)
SNOMED_LOOKUP: dict[str, str] = {
    "diabetes": "73211009",
    "hypertension": "38341003",
    "cancer": "363346000",
    "tumor": "108369006",
    "pregnancy": "77386006",
    "renal impairment": "723188008",
    "hepatic impairment": "235856003",
    "cardiac": "56265001",
    "hiv": "86406008",
    "autoimmune": "85828009",
    "asthma": "195967001",
    "obesity": "414916001",
    "depression": "35489007",
    "alzheimer": "26929004",
    "parkinson": "49049000",
}

# Visit / timepoint patterns for schedule recognition
TIMEPOINT_PATTERNS = [
    r"(?i)(?:day|week|month|cycle)\s*[-\s]?\d+",
    r"(?i)screening",
    r"(?i)baseline",
    r"(?i)follow[\s-]?up",
    r"(?i)end\s+of\s+(?:study|treatment)",
    r"(?i)week\s*\d+",
    r"(?i)visit\s*\d+",
]

# Per-capability confidence contribution weights (sum = 1.0)
CAPABILITY_CONFIDENCE_WEIGHTS: dict[str, float] = {
    "section_parsing":        0.35,
    "eligibility_extraction": 0.30,
    "schedule_recognition":   0.20,
    "feasibility_comparison": 0.15,
}

# Pass thresholds for each inline evaluator
EVALUATOR_THRESHOLDS: dict[str, float] = {
    "accuracy":      0.85,
    "completeness":  0.90,
    "standards":     0.80,
    "hallucination": 0.95,
    "readability":   0.70,
    "cost":          1.00,  # informational; always passes
    "consistency":   0.80,
    "provenance":    1.00,  # blocking gate: full coverage required before finalisation
}
