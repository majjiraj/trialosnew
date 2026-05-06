"""
ProtocolIntelligence — TrialOS Native Agent v1.0.0
Parses USDM protocol documents: eligibility extraction, endpoint classification,
SNOMED coding, arm comparison, and protocol gap detection.

Platform features:
  • Dynamic Retrieval Augmentation  — IG chapter + USDM section queries
  • Confidence-Based Execution      — <0.70 triggers HITL for protocol review
  • Validation Escalation           — ambiguous eligibility or missing primary endpoint = blocking
  • Contextual Prompt Injection     — HITL descriptions include prior protocol corrections
  • Memory Retrieval                — prior protocol patterns and gold examples injected
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../packages/trialo-agent-sdk"))

import json
import httpx
from trialo_agent_sdk import (
    BaseAgent, AgentContext, AgentOutput,
    escalate_findings, is_blocked_by_escalation, escalation_summary,
    build_hitl_context, inject_hitl_context_into_description, build_hitl_notification_body,
    compute_agent_confidence, branch_on_confidence,
    augment_ig_queries, retrieve_relevant_memories, build_memory_context_block,
)
from datetime import datetime, timezone

STUDY_GRAPH_URL = os.environ.get("STUDY_GRAPH_URL", "http://localhost:8013")
STANDARDS_REGISTRY_URL = os.environ.get("STANDARDS_REGISTRY_URL", "http://localhost:8012")

ENDPOINT_CLASSIFICATION_MAP = {
    "overall survival": "primary_efficacy",
    "progression-free survival": "primary_efficacy",
    "pfs": "primary_efficacy",
    "os": "primary_efficacy",
    "response rate": "secondary_efficacy",
    "orr": "secondary_efficacy",
    "safety": "safety",
    "adverse event": "safety",
    "pharmacokinetic": "exploratory",
    "biomarker": "exploratory",
    "quality of life": "secondary_efficacy",
    "qol": "secondary_efficacy",
}

SNOMED_LOOKUP = {
    "diabetes": "73211009",
    "hypertension": "38341003",
    "cancer": "363346000",
    "pregnancy": "77386006",
    "renal impairment": "723188008",
    "hepatic impairment": "235856003",
    "cardiac": "56265001",
}


class ProtocolIntelligence(BaseAgent):

    AGENT_NAME = "Protocol Intelligence"
    AGENT_VERSION = "1.0.0"
    REQUIRED_PERMISSIONS = [
        "study:data:read", "study:docs:read",
        "study:graph:read", "study:reports:write",
        "platform:notify:write",
    ]
    DECLARED_TOOLS = [
        "read_document", "query_study_design", "recall_memory",
        "validate_controlled_terminology", "generate_pdf_report", "send_notification",
    ]

    async def run(self, context: AgentContext) -> AgentOutput:
        findings: list[dict] = []

        # ── Feature 1: Dynamic Retrieval Augmentation ──────────────────────
        if "study:docs:read" in context.consented_permissions:
            try:
                await self.augmented_ig_search(
                    "protocol eligibility criteria endpoint classification phase arms",
                    domains=["DM", "AE", "EX"],
                    top_k=6,
                )
            except Exception:
                pass

        # ── Feature 5: Memory Retrieval ────────────────────────────────────
        memories = context.extra.get("memory_context", [])
        top_memories = retrieve_relevant_memories("protocol_analysis", context.__dict__, memories, top_k=3)
        memory_block = build_memory_context_block(top_memories, "protocol_analysis") if top_memories else ""

        # Load protocol data from study-graph or context
        protocol_data = context.extra.get("protocol_data") or {}
        study_design = {}
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                resp = await client.get(f"{STUDY_GRAPH_URL}/study/{context.study_id}/design")
                if resp.status_code == 200:
                    study_design = resp.json()
        except Exception:
            pass

        # study-graph /design returns {elements: {arm:[...], epoch:[...], endpoint:[...], ...}}
        # Flatten element groups into a merged dict keyed by USDM class names
        elements_map = study_design.get("elements", {})
        flat_design = {
            "arms":               elements_map.get("arm", []),
            "epochs":             elements_map.get("epoch", []),
            "eligibility_criteria": elements_map.get("eligibility", []),
            "endpoints":          elements_map.get("endpoint", []),
            "activities":         elements_map.get("activity", []),
            "encounters":         elements_map.get("encounter", []),
            "estimands":          elements_map.get("estimand", []),
            "indications":        elements_map.get("indication", []),
            "cohorts":            elements_map.get("cohort", []),
        }
        merged = {**protocol_data, **flat_design}

        # Extract and classify endpoints
        endpoints = merged.get("endpoints", [])
        classified_endpoints = _classify_endpoints(endpoints)
        primary_endpoints = [e for e in classified_endpoints if e["classification"] == "primary_efficacy"]

        if not primary_endpoints:
            findings.append({
                "type": "missing_primary_endpoint",
                "rule_id": "PROT001",
                "level": "error",
                "severity": "ERROR",
                "message": "No primary efficacy endpoint identified in protocol",
            })

        # Extract and validate eligibility criteria
        eligibility = merged.get("eligibility_criteria", merged.get("eligibilityCriteria", []))
        coded_eligibility = _code_eligibility(eligibility)
        ambiguous_criteria = [c for c in coded_eligibility if c.get("ambiguous")]
        for crit in ambiguous_criteria:
            findings.append({
                "type": "ambiguous_eligibility_criterion",
                "rule_id": "PROT002",
                "level": "warning",
                "severity": "WARNING",
                "criterion": crit.get("text", ""),
                "message": f"Eligibility criterion has ambiguous terms: '{crit.get('text', '')[:100]}'",
            })

        # Arm comparison
        arms = merged.get("arms", merged.get("studyArms", []))
        arm_analysis = _analyze_arms(arms)
        if arm_analysis.get("unbalanced"):
            findings.append({
                "type": "unbalanced_arms",
                "rule_id": "PROT003",
                "level": "warning",
                "severity": "WARNING",
                "message": f"Study arms may be unbalanced: {arm_analysis.get('detail')}",
            })

        # Gap detection
        gaps = _detect_protocol_gaps(merged)
        for gap in gaps:
            findings.append({
                "type": "protocol_gap",
                "rule_id": gap["rule_id"],
                "level": gap["level"],
                "severity": gap["level"].upper(),
                "message": gap["message"],
            })

        # ── Feature 3: Validation Escalation ──────────────────────────────
        escalation_result = self.escalate_findings(findings, domain="PROTOCOL")
        blocked = self.is_blocked(escalation_result)
        esc_summary = self.escalation_summary(escalation_result)

        # ── Feature 2: Confidence-Based Execution Branching ────────────────
        evidence_count = len(endpoints) + len(eligibility) + len(arms)
        gap_penalty = len([g for g in findings if g["level"] == "error"]) * 0.1
        confidence = self.compute_confidence(
            evidence_count=evidence_count,
            quality_signals=[max(0.0, 1.0 - gap_penalty),
                             1.0 if primary_endpoints else 0.0],
            validation_methods=["endpoint_classification", "eligibility_coding", "arm_analysis"],
        )
        branch = self.branch_on_confidence(
            confidence,
            thresholds={"proceed": 0.70, "escalate": 0.40, "defer": 0.20},
            context_hint="protocol-intelligence gate",
        )

        # ── Feature 4: Contextual Prompt Injection for HITL ───────────────
        if confidence < 0.70 and not context.is_test_run:
            prior_corrections = context.extra.get("prior_corrections", [])
            hitl_ctx = self.build_hitl_context(prior_corrections, domain="PROTOCOL")
            base_desc = (
                f"Protocol analysis confidence {confidence:.2f}. "
                f"{len(primary_endpoints)} primary endpoint(s), "
                f"{len(ambiguous_criteria)} ambiguous eligibility criteria. "
                f"Please review protocol intelligence findings."
            )
            if memory_block:
                base_desc += f"\n\nPRIOR PATTERNS:\n{memory_block}"
            hitl_desc = inject_hitl_context_into_description(base_desc, hitl_ctx)
            await context.notification_client.notify(
                user_id=context.extra.get("reviewer_id", "protocol-reviewer"),
                title=f"Protocol Review Required: {context.study_name}",
                body=hitl_desc,
                severity="warning",
            )

        report_md = _build_report(
            context, classified_endpoints, coded_eligibility, arm_analysis,
            gaps, confidence, branch, esc_summary,
        )
        artifact = await context.artifact_store.save_report(
            title=f"Protocol_Intelligence_{context.protocol_number}",
            content=report_md,
        )

        return AgentOutput(
            summary=(
                f"Analyzed protocol: {len(classified_endpoints)} endpoints classified, "
                f"{len(coded_eligibility)} eligibility criteria coded, "
                f"{len(arms)} arms analyzed (confidence={confidence:.2f})."
            ),
            findings=findings,
            artifacts=[artifact] if artifact else [],
            metadata={
                "endpoints_classified": len(classified_endpoints),
                "primary_endpoints": len(primary_endpoints),
                "eligibility_criteria": len(coded_eligibility),
                "ambiguous_criteria": len(ambiguous_criteria),
                "arms_analyzed": len(arms),
                "protocol_gaps": len(gaps),
                "confidence": confidence,
                "branch_action": branch.action,
                "blocked": blocked,
                "escalation": escalation_result.get("escalation_policy"),
            },
        )


def _classify_endpoints(endpoints: list) -> list[dict]:
    result = []
    for ep in endpoints:
        text = ""
        if isinstance(ep, dict):
            text = (ep.get("description", "") + " " + ep.get("name", "")).lower()
        elif isinstance(ep, str):
            text = ep.lower()
        classification = "exploratory"
        for keyword, cls in ENDPOINT_CLASSIFICATION_MAP.items():
            if keyword in text:
                classification = cls
                break
        result.append({
            "text": text[:200],
            "classification": classification,
            "raw": ep,
        })
    return result


def _code_eligibility(criteria: list) -> list[dict]:
    result = []
    for crit in criteria:
        text = ""
        if isinstance(crit, dict):
            text = crit.get("criterion", crit.get("text", crit.get("description", "")))
        elif isinstance(crit, str):
            text = crit
        text_lower = text.lower()
        snomed_code = None
        for term, code in SNOMED_LOOKUP.items():
            if term in text_lower:
                snomed_code = code
                break
        ambiguous = any(word in text_lower for word in [
            "may", "possible", "consider", "at discretion", "approximately", "acceptable",
        ])
        result.append({
            "text": text[:300],
            "snomed_code": snomed_code,
            "ambiguous": ambiguous,
            "type": "inclusion" if "inclusion" in text_lower else
                    "exclusion" if "exclusion" in text_lower else "general",
        })
    return result


def _analyze_arms(arms: list) -> dict:
    if not arms:
        return {"count": 0, "unbalanced": False, "detail": "No arms found"}
    arm_names = []
    for arm in arms:
        name = ""
        if isinstance(arm, dict):
            name = arm.get("name", arm.get("armName", ""))
        elif isinstance(arm, str):
            name = arm
        arm_names.append(name)
    has_control = any(
        "placebo" in n.lower() or "control" in n.lower() or "comparator" in n.lower()
        for n in arm_names
    )
    return {
        "count": len(arms),
        "arm_names": arm_names,
        "has_control_arm": has_control,
        "unbalanced": len(arms) == 1,
        "detail": f"{len(arms)} arm(s): {', '.join(arm_names[:3])}",
    }


def _detect_protocol_gaps(data: dict) -> list[dict]:
    gaps = []
    if not data.get("visits") and not data.get("studyVisits"):
        gaps.append({"rule_id": "PROT004", "level": "warning",
                     "message": "No visit schedule defined in protocol"})
    if not data.get("populations") and not data.get("studyPopulations"):
        gaps.append({"rule_id": "PROT005", "level": "warning",
                     "message": "No study population definition found"})
    if not data.get("title") and not data.get("studyTitle"):
        gaps.append({"rule_id": "PROT006", "level": "error",
                     "message": "Protocol title missing"})
    return gaps


def _build_report(context, endpoints, eligibility, arm_analysis, gaps,
                  confidence, branch, esc_summary) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    primary = [e for e in endpoints if e["classification"] == "primary_efficacy"]
    secondary = [e for e in endpoints if e["classification"] == "secondary_efficacy"]
    lines = [
        "# Protocol Intelligence Report",
        f"**Study:** {context.study_name}  |  **Protocol:** {context.protocol_number}",
        f"**Generated:** {ts}",
        "",
        "## Endpoints",
        f"| Type | Count |", f"|------|-------|",
        f"| Primary Efficacy | {len(primary)} |",
        f"| Secondary Efficacy | {len(secondary)} |",
        f"| Exploratory | {len([e for e in endpoints if e['classification'] == 'exploratory'])} |",
        f"| Safety | {len([e for e in endpoints if e['classification'] == 'safety'])} |",
        "",
        "## Eligibility Criteria",
        f"Total: {len(eligibility)}  |  Ambiguous: {len([c for c in eligibility if c.get('ambiguous')])}",
        "",
        f"## Arms: {arm_analysis.get('detail')}",
        f"Control arm present: {'Yes' if arm_analysis.get('has_control_arm') else 'No'}",
    ]
    if gaps:
        lines += ["", "## Protocol Gaps"]
        for g in gaps:
            lines.append(f"- [{g['level'].upper()}] {g['message']}")
    lines += [
        "", f"**Confidence:** {confidence:.2f}  |  **Branch:** {branch.action}",
        esc_summary or "",
        "", "---", f"*Generated by TrialOS ProtocolIntelligence v1.0.0*",
    ]
    return "\n".join(lines)
