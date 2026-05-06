"""
ProtocolICHM11Converter — TrialOS Native Agent v1.0.0
Converts an unstructured or partially-structured protocol document into a
fully ICH M11 CeSHarP-compliant structured format using Ollama LLM extraction.
Produces a 14-section M11 document artifact and optionally stores to DB.

Platform features:
  • Dynamic Retrieval Augmentation  — ICH M11 section guidance from standards-registry
  • Confidence-Based Execution      — <0.70 raises HITL for missing critical sections
  • Validation Escalation           — critical sections with no content = blocking
  • Contextual Prompt Injection     — HITL descriptions include prior conversion corrections
  • Memory Retrieval                — prior conversion patterns and gold examples injected
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../packages/trialo-agent-sdk"))

import json
import asyncio
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
AGENT_RUNTIME_URL      = os.environ.get("AGENT_RUNTIME_URL",       "http://localhost:8004")
OLLAMA_URL             = os.environ.get("OLLAMA_URL",              "http://localhost:11434")
OLLAMA_MODEL           = os.environ.get("OLLAMA_MODEL",            "llama3.2")
LLM_PROVIDER           = os.environ.get("LLM_PROVIDER",            "bedrock").strip().lower()
BEDROCK_MODEL_ID       = os.environ.get("BEDROCK_MODEL_ID",        "us.anthropic.claude-3-7-sonnet-20250219-v1:0")
AWS_REGION             = os.environ.get("AWS_DEFAULT_REGION",      "us-east-1")

# Critical M11 sections — absence blocks proceeding without human input
CRITICAL_SECTION_IDS = {"S01", "S04", "S05", "S06", "S08", "S09", "S12"}

_M11_SECTIONS = [
    {"id": "S01", "title": "General Information",
     "prompt_hint": "Extract the protocol title, version number, version date, sponsor name, sponsor address, protocol number, and all identifiers (IND, EudraCT, etc.)."},
    {"id": "S02", "title": "Protocol Summary",
     "prompt_hint": "Extract or create a structured summary covering study rationale, design overview, population, intervention, primary endpoint, and expected duration."},
    {"id": "S03", "title": "Background and Rationale",
     "prompt_hint": "Extract the scientific background, disease description, unmet medical need, prior research, and rationale for the study."},
    {"id": "S04", "title": "Objectives and Estimands",
     "prompt_hint": "Extract all study objectives (primary, secondary, exploratory) and for each, identify the associated estimand (population, variable, intercurrent events, summary measure)."},
    {"id": "S05", "title": "Eligibility Criteria",
     "prompt_hint": "List all inclusion criteria and exclusion criteria separately. Number each criterion. Flag any that use ambiguous language."},
    {"id": "S06", "title": "Study Design",
     "prompt_hint": "Describe the overall study design type (randomised/non-randomised, blinding, parallel/crossover), study arms with descriptions, epochs, allocation method, and include a schematic if described."},
    {"id": "S07", "title": "Study Interventions",
     "prompt_hint": "Extract all investigational products, comparators, doses, routes, administration schedules, concomitant medications policy, and rescue medications."},
    {"id": "S08", "title": "Schedule of Activities",
     "prompt_hint": "Extract the complete Schedule of Activities (SOA) table: all visits, timepoints, and assessments performed at each visit. Include screening, treatment, and follow-up periods."},
    {"id": "S09", "title": "Statistical Considerations",
     "prompt_hint": "Extract analysis populations, primary and secondary analyses, sample size calculation with assumptions, power, and significance level."},
    {"id": "S10", "title": "Data Management",
     "prompt_hint": "Extract data collection methods, eCRF description, data quality processes, and database lock procedures."},
    {"id": "S11", "title": "Monitoring",
     "prompt_hint": "Extract site monitoring plan, risk-based monitoring approach, and data review frequency."},
    {"id": "S12", "title": "Safety Reporting",
     "prompt_hint": "Extract SAE definitions, SAE reporting timelines (to sponsor, regulatory), SUSAR reporting, stopping rules, and DSMB/DMC information."},
    {"id": "S13", "title": "Ethical Considerations",
     "prompt_hint": "Extract IEC/IRB approval references, informed consent process, data protection, and ethical conduct statements."},
    {"id": "S14", "title": "Supporting Documentation",
     "prompt_hint": "Extract references, abbreviations list, and any appendices."},
]

_SECTION_INDEX = {s["id"]: s for s in _M11_SECTIONS}


class ProtocolICHM11Converter(BaseAgent):

    AGENT_NAME    = "Protocol ICH M11 Converter"
    AGENT_VERSION = "1.0.0"
    REQUIRED_PERMISSIONS = [
        "study:data:read", "study:docs:read",
        "study:graph:read", "study:reports:write",
        "platform:notify:write", "standards:read",
    ]
    DECLARED_TOOLS = [
        "read_document", "search_documents",
        "generate_pdf_report", "send_notification", "recall_memory",
    ]

    async def run(self, context: AgentContext) -> AgentOutput:
        findings: list[dict] = []

        # ── Feature 1: Dynamic Retrieval Augmentation ──────────────────────
        if "study:docs:read" in context.consented_permissions:
            try:
                await self.augmented_ig_search(
                    "ICH M11 CeSHarP section structure mandatory content protocol "
                    "objectives estimands eligibility schedule of activities safety reporting",
                    domains=["TS", "TI", "TV", "TA"],
                    top_k=8,
                )
            except Exception:
                pass

        # ── Feature 5: Memory Retrieval ────────────────────────────────────
        memories = context.extra.get("memory_context", [])
        top_memories = retrieve_relevant_memories("ich_m11_conversion", context.__dict__, memories, top_k=3)
        memory_block = build_memory_context_block(top_memories, "ich_m11_conversion") if top_memories else ""

        # ── Load inputs ────────────────────────────────────────────────────
        protocol_text = context.extra.get("protocol_text", "")
        usdm_data     = context.extra.get("usdm_data")

        # Fetch protocol text from agent-runtime if not provided
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

        if not protocol_text:
            findings.append({
                "type": "missing_protocol_text",
                "rule_id": "M11C-001",
                "level": "error",
                "severity": "ERROR",
                "message": "No protocol text available for ICH M11 conversion.",
            })

        # ── Core Logic: LLM-powered section extraction ─────────────────────
        m11_document: dict[str, dict] = {}
        sections_extracted = 0
        sections_missing_critical = []

        for section in _M11_SECTIONS:
            sid   = section["id"]
            title = section["title"]
            hint  = section["prompt_hint"]
            is_critical = sid in CRITICAL_SECTION_IDS

            extracted_content = ""

            # First try to get content from USDM data structural mapping
            if usdm_data:
                extracted_content = _extract_from_usdm(sid, usdm_data)

            # LLM extraction when USDM didn't fully cover this section
            if not extracted_content and protocol_text:
                text_window = protocol_text[:4000]
                if memory_block:
                    memory_hint = f"\nPRIOR PATTERNS:\n{memory_block[:500]}\n"
                else:
                    memory_hint = ""
                prompt = (
                    f"You are a clinical trial protocol specialist applying the ICH M11 CeSHarP standard.\n"
                    f"Task: Extract content for ICH M11 Section {sid}: {title}\n\n"
                    f"Instruction: {hint}\n"
                    f"{memory_hint}\n"
                    f"From the protocol text below, identify and extract all relevant content for this section.\n"
                    f"If content for this section is absent or insufficient, respond with: "
                    f"'MISSING: [brief description of what should be here per ICH M11]'\n\n"
                    f"Protocol text:\n{text_window}\n\n"
                    f"Extracted content for {sid} — {title}:"
                )
                extracted_content = await _llm_extract(prompt)

            empty = not extracted_content or extracted_content.strip().startswith("MISSING:")
            if empty:
                if is_critical:
                    sections_missing_critical.append(sid)
                    findings.append({
                        "type": "missing_critical_m11_section",
                        "rule_id": f"M11C-{sid}",
                        "level": "error",
                        "severity": "ERROR",
                        "section_id": sid,
                        "message": f"Critical ICH M11 section {sid} ({title}) could not be extracted — requires human input.",
                    })
                else:
                    findings.append({
                        "type": "missing_m11_section",
                        "rule_id": f"M11C-{sid}",
                        "level": "warning",
                        "severity": "WARNING",
                        "section_id": sid,
                        "message": f"ICH M11 section {sid} ({title}) content missing or incomplete.",
                    })
            else:
                sections_extracted += 1

            m11_document[sid] = {
                "id": sid,
                "title": title,
                "content": extracted_content,
                "status": "missing" if empty else "extracted",
                "critical": is_critical,
            }

        # ── Feature 3: Validation Escalation ──────────────────────────────
        escalation_result = self.escalate_findings(
            [f for f in findings if f.get("level") == "error"], domain="PROTOCOL"
        )
        blocked = self.is_blocked(escalation_result)
        esc_summary = self.escalation_summary(escalation_result)

        # ── Feature 2: Confidence-Based Execution Branching ────────────────
        confidence = self.compute_confidence(
            evidence_count=sections_extracted + (1 if protocol_text else 0),
            quality_signals=[
                sections_extracted / 14.0,
                max(0.0, 1.0 - len(sections_missing_critical) / len(CRITICAL_SECTION_IDS)),
            ],
            validation_methods=["usdm_mapping", "llm_extraction", "section_coverage"],
        )
        branch = self.branch_on_confidence(
            confidence,
            thresholds={"proceed": 0.70, "escalate": 0.40, "defer": 0.20},
            context_hint="M11 protocol conversion gate",
        )

        # ── Feature 4: Contextual Prompt Injection for HITL ───────────────
        if (sections_missing_critical or confidence < 0.70) and not context.is_test_run:
            prior_corrections = context.extra.get("prior_corrections", [])
            hitl_ctx = self.build_hitl_context(prior_corrections, domain="PROTOCOL")
            base_desc = (
                f"ICH M11 conversion: {sections_extracted}/14 sections extracted. "
                f"Critical sections needing human input: {sections_missing_critical}. "
                f"Confidence: {confidence:.2f}. "
                f"Please complete the missing sections to achieve ICH M11 compliance."
            )
            if memory_block:
                base_desc += f"\n\nPRIOR PATTERNS:\n{memory_block}"
            hitl_desc = inject_hitl_context_into_description(base_desc, hitl_ctx)
            await context.notification_client.notify(
                user_id=context.extra.get("reviewer_id", "protocol-reviewer"),
                title=f"ICH M11 Conversion Review Required: {context.study_name}",
                body=hitl_desc,
                severity="error" if sections_missing_critical else "warning",
            )

        report_md = _build_report(context, m11_document, sections_extracted,
                                  sections_missing_critical, confidence, branch, esc_summary)
        artifact = await context.artifact_store.save_report(
            title=f"ICH_M11_Protocol_{context.protocol_number}",
            content=report_md,
        )

        m11_json_artifact = await context.artifact_store.save_report(
            title=f"ICH_M11_Protocol_{context.protocol_number}_JSON",
            content=json.dumps(m11_document, indent=2),
        )

        return AgentOutput(
            summary=(
                f"ICH M11 conversion: {sections_extracted}/14 sections extracted. "
                f"{len(sections_missing_critical)} critical sections missing. "
                f"Confidence: {confidence:.2f}."
            ),
            findings=findings,
            artifacts=[a for a in [artifact, m11_json_artifact] if a],
            metadata={
                "sections_extracted":      sections_extracted,
                "sections_total":          14,
                "sections_missing":        [s for s, d in m11_document.items() if d["status"] == "missing"],
                "sections_missing_critical": sections_missing_critical,
                "m11_document":            {sid: d["status"] for sid, d in m11_document.items()},
                "confidence":              confidence,
                "branch_action":           branch.action,
                "blocked":                 blocked,
                "escalation":              escalation_result.get("escalation_policy"),
            },
        )


async def _llm_extract(prompt: str) -> str:
    if LLM_PROVIDER == "bedrock":
        try:
            import boto3
            body = {
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 3000,
                "temperature": 0.1,
                "messages": [
                    {"role": "user", "content": [{"type": "text", "text": prompt}]}
                ],
            }
            client = boto3.client("bedrock-runtime", region_name=AWS_REGION)
            resp = await asyncio.to_thread(
                client.invoke_model,
                modelId=BEDROCK_MODEL_ID,
                body=json.dumps(body),
                contentType="application/json",
                accept="application/json",
            )
            data = json.loads(resp["body"].read())
            content = data.get("content") or []
            if content and isinstance(content[0], dict):
                return str(content[0].get("text") or "").strip()
        except Exception:
            pass

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{OLLAMA_URL}/api/generate",
                json={"model": OLLAMA_MODEL, "prompt": prompt, "stream": False},
            )
            if resp.status_code == 200:
                return resp.json().get("response", "").strip()
    except Exception:
        pass
    return ""


def _extract_from_usdm(section_id: str, usdm_data: dict) -> str:
    study   = usdm_data.get("study", usdm_data)
    versions = study.get("versions", [])
    version  = versions[0] if versions else {}
    designs  = version.get("studyDesigns", [])
    design   = designs[0] if designs else {}

    if section_id == "S01":
        title   = study.get("officialTitle") or study.get("studyTitle", "")
        sponsor = study.get("studyIdentifiers", [{}])[0].get("text", "")
        ver_id  = version.get("versionIdentifier", "")
        if title:
            return f"Title: {title}\nVersion: {ver_id}\nSponsor/ID: {sponsor}"
    elif section_id == "S03":
        indications = design.get("indications", [])
        if indications:
            return "Indications: " + "; ".join(
                i.get("description", str(i)) for i in indications if i
            )
    elif section_id == "S04":
        objectives = design.get("objectives", [])
        if objectives:
            lines = []
            for obj in objectives:
                ep_count = len(obj.get("endpoints", []))
                lines.append(f"- {obj.get('description', '')[:200]} [{ep_count} endpoint(s)]")
            return "\n".join(lines)
    elif section_id == "S05":
        population = design.get("population", {})
        criteria   = population.get("criteria", []) + version.get("eligibilityCriteria", [])
        if criteria:
            lines = []
            for c in criteria:
                cat = c.get("category", {}).get("code", "") if isinstance(c.get("category"), dict) else ""
                txt = c.get("criterion", c.get("text", ""))
                lines.append(f"[{cat}] {txt[:200]}")
            return "\n".join(lines[:30])
    elif section_id == "S06":
        arms   = design.get("arms", design.get("studyArms", []))
        epochs = design.get("epochs", design.get("studyEpochs", []))
        if arms or epochs:
            arm_names   = [a.get("name", "") for a in arms]
            epoch_names = [e.get("name", "") for e in epochs]
            return f"Arms: {', '.join(arm_names)}\nEpochs: {', '.join(epoch_names)}"
    elif section_id == "S08":
        timelines = design.get("scheduleTimelines", [])
        encounters = design.get("encounters", [])
        if timelines or encounters:
            return (
                f"{len(timelines)} schedule timeline(s), "
                f"{len(encounters)} encounter(s) defined in USDM."
            )
    elif section_id == "S09":
        estimands = design.get("estimands", [])
        if estimands:
            return f"{len(estimands)} estimand(s): " + "; ".join(
                e.get("description", "")[:100] for e in estimands if e
            )
    return ""


def _build_report(context, m11_document, sections_extracted,
                  missing_critical, confidence, branch, esc_summary) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    status_icon = {"extracted": "✅", "missing": "❌"}
    lines = [
        "# ICH M11 CeSHarP Protocol Conversion Report",
        f"**Study:** {context.study_name}  |  **Protocol:** {context.protocol_number}",
        f"**Generated:** {ts}",
        "",
        f"## Conversion Summary: **{sections_extracted}/14 sections extracted**",
        f"**Confidence:** {confidence:.2f}  |  **Branch:** {branch.action}",
        "",
        "## Section Extraction Status",
        "| ID | Section | Status | Critical |",
        "|----|---------|--------|----------|",
    ]
    for sid, sec in m11_document.items():
        icon = status_icon.get(sec["status"], "—")
        crit = "🔴 Yes" if sec["critical"] else "No"
        lines.append(f"| {sid} | {sec['title']} | {icon} {sec['status']} | {crit} |")

    if missing_critical:
        lines += ["", "## Critical Sections Requiring Human Completion",
                  *[f"- **{sid}** — {_SECTION_INDEX[sid]['title']}" for sid in missing_critical]]

    lines += ["", "## Extracted Content"]
    for sid, sec in m11_document.items():
        if sec["status"] == "extracted" and sec["content"]:
            lines += [
                f"", f"### {sid} — {sec['title']}",
                sec["content"][:1000] + ("..." if len(sec["content"]) > 1000 else ""),
            ]

    if missing_critical:
        lines += ["", "## Sections Needing Human Input"]
        for sid in missing_critical:
            sec = m11_document.get(sid, {})
            lines += [
                f"", f"### {sid} — {_SECTION_INDEX[sid]['title']} *(MISSING — CRITICAL)*",
                f"_{_SECTION_INDEX[sid]['prompt_hint']}_",
                "", "> **[Human reviewer: please complete this section]**",
            ]

    lines += [
        "", esc_summary or "",
        "", "---",
        "*Generated by TrialOS Protocol ICH M11 Converter v1.0.0 (ICH M11 CeSHarP v2 / USDM v4.0)*",
    ]
    return "\n".join(lines)
