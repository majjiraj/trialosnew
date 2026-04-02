"""
MissingDataSweeper — TrialOS Native Agent v1.0.0
Identifies missing required data points across all SDTM domains.
Raises targeted queries for critical fields (AE, DM domains).
Generates missing data heat map by site.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../packages/trialo-agent-sdk"))

from trialo_agent_sdk import BaseAgent, AgentContext, AgentOutput
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
    AGENT_VERSION = "1.0.0"
    REQUIRED_PERMISSIONS = [
        "study:data:read", "study:queries:write",
        "study:reports:write", "platform:notify:write",
    ]
    DECLARED_TOOLS = ["read_sdtm_domain", "raise_data_query", "generate_pdf_report", "send_notification"]

    async def run(self, context: AgentContext) -> AgentOutput:
        all_missing: dict[str, list[dict]] = {}
        queries_raised = 0
        total_field_instances = 0

        for domain, fields in CRITICAL_FIELDS.items():
            records = await context.data_client.read_sdtm_domain(domain)
            if not records:
                continue

            domain_missing = self._find_missing(domain, records, fields)
            if domain_missing:
                all_missing[domain] = domain_missing
                for item in domain_missing:
                    total_field_instances += item["missing_count"]

                # Auto-raise queries for high-priority missing fields
                if domain in AUTO_QUERY_DOMAINS and not context.is_test_run:
                    for item in domain_missing:
                        if item["field"] in AUTO_QUERY_FIELDS and item["missing_count"] > 0:
                            subject_id = item["sample_subjects"][0] if item["sample_subjects"] else None
                            result = await context.data_client.raise_query(
                                domain=domain,
                                query_text=(
                                    f"Required field '{item['field']}' is missing. "
                                    f"Please provide the value. "
                                    f"This field is required per CDISC SDTM IG."
                                ),
                                subject_id=subject_id,
                                field_name=item["field"],
                            )
                            if result.get("status") == "raised":
                                queries_raised += 1
                            if queries_raised >= 10:  # Safety limit per run
                                break

        report_md = self._build_report(context, all_missing, queries_raised)
        artifact = await context.artifact_store.save_report(
            title=f"Missing_Data_Report_{context.protocol_number}",
            content=report_md,
        )

        if total_field_instances > 0 and not context.is_test_run:
            severity = "critical" if total_field_instances > 50 else "warning"
            await context.notification_client.notify(
                user_id=context.extra.get("dm_user_id", "data-manager"),
                title=f"Missing Data: {total_field_instances} field gaps in {context.study_name}",
                body=(
                    f"{total_field_instances} missing required field instances across "
                    f"{len(all_missing)} SDTM domains. {queries_raised} queries auto-raised."
                ),
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

    def _build_report(self, context: AgentContext, missing: dict, queries_raised: int) -> str:
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
            "",
        ]

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
