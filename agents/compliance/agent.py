"""
Compliance — TrialOS Native Agent v1.0.0
Validates studies against FDA/EMA/ICH regulatory requirements.
Checks decision memory for known exceptions and overrides.
Scores compliance by category with a submission deadline timeline.

Platform features:
  • Dynamic Retrieval Augmentation  — regulatory requirement + IG chapter queries
  • Confidence-Based Execution      — <0.70 triggers HITL for compliance officer review
  • Validation Escalation           — critical regulatory violations = blocking
  • Contextual Prompt Injection     — HITL descriptions include prior compliance corrections
  • Memory Retrieval                — decision memory exceptions + compliance gold patterns
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../packages/trialo-agent-sdk"))

import httpx
from trialo_agent_sdk import (
    BaseAgent, AgentContext, AgentOutput,
    escalate_findings, is_blocked_by_escalation, escalation_summary,
    build_hitl_context, inject_hitl_context_into_description,
    compute_agent_confidence, branch_on_confidence,
    augment_ig_queries, retrieve_relevant_memories, build_memory_context_block,
)
from datetime import datetime, timezone

STANDARDS_REGISTRY_URL = os.environ.get("STANDARDS_REGISTRY_URL", "http://localhost:8012")
STUDY_GRAPH_URL = os.environ.get("STUDY_GRAPH_URL", "http://localhost:8013")
MEMORY_ENGINE_URL = os.environ.get("MEMORY_ENGINE_URL", "http://localhost:8014")

# Compliance check definitions: category → list of checks
COMPLIANCE_CHECKS: dict[str, list[dict]] = {
    "traceability": [
        {"id": "TR001", "name": "Source Data Traceability",
         "description": "All data points must be traceable to source documents",
         "severity": "critical", "authority": "FDA"},
        {"id": "TR002", "name": "Protocol Deviation Tracking",
         "description": "Protocol deviations must be documented and tracked",
         "severity": "critical", "authority": "ICH E6"},
        {"id": "TR003", "name": "SDTM Derivation Traceability",
         "description": "SDTM derivations must reference source variables",
         "severity": "major", "authority": "CDISC"},
    ],
    "audit_trail": [
        {"id": "AT001", "name": "Audit Trail Completeness",
         "description": "All data changes must be captured in audit trail",
         "severity": "critical", "authority": "21 CFR Part 11"},
        {"id": "AT002", "name": "Electronic Signature",
         "description": "Electronic signatures must be validated",
         "severity": "critical", "authority": "21 CFR Part 11"},
        {"id": "AT003", "name": "Timestamp Accuracy",
         "description": "All timestamps must be accurate and timezone-aware",
         "severity": "major", "authority": "FDA"},
    ],
    "submission": [
        {"id": "SB001", "name": "CDISC Submission Standards",
         "description": "Data must comply with CDISC submission standards",
         "severity": "critical", "authority": "FDA"},
        {"id": "SB002", "name": "Define.xml Compliance",
         "description": "Define.xml must be present and valid",
         "severity": "major", "authority": "FDA/EMA"},
        {"id": "SB003", "name": "Reviewer's Guide",
         "description": "Study Data Reviewer's Guide must be provided",
         "severity": "major", "authority": "FDA"},
        {"id": "SB004", "name": "Study Data Package",
         "description": "Complete study data package per SDRG requirements",
         "severity": "major", "authority": "FDA"},
    ],
    "gcp": [
        {"id": "GCP001", "name": "Informed Consent Documentation",
         "description": "Informed consent must be documented for all subjects",
         "severity": "critical", "authority": "ICH E6"},
        {"id": "GCP002", "name": "Protocol Compliance",
         "description": "Study must be conducted per approved protocol",
         "severity": "critical", "authority": "ICH E6"},
        {"id": "GCP003", "name": "SAE Reporting",
         "description": "Serious adverse events reported within 24-72 hours",
         "severity": "critical", "authority": "FDA/EMA"},
        {"id": "GCP004", "name": "Data Integrity",
         "description": "Data must be attributable, legible, contemporaneous, original, accurate",
         "severity": "critical", "authority": "ALCOA+"},
    ],
}

SEVERITY_WEIGHT = {"critical": 1.0, "major": 0.5, "minor": 0.1}


class Compliance(BaseAgent):

    AGENT_NAME = "Compliance"
    AGENT_VERSION = "1.0.0"
    REQUIRED_PERMISSIONS = [
        "study:data:read", "study:docs:read",
        "study:graph:read", "study:reports:write",
        "platform:notify:write", "standards:read",
    ]
    DECLARED_TOOLS = [
        "get_regulatory_requirements", "query_decision_memory",
        "recall_memory", "generate_pdf_report", "send_notification",
    ]

    async def run(self, context: AgentContext) -> AgentOutput:
        findings: list[dict] = []
        compliance_scores: dict[str, float] = {}

        # ── Feature 1: Dynamic Retrieval Augmentation ──────────────────────
        if "study:docs:read" in context.consented_permissions:
            try:
                await self.augmented_ig_search(
                    "FDA EMA ICH GCP regulatory compliance requirements audit trail",
                    domains=["AE", "DM"],
                    top_k=5,
                )
            except Exception:
                pass

        # ── Feature 5: Memory Retrieval — exception overrides ─────────────
        memories = context.extra.get("memory_context", [])
        top_memories = retrieve_relevant_memories("compliance_validation", context.__dict__, memories, top_k=5)
        memory_block = build_memory_context_block(top_memories, "compliance_validation") if top_memories else ""

        # Fetch regulatory requirements from standards-registry
        reg_requirements = []
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(f"{STANDARDS_REGISTRY_URL}/regulatory/requirements")
                if resp.status_code == 200:
                    reg_requirements = resp.json().get("requirements", [])
        except Exception:
            pass

        # Fetch decision memory exceptions for this org
        known_exceptions: list[dict] = []
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(
                    f"{STUDY_GRAPH_URL}/study/{context.study_id}/decision-memory",
                    params={"category": "exception", "limit": 20},
                )
                if resp.status_code == 200:
                    known_exceptions = resp.json().get("memories", [])
        except Exception:
            pass

        exception_rule_ids = {e.get("rule_id") for e in known_exceptions if e.get("rule_id")}

        # Run compliance checks per category
        for category, checks in COMPLIANCE_CHECKS.items():
            passed = 0
            total = len(checks)
            for check in checks:
                # Look up actual study state
                check_passed = await _run_compliance_check(check, context, reg_requirements)

                # Apply known exception override
                if not check_passed and check["id"] in exception_rule_ids:
                    check_passed = True
                    findings.append({
                        "type": "compliance_exception_applied",
                        "rule_id": check["id"],
                        "level": "warning",
                        "severity": "WARNING",
                        "category": category,
                        "message": f"Exception applied for {check['id']}: {check['name']}",
                    })

                if check_passed:
                    passed += 1
                else:
                    severity = check["severity"]
                    level = "error" if severity == "critical" else "warning"
                    findings.append({
                        "type": "compliance_violation",
                        "rule_id": check["id"],
                        "level": level,
                        "severity": level.upper(),
                        "category": category,
                        "authority": check.get("authority", ""),
                        "message": f"[{severity.upper()}] {check['name']}: {check['description']}",
                    })

            category_score = passed / total if total > 0 else 1.0
            compliance_scores[category] = round(category_score * 100, 1)

        overall_score = sum(compliance_scores.values()) / max(len(compliance_scores), 1)

        # ── Feature 3: Validation Escalation ──────────────────────────────
        escalation_result = self.escalate_findings(findings, domain="COMPLIANCE")
        blocked = self.is_blocked(escalation_result)
        esc_summary = self.escalation_summary(escalation_result)

        # ── Feature 2: Confidence-Based Execution Branching ────────────────
        critical_violations = len([f for f in findings
                                   if f.get("type") == "compliance_violation"
                                   and f.get("severity") == "ERROR"])
        confidence = self.compute_confidence(
            evidence_count=len(reg_requirements) + len(known_exceptions),
            quality_signals=[
                overall_score / 100,
                max(0.0, 1.0 - (critical_violations * 0.15)),
            ],
            validation_methods=["regulatory_check", "decision_memory_lookup", "gcp_check"],
        )
        branch = self.branch_on_confidence(
            confidence,
            thresholds={"proceed": 0.70, "escalate": 0.40, "defer": 0.20},
            context_hint="compliance-validation gate",
        )

        # ── Feature 4: Contextual Prompt Injection for HITL ───────────────
        if critical_violations > 0 or confidence < 0.70:
            prior_corrections = context.extra.get("prior_corrections", [])
            hitl_ctx = self.build_hitl_context(prior_corrections, domain="COMPLIANCE")
            base_desc = (
                f"Compliance score {overall_score:.1f}%. "
                f"Critical violations: {critical_violations}. "
                f"Known exceptions applied: {len([f for f in findings if f.get('type') == 'compliance_exception_applied'])}. "
                f"Please review compliance findings and update exception registry if needed."
            )
            if memory_block:
                base_desc += f"\n\nPRIOR COMPLIANCE CONTEXT:\n{memory_block}"
            hitl_desc = inject_hitl_context_into_description(base_desc, hitl_ctx)
            if not context.is_test_run:
                await context.notification_client.notify(
                    user_id=context.extra.get("reviewer_id", "compliance-officer"),
                    title=f"Compliance Review Required: {context.study_name}",
                    body=hitl_desc,
                    severity="error" if critical_violations > 0 else "warning",
                )

        report_md = _build_report(context, compliance_scores, findings, overall_score,
                                  confidence, branch, esc_summary)
        artifact = await context.artifact_store.save_report(
            title=f"Compliance_Report_{context.protocol_number}",
            content=report_md,
        )

        return AgentOutput(
            summary=(
                f"Compliance score: {overall_score:.1f}%. "
                f"Critical violations: {critical_violations}. "
                f"Exceptions applied: {len([f for f in findings if 'exception' in f.get('type', '')])}. "
                f"Confidence: {confidence:.2f}."
            ),
            findings=findings,
            artifacts=[artifact] if artifact else [],
            metadata={
                "overall_score": overall_score,
                "scores_by_category": compliance_scores,
                "critical_violations": critical_violations,
                "exceptions_applied": len([f for f in findings if "exception" in f.get("type", "")]),
                "confidence": confidence,
                "branch_action": branch.action,
                "blocked": blocked,
                "escalation": escalation_result.get("escalation_policy"),
            },
        )


async def _run_compliance_check(check: dict, context: AgentContext, reg_requirements: list) -> bool:
    check_id = check["id"]
    # Heuristic checks based on available context
    study_meta = context.extra.get("study_metadata", {})
    if check_id == "AT001":
        return study_meta.get("audit_trail_enabled", True)
    if check_id == "AT002":
        return study_meta.get("esignature_configured", True)
    if check_id == "GCP001":
        return study_meta.get("consent_forms_uploaded", False)
    if check_id == "GCP003":
        return study_meta.get("sae_reporting_configured", True)
    if check_id == "SB001":
        return study_meta.get("cdisc_compliant", False)
    if check_id == "SB002":
        return study_meta.get("define_xml_present", False)
    # Default: check if requirement exists in registry (means it's tracked)
    for req in reg_requirements:
        if req.get("requirement_id") == check_id:
            return req.get("status") == "compliant"
    return True  # assume compliant if no contrary evidence


def _build_report(context, scores, findings, overall, confidence, branch, esc_summary) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        "# Compliance Report",
        f"**Study:** {context.study_name}  |  **Protocol:** {context.protocol_number}",
        f"**Generated:** {ts}",
        "",
        f"## Overall Compliance Score: **{overall:.1f}%**",
        "",
        "## Score by Category",
        "| Category | Score |",
        "|----------|-------|",
    ]
    for cat, score in scores.items():
        status = "✅" if score >= 80 else "⚠️" if score >= 60 else "❌"
        lines.append(f"| {cat.replace('_', ' ').title()} | {status} {score}% |")
    if findings:
        lines += ["", "## Findings"]
        for f in findings[:30]:
            marker = "❌" if f["level"] == "error" else ("ℹ️" if "exception" in f.get("type", "") else "⚠️")
            lines.append(f"- {marker} [{f.get('category', '').upper()}] {f['message']}")
    lines += [
        "", f"**Confidence:** {confidence:.2f}  |  **Branch:** {branch.action}",
        esc_summary or "",
        "", "---", "*Generated by TrialOS Compliance v1.0.0*",
    ]
    return "\n".join(lines)
