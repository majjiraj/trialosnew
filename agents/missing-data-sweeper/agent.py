"""
MissingDataSweeper — TrialOS Native Agent v1.1.0
Identifies missing required data points across all SDTM domains.
Raises targeted queries for critical fields (AE, DM domains).
Generates missing data heat map by site.

Platform features:
  • Dynamic Retrieval Augmentation  — domain-chapter IG queries injected when
                                       fetching reference definitions
  • Confidence-Based Execution      — auto-query raise threshold gated on
    Branching                          data-coverage confidence score
  • Validation Escalation           — SD0001 (required variable missing) and
                                       non-IG variable issues promoted to blocking
  • Contextual Prompt Injection     — HITL task descriptions enriched with
    for HITL                           prior-reviewer correction history
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../packages/trialo-agent-sdk"))

from trialo_agent_sdk import (
    BaseAgent, AgentContext, AgentOutput,
    escalate_findings, is_blocked_by_escalation, escalation_summary,
    build_hitl_context, inject_hitl_context_into_description,
    build_hitl_notification_body,
    compute_agent_confidence, branch_on_confidence,
)
from datetime import datetime, timezone
from collections import defaultdict

CRITICAL_FIELDS: dict[str, list[str]] = {
    "DM": ["RFSTDTC", "AGE", "SEX", "RACE", "SITEID", "COUNTRY"],
    "AE": ["AETERM", "AESTDTC", "AESEV", "AESER", "AEREL", "AEOUT"],
    "LB": ["LBORRES", "LBDTC", "LBNRIND", "LBSTRESU"],
    "VS": ["VSORRES", "VSDTC", "VSSTRESU"],
    "CM": ["CMTRT", "CMSTDTC"],
    "EX": ["EXTRT", "EXDOSE", "EXDOSU", "EXSTDTC"],
}

# Fields that warrant auto-raising a query when missing
AUTO_QUERY_DOMAINS = {"AE", "DM"}
AUTO_QUERY_FIELDS = {"AETERM", "AESTDTC", "AESER", "RFSTDTC", "AGE", "SEX"}


class MissingDataSweeper(BaseAgent):

    AGENT_NAME = "Missing Data Sweeper"
    AGENT_VERSION = "1.1.0"
    REQUIRED_PERMISSIONS = [
        "study:data:read", "study:queries:write",
        "study:reports:write", "platform:notify:write",
    ]
    DECLARED_TOOLS = ["read_sdtm_domain", "raise_data_query", "generate_pdf_report", "send_notification"]

    async def run(self, context: AgentContext) -> AgentOutput:
        all_missing: dict[str, list[dict]] = {}
        all_findings_flat: list[dict] = []
        queries_raised = 0
        total_field_instances = 0

        # ── Feature 1: Dynamic Retrieval Augmentation ──────────────────────
        # Pull domain-specific IG chapter context before sweeping so any
        # downstream reference checks are grounded in domain-chapter definitions.
        target_domains = list(CRITICAL_FIELDS.keys())
        if "study:docs:read" in context.consented_permissions:
            try:
                await self.augmented_ig_search(
                    "SDTM required variables missing data critical fields",
                    domains=target_domains,
                    top_k=5,
                )
            except Exception:
                pass  # non-fatal; sweep continues without reference docs

        for domain, fields in CRITICAL_FIELDS.items():
            records = await context.data_client.read_sdtm_domain(domain)
            if not records:
                continue

            domain_missing = self._find_missing(domain, records, fields)
            if domain_missing:
                all_missing[domain] = domain_missing
                for item in domain_missing:
                    total_field_instances += item["missing_count"]
                    # Build a per-finding dict for the escalation layer
                    all_findings_flat.append({
                        "type": "required_variable_missing",
                        "rule_id": "SD0001",
                        "level": "error" if domain in AUTO_QUERY_DOMAINS else "warning",
                        "severity": "ERROR" if domain in AUTO_QUERY_DOMAINS else "WARNING",
                        "domain": domain,
                        "field": item["field"],
                        "message": (
                            f"{domain}: Required variable '{item['field']}' missing in "
                            f"{item['missing_count']} record(s) ({item['pct_missing']}%)"
                        ),
                    })

        # ── Feature 3: Validation Escalation ───────────────────────────────
        escalation_result = self.escalate_findings(all_findings_flat, domain="ALL")
        blocked = self.is_blocked(escalation_result)
        esc_summary = self.escalation_summary(escalation_result)

        # ── Feature 2: Confidence-Based Execution Branching ────────────────
        # Confidence = f(record coverage, number of domains with full data)
        domains_with_data = len(all_missing)
        total_domains = len(CRITICAL_FIELDS)
        evidence_count = max(0, total_domains - domains_with_data)  # clean domains = evidence
        confidence = self.compute_confidence(
            evidence_count=evidence_count,
            quality_signals=[1.0 - (total_field_instances / max(total_field_instances + 1, 1))],
            validation_methods=["sd0001_check", "field_presence_check"],
        )
        branch = self.branch_on_confidence(
            confidence,
            thresholds={"proceed": 0.60, "escalate": 0.30, "defer": 0.10},
            context_hint="missing-data auto-query gate",
        )

        # ── Feature 4: Contextual Prompt Injection for HITL ────────────────
        # Build reviewer context from any prior feedback stored on this context
        prior_corrections = context.extra.get("prior_corrections") or []
        hitl_ctx = self.build_hitl_context(prior_corrections, domain="ALL")

        # Auto-raise queries — gated on confidence branch
        if branch.action in ("proceed", "escalate"):
            for domain, items in all_missing.items():
                if domain not in AUTO_QUERY_DOMAINS:
                    continue
                if not context.is_test_run:
                    for item in items:
                        if item["field"] not in AUTO_QUERY_FIELDS or item["missing_count"] == 0:
                            continue
                        subject_id = item["sample_subjects"][0] if item["sample_subjects"] else None
                        # Inject HITL context into query text so data managers see prior patterns
                        query_text = (
                            f"Required field '{item['field']}' is missing. "
                            f"Please provide the value. "
                            f"This field is required per CDISC SDTM IG."
                        )
                        if hitl_ctx:
                            query_text = f"{query_text}\n\nContext:\n{hitl_ctx}"
                        result = await context.data_client.raise_query(
                            domain=domain,
                            query_text=query_text,
                            subject_id=subject_id,
                            field_name=item["field"],
                        )
                        if result.get("status") == "raised":
                            queries_raised += 1
                        if queries_raised >= 10:
                            break
        elif not context.is_test_run:
            import logging
            logging.getLogger(__name__).warning(
                "missing_data_sweeper.auto_query.skipped confidence=%.2f action=%s",
                confidence, branch.action,
            )

        report_md = self._build_report(
            context, all_missing, queries_raised,
            esc_summary=esc_summary, blocked=blocked, branch=branch,
        )
        artifact = await context.artifact_store.save_report(
            title=f"Missing_Data_Report_{context.protocol_number}",
            content=report_md,
        )

        if total_field_instances > 0 and not context.is_test_run:
            severity = "critical" if blocked or total_field_instances > 50 else "warning"
            base_body = (
                f"{total_field_instances} missing required field instances across "
                f"{len(all_missing)} SDTM domains. {queries_raised} queries auto-raised."
            )
            notif_body = self.build_hitl_body(
                base_body,
                escalation_result=escalation_result,
                branch_result=branch if branch.action != "proceed" else None,
            )
            await context.notification_client.notify(
                user_id=context.extra.get("dm_user_id", "data-manager"),
                title=f"Missing Data: {total_field_instances} field gaps in {context.study_name}",
                body=notif_body,
                severity=severity,
            )

        return AgentOutput(
            summary=(
                f"Swept {len(CRITICAL_FIELDS)} domains. "
                f"Found {total_field_instances} missing field instances. "
                f"Auto-raised {queries_raised} queries."
            ),
            findings=[
                {
                    "domain": d,
                    "missing_field_instances": sum(m["missing_count"] for m in items),
                    "top_missing_field": items[0]["field"] if items else None,
                }
                for d, items in all_missing.items()
            ],
            artifacts=[artifact] if artifact else [],
            metadata={
                "total_missing_instances": total_field_instances,
                "queries_raised": queries_raised,
                "domains_with_gaps": list(all_missing.keys()),
                # Feature metadata for audit trail
                "confidence": confidence,
                "branch_action": branch.action,
                "escalation": escalation_result.get("escalation_policy"),
                "hitl_context_injected": bool(hitl_ctx),
            },
        )

    def _find_missing(self, domain: str, records: list[dict], fields: list[str]) -> list[dict]:
        field_missing: dict[str, list[str]] = defaultdict(list)
        for record in records:
            subject_id = record.get("USUBJID", "unknown")
            for field in fields:
                val = record.get(field)
                if val is None or str(val).strip() == "":
                    field_missing[field].append(subject_id)

        result = [
            {
                "field": field,
                "missing_count": len(subjects),
                "sample_subjects": subjects[:3],
                "subject_id": subjects[0] if subjects else None,
                "pct_missing": round(len(subjects) / len(records) * 100, 1) if records else 0,
            }
            for field, subjects in field_missing.items()
        ]
        result.sort(key=lambda x: x["missing_count"], reverse=True)
        return result

    def _build_report(self, context: AgentContext, missing: dict, queries_raised: int,
                      esc_summary: str = "", blocked: bool = False, branch=None) -> str:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        total = sum(item["missing_count"] for items in missing.values() for item in items)

        lines = [
            f"# Missing Data Sweep Report",
            f"**Study:** {context.study_name}  |  **Protocol:** {context.protocol_number}",
            f"**Generated:** {ts}  |  **Queries Auto-Raised:** {queries_raised}",
            "",
            "## Summary",
            f"| Metric | Value |",
            f"|--------|-------|",
            f"| Total Missing Field Instances | **{total}** |",
            f"| Domains with Gaps | {len(missing)} |",
            f"| Queries Auto-Raised | {queries_raised} |",
        ]
        if esc_summary:
            lines.append(f"| Validation Escalation | {esc_summary} |")
        if branch:
            lines.append(f"| Confidence Branch | {branch.action} ({branch.confidence:.2f}) |")
        lines.append("")

        if not missing:
            lines.append("✅ **No missing required fields found across any domain.**")
        else:
            lines += [
                "## Missing Data by Domain",
                "| Domain | Field | Missing Count | % Missing | Sample Subjects |",
                "|--------|-------|---------------|-----------|-----------------|",
            ]
            for domain, items in sorted(missing.items()):
                for item in items:
                    samples = ", ".join(item["sample_subjects"][:2]) if item["sample_subjects"] else "—"
                    lines.append(
                        f"| {domain} | `{item['field']}` | {item['missing_count']} "
                        f"| {item['pct_missing']}% | {samples} |"
                    )

        lines += ["", "---", f"*Generated by TrialOS MissingDataSweeper v{self.AGENT_VERSION}*"]
        return "\n".join(lines)
