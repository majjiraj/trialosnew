"""Structural validators: ICH M11 completeness and CDISC CT code checks."""
from __future__ import annotations
from typing import Any

# ── CDISC Controlled Terminology code lists ───────────────────────────────────

VALID_EPOCH_TYPE_CODES: set[str] = {
    "C48268", "C101526", "C99158", "C127793", "C127790", "C48261",
}
VALID_ARM_TYPE_CODES: set[str] = {
    "C174266", "C174267", "C174268", "C174269",
}
VALID_PHASE_CODES: set[str] = {
    "C15600", "C15601", "C15602", "C15603", "C54723", "C98388",
}

REQUIRED_ICH_M11_SECTIONS: dict[str, str] = {
    "study_identifiers":    "Study identifiers (NCT/sponsor number)",
    "objectives_endpoints": "Primary/secondary objectives and endpoints",
    "study_arms":           "Study arms",
    "study_epochs":         "Study epochs/periods",
    "population":           "Inclusion/exclusion criteria",
    "indications":          "Disease indication",
}


def validate_ich_m11(usdm_json: dict) -> dict:
    """Check that all required ICH M11 protocol sections are present.

    Returns {"passed": bool, "score": float, "gaps": list[str]}.
    """
    study = usdm_json.get("study", {})
    sv_list = study.get("versions") if isinstance(study.get("versions"), list) else []
    sv = sv_list[0] if sv_list and isinstance(sv_list[0], dict) else {}
    designs = sv.get("studyDesigns") if isinstance(sv.get("studyDesigns"), list) else []
    design = designs[0] if designs and isinstance(designs[0], dict) else {}

    gaps: list[str] = []
    section_map = {
        "study_identifiers":    bool(sv.get("studyIdentifiers") or study.get("studyIdentifiers")),
        "objectives_endpoints": bool(design.get("objectives")),
        "study_arms":           bool(design.get("studyArms") or design.get("arms")),
        "study_epochs":         bool(design.get("studyEpochs") or design.get("epochs")),
        "population":           bool(design.get("studyPopulations") or design.get("population")),
        "indications":          bool(design.get("studyIndications") or design.get("indications")),
    }
    for sid, present in section_map.items():
        if not present:
            gaps.append(f"ich_m11_missing:{sid}:{REQUIRED_ICH_M11_SECTIONS[sid]}")

    score = 1.0 - (len(gaps) / max(len(REQUIRED_ICH_M11_SECTIONS), 1))
    return {"passed": len(gaps) == 0, "score": round(score, 3), "gaps": gaps}


def validate_cdisc_ct(usdm_json: dict) -> dict:
    """Spot-check CDISC Controlled Terminology codes in arms, epochs, and phase.

    Returns {"passed": bool, "score": float, "gaps": list[str]}.
    """
    study = usdm_json.get("study", {})
    sv_list = study.get("versions") if isinstance(study.get("versions"), list) else []
    sv = sv_list[0] if sv_list and isinstance(sv_list[0], dict) else {}
    designs = sv.get("studyDesigns") if isinstance(sv.get("studyDesigns"), list) else []
    design = designs[0] if designs and isinstance(designs[0], dict) else {}

    gaps: list[str] = []
    total_checks = 0

    def _get_code(obj: Any) -> str:
        if not isinstance(obj, dict):
            return ""
        return str(obj.get("code") or obj.get("standardCode", {}).get("code") or "")

    for arm in (design.get("studyArms") or design.get("arms") or []):
        if not isinstance(arm, dict):
            continue
        total_checks += 1
        code = _get_code(arm.get("studyArmType") or arm.get("type") or {})
        if code and code not in VALID_ARM_TYPE_CODES:
            gaps.append(f"cdisc_ct:arm_type_invalid_code:{code}")

    for epoch in (design.get("studyEpochs") or design.get("epochs") or []):
        if not isinstance(epoch, dict):
            continue
        total_checks += 1
        code = _get_code(epoch.get("studyEpochType") or epoch.get("type") or {})
        if code and code not in VALID_EPOCH_TYPE_CODES:
            gaps.append(f"cdisc_ct:epoch_type_invalid_code:{code}")

    total_checks += 1
    phase_obj = design.get("studyPhase") or {}
    phase_code = _get_code(phase_obj)
    if phase_code and phase_code not in VALID_PHASE_CODES:
        gaps.append(f"cdisc_ct:phase_invalid_code:{phase_code}")

    score = 1.0 - (len(gaps) / max(total_checks, 1))
    return {"passed": len(gaps) == 0, "score": round(score, 3), "gaps": gaps}


def validate_schema_fields(usdm_json: dict) -> dict:
    """Check for unexpected root-level fields and missing required USDM v4 structure.

    Returns {"passed": bool, "score": float, "gaps": list[str]}.
    """
    study = usdm_json.get("study", {})
    gaps: list[str] = []

    # Root-level non-USDM fields that should have been moved to versions[0]
    non_usdm_root = [
        "studyTitle", "studyVersion", "studyRationale", "studyPhase",
        "studyType", "studyAcronym", "studyDesigns", "studyIdentifiers",
    ]
    for field in non_usdm_root:
        if study.get(field):
            gaps.append(f"schema:non_usdm_root_field:{field}")

    # Required top-level structure
    if not study.get("id"):
        gaps.append("schema:missing_study_id")
    if not study.get("versions"):
        gaps.append("schema:missing_versions_array")
    else:
        sv = (study.get("versions") or [{}])[0]
        if not sv.get("versionIdentifier"):
            gaps.append("schema:missing_versionIdentifier")
        if not sv.get("titles"):
            gaps.append("schema:missing_version_titles")
        if not sv.get("studyDesigns"):
            gaps.append("schema:missing_studyDesigns")

    score = max(0.0, 1.0 - len(gaps) / 10)
    return {"passed": len(gaps) == 0, "score": round(score, 3), "gaps": gaps}
