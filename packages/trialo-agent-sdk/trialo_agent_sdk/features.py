"""
TrialOS Agent SDK — Shared Platform Feature Implementations

Five platform-wide features available to every agent (new or existing):
  1. Dynamic Retrieval Augmentation
  2. Confidence-Based Execution Branching
  3. Validation Escalation
  4. Contextual Prompt Injection for HITL
  5. Memory Retrieval and Context Building

These are exposed as standalone functions AND as methods on BaseAgent.
Agents can call them directly or let BaseAgent auto-wire them at run boundaries.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


# ─────────────────────────────────────────────────────────────────────────────
# Feature 1: Dynamic Retrieval Augmentation
# ─────────────────────────────────────────────────────────────────────────────

_DOMAIN_CHAPTER_QUERIES: dict[str, str] = {
    "AE": "Adverse Events AE domain chapter required variables CDISC SDTMIG section",
    "DM": "Demographics DM domain chapter required variables CDISC SDTMIG section",
    "LB": "Laboratory Tests LB domain chapter required variables CDISC SDTMIG section",
    "VS": "Vital Signs VS domain chapter required variables CDISC SDTMIG section",
    "CM": "Concomitant Medications CM domain chapter required variables CDISC SDTMIG section",
    "EX": "Exposure EX domain chapter required variables CDISC SDTMIG section",
    "MH": "Medical History MH domain chapter required variables CDISC SDTMIG section",
    "DS": "Disposition DS domain chapter required variables CDISC SDTMIG section",
    "TU": "Tumor TU domain chapter required variables CDISC SDTMIG section",
    "RS": "Disease Response RS domain chapter required variables CDISC SDTMIG section",
    "PR": "Procedures PR domain chapter required variables CDISC SDTMIG section",
    "FA": "Findings About FA domain chapter required variables CDISC SDTMIG section",
}

_RULE_QUERY_TEMPLATE = "CDISC SDTM validation rule {rule_id} conformance check definition"


def augment_ig_queries(base_query: str, domains: list[str]) -> list[str]:
    """Return base_query plus mandatory domain-chapter anchor queries.

    Ensures retrieval surfaces domain-specific IG sections (not only generic
    SDTM fundamentals), reducing hallucinated non-IG variable names.
    """
    queries = [base_query]
    for domain in (domains or []):
        chapter_q = _DOMAIN_CHAPTER_QUERIES.get(domain.upper().strip())
        if chapter_q and chapter_q not in queries:
            queries.append(chapter_q)
    return queries


def augment_conformance_queries(
    base_query: str,
    domains: list[str],
    rule_ids: list[str] | None = None,
) -> list[str]:
    """Augment conformance rule lookups with domain chapter queries and rule references."""
    queries = augment_ig_queries(base_query, domains)
    for rule in (rule_ids or [])[:5]:
        q = _RULE_QUERY_TEMPLATE.format(rule_id=rule)
        if q not in queries:
            queries.append(q)
    return queries


# ─────────────────────────────────────────────────────────────────────────────
# Feature 2: Confidence-Based Execution Branching
# ─────────────────────────────────────────────────────────────────────────────

_DEFAULT_BRANCH_THRESHOLDS: dict[str, float] = {
    "proceed": 0.70,
    "escalate": 0.40,
    "defer": 0.20,
}


@dataclass
class BranchResult:
    """Outcome of a confidence-based branching decision."""
    action: Literal["proceed", "escalate", "defer", "skip"]
    confidence: float
    reason: str
    details: dict[str, Any] = field(default_factory=lambda: {})


def compute_agent_confidence(
    evidence_count: int,
    quality_signals: list[float] | None = None,
    validation_methods_used: list[str] | None = None,
    base: float = 0.5,
) -> float:
    """Compute grounded confidence from evidence signals.

    Mirrors the runtime _compute_grounded_confidence formula:
      evidence_component  (0–0.40) — grows with evidence_count
      quality_component   (0–0.35) — average of quality_signals
      validation_bonus    (0–0.25) — +0.05 per validation method (max 5)
    If evidence_count == 0 the result is always capped at 0.30.
    """
    if evidence_count == 0:
        return round(min(base * 0.35, 0.3), 3)
    evidence_component = min(evidence_count / 10.0, 1.0) * 0.40
    sigs = quality_signals or []
    quality_component = (
        (sum(float(s) for s in sigs[:5]) / max(len(sigs[:5]), 1)) * 0.35
        if sigs else 0.15
    )
    validation_bonus = min(len(validation_methods_used or []) * 0.05, 0.25)
    return round(min(base + evidence_component + quality_component + validation_bonus, 1.0), 3)


def branch_on_confidence(
    confidence: float,
    thresholds: dict[str, float] | None = None,
    context_hint: str = "",
) -> BranchResult:
    """Return which branch to take based on confidence score.

    Actions (in priority order):
        proceed   — confidence >= thresholds['proceed'] (default 0.70)
        escalate  — confidence >= thresholds['escalate'] (default 0.40)
        defer     — confidence >= thresholds['defer']   (default 0.20)
        skip      — confidence < thresholds['defer']
    """
    t = {**_DEFAULT_BRANCH_THRESHOLDS, **(thresholds or {})}
    hint = f" — {context_hint}" if context_hint else ""

    if confidence >= t["proceed"]:
        return BranchResult(
            "proceed", confidence,
            f"Sufficient confidence ({confidence:.2f}) to proceed{hint}",
        )
    if confidence >= t["escalate"]:
        return BranchResult(
            "escalate", confidence,
            f"Low confidence ({confidence:.2f}) — human review recommended{hint}",
            {"threshold_missed": "proceed", "threshold_required": t["proceed"]},
        )
    if confidence >= t["defer"]:
        return BranchResult(
            "defer", confidence,
            f"Very low confidence ({confidence:.2f}) — deferring action{hint}",
            {"threshold_missed": "escalate", "threshold_required": t["escalate"]},
        )
    return BranchResult(
        "skip", confidence,
        f"Insufficient confidence ({confidence:.2f}) — action skipped{hint}",
        {"threshold_missed": "defer", "threshold_required": t["defer"]},
    )


# ─────────────────────────────────────────────────────────────────────────────
# Feature 3: Validation Escalation
# ─────────────────────────────────────────────────────────────────────────────

ESCALATION_BLOCKING_TYPES: frozenset[str] = frozenset({
    "non_ig_sdtm_variable",
    "non_ig_variable",
    "controlled_terminology_violation",
    "required_variable_missing",
    "SD0037",   # Controlled terminology violation
    "SD0001",   # Required variable missing
})

ESCALATION_POLICY_ID = "validation_escalation_v1"


def escalate_findings(
    findings: list[dict[str, Any]],
    blocking_types: frozenset[str] | set[str] | None = None,
    domain: str = "",
) -> dict[str, Any]:
    """Apply validation escalation policy to an agent's list of findings.

    Promotes configured warning types to blocking errors and returns a structured
    escalation report that agents embed in metadata/audit output.

    Returns:
        findings            — list with level/severity corrected for blocking types
        error_count         — final count after escalation
        warning_count       — final count after escalation
        blocking_issues     — subset of blocking-type findings
        validation_passed   — True only when error_count == 0
        escalation_policy   — policy metadata for auditability
    """
    bt = frozenset(blocking_types) if blocking_types is not None else ESCALATION_BLOCKING_TYPES
    processed: list[dict[str, Any]] = []
    escalated_count = 0
    blocking_issues: list[dict[str, Any]] = []

    for finding in (findings or []):
        f = dict(finding)
        issue_type = str(f.get("type") or f.get("rule_id") or "").strip()
        if issue_type in bt:
            if f.get("level") != "error" and f.get("severity") != "ERROR":
                f["level"] = "error"
                f["severity"] = "ERROR"
                escalated_count += 1
            blocking_issues.append(f)
        processed.append(f)

    error_count = sum(
        1 for f in processed
        if (f.get("level") == "error" or f.get("severity") == "ERROR")
    )
    warning_count = sum(
        1 for f in processed
        if (f.get("level") == "warning" or f.get("severity") == "WARNING")
    )

    return {
        "domain": domain,
        "findings": processed,
        "error_count": error_count,
        "warning_count": warning_count,
        "blocking_issues": blocking_issues,
        "validation_passed": error_count == 0,
        "escalation_policy": {
            "policy_id": ESCALATION_POLICY_ID,
            "blocking_issue_types": sorted(bt),
            "escalated_warning_count": escalated_count,
            "blocking_issue_count": len(blocking_issues),
        },
    }


def is_blocked_by_escalation(escalation_result: dict[str, Any]) -> bool:
    """Return True if the escalation policy produced any blocking issues."""
    return len(escalation_result.get("blocking_issues", [])) > 0


def escalation_summary(escalation_result: dict[str, Any]) -> str:
    """Return a one-line human-readable escalation summary for logs/notifications."""
    n = len(escalation_result.get("blocking_issues", []))
    es = escalation_result.get("escalation_policy", {}).get("escalated_warning_count", 0)
    domain = escalation_result.get("domain", "")
    parts: list[str] = []
    if n:
        parts.append(f"{n} blocking issue(s)")
    if es:
        parts.append(f"{es} warning(s) escalated to error")
    if not parts:
        return f"{domain}: all findings within acceptable limits" if domain else "all findings within acceptable limits"
    scope = f"{domain}: " if domain else ""
    return f"{scope}{'; '.join(parts)} (policy={ESCALATION_POLICY_ID})"


# ─────────────────────────────────────────────────────────────────────────────
# Feature 4: Contextual Prompt Injection for HITL
# ─────────────────────────────────────────────────────────────────────────────

def build_hitl_context(
    prior_corrections: list[dict[str, Any]] | None,
    domain: str = "",
    include_rejections: bool = True,
    include_endorsements: bool = True,
) -> str:
    """Build a context block injected into HITL task descriptions/prompts.

    Surfaces prior reviewer corrections, rejections, and endorsements so the
    human reviewer is immediately aware of known patterns and known-bad mappings.
    Returns an empty string when no prior corrections are available.
    """
    corrections = prior_corrections or []
    if not corrections:
        return ""

    prefer = [c for c in corrections if (c.get("action") or "prefer") == "prefer"]
    blocked = [c for c in corrections if c.get("action") in ("block_source", "block_pair")]
    endorsed = [c for c in corrections if c.get("action") == "endorse"]

    lines: list[str] = []
    scope = f" (domain: {domain})" if domain else ""

    if prefer and include_endorsements:
        lines.append(f"PRIOR REVIEWER CORRECTIONS{scope} — apply these preferentially:")
        for c in prefer[:10]:
            src = c.get("source_column") or "?"
            var = c.get("sdtm_variable") or "?"
            desc = c.get("description") or ""
            lines.append(f"  • {src} → {var}{': ' + desc if desc else ''}")

    if blocked and include_rejections:
        lines.append(f"\nKNOWN REJECTED MAPPINGS{scope} — do not approve these:")
        for c in blocked[:10]:
            src = c.get("source_column") or "?"
            var = c.get("sdtm_variable") or ""
            lines.append(f"  ✗ {src}{' → ' + var if var else ''} (rejected by prior reviewer)")

    if endorsed and include_endorsements:
        lines.append(f"\nPREVIOUSLY ENDORSED PATTERNS:")
        for c in endorsed[:5]:
            lines.append(f"  ✓ {c.get('description') or c.get('source_column', '?')}")

    return "\n".join(lines)


def inject_hitl_context_into_description(
    base_description: str,
    prior_corrections: list[dict[str, Any]] | None,
    domain: str = "",
) -> str:
    """Prepend HITL prior-feedback context block to a reviewer task description."""
    ctx = build_hitl_context(prior_corrections, domain=domain)
    if not ctx:
        return base_description
    return f"{ctx}\n\n---\n{base_description}"


def build_hitl_notification_body(
    base_body: str,
    escalation_result: dict[str, Any] | None = None,
    branch_result: "BranchResult | None" = None,
) -> str:
    """Enrich a HITL notification body with escalation and confidence context."""
    parts = [base_body]
    if escalation_result and is_blocked_by_escalation(escalation_result):
        parts.append(f"⚠ Escalation: {escalation_summary(escalation_result)}")
    if branch_result and branch_result.action in ("escalate", "defer"):
        parts.append(f"⚠ Confidence: {branch_result.reason}")
    return " ".join(parts)


# ─────────────────────────────────────────────────────────────────────────────
# Feature 5: Memory Retrieval and Context Building
# ─────────────────────────────────────────────────────────────────────────────

def retrieve_relevant_memories(
    task_type: str,
    context: str,
    memories: list[dict[str, Any]],
    top_k: int = 3,
) -> list[dict[str, Any]]:
    """Score and rank memory items by relevance to the current task context.

    Pure function — no I/O. Agents call this when the runtime has already
    injected memory_context into AgentContext, or as a fallback when the
    memory-engine service is unavailable.

    Scoring heuristic (deterministic, no embedding required):
      • Subject/object text overlap with context terms  (0–0.50)
      • task_type match bonus                           (0–0.25)
      • confidence weight                               (0–0.25)
    Returns top_k memories sorted by score descending.
    """
    if not memories:
        return []

    context_tokens = set(context.lower().split())
    task_lower = task_type.lower()

    scored: list[tuple[float, dict[str, Any]]] = []
    for mem in memories:
        score = 0.0
        # Text overlap
        mem_text = " ".join([
            str(mem.get("subject", "")),
            str(mem.get("predicate", "")),
            str(mem.get("object", "")),
            str(mem.get("context_summary", "")),
            str(mem.get("description", "")),
        ]).lower()
        mem_tokens = set(mem_text.split())
        overlap = len(context_tokens & mem_tokens) / max(len(context_tokens), 1)
        score += min(overlap * 0.50, 0.50)

        # Task type match
        mem_task = str(mem.get("task_type", "")).lower()
        if mem_task and (task_lower in mem_task or mem_task in task_lower):
            score += 0.25

        # Confidence
        conf = float(mem.get("confidence", mem.get("importance", 0.8)))
        score += min(conf * 0.25, 0.25)

        scored.append((score, mem))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [m for _, m in scored[:top_k]]


def build_memory_context_block(
    memory_items: list[dict[str, Any]],
    task_type: str = "",
    include_procedural: bool = True,
) -> str:
    """Format memory items into a structured PRIOR CONTEXT block for LLM prompts.

    Mirrors the style of build_hitl_context() — a clearly delimited block
    agents prepend to their system/user prompt so the LLM sees prior learnings
    before generating output.
    """
    if not memory_items:
        return ""

    episodic = [m for m in memory_items if m.get("memory_type") == "episodic" or "episode_type" in m]
    semantic  = [m for m in memory_items if m.get("memory_type") == "semantic"  or ("subject" in m and "predicate" in m)]
    procedural= [m for m in memory_items if m.get("memory_type") == "procedural" or "steps" in m]
    learnings = [m for m in memory_items if m.get("memory_type") == "learning"  or "learning_type" in m]

    lines: list[str] = []
    scope = f" for {task_type}" if task_type else ""

    if semantic:
        lines.append(f"PRIOR KNOWLEDGE{scope}:")
        for m in semantic[:5]:
            subj = m.get("subject", "?")
            pred = m.get("predicate", "")
            obj  = m.get("object", "?")
            conf = m.get("confidence", 1.0)
            lines.append(f"  • {subj} {pred} {obj} [confidence={conf:.2f}]")

    if learnings:
        gold = [m for m in learnings if m.get("learning_type") == "gold_pattern"]
        anti = [m for m in learnings if m.get("learning_type") == "anti_pattern"]
        if gold:
            lines.append(f"\nGOLD PATTERNS (apply these):")
            for m in gold[:5]:
                lines.append(f"  ✓ {m.get('description', '?')[:200]}")
        if anti:
            lines.append(f"\nANTI-PATTERNS (avoid these):")
            for m in anti[:5]:
                lines.append(f"  ✗ {m.get('description', '?')[:200]}")

    if episodic:
        lines.append(f"\nPRIOR EPISODES:")
        for m in episodic[:3]:
            outcome = m.get("outcome_summary", "?")[:150]
            ep_type = m.get("episode_type", "")
            badge = "✓" if ep_type == "success" else ("✗" if ep_type == "failure" else "~")
            lines.append(f"  {badge} {outcome}")

    if include_procedural and procedural:
        lines.append(f"\nPROCEDURAL GUIDANCE:")
        for m in procedural[:2]:
            lines.append(f"  → {m.get('procedure_name', '?')}: {m.get('expected_outcome', '')[:100]}")

    return "\n".join(lines) if lines else ""


# ─────────────────────────────────────────────────────────────────────────────
# Feature 5b: Terminology Augmentation (wraps Feature 1 for CT codelists)
# ─────────────────────────────────────────────────────────────────────────────

_CODELIST_QUERY_TEMPLATES: dict[str, str] = {
    "AESEV":   "CDISC CT AESEV adverse event severity codelist MILD MODERATE SEVERE controlled terminology",
    "AEOUT":   "CDISC CT AEOUT adverse event outcome codelist RECOVERED FATAL controlled terminology",
    "AEREL":   "CDISC CT AEREL adverse event causality relationship codelist controlled terminology",
    "AEACN":   "CDISC CT AEACN action taken study treatment codelist controlled terminology",
    "SEX":     "CDISC CT SEX gender codelist Male Female Unknown controlled terminology",
    "RACE":    "CDISC CT RACE race codelist controlled terminology",
    "ETHNIC":  "CDISC CT ETHNIC ethnicity codelist Hispanic controlled terminology",
    "EPOCH":   "CDISC CT EPOCH study epoch codelist SCREENING TREATMENT FOLLOW-UP controlled terminology",
    "NY":      "CDISC CT NY yes no response codelist controlled terminology",
    "AGEU":    "CDISC CT AGEU age units codelist YEARS MONTHS DAYS controlled terminology",
    "NCOMPLT": "CDISC CT NCOMPLT not completed reason codelist withdrawal controlled terminology",
    "STENRF":  "CDISC CT STENRF start end relative reference period controlled terminology",
    "CMROUTE": "CDISC CT CMROUTE route of administration codelist ORAL INTRAVENOUS controlled terminology",
}


def augment_terminology_queries(
    base_query: str,
    codelist_codes: list[str],
) -> list[str]:
    """Return base_query plus CT-codelist anchor queries for semantic retrieval.

    Ensures retrieval surfaces codelist definitions so agents can validate
    terminology values without guessing valid codes.
    Extends the same pattern as augment_ig_queries.
    """
    queries = [base_query]
    for code in (codelist_codes or []):
        template = _CODELIST_QUERY_TEMPLATES.get(code.upper().strip())
        if template and template not in queries:
            queries.append(template)
    return queries
