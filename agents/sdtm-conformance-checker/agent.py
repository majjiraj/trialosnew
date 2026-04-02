"""
SDTMConformanceChecker — TrialOS Native Agent v1.0.0
Runs CDISC SDTM conformance checks across all study domains.
Generates findings report with severity levels (ERROR/WARNING).
Equivalent to Pinnacle 21 Community checks.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../packages/trialo-agent-sdk"))

from trialo_agent_sdk import BaseAgent, AgentContext, AgentOutput
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
    AGENT_VERSION = "1.0.0"
    REQUIRED_PERMISSIONS = ["study:data:read", "study:validation:read", "study:reports:write"]
    DECLARED_TOOLS = ["read_sdtm_domain", "check_cdisc_conformance", "generate_pdf_report", "send_notification"]

    async def run(self, context: AgentContext) -> AgentOutput:
        all_findings: dict[str, list[dict]] = {}
        total_errors = 0
        total_warnings = 0
        domains_checked = []

        for domain in SDTM_DOMAINS:
            records = await context.data_client.read_sdtm_domain(domain)
            if not records:
                continue

            domains_checked.append(domain)
            findings = self._check_domain(domain, records)

            if findings:
                all_findings[domain] = findings
                total_errors += sum(1 for f in findings if f["severity"] == "ERROR")
                total_warnings += sum(1 for f in findings if f["severity"] == "WARNING")

        # Generate report
        report_md = self._build_report(context, all_findings, total_errors, total_warnings, domains_checked)
        artifact = await context.artifact_store.save_report(
            title=f"SDTM_Conformance_Report_{context.protocol_number}",
            content=report_md,
        )

        # Alert DM if errors found
        if total_errors > 0 and not context.is_test_run:
            severity = "critical" if total_errors >= 10 else "warning"
            await context.notification_client.notify(
                user_id=context.extra.get("dm_user_id", "data-manager"),
                title=f"SDTM Conformance: {total_errors} errors in {context.study_name}",
                body=f"{total_errors} ERROR-level conformance findings across {len(all_findings)} domains. Review report.",
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

    def _build_report(self, context: AgentContext, findings: dict, errors: int, warnings: int, domains: list) -> str:
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
            "",
        ]

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
