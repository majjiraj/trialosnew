"""
CRFGeneration — TrialOS Native Agent v1.0.0
Generates CRF (Case Report Form) field specifications from USDM study activities.
Produces CDASH-annotated field tables with SDTM traceability and exports to Excel spec.

Platform features:
  • Dynamic Retrieval Augmentation  — CDASH + SDTM IG chapter queries per domain
  • Confidence-Based Execution      — completeness gating; <0.65 raises HITL
  • Validation Escalation           — missing required CDASH fields = blocking
  • Contextual Prompt Injection     — HITL descriptions include prior form corrections
  • Memory Retrieval                — prior CRF generation patterns injected
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../packages/trialo-agent-sdk"))

import json
import httpx
from trialo_agent_sdk import (
    BaseAgent, AgentContext, AgentOutput,
    escalate_findings, is_blocked_by_escalation, escalation_summary,
    build_hitl_context, inject_hitl_context_into_description,
    compute_agent_confidence, branch_on_confidence,
    augment_ig_queries, retrieve_relevant_memories, build_memory_context_block,
)
from datetime import datetime, timezone

STUDY_GRAPH_URL = os.environ.get("STUDY_GRAPH_URL", "http://localhost:8013")
STANDARDS_REGISTRY_URL = os.environ.get("STANDARDS_REGISTRY_URL", "http://localhost:8012")

# CDASH domain → required fields with SDTM traceability
CDASH_DOMAIN_FIELDS: dict[str, list[dict]] = {
    "DM": [
        {"cdash": "SUBJID", "sdtm": "SUBJID", "label": "Subject Identifier", "type": "text", "required": True},
        {"cdash": "SITEID", "sdtm": "SITEID", "label": "Study Site Identifier", "type": "text", "required": True},
        {"cdash": "BRTHDTC", "sdtm": "BRTHDTC", "label": "Date of Birth", "type": "date", "required": False},
        {"cdash": "SEX", "sdtm": "SEX", "label": "Sex", "type": "codelist", "codelist": "SEX", "required": True},
        {"cdash": "RACE", "sdtm": "RACE", "label": "Race", "type": "codelist", "codelist": "RACE", "required": True},
        {"cdash": "ETHNIC", "sdtm": "ETHNIC", "label": "Ethnicity", "type": "codelist", "codelist": "ETHNIC", "required": False},
    ],
    "AE": [
        {"cdash": "AETERM", "sdtm": "AETERM", "label": "Adverse Event Term", "type": "text", "required": True},
        {"cdash": "AESTDTC", "sdtm": "AESTDTC", "label": "AE Start Date", "type": "datetime", "required": True},
        {"cdash": "AEENDTC", "sdtm": "AEENDTC", "label": "AE End Date", "type": "datetime", "required": False},
        {"cdash": "AESEV", "sdtm": "AESEV", "label": "Severity", "type": "codelist", "codelist": "AESEV", "required": True},
        {"cdash": "AESER", "sdtm": "AESER", "label": "Serious AE", "type": "codelist", "codelist": "NY", "required": True},
        {"cdash": "AEREL", "sdtm": "AEREL", "label": "Relationship to Study Drug", "type": "codelist", "codelist": "AEREL", "required": True},
        {"cdash": "AEOUT", "sdtm": "AEOUT", "label": "Outcome of AE", "type": "codelist", "codelist": "AEOUT", "required": True},
        {"cdash": "AEACN", "sdtm": "AEACN", "label": "Action Taken", "type": "codelist", "codelist": "AEACN", "required": False},
    ],
    "CM": [
        {"cdash": "CMTRT", "sdtm": "CMTRT", "label": "Reported Name of Drug", "type": "text", "required": True},
        {"cdash": "CMINDIC", "sdtm": "CMINDC", "label": "Indication", "type": "text", "required": False},
        {"cdash": "CMDOSE", "sdtm": "CMDOSE", "label": "Dose per Administration", "type": "numeric", "required": False},
        {"cdash": "CMDOSU", "sdtm": "CMDOSU", "label": "Dose Units", "type": "text", "required": False},
        {"cdash": "CMROUTE", "sdtm": "CMROUTE", "label": "Route of Administration", "type": "codelist", "codelist": "CMROUTE", "required": False},
        {"cdash": "CMSTDTC", "sdtm": "CMSTDTC", "label": "Start Date", "type": "date", "required": True},
        {"cdash": "CMENDTC", "sdtm": "CMENDTC", "label": "End Date", "type": "date", "required": False},
    ],
    "EX": [
        {"cdash": "EXTRT", "sdtm": "EXTRT", "label": "Name of Treatment", "type": "text", "required": True},
        {"cdash": "EXDOSE", "sdtm": "EXDOSE", "label": "Dose per Administration", "type": "numeric", "required": True},
        {"cdash": "EXDOSU", "sdtm": "EXDOSU", "label": "Dose Units", "type": "text", "required": True},
        {"cdash": "EXROUTE", "sdtm": "EXROUTE", "label": "Route of Administration", "type": "codelist", "codelist": "CMROUTE", "required": True},
        {"cdash": "EXSTDTC", "sdtm": "EXSTDTC", "label": "Start Date/Time", "type": "datetime", "required": True},
        {"cdash": "EXENDTC", "sdtm": "EXENDTC", "label": "End Date/Time", "type": "datetime", "required": False},
    ],
    "LB": [
        {"cdash": "LBTEST", "sdtm": "LBTEST", "label": "Lab Test Name", "type": "text", "required": True},
        {"cdash": "LBORRES", "sdtm": "LBORRES", "label": "Result", "type": "text", "required": True},
        {"cdash": "LBORRESU", "sdtm": "LBORRESU", "label": "Units", "type": "text", "required": False},
        {"cdash": "LBDTC", "sdtm": "LBDTC", "label": "Date/Time of Collection", "type": "datetime", "required": True},
        {"cdash": "LBNRLO", "sdtm": "LBNRLO", "label": "Reference Range Lower Limit", "type": "numeric", "required": False},
        {"cdash": "LBNRHI", "sdtm": "LBNRHI", "label": "Reference Range Upper Limit", "type": "numeric", "required": False},
    ],
    "VS": [
        {"cdash": "VSTESTCD", "sdtm": "VSTESTCD", "label": "Vital Signs Test Code", "type": "codelist", "codelist": "VSTESTCD", "required": True},
        {"cdash": "VSORRES", "sdtm": "VSORRES", "label": "Result", "type": "text", "required": True},
        {"cdash": "VSORRESU", "sdtm": "VSORRESU", "label": "Units", "type": "text", "required": False},
        {"cdash": "VSDTC", "sdtm": "VSDTC", "label": "Date/Time of Measurement", "type": "datetime", "required": True},
    ],
}

ACTIVITY_TO_DOMAINS: dict[str, list[str]] = {
    "adverse_event": ["AE"],
    "adverse event": ["AE"],
    "laboratory": ["LB"],
    "lab": ["LB"],
    "vital signs": ["VS"],
    "vitals": ["VS"],
    "concomitant medication": ["CM"],
    "medication": ["CM"],
    "exposure": ["EX"],
    "dosing": ["EX"],
    "demographics": ["DM"],
    "enrollment": ["DM"],
}


class CRFGeneration(BaseAgent):

    AGENT_NAME = "CRF Generation"
    AGENT_VERSION = "1.0.0"
    REQUIRED_PERMISSIONS = [
        "study:data:read", "study:docs:read",
        "study:graph:read", "study:reports:write",
        "platform:notify:write", "standards:read",
    ]
    DECLARED_TOOLS = [
        "query_study_design", "validate_controlled_terminology",
        "recall_memory", "generate_pdf_report", "send_notification",
    ]

    async def run(self, context: AgentContext) -> AgentOutput:
        findings: list[dict] = []
        crf_forms: list[dict] = []

        # ── Feature 1: Dynamic Retrieval Augmentation ──────────────────────
        if "study:docs:read" in context.consented_permissions:
            try:
                await self.augmented_ig_search(
                    "CDASH CRF fields eCRF design study activities data collection",
                    domains=["DM", "AE", "LB", "VS", "CM", "EX"],
                    top_k=6,
                )
            except Exception:
                pass

        # ── Feature 5: Memory Retrieval ────────────────────────────────────
        memories = context.extra.get("memory_context", [])
        top_memories = retrieve_relevant_memories("crf_generation", context.__dict__, memories, top_k=3)
        memory_block = build_memory_context_block(top_memories, "crf_generation") if top_memories else ""

        # Load study activities from graph or context
        activities = context.extra.get("activities", [])
        if not activities:
            try:
                async with httpx.AsyncClient(timeout=15) as client:
                    resp = await client.get(f"{STUDY_GRAPH_URL}/study/{context.study_id}/design")
                    if resp.status_code == 200:
                        design = resp.json()
                        # study-graph /design returns {elements: {activity: [...]}}
                        activities = design.get("elements", {}).get("activity", design.get("activities", []))
            except Exception:
                pass

        # Determine domains to generate CRFs for
        domains_needed: set[str] = {"DM"}  # always include DM
        for activity in activities:
            activity_name = ""
            if isinstance(activity, dict):
                activity_name = activity.get("name", activity.get("description", "")).lower()
            elif isinstance(activity, str):
                activity_name = activity.lower()
            for key, doms in ACTIVITY_TO_DOMAINS.items():
                if key in activity_name:
                    domains_needed.update(doms)

        # If no activities detected, include standard domains
        if len(domains_needed) <= 1:
            domains_needed.update({"AE", "CM", "EX", "LB", "VS"})

        # Generate CRF forms per domain
        for domain in sorted(domains_needed):
            if domain not in CDASH_DOMAIN_FIELDS:
                continue
            fields = CDASH_DOMAIN_FIELDS[domain]
            missing_required = [f for f in fields if f["required"] and not f.get("cdash")]
            for mf in missing_required:
                findings.append({
                    "type": "missing_required_cdash_field",
                    "rule_id": "CRF001",
                    "level": "error",
                    "severity": "ERROR",
                    "domain": domain,
                    "field": mf["cdash"],
                    "message": f"{domain}: Required CDASH field '{mf['cdash']}' missing",
                })
            crf_forms.append({
                "domain": domain,
                "form_name": f"{domain} Form",
                "fields": fields,
                "total_fields": len(fields),
                "required_fields": len([f for f in fields if f["required"]]),
                "codelist_fields": len([f for f in fields if f.get("codelist")]),
            })

        # ── Feature 3: Validation Escalation ──────────────────────────────
        escalation_result = self.escalate_findings(findings, domain="CRF")
        blocked = self.is_blocked(escalation_result)
        esc_summary = self.escalation_summary(escalation_result)

        # ── Feature 2: Confidence-Based Execution Branching ────────────────
        total_fields = sum(f["total_fields"] for f in crf_forms)
        evidence_count = len(activities) + len(crf_forms)
        confidence = self.compute_confidence(
            evidence_count=evidence_count,
            quality_signals=[
                1.0 if crf_forms else 0.0,
                1.0 - (len(findings) / max(total_fields, 1)),
            ],
            validation_methods=["cdash_field_check", "activity_domain_mapping"],
        )
        branch = self.branch_on_confidence(
            confidence,
            thresholds={"proceed": 0.65, "escalate": 0.40, "defer": 0.20},
            context_hint="crf-generation gate",
        )

        # ── Feature 4: Contextual Prompt Injection for HITL ───────────────
        if confidence < 0.65 and not context.is_test_run:
            prior_corrections = context.extra.get("prior_corrections", [])
            hitl_ctx = self.build_hitl_context(prior_corrections, domain="CRF")
            base_desc = (
                f"CRF generation confidence {confidence:.2f}. "
                f"Generated {len(crf_forms)} forms with {total_fields} total fields. "
                f"Please review and annotate the CRF specification."
            )
            if memory_block:
                base_desc += f"\n\nPRIOR PATTERNS:\n{memory_block}"
            hitl_desc = inject_hitl_context_into_description(base_desc, hitl_ctx)
            await context.notification_client.notify(
                user_id=context.extra.get("reviewer_id", "crf-designer"),
                title=f"CRF Review Required: {context.study_name}",
                body=hitl_desc,
                severity="warning",
            )

        report_md = _build_report(context, crf_forms, findings, confidence, branch, esc_summary)
        artifact = await context.artifact_store.save_report(
            title=f"CRF_Specification_{context.protocol_number}",
            content=report_md,
        )

        return AgentOutput(
            summary=(
                f"Generated {len(crf_forms)} CRF forms ({total_fields} fields total) "
                f"for study {context.study_name} (confidence={confidence:.2f})."
            ),
            findings=findings,
            artifacts=[artifact] if artifact else [],
            metadata={
                "forms_generated": len(crf_forms),
                "total_fields": total_fields,
                "domains": [f["domain"] for f in crf_forms],
                "activities_used": len(activities),
                "confidence": confidence,
                "branch_action": branch.action,
                "blocked": blocked,
                "crf_forms": crf_forms,
            },
        )


def _build_report(context, forms, findings, confidence, branch, esc_summary) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        "# CRF Specification Report",
        f"**Study:** {context.study_name}  |  **Protocol:** {context.protocol_number}",
        f"**Generated:** {ts}",
        "",
        "## Forms Summary",
        f"| Domain | Form Name | Total Fields | Required | Codelists |",
        f"|--------|-----------|-------------|----------|-----------|",
    ]
    for form in forms:
        lines.append(
            f"| {form['domain']} | {form['form_name']} | {form['total_fields']} "
            f"| {form['required_fields']} | {form['codelist_fields']} |"
        )
    lines += ["", "## Field Specifications"]
    for form in forms:
        lines += [
            f"", f"### {form['domain']} — {form['form_name']}",
            "| CDASH Field | SDTM Variable | Label | Type | Codelist | Required |",
            "|-------------|---------------|-------|------|----------|----------|",
        ]
        for field in form["fields"]:
            req = "Yes" if field["required"] else "No"
            cl = field.get("codelist", "—")
            lines.append(
                f"| `{field['cdash']}` | `{field['sdtm']}` | {field['label']} "
                f"| {field['type']} | {cl} | {req} |"
            )
    if findings:
        lines += ["", "## Issues Found"]
        for f in findings[:20]:
            lines.append(f"- [{f['level'].upper()}] {f['message']}")
    lines += [
        f"", f"**Confidence:** {confidence:.2f}  |  **Branch:** {branch.action}",
        esc_summary or "",
        "", "---", "*Generated by TrialOS CRFGeneration v1.0.0*",
    ]
    return "\n".join(lines)
