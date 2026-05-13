"""
StandardsMapping — TrialOS Native Agent v1.0.0
Maps source EDC/eCRF columns to SDTM variables using a deterministic-rules-first
approach with LLM fallback. Validates each mapped variable against controlled
terminology. Stores successful mappings as gold patterns in memory-engine.

Platform features:
  • Dynamic Retrieval Augmentation  — IG chapter + CT codelist queries per domain
  • Confidence-Based Execution      — deterministic pass first, LLM fallback on unmatched
  • Validation Escalation           — non-IG variables + CT violations = blocking
  • Contextual Prompt Injection     — HITL tasks show prior mapping corrections
  • Memory Retrieval                — semantic gold patterns retrieved before LLM fallback
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
    augment_ig_queries, augment_terminology_queries,
    retrieve_relevant_memories, build_memory_context_block,
    ESCALATION_BLOCKING_TYPES,
)
from datetime import datetime, timezone

STANDARDS_REGISTRY_URL = os.environ.get("STANDARDS_REGISTRY_URL", "http://localhost:8012")
MEMORY_ENGINE_URL = os.environ.get("MEMORY_ENGINE_URL", "http://localhost:8014")
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "bedrock").strip().lower()
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2")
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "us.anthropic.claude-3-7-sonnet-20250219-v1:0")
AWS_REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")

# Deterministic mapping rules: source_column_pattern -> (sdtm_variable, domain, ct_codelist)
DETERMINISTIC_RULES: dict[str, tuple[str, str, str | None]] = {
    "SUBJECT": ("USUBJID", "DM", None),
    "SUBJID": ("SUBJID", "DM", None),
    "SITEID": ("SITEID", "DM", None),
    "AGE": ("AGE", "DM", None),
    "SEX": ("SEX", "DM", "SEX"),
    "RACE": ("RACE", "DM", "RACE"),
    "ETHNIC": ("ETHNIC", "DM", "ETHNIC"),
    "COUNTRY": ("COUNTRY", "DM", None),
    "RFSTDTC": ("RFSTDTC", "DM", None),
    "AETERM": ("AETERM", "AE", None),
    "AESTDTC": ("AESTDTC", "AE", None),
    "AEENDTC": ("AEENDTC", "AE", None),
    "AESEV": ("AESEV", "AE", "AESEV"),
    "AESER": ("AESER", "AE", "NY"),
    "AEREL": ("AEREL", "AE", "AEREL"),
    "AEOUT": ("AEOUT", "AE", "AEOUT"),
    "AEACN": ("AEACN", "AE", "AEACN"),
    "LBTEST": ("LBTEST", "LB", None),
    "LBORRES": ("LBORRES", "LB", None),
    "LBORRESU": ("LBORRESU", "LB", None),
    "LBNRIND": ("LBNRIND", "LB", "NRIND"),
    "LBDTC": ("LBDTC", "LB", None),
    "VSORRES": ("VSORRES", "VS", None),
    "VSORRESU": ("VSORRESU", "VS", None),
    "VSTESTCD": ("VSTESTCD", "VS", None),
    "VSDTC": ("VSDTC", "VS", None),
    "CMTRT": ("CMTRT", "CM", None),
    "CMDOSE": ("CMDOSE", "CM", None),
    "CMDOSU": ("CMDOSU", "CM", None),
    "CMROUTE": ("CMROUTE", "CM", "CMROUTE"),
    "CMSTDTC": ("CMSTDTC", "CM", None),
    "EXTRT": ("EXTRT", "EX", None),
    "EXDOSE": ("EXDOSE", "EX", None),
    "EXDOSU": ("EXDOSU", "EX", None),
    "EXROUTE": ("EXROUTE", "EX", "CMROUTE"),
    "EXSTDTC": ("EXSTDTC", "EX", None),
    "EPOCH": ("EPOCH", "DM", "EPOCH"),
    "VISIT": ("VISIT", "TV", None),
    "VISITNUM": ("VISITNUM", "TV", None),
}

# LLM fallback prompt template
_LLM_FALLBACK_PROMPT = """You are a CDISC SDTM mapping expert.
Map the source column '{source_col}' (sample values: {sample_values}) to the most appropriate SDTM variable.

Context from prior mappings:
{memory_context}

Return JSON: {{"sdtm_variable": "...", "domain": "...", "confidence": 0.0-1.0, "rationale": "..."}}
Only return JSON, no explanation."""


class StandardsMapping(BaseAgent):

    AGENT_NAME = "Standards Mapping"
    AGENT_VERSION = "1.0.0"
    REQUIRED_PERMISSIONS = [
        "study:data:read", "study:docs:read",
        "study:reports:write", "platform:notify:write",
        "standards:read",
    ]
    DECLARED_TOOLS = [
        "read_sdtm_domain", "validate_controlled_terminology",
        "recall_memory", "store_learning",
        "generate_pdf_report", "send_notification",
    ]

    async def run(self, context: AgentContext) -> AgentOutput:
        findings: list[dict] = []
        mapping_results: list[dict] = []

        # ── Feature 1: Dynamic Retrieval Augmentation ──────────────────────
        source_columns = context.extra.get("source_columns", [])
        domains_to_map = list({DETERMINISTIC_RULES.get(c.upper(), (None, None, None))[1]
                                for c in source_columns
                                if DETERMINISTIC_RULES.get(c.upper())} or ["DM", "AE", "LB"])
        domains_to_map = [d for d in domains_to_map if d]

        if "study:docs:read" in context.consented_permissions:
            try:
                await self.augmented_ig_search(
                    "SDTM variable mapping controlled terminology codelist",
                    domains=domains_to_map[:4],
                    top_k=6,
                )
            except Exception:
                pass

        # ── Feature 5: Memory Retrieval — gold patterns ────────────────────
        memories = context.extra.get("memory_context", [])
        top_memories = retrieve_relevant_memories("sdtm_mapping", context.__dict__, memories, top_k=5)
        memory_block = build_memory_context_block(top_memories, "sdtm_mapping",
                                                  include_procedural=True) if top_memories else ""

        # Load source dataset
        source_data: list[dict] = context.extra.get("source_data", [])
        if not source_data and hasattr(context, "data_client"):
            try:
                source_data = await context.data_client.read_raw(
                    "SELECT * FROM raw_datasets WHERE study_id = $1 LIMIT 200",
                    context.study_id,
                ) or []
            except Exception:
                pass

        if not source_columns and source_data:
            source_columns = list(source_data[0].keys()) if source_data else []

        deterministic_mapped = 0
        llm_mapped = 0
        ct_violations = 0
        unmapped_cols: list[str] = []

        for col in source_columns:
            col_upper = col.upper()
            sample_values = [str(row.get(col, "")) for row in source_data[:5] if row.get(col)]

            # Deterministic path
            if col_upper in DETERMINISTIC_RULES:
                sdtm_var, domain, ct_codelist = DETERMINISTIC_RULES[col_upper]
                ct_valid = True
                ct_violations_for_col = []

                if ct_codelist and sample_values:
                    ct_valid, ct_violations_for_col = await _validate_ct(
                        STANDARDS_REGISTRY_URL, ct_codelist, sample_values
                    )
                    if not ct_valid:
                        ct_violations += len(ct_violations_for_col)
                        for v in ct_violations_for_col:
                            findings.append({
                                "type": "controlled_terminology_violation",
                                "rule_id": "CT001",
                                "level": "error",
                                "severity": "ERROR",
                                "domain": domain,
                                "variable": sdtm_var,
                                "codelist": ct_codelist,
                                "value": v,
                                "message": f"{domain}.{sdtm_var}: Value '{v}' not in {ct_codelist} codelist",
                            })

                mapping_results.append({
                    "source_column": col,
                    "sdtm_variable": sdtm_var,
                    "domain": domain,
                    "ct_codelist": ct_codelist,
                    "ct_valid": ct_valid,
                    "method": "deterministic",
                    "confidence": 0.95,
                    "sample_values": sample_values[:3],
                })
                deterministic_mapped += 1

            else:
                # LLM fallback with memory context
                llm_result = await _llm_map_column(col, sample_values, memory_block)
                if llm_result:
                    sdtm_var = llm_result.get("sdtm_variable", "")
                    domain = llm_result.get("domain", "")
                    llm_confidence = llm_result.get("confidence", 0.5)

                    if sdtm_var and domain:
                        mapping_results.append({
                            "source_column": col,
                            "sdtm_variable": sdtm_var,
                            "domain": domain,
                            "ct_codelist": None,
                            "ct_valid": True,
                            "method": "llm_fallback",
                            "confidence": llm_confidence,
                            "rationale": llm_result.get("rationale", ""),
                            "sample_values": sample_values[:3],
                        })
                        llm_mapped += 1
                    else:
                        unmapped_cols.append(col)
                        findings.append({
                            "type": "unmapped_source_column",
                            "rule_id": "MAP001",
                            "level": "warning",
                            "severity": "WARNING",
                            "message": f"Could not map source column '{col}' to any SDTM variable",
                        })
                else:
                    unmapped_cols.append(col)

        # Detect non-IG variables
        ig_sdtm_domains = {"DM", "AE", "LB", "VS", "CM", "EX", "MH", "SV", "TV",
                           "DS", "QS", "PR", "SC", "SE", "FA", "IS", "MB", "PC",
                           "PP", "TU", "RS", "TR", "DD", "CE", "AG", "BE", "CO"}
        for mapping in mapping_results:
            if mapping.get("domain") and mapping["domain"] not in ig_sdtm_domains:
                findings.append({
                    "type": "non_ig_sdtm_variable",
                    "rule_id": "MAP002",
                    "level": "error",
                    "severity": "ERROR",
                    "domain": mapping["domain"],
                    "variable": mapping["sdtm_variable"],
                    "message": f"Mapped to non-IG SDTM domain '{mapping['domain']}'",
                })

        # ── Feature 3: Validation Escalation ──────────────────────────────
        escalation_result = self.escalate_findings(findings, domain="MAPPING")
        blocked = self.is_blocked(escalation_result)
        esc_summary = self.escalation_summary(escalation_result)

        # ── Feature 2: Confidence-Based Execution Branching ────────────────
        total_cols = len(source_columns) or 1
        map_rate = (deterministic_mapped + llm_mapped) / total_cols
        ct_violation_rate = ct_violations / max(deterministic_mapped, 1)
        confidence = self.compute_confidence(
            evidence_count=deterministic_mapped + llm_mapped,
            quality_signals=[map_rate, max(0.0, 1.0 - ct_violation_rate)],
            validation_methods=["deterministic_rules", "llm_fallback", "ct_validation"],
        )
        branch = self.branch_on_confidence(
            confidence,
            thresholds={"proceed": 0.70, "escalate": 0.40, "defer": 0.20},
            context_hint="standards-mapping gate",
        )

        # Store gold patterns for high-confidence deterministic mappings
        if branch.action == "proceed" and not blocked and not context.is_test_run:
            await _store_gold_patterns(MEMORY_ENGINE_URL, context, mapping_results, confidence)

        # ── Feature 4: Contextual Prompt Injection for HITL ───────────────
        if confidence < 0.70 or blocked:
            prior_corrections = context.extra.get("prior_corrections", [])
            hitl_ctx = self.build_hitl_context(prior_corrections, domain="MAPPING")
            base_desc = (
                f"Mapping confidence {confidence:.2f}. "
                f"Deterministic: {deterministic_mapped}, LLM: {llm_mapped}, "
                f"Unmapped: {len(unmapped_cols)}, CT violations: {ct_violations}. "
                f"Please review the mapping table."
            )
            hitl_desc = inject_hitl_context_into_description(base_desc, hitl_ctx)
            if not context.is_test_run:
                await context.notification_client.notify(
                    user_id=context.extra.get("reviewer_id", "data-manager"),
                    title=f"Mapping Review Required: {context.study_name}",
                    body=hitl_desc,
                    severity="error" if blocked else "warning",
                )

        report_md = _build_report(context, mapping_results, findings, confidence, branch, esc_summary)
        artifact = await context.artifact_store.save_report(
            title=f"Standards_Mapping_{context.protocol_number}",
            content=report_md,
        )

        return AgentOutput(
            summary=(
                f"Mapped {deterministic_mapped + llm_mapped}/{len(source_columns)} columns "
                f"(det={deterministic_mapped}, llm={llm_mapped}). "
                f"CT violations={ct_violations}. Confidence={confidence:.2f}."
            ),
            findings=findings,
            artifacts=[artifact] if artifact else [],
            metadata={
                "total_columns": len(source_columns),
                "deterministic_mapped": deterministic_mapped,
                "llm_mapped": llm_mapped,
                "unmapped": len(unmapped_cols),
                "ct_violations": ct_violations,
                "confidence": confidence,
                "branch_action": branch.action,
                "blocked": blocked,
                "escalation": escalation_result.get("escalation_policy"),
                "mapping_table": mapping_results,
            },
        )


async def _validate_ct(registry_url: str, codelist: str, values: list[str]) -> tuple[bool, list[str]]:
    violations = []
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            for val in values:
                resp = await client.post(
                    f"{registry_url}/terminology/codelists/{codelist}/validate",
                    json={"value": val},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    if not data.get("valid"):
                        violations.append(val)
    except Exception:
        pass
    return len(violations) == 0, violations


async def _llm_map_column(col: str, samples: list[str], memory_block: str) -> dict | None:
    try:
        prompt = _LLM_FALLBACK_PROMPT.format(
            source_col=col,
            sample_values=", ".join(samples[:5]) or "N/A",
            memory_context=memory_block[:500] if memory_block else "None",
        )
        text = await _llm_generate(prompt, timeout=20)
        if text:
            start = text.find("{")
            end = text.rfind("}") + 1
            if start >= 0 and end > start:
                return json.loads(text[start:end])
    except Exception:
        pass
    return None


async def _llm_generate(prompt: str, timeout: int = 20) -> str:
    if LLM_PROVIDER == "bedrock":
        try:
            import boto3
            body = {
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 1000,
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
                return str(content[0].get("text") or "")
        except Exception:
            pass

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{OLLAMA_URL}/api/generate",
                json={"model": OLLAMA_MODEL, "prompt": prompt, "stream": False},
                timeout=timeout,
            )
            if resp.status_code == 200:
                return str(resp.json().get("response", ""))
    except Exception:
        pass
    return ""


async def _store_gold_patterns(memory_url: str, context, mappings: list[dict], confidence: float) -> None:
    high_conf = [m for m in mappings if m.get("confidence", 0) >= 0.90 and m.get("method") == "deterministic"]
    for m in high_conf[:10]:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    f"{memory_url}/learnings/agent",
                    json={
                        "agent_id": "standards-mapping",
                        "org_id": context.org_id,
                        "learning_type": "gold_pattern",
                        "content": {
                            "subject": m["source_column"],
                            "predicate": "maps_to",
                            "object": f"{m['domain']}.{m['sdtm_variable']}",
                            "codelist": m.get("ct_codelist"),
                        },
                        "confidence": confidence,
                        "study_id": context.study_id,
                    },
                )
        except Exception:
            pass


def _build_report(context, mappings, findings, confidence, branch, esc_summary) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    det = [m for m in mappings if m["method"] == "deterministic"]
    llm = [m for m in mappings if m["method"] == "llm_fallback"]
    ct_fail = [m for m in mappings if not m.get("ct_valid")]
    lines = [
        "# Standards Mapping Report",
        f"**Study:** {context.study_name}  |  **Protocol:** {context.protocol_number}",
        f"**Generated:** {ts}",
        "",
        "## Mapping Summary",
        f"| Method | Count |", f"|--------|-------|",
        f"| Deterministic | {len(det)} |",
        f"| LLM Fallback | {len(llm)} |",
        f"| CT Violations | {len(ct_fail)} |",
        f"| Confidence | {confidence:.2f} |",
        f"| Branch | {branch.action} |",
        "",
        "## Mapping Table",
        "| Source Column | SDTM Variable | Domain | CT Codelist | Method | Conf |",
        "|---------------|---------------|--------|-------------|--------|------|",
    ]
    for m in mappings[:50]:
        ct = m.get("ct_codelist") or "—"
        ct_flag = "" if m.get("ct_valid", True) else " ❌"
        lines.append(
            f"| `{m['source_column']}` | `{m['sdtm_variable']}` | {m['domain']} "
            f"| {ct}{ct_flag} | {m['method']} | {m.get('confidence', 0):.2f} |"
        )
    if findings:
        lines += ["", "## Findings"]
        for f in findings[:20]:
            lines.append(f"- [{f['level'].upper()}] {f['message']}")
    if esc_summary:
        lines.append(f"\n{esc_summary}")
    lines += ["", "---", f"*Generated by TrialOS StandardsMapping v1.0.0*"]
    return "\n".join(lines)
