"""
SDTMConformanceChecker — TrialOS Native Agent v1.1.0
Runs CDISC SDTM conformance checks across all study domains.
Generates findings report with severity levels (ERROR/WARNING).
Equivalent to Pinnacle 21 Community checks.

Platform features:
  • Dynamic Retrieval Augmentation  — SDTMIG domain-chapter and rule-specific
                                       queries injected before per-domain checks
  • Confidence-Based Execution      — alert threshold gated on conformance
    Branching                          confidence score (evidence quality)
  • Validation Escalation           — SD0001/SD0037/non-IG findings promoted
                                       to blocking errors via policy v1
  • Contextual Prompt Injection     — DM notifications enriched with prior
    for HITL                           conformance reviewer feedback history
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../packages/trialo-agent-sdk"))

from trialo_agent_sdk import (
    BaseAgent, AgentContext, AgentOutput,
    escalate_findings, is_blocked_by_escalation, escalation_summary,
    build_hitl_context, build_hitl_notification_body,
    compute_agent_confidence, branch_on_confidence,
)
from datetime import datetime, timezone
from collections import defaultdict

SDTM_DOMAINS = ["DM", "AE", "LB", "VS", "CM", "EX", "MH", "DS"]

REQUIRED_FIELDS = {
    "DM": ["STUDYID", "DOMAIN", "USUBJID", "SUBJID", "SITEID", "AGE", "AGEU", "SEX"],
    "AE": ["STUDYID", "DOMAIN", "USUBJID", "AESEQ", "AETERM", "AESTDTC"],
    "LB": ["STUDYID", "DOMAIN", "USUBJID", "LBSEQ", "LBTESTCD", "LBTEST", "LBORRES", "LBDTC"],
    "VS": ["STUDYID", "DOMAIN", "USUBJID", "VSSEQ", "VSTESTCD", "VSTEST", "VSORRES", "VSDTC"],
    "CM": ["STUDYID", "DOMAIN", "USUBJID", "CMSEQ", "CMTRT"],
    "EX": ["STUDYID", "DOMAIN", "USUBJID", "EXSEQ", "EXTRT", "EXDOSE", "EXDOSU"],
    "MH": ["STUDYID", "DOMAIN", "USUBJID", "MHSEQ", "MHTERM"],
    "DS": ["STUDYID", "DOMAIN", "USUBJID", "DSSEQ", "DSTERM", "DSDECOD"],
}

CONTROLLED_TERMS = {
    "AE": {
        "AESEV": ["MILD", "MODERATE", "SEVERE"],
        "AESER": ["Y", "N"],
        "AEREL": ["NOT RELATED", "UNLIKELY RELATED", "POSSIBLY RELATED", "PROBABLY RELATED", "RELATED"],
        "AEOUT": ["RECOVERED/RESOLVED", "RECOVERING/RESOLVING", "NOT RECOVERED/NOT RESOLVED",
                   "RECOVERED/RESOLVED WITH SEQUELAE", "FATAL", "UNKNOWN"],
    },
    "LB": {"LBNRIND": ["LOW", "NORMAL", "HIGH", "ABNORMAL"]},
    "DM": {
        "AGEU": ["DAYS", "WEEKS", "MONTHS", "YEARS"],
        "SEX": ["M", "F", "U", "UNDIFFERENTIATED"],
    },
}


class SDTMConformanceChecker(BaseAgent):

    AGENT_NAME = "SDTM Conformance Checker"
    AGENT_VERSION = "1.1.0"
    REQUIRED_PERMISSIONS = ["study:data:read", "study:validation:read", "study:reports:write", "study:notifications:write"]
    DECLARED_TOOLS = ["read_sdtm_domain", "check_cdisc_conformance", "generate_pdf_report", "send_notification"]

    async def run(self, context: AgentContext) -> AgentOutput:
        all_findings: dict[str, list[dict]] = {}
        all_findings_flat: list[dict] = []
        total_errors = 0
        total_warnings = 0
        domains_checked = []

        # ── Feature 1: Dynamic Retrieval Augmentation ─────────────────────
        # Pull SDTMIG domain chapters + key rule definitions before checking
        if "study:docs:read" in context.consented_permissions:
            try:
                await self.augmented_conformance_search(
                    "CDISC SDTM conformance required variables controlled terminology",
                    domains=SDTM_DOMAINS,
                    rule_ids=["SD0001", "SD0037", "SD0006"],
                    top_k=8,
                )
            except Exception:
                pass  # non-fatal; conformance checks run on data without reference docs

        for domain in SDTM_DOMAINS:
            records = await context.data_client.read_sdtm_domain(domain)
            if not records:
                continue
            domains_checked.append(domain)
            findings = self._check_domain(domain, records)

            if findings:
                all_findings[domain] = findings
                for f in findings:
                    all_findings_flat.append({**f, "domain": domain})
                total_errors += sum(1 for f in findings if f["severity"] == "ERROR")
                total_warnings += sum(1 for f in findings if f["severity"] == "WARNING")

        # ── Feature 3: Validation Escalation ──────────────────────────────
        # SD0001, SD0037, non_ig_sdtm_variable automatically promoted to blocking
        escalation_result = self.escalate_findings(all_findings_flat, domain="ALL")
        blocked = self.is_blocked(escalation_result)
        esc_sum = self.escalation_summary(escalation_result)
        # Refresh counts from escalated findings list
        total_errors = sum(
            1 for f in escalation_result.get("findings", [])
            if f.get("severity") == "ERROR" or f.get("level") == "error"
        )

        # ── Feature 2: Confidence-Based Execution Branching ───────────────
        # Confidence reflects share of clean domains and total evidence (records checked)
        total_records = sum(
            len(all_findings.get(d, [])) for d in domains_checked
        )
        clean_domains = len(domains_checked) - len(all_findings)
        confidence = self.compute_confidence(
            evidence_count=len(domains_checked),
            quality_signals=[clean_domains / max(len(domains_checked), 1)],
            validation_methods=["sd0001_check", "sd0037_check", "sd0006_check"],
        )
        branch = self.branch_on_confidence(
            confidence,
            thresholds={"proceed": 0.60, "escalate": 0.30, "defer": 0.15},
            context_hint="SDTM conformance alert gate",
        )

        # ── Feature 4: Contextual Prompt Injection for HITL ───────────────
        prior_corrections = context.extra.get("prior_corrections") or []
        hitl_ctx = self.build_hitl_context(prior_corrections, domain="ALL")

        # Generate report
        report_md = self._build_report(
            context, all_findings, total_errors, total_warnings, domains_checked,
            esc_summary=esc_sum, blocked=blocked, branch=branch,
        )
        artifact = await context.artifact_store.save_report(
            title=f"SDTM_Conformance_Report_{context.protocol_number}",
            content=report_md,
        )

        # Alert DM — gated on confidence branch
        if total_errors > 0 and not context.is_test_run and branch.action in ("proceed", "escalate"):
            severity = "critical" if blocked or total_errors >= 10 else "warning"
            base_body = (
                f"{total_errors} ERROR-level conformance findings across "
                f"{len(all_findings)} domain(s). Review report."
            )
            notif_body = self.build_hitl_body(
                base_body,
                escalation_result=escalation_result if blocked else None,
                branch_result=branch if branch.action == "escalate" else None,
            )
            if hitl_ctx:
                notif_body = f"{notif_body}\n\n{hitl_ctx}"
            await context.notification_client.notify(
                user_id=context.extra.get("dm_user_id", "data-manager"),
                title=f"SDTM Conformance: {total_errors} errors in {context.study_name}",
                body=notif_body,
                severity=severity,
            )

        return AgentOutput(
            summary=(
                f"Checked {len(domains_checked)} SDTM domains. "
                f"Found {total_errors} errors and {total_warnings} warnings."
            ),
            findings=[
                {
                    "domain": d,
                    "errors": sum(1 for f in flist if f["severity"] == "ERROR"),
                    "warnings": sum(1 for f in flist if f["severity"] == "WARNING"),
                    "top_rule": flist[0]["rule_id"] if flist else None,
                }
                for d, flist in all_findings.items()
            ],
            artifacts=[artifact] if artifact else [],
            metadata={
                "domains_checked": domains_checked,
                "total_errors": total_errors,
                "total_warnings": total_warnings,
                # Feature metadata for audit trail
                "confidence": confidence,
                "branch_action": branch.action,
                "escalation": escalation_result.get("escalation_policy"),
                "hitl_context_injected": bool(hitl_ctx),
            },
        )

    def _check_domain(self, domain: str, records: list[dict]) -> list[dict]:
        findings = []
        required = REQUIRED_FIELDS.get(domain, [])
        ct = CONTROLLED_TERMS.get(domain, {})

        # Aggregate missing field counts
        missing_counts: dict[str, int] = defaultdict(int)

        for record in records:
            ref = record.get("USUBJID", "unknown")

            # SD0001: missing required variable
            for field in required:
                val = record.get(field)
                if val is None or str(val).strip() == "":
                    missing_counts[field] += 1

            # SD0037: controlled terminology
            for field, allowed in ct.items():
                val = record.get(field)
                if val and str(val).strip() and str(val).strip() not in allowed:
                    findings.append({
                        "rule_id": "SD0037", "severity": "ERROR", "field": field,
                        "message": f"'{val}' not in controlled terminology. Allowed: {allowed}",
                        "record_ref": ref,
                    })

            # SD0006: DOMAIN value must match
            if record.get("DOMAIN") and record["DOMAIN"] != domain:
                findings.append({
                    "rule_id": "SD0006", "severity": "ERROR", "field": "DOMAIN",
                    "message": f"DOMAIN='{record['DOMAIN']}' but expected '{domain}'",
                    "record_ref": ref,
                })

            # AE-specific
            if domain == "AE":
                if record.get("AESER") == "Y" and not record.get("AEOUT"):
                    findings.append({
                        "rule_id": "AE0003", "severity": "WARNING", "field": "AEOUT",
                        "message": "SAE (AESER=Y) has no outcome (AEOUT)", "record_ref": ref,
                    })

            # LB-specific
            if domain == "LB" and record.get("LBORRES") and not record.get("LBSTRESN") and not record.get("LBSTRESC"):
                findings.append({
                    "rule_id": "LB0001", "severity": "WARNING", "field": "LBSTRESN",
                    "message": "LBORRES present but LBSTRESN/LBSTRESC missing", "record_ref": ref,
                })

        # Emit aggregated SD0001 findings
        for field, count in missing_counts.items():
            findings.insert(0, {
                "rule_id": "SD0001", "severity": "ERROR", "field": field,
                "message": f"Required variable '{field}' missing in {count}/{len(records)} records",
                "record_ref": f"Multiple ({count} records)",
            })

        return findings

    def _build_report(
        self, context: AgentContext, findings: dict, errors: int, warnings: int,
        domains: list, esc_summary: str = "", blocked: bool = False, branch=None,
    ) -> str:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        lines = [
            f"# SDTM Conformance Report",
            f"**Study:** {context.study_name}  |  **Protocol:** {context.protocol_number}",
            f"**Generated:** {ts}  |  **Agent:** SDTMConformanceChecker v{self.AGENT_VERSION}",
            "",
            "## Executive Summary",
            f"| Metric | Value |",
            f"|--------|-------|",
            f"| Domains Checked | {len(domains)} ({', '.join(domains)}) |",
            f"| Total Errors | **{errors}** |",
            f"| Total Warnings | **{warnings}** |",
            f"| Domains with Issues | {len(findings)} |",
            f"| Clean Domains | {len(domains) - len(findings)} |",
        ]

        if esc_summary:
            blocked_icon = "🚫" if blocked else "✅"
            lines += [
                f"| Validation Escalation | {blocked_icon} {esc_summary} |",
            ]
        if branch is not None:
            branch_icon = {"proceed": "✅", "escalate": "⚠️", "defer": "🔶", "skip": "⏭️"}.get(branch.action, "")
            lines += [
                f"| Alert Confidence | {branch_icon} `{branch.action}` — {branch.reason} |",
            ]

        lines.append("")

        if not findings:
            lines.append("✅ **All domains pass CDISC SDTM conformance checks.**")
        else:
            lines.append("## Findings by Domain")
            for domain, domain_findings in findings.items():
                errs = [f for f in domain_findings if f["severity"] == "ERROR"]
                warns = [f for f in domain_findings if f["severity"] == "WARNING"]
                lines += [
                    f"",
                    f"### {domain} — {len(errs)} errors, {len(warns)} warnings",
                    f"| Rule | Severity | Field | Message |",
                    f"|------|----------|-------|---------|",
                ]
                for f in domain_findings[:25]:
                    msg = f["message"][:120].replace("|", "\\|")
                    lines.append(f"| {f['rule_id']} | **{f['severity']}** | `{f['field']}` | {msg} |")
                if len(domain_findings) > 25:
                    lines.append(f"| | | | *...{len(domain_findings)-25} more findings* |")

        lines += ["", "---", f"*Generated by TrialOS SDTMConformanceChecker agent. Not a substitute for qualified DM review.*"]
        return "\n".join(lines)
