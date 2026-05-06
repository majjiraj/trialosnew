"""
ICHM11Validator — TrialOS Native Agent v1.0.0
Validates protocol documents against ICH M11 CeSHarP mandatory structure.
Runs at two trigger points:
  A) After context graph creation for protocol documents
  B) After USDM conversion (study-design-extractor) to check USDM↔M11 alignment

Platform features:
  • Dynamic Retrieval Augmentation  — ICH M11 section guidance from standards-registry
  • Confidence-Based Execution      — <0.70 triggers HITL for protocol reviewer
  • Validation Escalation           — critical missing sections (S04/S05/S06/S08) = blocking
  • Contextual Prompt Injection     — HITL description enriched with prior review corrections
  • Memory Retrieval                — prior validation patterns and known exceptions
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
STUDY_GRAPH_URL        = os.environ.get("STUDY_GRAPH_URL",         "http://localhost:8013")
AGENT_RUNTIME_URL      = os.environ.get("AGENT_RUNTIME_URL",       "http://localhost:8004")

# ICH M11 sections that are CRITICAL — their absence blocks proceeding
CRITICAL_SECTION_IDS = {"S01", "S02", "S03", "S04", "S05", "S06", "S08", "S09", "S12"}


class ICHM11Validator(BaseAgent):

    AGENT_NAME    = "ICH M11 Validator"
    AGENT_VERSION = "1.0.0"
    REQUIRED_PERMISSIONS = [
        "study:data:read", "study:docs:read",
        "study:reports:write", "platform:notify:write", "standards:read",
    ]
    DECLARED_TOOLS = [
        "read_document", "validate_ich_m11_structure",
        "generate_pdf_report", "send_notification",
    ]

    async def run(self, context: AgentContext) -> AgentOutput:
        findings: list[dict] = []

        # ── Feature 1: Dynamic Retrieval Augmentation ──────────────────────
        if "study:docs:read" in context.consented_permissions:
            try:
                await self.augmented_ig_search(
                    "ICH M11 CeSHarP protocol mandatory sections structure objectives "
                    "eligibility criteria study design schedule of activities safety reporting",
                    domains=["TS", "TI", "TV", "TA"],
                    top_k=6,
                )
            except Exception:
                pass

        # ── Feature 5: Memory Retrieval ────────────────────────────────────
        memories = context.extra.get("memory_context", [])
        top_memories = retrieve_relevant_memories("ich_m11_validation", context.__dict__, memories, top_k=3)
        memory_block = build_memory_context_block(top_memories, "ich_m11_validation") if top_memories else ""

        # ── Load inputs ────────────────────────────────────────────────────
        protocol_text       = context.extra.get("protocol_text", "")
        structured_sections = context.extra.get("structured_sections", {})
        usdm_data           = context.extra.get("usdm_data")

        # Fetch protocol text from study-graph / documents if not provided
        if not protocol_text and context.study_id:
            try:
                async with httpx.AsyncClient(timeout=20) as client:
                    resp = await client.get(
                        f"{AGENT_RUNTIME_URL}/documents",
                        params={"study_id": context.study_id, "doc_type": "protocol", "limit": 1},
                    )
                    if resp.status_code == 200:
                        docs = resp.json().get("documents", [])
                        if docs:
                            protocol_text = docs[0].get("content", "")
            except Exception:
                pass

        # Fetch USDM data from study-graph if not provided directly
        if not usdm_data and context.study_id:
            try:
                async with httpx.AsyncClient(timeout=15) as client:
                    resp = await client.get(f"{STUDY_GRAPH_URL}/study/{context.study_id}/design")
                    if resp.status_code == 200:
                        design_data = resp.json()
                        usdm_data = {"elements": design_data.get("elements", {})}
            except Exception:
                pass

        # ── Phase A + B: Call standards-registry validation ────────────────
        validation_result: dict = {}
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{STANDARDS_REGISTRY_URL}/ich-m11/validate",
                    json={
                        "protocol_text":       protocol_text[:20000] if protocol_text else None,
                        "structured_sections": structured_sections,
                        "usdm_data":           usdm_data,
                    },
                )
                if resp.status_code == 200:
                    validation_result = resp.json()
        except Exception as exc:
            findings.append({
                "type": "validation_service_unavailable",
                "rule_id": "M11-SVC",
                "level": "warning",
                "severity": "WARNING",
                "message": f"Standards-registry unavailable; M11 validation skipped: {exc}",
            })

        score           = validation_result.get("score", 0)
        vf              = validation_result.get("findings", [])
        sections_present = validation_result.get("sections_present", {})
        usdm_coverage   = validation_result.get("usdm_coverage", {})

        # Translate validation findings into agent findings
        for vfinding in vf:
            sid      = vfinding.get("section_id", "")
            severity = vfinding.get("severity", "major").lower()
            level    = "error" if severity == "critical" else "warning"
            findings.append({
                "type": "ich_m11_section_issue",
                "rule_id": f"M11-{sid}",
                "level": level,
                "severity": level.upper(),
                "section_id": sid,
                "message": vfinding.get("message", ""),
            })

        # ── Feature 3: Validation Escalation ──────────────────────────────
        blocking_types = frozenset(f"ich_m11_section_issue" for _ in CRITICAL_SECTION_IDS)
        critical_findings = [f for f in findings
                             if f.get("level") == "error"
                             and f.get("section_id") in CRITICAL_SECTION_IDS]
        # Escalate critical findings explicitly
        escalation_input = critical_findings + [f for f in findings if f.get("level") == "error"]
        escalation_result = self.escalate_findings(escalation_input, domain="PROTOCOL")
        blocked = self.is_blocked(escalation_result)
        esc_summary = self.escalation_summary(escalation_result)

        # ── Feature 2: Confidence-Based Execution Branching ────────────────
        sections_found = sum(1 for v in sections_present.values() if v == "found")
        total_sections = len(sections_present) or 14
        coverage_ratio = sections_found / total_sections
        confidence = self.compute_confidence(
            evidence_count=len(vf) + (1 if protocol_text else 0) + (1 if usdm_data else 0),
            quality_signals=[coverage_ratio, score / 100.0],
            validation_methods=["ich_m11_section_check", "usdm_alignment_check"],
        )
        branch = self.branch_on_confidence(
            confidence,
            thresholds={"proceed": 0.70, "escalate": 0.40, "defer": 0.20},
            context_hint="ICH M11 validation gate",
        )

        # ── Feature 4: Contextual Prompt Injection for HITL ───────────────
        missing_critical = [f["section_id"] for f in findings
                            if f.get("level") == "error"
                            and f.get("section_id") in CRITICAL_SECTION_IDS]
        if missing_critical or confidence < 0.70:
            prior_corrections = context.extra.get("prior_corrections", [])
            hitl_ctx = self.build_hitl_context(prior_corrections, domain="PROTOCOL")
            base_desc = (
                f"ICH M11 score: {score}/100. "
                f"Sections found: {sections_found}/{total_sections}. "
                f"Critical sections missing: {missing_critical}. "
                f"USDM coverage: {list(usdm_coverage.keys())}. "
                f"Please review and complete missing protocol sections."
            )
            if memory_block:
                base_desc += f"\n\nPRIOR VALIDATION CONTEXT:\n{memory_block}"
            hitl_desc = inject_hitl_context_into_description(base_desc, hitl_ctx)
            if not context.is_test_run:
                await context.notification_client.notify(
                    user_id=context.extra.get("reviewer_id", "protocol-reviewer"),
                    title=f"ICH M11 Review Required: {context.study_name}",
                    body=hitl_desc,
                    severity="error" if missing_critical else "warning",
                )

        report_md = _build_report(context, score, sections_present, usdm_coverage,
                                  findings, confidence, branch, esc_summary)
        artifact = await context.artifact_store.save_report(
            title=f"ICHM11_Validation_{context.protocol_number}",
            content=report_md,
        )

        return AgentOutput(
            summary=(
                f"ICH M11 score: {score}/100. "
                f"Sections: {sections_found}/{total_sections} found. "
                f"Critical missing: {len(missing_critical)}. "
                f"Confidence: {confidence:.2f}."
            ),
            findings=findings,
            artifacts=[artifact] if artifact else [],
            metadata={
                "ich_m11_score":       score,
                "conformant":          validation_result.get("conformant", False),
                "sections_found":      sections_found,
                "sections_total":      total_sections,
                "missing_critical":    missing_critical,
                "usdm_covered":        [k for k, v in usdm_coverage.items() if v],
                "sections_present":    sections_present,
                "confidence":          confidence,
                "branch_action":       branch.action,
                "blocked":             blocked,
                "escalation":          escalation_result.get("escalation_policy"),
            },
        )


def _build_report(context, score, sections_present, usdm_coverage, findings, confidence, branch, esc_summary) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    status_icon = {
        "found":   "✅",
        "partial": "⚠️",
        "missing": "❌",
        "unknown": "—",
    }
    lines = [
        "# ICH M11 CeSHarP Validation Report",
        f"**Study:** {context.study_name}  |  **Protocol:** {context.protocol_number}",
        f"**Generated:** {ts}",
        "",
        f"## Overall Score: **{score}/100**",
        f"**Standard:** ICH M11 v2 (CeSHarP 2024)  |  "
        f"**Conformant:** {'Yes' if score >= 80 else 'No'}",
        "",
        "## Section-by-Section Status",
        "| ID | Section | Status | USDM Covered |",
        "|----|---------|--------|-------------|",
    ]
    _SECTION_TITLES = {
        "S01": "General Information", "S02": "Protocol Summary",
        "S03": "Background and Rationale", "S04": "Objectives and Estimands",
        "S05": "Eligibility Criteria", "S06": "Study Design",
        "S07": "Study Interventions", "S08": "Schedule of Activities",
        "S09": "Statistical Considerations", "S10": "Data Management",
        "S11": "Monitoring", "S12": "Safety Reporting",
        "S13": "Ethical Considerations", "S14": "Supporting Documentation",
    }
    for sec in [{"id": f"S{i:02d}"} for i in range(1, 15)]:
        sid = sec["id"]
        status = sections_present.get(sid, "unknown")
        usdm_ok = "✅" if usdm_coverage.get(sid) else "—"
        icon = status_icon.get(status, "—")
        title = _SECTION_TITLES.get(sid, "—")
        lines.append(f"| {sid} | {title} | {icon} {status} | {usdm_ok} |")
    if findings:
        lines += ["", "## Findings"]
        for f in findings[:20]:
            marker = "❌" if f["level"] == "error" else "⚠️"
            lines.append(f"- {marker} [{f.get('section_id', '')}] {f['message']}")
    lines += [
        "",
        f"**Confidence:** {confidence:.2f}  |  **Branch:** {branch.action}",
        esc_summary or "",
        "", "---", "*Generated by TrialOS ICH M11 Validator v1.0.0*",
    ]
    return "\n".join(lines)
