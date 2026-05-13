"""
StudyDesignExtractor — TrialOS Native Agent v1.0.0
Parses USDM protocol documents and extracts structured study design elements
into the study-graph service (Neo4j + PostgreSQL).

Platform features:
  • Dynamic Retrieval Augmentation  — IG + USDM chapter queries for extraction guidance
  • Confidence-Based Execution      — <0.70 raises HITL for manual review
  • Validation Escalation           — missing mandatory protocol fields promoted to blocking
  • Contextual Prompt Injection     — HITL descriptions enriched with prior extraction corrections
  • Memory Retrieval                — prior extraction patterns injected as context
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../packages/trialo-agent-sdk"))

import json
import asyncio
import httpx
from trialo_agent_sdk import (
    BaseAgent, AgentContext, AgentOutput,
    escalate_findings, is_blocked_by_escalation, escalation_summary,
    build_hitl_context, inject_hitl_context_into_description, build_hitl_notification_body,
    compute_agent_confidence, branch_on_confidence,
    augment_ig_queries, retrieve_relevant_memories, build_memory_context_block,
)
from datetime import datetime, timezone

STUDY_GRAPH_URL   = os.environ.get("STUDY_GRAPH_URL",   "http://localhost:8013")
AGENT_RUNTIME_URL = os.environ.get("AGENT_RUNTIME_URL", "http://localhost:8004")

# USDM v4.0 mandatory fields — checked at design level (study.versions[0].studyDesigns[0])
# or at version/study level as fallbacks
MANDATORY_PROTOCOL_FIELDS = [
    "arms",           # StudyArm[] — min 1 required per USDM v4.0
    "epochs",         # StudyEpoch[] — min 1 required
    "objectives",     # Objective[] — at least one for primary endpoint
    "population",     # StudyDesignPopulation — enrollment and eligibility
    "indications",    # Indication[] — therapeutic area / target disease
]


class StudyDesignExtractor(BaseAgent):

    AGENT_NAME = "Study Design Extractor"
    AGENT_VERSION = "1.0.0"
    REQUIRED_PERMISSIONS = [
        "study:data:read", "study:docs:read",
        "study:graph:write", "study:reports:write",
        "platform:notify:write",
    ]
    DECLARED_TOOLS = [
        "read_document", "query_study_design", "store_learning",
        "generate_pdf_report", "send_notification",
    ]

    async def run(self, context: AgentContext) -> AgentOutput:
        findings: list[dict] = []
        extracted_elements: dict = {}

        # ── Feature 1: Dynamic Retrieval Augmentation ──────────────────────
        if "study:docs:read" in context.consented_permissions:
            try:
                await self.augmented_ig_search(
                    "USDM v4.0 StudyArm StudyEpoch StudyCell StudyElement Activity "
                    "Encounter ScheduleTimeline EligibilityCriterion BiomedicalConcept "
                    "Estimand Indication StudyDesignPopulation StudyCohort",
                    domains=["DM", "EX", "TV", "TA", "TI", "TE", "TS"],
                    top_k=7,
                )
            except Exception:
                pass

        # ── Feature 5: Memory Retrieval ────────────────────────────────────
        memories = context.extra.get("memory_context", [])
        if memories:
            top_memories = retrieve_relevant_memories("protocol_analysis", context.__dict__, memories)
            if top_memories:
                context.extra["auto_memory_context"] = build_memory_context_block(top_memories, "protocol_analysis")

        # Load USDM document
        usdm_data = context.extra.get("usdm_data") or {}
        if not usdm_data and hasattr(context, "data_client"):
            try:
                usdm_records = await context.data_client.read_raw(
                    f"SELECT usdm_json FROM usdm_conversions WHERE study_id = $1 ORDER BY created_at DESC LIMIT 1",
                    context.study_id,
                )
                if usdm_records:
                    raw = usdm_records[0].get("usdm_json") or {}
                    usdm_data = raw if isinstance(raw, dict) else json.loads(raw)
            except Exception:
                pass

        # Validate mandatory USDM v4.0 fields at the design level
        design = _usdm_design(usdm_data)
        missing_mandatory = []
        for field in MANDATORY_PROTOCOL_FIELDS:
            val = design.get(field) or design.get(field + "s")
            if not val:
                missing_mandatory.append(field)
            findings.append({
                "type": "missing_mandatory_protocol_field",
                "rule_id": "USDM001",
                "level": "error",
                "severity": "ERROR",
                "field": field,
                "message": f"USDM v4.0 mandatory field '{field}' absent from studyDesign",
            }) if not val else None

        # ── Feature 3: Validation Escalation ──────────────────────────────
        escalation_result = self.escalate_findings(findings, domain="PROTOCOL")
        blocked = self.is_blocked(escalation_result)

        # Extract study elements
        extracted_elements = _extract_elements(usdm_data)
        evidence_count = sum(len(v) if isinstance(v, list) else (1 if v else 0)
                             for v in extracted_elements.values())

        # ── Feature 2: Confidence-Based Execution Branching ────────────────
        mandatory_coverage = 1.0 - (len(missing_mandatory) / max(len(MANDATORY_PROTOCOL_FIELDS), 1))
        confidence = self.compute_confidence(
            evidence_count=evidence_count,
            quality_signals=[mandatory_coverage],
            validation_methods=["usdm_field_presence", "schema_validation"],
        )
        branch = self.branch_on_confidence(
            confidence,
            thresholds={"proceed": 0.70, "escalate": 0.40, "defer": 0.20},
            context_hint="study-design extraction gate",
        )

        # Post to study-graph
        graph_result = {}
        if branch.action in ("proceed", "escalate") and not blocked:
            try:
                async with httpx.AsyncClient(timeout=30) as client:
                    resp = await client.post(
                        f"{STUDY_GRAPH_URL}/study/{context.study_id}/design/extract",
                        params={"org_id": context.org_id},
                        json={
                            "usdm_data": usdm_data,
                            "source": "agent_extracted",
                        },
                    )
                    if resp.status_code == 200:
                        graph_result = resp.json()
                        asyncio.create_task(
                            _trigger_ich_m11_usdm_check(context, usdm_data)
                        )
            except Exception:
                pass

        # ── Feature 4: Contextual Prompt Injection for HITL ───────────────
        if branch.action in ("escalate", "defer") or confidence < 0.70:
            prior_corrections = context.extra.get("prior_corrections", [])
            hitl_ctx = self.build_hitl_context(prior_corrections, domain="PROTOCOL")
            base_desc = (
                f"Study design extraction confidence {confidence:.2f} below threshold. "
                f"Extracted: {evidence_count} elements. Missing mandatory: {missing_mandatory}. "
                f"Please review and correct the extracted study design elements."
            )
            hitl_desc = inject_hitl_context_into_description(base_desc, hitl_ctx)
            if not context.is_test_run:
                await context.notification_client.notify(
                    user_id=context.extra.get("reviewer_id", "protocol-reviewer"),
                    title=f"Study Design Review Required: {context.study_name}",
                    body=hitl_desc,
                    severity="warning",
                )

        report_md = _build_report(context, extracted_elements, confidence, branch,
                                  missing_mandatory, graph_result)
        artifact = await context.artifact_store.save_report(
            title=f"StudyDesign_Extraction_{context.protocol_number}",
            content=report_md,
        )

        list_keys = [
            "arms", "epochs", "cells", "elements", "activities", "encounters",
            "schedule_timelines", "objectives", "endpoints", "estimands",
            "indications", "eligibility_criteria", "cohorts",
        ]
        return AgentOutput(
            summary=(
                f"Extracted {evidence_count} USDM v4.0 design elements "
                f"(confidence={confidence:.2f}, action={branch.action}). "
                f"{len(missing_mandatory)} mandatory fields missing."
            ),
            findings=findings,
            artifacts=[artifact] if artifact else [],
            metadata={
                "usdm_version": "4.0",
                "extracted_elements": {k: len(extracted_elements.get(k, []))
                                       if isinstance(extracted_elements.get(k), list)
                                       else (1 if extracted_elements.get(k) else 0)
                                       for k in list_keys},
                "study_phase": extracted_elements.get("study_phase", ""),
                "protocol_version": extracted_elements.get("protocol_version", ""),
                "confidence": confidence,
                "branch_action": branch.action,
                "missing_mandatory": missing_mandatory,
                "graph_elements_created": graph_result.get("elements_created", 0),
                "escalation": escalation_result.get("escalation_policy"),
            },
        )


async def _trigger_ich_m11_usdm_check(context, usdm_data: dict):
    """Fire-and-forget: launch ICH M11 USDM-alignment check after study design extraction."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{AGENT_RUNTIME_URL}/runs/by-slug",
                json={
                    "agent_slug": "ich-m11-validator",
                    "org_id":     context.org_id,
                    "study_id":   context.study_id,
                    "input_context": {
                        "usdm_data":      usdm_data,
                        "trigger_source": "study_design_extractor",
                    },
                },
            )
    except Exception:
        pass


def _dig(data: dict, key: str, default=None):
    if not data:
        return default
    if key in data:
        return data[key]
    for v in data.values():
        if isinstance(v, dict):
            result = _dig(v, key)
            if result is not None:
                return result
    return default


def _usdm_design(usdm_data: dict) -> dict:
    """Navigate USDM v4.0: study.versions[0].studyDesigns[0].
    Falls back gracefully for legacy/flat exports."""
    study = usdm_data.get("study", usdm_data)
    versions = study.get("versions", [])
    if versions:
        designs = versions[0].get("studyDesigns", [])
        if designs:
            return designs[0]
    for key in ("studyDesign", "design"):
        if key in study:
            return study[key]
    return study


def _code_value(code_obj) -> str:
    if not code_obj:
        return ""
    if isinstance(code_obj, str):
        return code_obj
    if isinstance(code_obj, dict):
        std = code_obj.get("standardCode") or code_obj
        return std.get("code", std.get("decode", std.get("id", "")))
    return str(code_obj)


def _extract_elements(usdm_data: dict) -> dict:
    """
    Extract all USDM v4.0 design elements from the canonical nested path.
    Returns a dict with counts and sample objects per element type.
    """
    design = _usdm_design(usdm_data)
    study  = usdm_data.get("study", usdm_data)
    version = (study.get("versions") or [{}])[0]

    # Eligibility criteria can live at version level or inside population
    population = design.get("population", {})
    criteria_from_population = population.get("criteria", [])
    criteria_from_version    = version.get("eligibilityCriteria", [])
    criteria_from_design     = design.get("eligibilityCriteria", [])
    all_criteria = criteria_from_population + criteria_from_version + criteria_from_design

    # Endpoints come from objectives
    all_endpoints = []
    for obj in design.get("objectives", []):
        all_endpoints.extend(obj.get("endpoints", []))

    return {
        "arms":               design.get("arms", design.get("studyArms", [])),
        "epochs":             design.get("epochs", design.get("studyEpochs", [])),
        "cells":              design.get("studyCells", []),
        "elements":           design.get("elements", design.get("studyElements", [])),
        "activities":         design.get("activities", []),
        "encounters":         design.get("encounters", []),
        "schedule_timelines": design.get("scheduleTimelines", []),
        "objectives":         design.get("objectives", []),
        "endpoints":          all_endpoints,
        "estimands":          design.get("estimands", []),
        "indications":        design.get("indications", []),
        "eligibility_criteria": all_criteria,
        "cohorts":            population.get("cohorts", []),
        "population":         population or None,
        # Study-level metadata
        "study_title":  _dig(usdm_data, "officialTitle") or _dig(usdm_data, "studyTitle") or "",
        "study_phase":  _code_value(_dig(usdm_data, "studyPhase")),
        "protocol_version": version.get("versionIdentifier", version.get("protocolVersion", "")),
    }


def _build_report(context, elements, confidence, branch, missing, graph_result) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        "# Study Design Extraction Report (USDM v4.0)",
        f"**Study:** {context.study_name}  |  **Protocol:** {context.protocol_number}",
        f"**Generated:** {ts}",
        "",
        f"**Study Phase:** {elements.get('study_phase', '—')}  |  "
        f"**Protocol Version:** {elements.get('protocol_version', '—')}",
        "",
        "## USDM v4.0 Extraction Summary",
        "| Element Class | Count |",
        "|--------------|-------|",
    ]
    list_keys = [
        "arms", "epochs", "cells", "elements", "activities", "encounters",
        "schedule_timelines", "objectives", "endpoints", "estimands",
        "indications", "eligibility_criteria", "cohorts",
    ]
    for k in list_keys:
        v = elements.get(k, [])
        count = len(v) if isinstance(v, list) else (1 if v else 0)
        lines.append(f"| {k.replace('_', ' ').title()} | {count} |")
    lines += [
        "",
        f"**Confidence:** {confidence:.2f}  |  **Branch:** {branch.action}",
        f"**Graph Nodes Created:** {graph_result.get('elements_created', graph_result.get('nodes_created', 0))}",
    ]
    if missing:
        lines += ["", "## Missing USDM v4.0 Mandatory Fields", *[f"- `{f}`" for f in missing]]
    lines += ["", "---", "*Generated by TrialOS StudyDesignExtractor v1.0.0 (USDM-IG v4.0)*"]
    return "\n".join(lines)
