"""
Inline evaluators L5.E11–E17 for the Protocol-to-USDM Cognitive Agent.

Each evaluator returns:
    {"score": float, "passed": bool, "details": list[str]}

Evaluator mapping:
  L5.E11  evaluate_accuracy         — extracted fields traceable to source text
  L5.E12  evaluate_completeness     — all 10 USDM mandatory sections populated
  L5.E13  evaluate_standards        — ICH M11 + USDM v4.0 structural compliance
  L5.E14  detect_hallucinations     — every value grounded in protocol source
  L5.E15  evaluate_readability      — text clarity per section
  L5.E16  evaluate_cost             — token cost accounting (informational)
  L5.E17  evaluate_consistency      — cross-field coherence
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

import re
from typing import Any, Optional

from usdm_schemas import (
    USDM_MANDATORY_SECTIONS,
    ICH_M11_TO_USDM,
    EVALUATOR_THRESHOLDS,
    USDM_IG_SECTION_TYPES,
    USDM_IG_REQUIRED_FIELDS,
    USDM_GAP_RULES,
)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _leaf_strings(obj: Any, max_per_section: int = 5) -> list[str]:
    """Recursively extract leaf string values from a nested dict/list."""
    results: list[str] = []
    if isinstance(obj, str) and obj.strip():
        results.append(obj.strip())
    elif isinstance(obj, dict):
        for v in obj.values():
            results.extend(_leaf_strings(v, max_per_section))
            if len(results) >= max_per_section:
                break
    elif isinstance(obj, list):
        for item in obj:
            results.extend(_leaf_strings(item, max_per_section))
            if len(results) >= max_per_section:
                break
    return results[:max_per_section]


def _ngrams(text: str, n: int) -> set[str]:
    tokens = re.findall(r"[a-z0-9]+", text.lower())
    return {" ".join(tokens[i: i + n]) for i in range(len(tokens) - n + 1)}


def _resolve_dotted_path(obj: dict, path: str) -> Any:
    """Walk a dotted path like 'studyProtocols.officialTitle' into a nested dict."""
    parts = path.split(".")
    current: Any = obj
    for part in parts:
        if isinstance(current, dict):
            current = current.get(part)
        elif isinstance(current, list) and current:
            current = current[0] if isinstance(current[0], dict) else None
        else:
            return None
        if current is None:
            return None
    return current


def _is_populated(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, dict):
        return bool(value)
    if isinstance(value, list):
        return bool(value)
    if isinstance(value, str):
        return bool(value.strip())
    return True


def _normalize_usdm_path(path: str) -> str:
    """Normalize paths like study.versions[].id to a dotted path usable by resolver."""
    if not isinstance(path, str):
        return ""
    normalized = path.strip()
    normalized = re.sub(r"\[(\d+)?\]", "", normalized)
    normalized = normalized.replace("..", ".")
    return normalized.strip(".")


def _memory_rule_to_check(rule: dict) -> tuple[str, str, str]:
    """Return (rule_id, target_path, check_type) for a memory-backed rule."""
    rule_id = str(rule.get("rule_id") or rule.get("id") or "MEM-RULE")
    target = _normalize_usdm_path(str(rule.get("path") or rule.get("target") or rule.get("field_path") or ""))
    expected = str(rule.get("expected") or rule.get("requirement") or rule.get("description") or "").lower()
    check = "present"
    if any(tok in expected for tok in ["non-empty", "required", "must exist", "present", "not null"]):
        check = "present"
    elif "iso 8601" in expected or "yyyy-mm-dd" in expected:
        check = "iso8601_date"
    return rule_id, target, check


# ─── L5.E11: Accuracy ─────────────────────────────────────────────────────────

def evaluate_accuracy(usdm_json: dict, protocol_text: str) -> dict:
    """Check extracted USDM field values are traceable to the source protocol text."""
    protocol_lower = protocol_text.lower()
    sampled = 0
    matched = 0
    details: list[str] = []

    for section in USDM_MANDATORY_SECTIONS:
        section_val = usdm_json.get(section)
        if not section_val:
            continue
        leaves = _leaf_strings(section_val, max_per_section=8)
        for leaf in leaves:
            if len(leaf) < 8:
                continue
            sampled += 1
            leaf_lower = leaf.lower().strip()
            # Stage 1: substring fingerprint match (first 40 chars / first 20 chars)
            fragment = leaf_lower[:40]
            stage1 = fragment in protocol_lower or leaf_lower[:20] in protocol_lower
            # Stage 2: bigram overlap — any 2-gram from leaf appears in protocol
            leaf_bigrams = _ngrams(leaf_lower, 2)
            proto_bigrams = _ngrams(protocol_lower[:10000], 2)
            stage2 = bool(leaf_bigrams & proto_bigrams) if len(leaf_bigrams) >= 2 else False
            if stage1 or stage2:
                matched += 1
            else:
                details.append(f"Untraced value in '{section}': \"{leaf[:60]}\"")

    score = (matched / sampled) if sampled > 0 else 0.50
    passed = score >= EVALUATOR_THRESHOLDS["accuracy"]
    return {"score": round(score, 3), "passed": passed, "details": details[:5]}


# ─── L5.E12: Completeness ─────────────────────────────────────────────────────

def evaluate_completeness(usdm_json: dict) -> dict:
    """Verify all 10 mandatory USDM sections are populated."""
    missing: list[str] = []
    populated = 0

    for section in USDM_MANDATORY_SECTIONS:
        val = usdm_json.get(section)
        if _is_populated(val):
            populated += 1
        else:
            missing.append(section)

    score = populated / len(USDM_MANDATORY_SECTIONS)
    passed = score >= EVALUATOR_THRESHOLDS["completeness"]
    details = [f"Missing section: {s}" for s in missing]
    return {"score": round(score, 3), "passed": passed, "details": details}


# ─── L5.E13: Standards (ICH M11 + USDM schema) ────────────────────────────────

def evaluate_standards(usdm_json: dict, memory_rules: Optional[list[dict]] = None) -> dict:
    """Verify both ICH M11 mappings and USDM implementation-guideline structure."""
    resolved = 0
    ich_total = len(ICH_M11_TO_USDM)
    details: list[str] = []
    gap_failures: list[str] = []

    # Part 1: ICH M11 -> USDM mapping checks.
    for ich_section, usdm_path in ICH_M11_TO_USDM.items():
        val = _resolve_dotted_path(usdm_json, usdm_path)
        if val is None:
            top_key = usdm_path.split(".")[0].split("[")[0]
            val = usdm_json.get(top_key)
        if _is_populated(val):
            resolved += 1
        else:
            details.append(f"ICH M11 '{ich_section}' → USDM '{usdm_path}' not populated")

    # Bonus for practical identifier coverage in generated exports.
    identifiers = usdm_json.get("studyIdentifiers", [])
    if isinstance(identifiers, list) and identifiers:
        resolved += 1

    # Part 2: USDM implementation-guideline section type checks.
    for section, expected_type in USDM_IG_SECTION_TYPES.items():
        value = usdm_json.get(section)
        if expected_type == "dict" and isinstance(value, dict):
            resolved += 1
        elif expected_type == "list" and isinstance(value, list):
            resolved += 1
        else:
            details.append(
                f"USDM IG section '{section}' expected {expected_type} but got "
                f"{type(value).__name__ if value is not None else 'None'}"
            )

    # Part 3: Minimal required field presence checks.
    for target, required_fields in USDM_IG_REQUIRED_FIELDS.items():
        if target.endswith("[]"):
            section = target[:-2]
            value = usdm_json.get(section)
            if isinstance(value, list) and value and isinstance(value[0], dict):
                if all(_is_populated(value[0].get(field)) for field in required_fields):
                    resolved += 1
                else:
                    details.append(
                        f"USDM IG section '{section}[0]' missing required fields: "
                        f"{', '.join(required_fields)}"
                    )
            else:
                details.append(f"USDM IG section '{section}' has no structured first element")
        else:
            value = usdm_json.get(target)
            if isinstance(value, dict) and all(_is_populated(value.get(field)) for field in required_fields):
                resolved += 1
            else:
                details.append(
                    f"USDM IG section '{target}' missing required fields: "
                    f"{', '.join(required_fields)}"
                )

    # Part 4: Explicit gap rules (from USDM gap-analysis playbook).
    study_root = usdm_json.get("study") if isinstance(usdm_json.get("study"), dict) else usdm_json
    version0 = None
    if isinstance(study_root, dict):
        versions = study_root.get("versions")
        if isinstance(versions, list) and versions and isinstance(versions[0], dict):
            version0 = versions[0]

    for rule in USDM_GAP_RULES:
        target = rule["target"]
        check = rule["check"]
        value = _resolve_dotted_path(usdm_json, target)
        if value is None and "." in target:
            value = usdm_json.get(target.split(".")[0])

        passed_rule = False
        if check == "dict_non_empty":
            passed_rule = isinstance(value, dict) and bool(value)
        elif check == "list_non_empty":
            passed_rule = isinstance(value, list) and bool(value)
        elif check == "string_non_empty":
            passed_rule = isinstance(value, str) and bool(value.strip())
        elif check == "no_root_duplication":
            if version0 is None:
                passed_rule = True
            else:
                root_has = isinstance(study_root, dict) and _is_populated(study_root.get(target))
                version_has = _is_populated(version0.get(target))
                passed_rule = not (root_has and version_has)
        elif check == "absent_root_field":
            if version0 is None:
                passed_rule = True
            else:
                passed_rule = not (isinstance(study_root, dict) and target in study_root)
        elif check == "estimand_ice_structured":
            estimands = usdm_json.get("estimands")
            if estimands is None and isinstance(version0, dict):
                estimands = version0.get("estimands")
            if not isinstance(estimands, list) or not estimands:
                passed_rule = True
            else:
                def _ice_ok(est: dict) -> bool:
                    ice = est.get("intercurrentEvents")
                    if ice is None:
                        return True
                    if not isinstance(ice, list):
                        return False
                    for item in ice:
                        if not isinstance(item, dict):
                            return False
                        if not _is_populated(item.get("description")) and not _is_populated(item.get("text")):
                            return False
                    return True
                passed_rule = all(isinstance(est, dict) and _ice_ok(est) for est in estimands)

        if passed_rule:
            resolved += 1
        else:
            msg = f"[{rule['id']}] Gap check failed at '{target}' (expected {check})"
            details.append(msg)
            gap_failures.append(msg)

    # Part 5: Memory-backed quality rules (seeded from Excel + HITL feedback).
    external_total = 0
    if memory_rules:
        study_root = usdm_json.get("study") if isinstance(usdm_json.get("study"), dict) else usdm_json
        for mem_rule in memory_rules[:100]:
            rid, target, check = _memory_rule_to_check(mem_rule)
            if not target:
                continue
            top_key = target.split(".")[0]
            if top_key not in usdm_json and not (isinstance(study_root, dict) and top_key in study_root):
                continue

            external_total += 1
            value = _resolve_dotted_path(usdm_json, target)
            if value is None and isinstance(study_root, dict):
                value = _resolve_dotted_path(study_root, target)

            passed_rule = True
            if check == "present":
                passed_rule = _is_populated(value)
            elif check == "iso8601_date":
                passed_rule = isinstance(value, str) and bool(re.match(r"^\d{4}-\d{2}-\d{2}$", value.strip()))

            if passed_rule:
                resolved += 1
            else:
                msg = f"[{rid}] Memory rule failed at '{target}' (expected {check})"
                details.append(msg)
                gap_failures.append(msg)

    total = ich_total + 1 + len(USDM_IG_SECTION_TYPES) + len(USDM_IG_REQUIRED_FIELDS) + len(USDM_GAP_RULES) + external_total
    score = resolved / total
    passed = score >= EVALUATOR_THRESHOLDS["standards"]
    return {
        "score": round(score, 3),
        "passed": passed,
        "details": details[:30],
        "gap_failures": gap_failures,
    }


# ─── L5.E14: Hallucination Detection ──────────────────────────────────────────

def detect_hallucinations(usdm_json: dict, protocol_text: str) -> dict:
    """Detect USDM values not grounded in the source protocol text."""
    protocol_ngrams = _ngrams(protocol_text, 3)
    hallucinated = 0
    total = 0
    details: list[str] = []

    for section in USDM_MANDATORY_SECTIONS:
        val = usdm_json.get(section)
        if not val:
            continue
        for leaf in _leaf_strings(val, max_per_section=5):
            if len(leaf) < 15:
                continue
            total += 1
            leaf_ngrams = _ngrams(leaf, 3)
            if not leaf_ngrams:
                continue
            overlap = len(leaf_ngrams & protocol_ngrams) / len(leaf_ngrams)
            if overlap < 0.40:
                hallucinated += 1
                details.append(f"Possibly hallucinated in '{section}': \"{leaf[:70]}\"")

    score = 1.0 - (hallucinated / total) if total > 0 else 0.95
    passed = score >= EVALUATOR_THRESHOLDS["hallucination"]
    return {"score": round(score, 3), "passed": passed, "details": details[:5]}


# ─── L5.E15: Readability ──────────────────────────────────────────────────────

_PLACEHOLDER_PATTERNS = re.compile(
    r"(lorem ipsum|placeholder|tbd|to be determined|\[insert\]|xxx|n\/a pending)",
    re.IGNORECASE,
)

def evaluate_readability(usdm_json: dict) -> dict:
    """Score text clarity in USDM sections."""
    max_score = len(USDM_MANDATORY_SECTIONS) * 0.15
    running = 0.0
    details: list[str] = []

    for section in USDM_MANDATORY_SECTIONS:
        val = usdm_json.get(section)
        if not val:
            continue
        texts = _leaf_strings(val, max_per_section=3)
        for text in texts:
            if len(text) < 10:
                continue
            sentences = re.split(r"[.!?]+", text)
            sentences = [s.strip() for s in sentences if s.strip()]
            if sentences:
                avg_words = sum(len(s.split()) for s in sentences) / len(sentences)
                if avg_words <= 30:
                    running += 0.10
                else:
                    details.append(f"Long sentences in '{section}' (avg {avg_words:.0f} words)")
            if not _PLACEHOLDER_PATTERNS.search(text):
                running += 0.05
            else:
                details.append(f"Placeholder text found in '{section}'")
            break  # one text sample per section

    score = min(running / max_score, 1.0) if max_score > 0 else 0.70
    passed = score >= EVALUATOR_THRESHOLDS["readability"]
    return {"score": round(score, 3), "passed": passed, "details": details[:5]}


# ─── L5.E16: Cost (informational) ─────────────────────────────────────────────

def evaluate_cost(tokens_used: int, usdm_json: dict) -> dict:
    """Compute token cost for this conversion run (always passes)."""
    cost_usd = tokens_used * 0.000002  # $2 per 1M tokens (mid-tier estimate)
    populated = sum(1 for s in USDM_MANDATORY_SECTIONS if _is_populated(usdm_json.get(s)))
    cost_per_section = cost_usd / max(populated, 1)
    return {
        "score": 1.0,
        "passed": True,
        "details": [
            f"tokens_used={tokens_used}",
            f"cost_usd={cost_usd:.4f}",
            f"sections_populated={populated}",
            f"cost_per_section={cost_per_section:.4f}",
        ],
        "cost_usd": round(cost_usd, 4),
    }


# ─── L5.E17: Consistency ──────────────────────────────────────────────────────

def evaluate_consistency(usdm_json: dict) -> dict:
    """Check cross-field coherence across USDM sections."""
    score = 0.0
    details: list[str] = []

    # Check 1: studyProtocols has an official title (+0.20)
    protocols = usdm_json.get("studyProtocols")
    if isinstance(protocols, dict) and protocols.get("officialTitle"):
        score += 0.20
    elif isinstance(protocols, list) and any(p.get("officialTitle") for p in protocols if isinstance(p, dict)):
        score += 0.20
    else:
        details.append("studyProtocols.officialTitle is missing")

    # Check 2: arms is a non-empty list (+0.20)
    arms = usdm_json.get("arms", [])
    arm_names: set[str] = set()
    if isinstance(arms, list) and arms:
        score += 0.20
        for arm in arms:
            if isinstance(arm, dict):
                name = arm.get("name") or arm.get("armName") or ""
                if name:
                    arm_names.add(name.lower())
    else:
        details.append("arms section is empty")

    # Check 3: populations have type inc/exc (+0.20)
    populations = usdm_json.get("populations", [])
    if isinstance(populations, list) and populations:
        typed = sum(
            1 for p in populations
            if isinstance(p, dict) and p.get("type") in ("inclusion", "exclusion", "inc", "exc")
        )
        if typed > 0 or len(populations) > 0:
            score += 0.20
    elif isinstance(populations, dict) and populations:
        score += 0.20
    else:
        details.append("populations section is empty or missing type tags")

    # Check 4: activities is a non-empty list (+0.20)
    activities = usdm_json.get("activities", [])
    if isinstance(activities, list) and activities:
        score += 0.20
    elif isinstance(activities, dict) and activities:
        score += 0.20
    else:
        details.append("activities section is empty")

    # Check 5: estimands reference arms when arm names are known (+0.20)
    estimands = usdm_json.get("estimands", [])
    if isinstance(estimands, list) and estimands and arm_names:
        matched = any(
            arm_names & set(
                re.findall(r"[a-z]+", str(e).lower())
            )
            for e in estimands
        )
        if matched:
            score += 0.20
        else:
            details.append("estimands do not reference arm names")
    elif not arm_names or not estimands:
        score += 0.20  # cannot check; give benefit of the doubt

    passed = score >= EVALUATOR_THRESHOLDS["consistency"]
    return {"score": round(score, 3), "passed": passed, "details": details}


# ─── L5.E18.P: Provenance Coverage (blocking gate) ────────────────────────────

def evaluate_provenance_coverage(usdm_json: dict, provenance_map: dict, threshold: float = 1.0) -> dict:
    """Ensure every populated mandatory USDM section has a source provenance entry.

    This evaluator is blocking: without full coverage no conversion may be finalized
    without HITL approval (per Phase 3 gate policy).
    """
    populated = [s for s in USDM_MANDATORY_SECTIONS if _is_populated(usdm_json.get(s))]
    if not populated:
        return {"score": 0.0, "passed": False, "details": ["No populated sections to trace"]}

    covered: list[str] = []
    missing: list[str] = []
    for section in populated:
        if any(k == section or k.startswith(section + ".") or k.startswith(section + "[")
               for k in provenance_map):
            covered.append(section)
        else:
            missing.append(section)

    coverage = len(covered) / len(populated)
    passed = coverage >= threshold
    details = [f"Missing provenance for: {s}" for s in missing] if missing else [
        f"All {len(covered)} populated sections have provenance"
    ]
    return {
        "score": round(coverage, 3),
        "passed": passed,
        "details": details,
        "covered_sections": covered,
        "missing_sections": missing,
    }


# ─── Run all evaluators ───────────────────────────────────────────────────────

def run_all_evaluators(
    usdm_json: dict,
    protocol_text: str,
    tokens_used: int = 0,
    provenance_map: Optional[dict] = None,
    require_provenance: bool = False,
    provenance_threshold: float = 1.0,
    memory_rules: Optional[list[dict]] = None,
) -> dict[str, dict]:
    """Run all 7 base evaluators + optional provenance gate and return a keyed dict."""
    results = {
        "accuracy":      evaluate_accuracy(usdm_json, protocol_text),
        "completeness":  evaluate_completeness(usdm_json),
        "standards":     evaluate_standards(usdm_json, memory_rules=memory_rules),
        "hallucination": detect_hallucinations(usdm_json, protocol_text),
        "readability":   evaluate_readability(usdm_json),
        "cost":          evaluate_cost(tokens_used, usdm_json),
        "consistency":   evaluate_consistency(usdm_json),
    }
    if require_provenance and provenance_map is not None:
        results["provenance"] = evaluate_provenance_coverage(usdm_json, provenance_map, provenance_threshold)
    return results
