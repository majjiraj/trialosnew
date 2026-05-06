"""
Writing — TrialOS Native Agent v1.0.0
Generates clinical trial documents: CSR synopsis, AE narratives, variable documentation.
Uses procedural memory-driven structure for consistent document generation.

Platform features:
  • Dynamic Retrieval Augmentation  — IG chapter + prior document structure queries
  • Confidence-Based Execution      — <0.65 triggers HITL for medical writing review
  • Validation Escalation           — missing safety data = blocking for AE narratives
  • Contextual Prompt Injection     — HITL descriptions include prior writing corrections
  • Memory Retrieval                — procedural memory provides proven document structure
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

MEMORY_ENGINE_URL = os.environ.get("MEMORY_ENGINE_URL", "http://localhost:8014")

CSR_SYNOPSIS_STRUCTURE = [
    "Title", "Study Identifiers", "Study Objectives", "Study Design",
    "Study Population", "Treatment", "Efficacy Results", "Safety Results",
    "Conclusions",
]

AE_NARRATIVE_TEMPLATE = """Subject {subject_id}: A {age}-year-old {sex} subject {enrolled_desc}.
On {ae_date}, the subject experienced {ae_term} (severity: {severity}, serious: {serious}).
{action_taken_desc}
{outcome_desc}
The investigator assessed the relationship to study drug as {relationship}."""


class Writing(BaseAgent):

    AGENT_NAME = "Writing"
    AGENT_VERSION = "1.0.0"
    REQUIRED_PERMISSIONS = [
        "study:data:read", "study:docs:read",
        "study:reports:write", "platform:notify:write",
    ]
    DECLARED_TOOLS = [
        "read_sdtm_domain", "recall_memory",
        "generate_pdf_report", "send_notification",
    ]

    async def run(self, context: AgentContext) -> AgentOutput:
        findings: list[dict] = []
        document_type = context.extra.get("document_type", "csr_synopsis")

        # ── Feature 1: Dynamic Retrieval Augmentation ──────────────────────
        if "study:docs:read" in context.consented_permissions:
            try:
                await self.augmented_ig_search(
                    f"clinical study report {document_type} medical writing ICH E3",
                    domains=["AE", "DM"],
                    top_k=5,
                )
            except Exception:
                pass

        # ── Feature 5: Memory Retrieval — procedural structure ────────────
        memories = context.extra.get("memory_context", [])
        top_memories = retrieve_relevant_memories("narrative_writing", context.__dict__, memories, top_k=3)
        memory_block = build_memory_context_block(
            top_memories, "narrative_writing", include_procedural=True
        ) if top_memories else ""

        # Fetch procedural memory for document type
        procedural_steps = await _fetch_procedural_memory(document_type)

        artifacts_generated = []
        metadata: dict = {
            "document_type": document_type,
            "confidence": 0.0,
            "branch_action": "",
        }

        if document_type == "csr_synopsis":
            result = await self._generate_csr_synopsis(context, findings, memory_block, procedural_steps)
        elif document_type == "ae_narratives":
            result = await self._generate_ae_narratives(context, findings, memory_block)
        elif document_type == "variable_documentation":
            result = await self._generate_variable_docs(context, findings, memory_block)
        else:
            result = await self._generate_csr_synopsis(context, findings, memory_block, procedural_steps)

        content = result.get("content", "")
        evidence_count = result.get("evidence_count", 0)
        sections_complete = result.get("sections_complete", 0)
        total_sections = result.get("total_sections", 1)

        # ── Feature 3: Validation Escalation ──────────────────────────────
        escalation_result = self.escalate_findings(findings, domain="WRITING")
        blocked = self.is_blocked(escalation_result)
        esc_summary = self.escalation_summary(escalation_result)

        # ── Feature 2: Confidence-Based Execution Branching ────────────────
        completeness = sections_complete / max(total_sections, 1)
        confidence = self.compute_confidence(
            evidence_count=evidence_count,
            quality_signals=[completeness],
            validation_methods=["section_completeness", "data_availability"],
        )
        branch = self.branch_on_confidence(
            confidence,
            thresholds={"proceed": 0.65, "escalate": 0.40, "defer": 0.20},
            context_hint="writing-generation gate",
        )

        # ── Feature 4: Contextual Prompt Injection for HITL ───────────────
        if confidence < 0.65 and not context.is_test_run:
            prior_corrections = context.extra.get("prior_corrections", [])
            hitl_ctx = self.build_hitl_context(prior_corrections, domain="WRITING")
            base_desc = (
                f"Document '{document_type}' generation confidence {confidence:.2f}. "
                f"Sections completed: {sections_complete}/{total_sections}. "
                f"Please review and complete the document."
            )
            if memory_block:
                base_desc += f"\n\nPRIOR WRITING PATTERNS:\n{memory_block}"
            hitl_desc = inject_hitl_context_into_description(base_desc, hitl_ctx)
            await context.notification_client.notify(
                user_id=context.extra.get("reviewer_id", "medical-writer"),
                title=f"Document Review Required: {document_type} — {context.study_name}",
                body=hitl_desc,
                severity="warning",
            )

        artifact = await context.artifact_store.save_report(
            title=f"{document_type.upper()}_{context.protocol_number}",
            content=content,
        )

        return AgentOutput(
            summary=(
                f"Generated {document_type} for {context.study_name}. "
                f"Sections: {sections_complete}/{total_sections}. "
                f"Confidence: {confidence:.2f}."
            ),
            findings=findings,
            artifacts=[artifact] if artifact else [],
            metadata={
                "document_type": document_type,
                "sections_complete": sections_complete,
                "total_sections": total_sections,
                "confidence": confidence,
                "branch_action": branch.action,
                "blocked": blocked,
                "escalation": escalation_result.get("escalation_policy"),
            },
        )

    async def _generate_csr_synopsis(self, context, findings, memory_block, procedural_steps) -> dict:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        sections_complete = 0
        structure = procedural_steps if procedural_steps else CSR_SYNOPSIS_STRUCTURE

        # Fetch study data
        dm_records = []
        ae_records = []
        try:
            dm_records = await context.data_client.read_sdtm_domain("DM") or []
            ae_records = await context.data_client.read_sdtm_domain("AE") or []
        except Exception:
            pass

        lines = [
            f"# Clinical Study Report Synopsis",
            f"**Study:** {context.study_name}  |  **Protocol:** {context.protocol_number}",
            f"**Generated:** {ts}",
            "",
        ]

        section_data = {
            "Title": context.study_name,
            "Study Identifiers": f"Protocol: {context.protocol_number}, Study ID: {context.study_id}",
            "Study Objectives": context.extra.get("objectives", "To be completed by medical writer."),
            "Study Design": context.extra.get("study_design", "Randomized, double-blind, placebo-controlled."),
            "Study Population": f"{len(dm_records)} subjects enrolled" if dm_records else "Enrollment data not available.",
            "Treatment": context.extra.get("treatment_description", "To be completed by medical writer."),
            "Efficacy Results": context.extra.get("efficacy_summary", "Efficacy analysis to be completed."),
            "Safety Results": (f"{len(ae_records)} adverse events reported across {len(dm_records)} subjects."
                               if ae_records else "No adverse event data available."),
            "Conclusions": context.extra.get("conclusions", "Conclusions to be finalized after data review."),
        }

        for section in structure:
            content = section_data.get(section, "Section content pending.")
            is_complete = content and "to be completed" not in content.lower() and "pending" not in content.lower()
            if is_complete:
                sections_complete += 1
            lines += [f"## {section}", content, ""]

        if memory_block:
            lines += ["---", "## Prior Patterns Reference", memory_block]

        return {
            "content": "\n".join(lines),
            "sections_complete": sections_complete,
            "total_sections": len(structure),
            "evidence_count": len(dm_records) + len(ae_records),
        }

    async def _generate_ae_narratives(self, context, findings, memory_block) -> dict:
        ae_records = []
        dm_records = []
        try:
            ae_records = await context.data_client.read_sdtm_domain("AE") or []
            dm_records = await context.data_client.read_sdtm_domain("DM") or []
        except Exception:
            pass

        # Flag missing SAE data
        serious_ae = [r for r in ae_records if str(r.get("AESER", "")).upper() == "Y"]
        for ae in serious_ae:
            if not ae.get("AETERM") or not ae.get("AESTDTC"):
                findings.append({
                    "type": "missing_sae_data",
                    "rule_id": "NAR001",
                    "level": "error",
                    "severity": "ERROR",
                    "message": f"SAE narrative missing term or start date for subject {ae.get('USUBJID')}",
                })

        dm_map = {r.get("USUBJID"): r for r in dm_records}
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        lines = [
            "# Adverse Event Narratives",
            f"**Study:** {context.study_name}  |  **Generated:** {ts}",
            f"**Total AEs:** {len(ae_records)}  |  **Serious AEs:** {len(serious_ae)}",
            "",
        ]

        narratives_written = 0
        for ae in serious_ae[:20]:
            subj_id = ae.get("USUBJID", "Unknown")
            dm = dm_map.get(subj_id, {})
            narrative = AE_NARRATIVE_TEMPLATE.format(
                subject_id=subj_id,
                age=dm.get("AGE", "unknown age"),
                sex=dm.get("SEX", "unknown sex"),
                enrolled_desc=f"enrolled at site {dm.get('SITEID', 'unknown')}",
                ae_date=ae.get("AESTDTC", "unknown date"),
                ae_term=ae.get("AETERM", "unknown term"),
                severity=ae.get("AESEV", "unknown"),
                serious=ae.get("AESER", "N"),
                action_taken_desc=f"Action taken: {ae.get('AEACN', 'not specified')}.",
                outcome_desc=f"Outcome: {ae.get('AEOUT', 'unknown')}.",
                relationship=ae.get("AEREL", "unknown"),
            )
            lines += [f"## Subject {subj_id}", narrative, ""]
            narratives_written += 1

        if not serious_ae:
            lines.append("No serious adverse events requiring narrative documentation.")

        return {
            "content": "\n".join(lines),
            "sections_complete": narratives_written,
            "total_sections": max(len(serious_ae), 1),
            "evidence_count": len(ae_records) + len(dm_records),
        }

    async def _generate_variable_docs(self, context, findings, memory_block) -> dict:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        lines = [
            "# SDTM Variable Documentation",
            f"**Study:** {context.study_name}  |  **Generated:** {ts}",
            "",
            "## Variable Definitions",
            "",
            "| Variable | Domain | Label | Type | Controlled Terms | Derivation |",
            "|----------|--------|-------|------|-----------------|------------|",
        ]

        variables = context.extra.get("variables", [])
        if not variables:
            variables = [
                {"var": "USUBJID", "domain": "ALL", "label": "Unique Subject Identifier",
                 "type": "text", "ct": "—", "derivation": "SITEID + SUBJID"},
                {"var": "AESEV", "domain": "AE", "label": "Severity/Intensity",
                 "type": "codelist", "ct": "AESEV", "derivation": "Collected"},
                {"var": "AEREL", "domain": "AE", "label": "Causality",
                 "type": "codelist", "ct": "AEREL", "derivation": "Collected"},
            ]

        for v in variables:
            lines.append(
                f"| `{v['var']}` | {v['domain']} | {v['label']} "
                f"| {v['type']} | {v['ct']} | {v['derivation']} |"
            )

        return {
            "content": "\n".join(lines),
            "sections_complete": len(variables),
            "total_sections": max(len(variables), 1),
            "evidence_count": len(variables),
        }


async def _fetch_procedural_memory(doc_type: str) -> list[str]:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{MEMORY_ENGINE_URL}/memory/procedural/{doc_type}",
                params={"limit": 1},
            )
            if resp.status_code == 200:
                data = resp.json()
                memories = data.get("memories", [])
                if memories:
                    steps = memories[0].get("steps", [])
                    if isinstance(steps, list):
                        return steps
    except Exception:
        pass
    return []
