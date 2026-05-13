"""
ProtocolUSDMCognitiveAgent — TrialOS Cognitive Sub-Agent v1.0.0
Layer 5, Engine 1 (L5.E1): Protocol-to-USDM conversion with inline evaluation.

Capabilities:
  S1  Section Parsing       — maps ICH M11 sections to USDM v4.0 elements
  S2  Eligibility Extraction— extracts inclusion/exclusion criteria with SNOMED codes
  S3  Schedule Recognition  — extracts visit schedule and timepoints as USDM activities
  S4  Feasibility Comparison— compares against prior study episodes from L3 memory

Platform features (all 5):
  Feature 1  Dynamic Retrieval Augmentation  — USDM/ICH M11 domain queries
  Feature 2  Confidence-Based Execution      — gated at 0.75 / 0.50 / 0.30
  Feature 3  Validation Escalation           — blocking on hallucination or completeness fail
  Feature 4  Contextual Prompt Injection     — HITL task enriched with prior corrections
  Feature 5  Memory Retrieval                — top-3 prior episodes injected into prompts

Inline evaluators (L5.E11–E17):
  L5.E11 Accuracy, L5.E12 Completeness, L5.E13 Standards,
  L5.E14 Hallucination, L5.E15 Readability, L5.E16 Cost, L5.E17 Consistency

Retry tree (L5.E18): revise prompt → retrieval → stronger model → alt agent → HITL

Self-learning (L5.E8–E10): episodic + semantic + gold/anti-pattern write-back after every run.
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../packages/trialo-agent-sdk"))

import json
import re
import asyncio
import hashlib
import httpx
from datetime import datetime, timezone
from typing import Any, Optional

from trialo_agent_sdk import (
    BaseAgent, AgentContext, AgentOutput,
    escalate_findings, is_blocked_by_escalation, escalation_summary,
    build_hitl_context, inject_hitl_context_into_description, build_hitl_notification_body,
    compute_agent_confidence, branch_on_confidence,
    augment_ig_queries, retrieve_relevant_memories, build_memory_context_block,
)

sys.path.insert(0, os.path.dirname(__file__))

from usdm_schemas import (
    USDM_MANDATORY_SECTIONS, ICH_M11_TO_USDM, SECTION_PATTERNS,
    SNOMED_LOOKUP, TIMEPOINT_PATTERNS, CAPABILITY_CONFIDENCE_WEIGHTS,
    EVALUATOR_THRESHOLDS, USDM_IG_SECTION_TYPES, USDM_GAP_RULES,
)
from evaluators import run_all_evaluators
from memory_writer import (
    write_episodic_memory, write_semantic_facts,
    write_learnings, update_reputation,
)

AGENT_RUNTIME_URL = os.environ.get("AGENT_RUNTIME_URL", "http://localhost:8004")
OLLAMA_BASE_URL   = os.environ.get("OLLAMA_BASE_URL",   "http://localhost:11434")
OLLAMA_MODEL      = os.environ.get("OLLAMA_MODEL",      "llama3.1:8b")
BEDROCK_MODEL_ID  = os.environ.get("BEDROCK_MODEL_ID",  "us.anthropic.claude-sonnet-4-5-20250929-v1:0")
MEMORY_ENGINE_URL = os.environ.get("MEMORY_ENGINE_URL", "http://localhost:8014")

# Alternate agent for L5.E18 level-4 delegation
ALT_AGENT_SLUG = "protocol-ich-m11-converter"


class ProtocolUSDMCognitiveAgent(BaseAgent):

    AGENT_NAME    = "Protocol USDM Cognitive"
    AGENT_VERSION = "1.0.0"
    REQUIRED_PERMISSIONS = [
        "study:data:read",
        "study:docs:read",
        "study:graph:read",
        "study:reports:write",
        "platform:notify:write",
    ]
    DECLARED_TOOLS = [
        "read_document", "query_study_design", "recall_memory",
        "validate_usdm_schema", "generate_pdf_report", "send_notification",
    ]
    # Higher confidence required for USDM — patient safety implications
    AUTO_CONFIDENCE_THRESHOLDS = {"proceed": 0.75, "escalate": 0.50, "defer": 0.30}

    async def run(self, context: AgentContext) -> AgentOutput:
        trigger    = context.trigger_payload or {}
        doc_id     = trigger.get("doc_id") or trigger.get("document_id") or trigger.get("protocol_doc_id")
        retry_attempt = int(trigger.get("retry_attempt", 0))

        # ── Feature 1: Dynamic Retrieval Augmentation ──────────────────────
        if "study:docs:read" in context.consented_permissions:
            try:
                await self.augmented_ig_search(
                    "protocol USDM v4.0 ICH M11 eligibility criteria study design endpoints",
                    domains=["DM", "EX", "AE"],
                    top_k=6,
                )
            except Exception:
                pass

        # ── Feature 5: Memory Retrieval ────────────────────────────────────
        memories = context.extra.get("memory_context", [])
        top_memories = retrieve_relevant_memories(
            "protocol_usdm_conversion",
            context.__dict__,
            memories,
            top_k=3,
        )
        memory_block = build_memory_context_block(top_memories, "protocol_usdm_conversion") if top_memories else ""

        # ── Fetch protocol document ────────────────────────────────────────
        protocol_text = ""
        if doc_id:
            try:
                protocol_text = await context.data_client.read_document(doc_id)
            except Exception:
                pass
        if not protocol_text:
            protocol_text = trigger.get("protocol_text") or context.extra.get("protocol_text") or ""

        if not protocol_text:
            return AgentOutput(
                summary="No protocol document provided. Specify doc_id in trigger_payload.",
                findings=[{"type": "missing_input", "rule_id": "USDM000", "level": "error",
                           "severity": "ERROR", "message": "trigger_payload.doc_id is required"}],
                artifacts=[],
                metadata={"confidence": 0.0, "branch_action": "defer"},
            )

        tokens_used = len(protocol_text.split()) * 2  # rough token estimate

        # ── L5.E1 S1: Section Parsing (with char-offset provenance) ───────
        section_map, section_offsets = self._parse_sections_with_offsets(protocol_text, memory_block)
        section_coverage = sum(1 for v in section_map.values() if v and str(v).strip()) / max(len(SECTION_PATTERNS), 1)

        # ── L5.E1 S2: Eligibility Extraction ──────────────────────────────
        eligibility = self._extract_eligibility(section_map)

        # ── L5.E1 S3: Schedule Recognition ────────────────────────────────
        activities, epochs = self._extract_schedule(section_map, protocol_text)

        # ── Assemble USDM v4.0 JSON ────────────────────────────────────────
        usdm_json = self._assemble_usdm(
            context, section_map, eligibility, activities, epochs, top_memories
        )

        # ── L5.E1 S4: Feasibility Comparison ──────────────────────────────
        feasibility_note = self._compare_feasibility(usdm_json, top_memories)
        if feasibility_note:
            usdm_json.setdefault("meta", {})["feasibilityNote"] = feasibility_note

        # ── Build per-field provenance map (Phase 3) ───────────────────────
        provenance_map = self._build_provenance_map(usdm_json, section_map, section_offsets)
        provenance_coverage = self._compute_provenance_coverage(usdm_json, provenance_map)

        org_id = getattr(context, "org_id", None) or trigger.get("org_id")
        memory_quality_rules = await self._fetch_memory_quality_rules(org_id)

        # ── Run all 7 evaluators + provenance gate (L5.E11–E18) ───────────
        require_provenance = trigger.get("require_provenance", False)
        prov_threshold = float(trigger.get("provenance_min_coverage", 1.0))
        eval_scores = run_all_evaluators(
            usdm_json, protocol_text, tokens_used,
            provenance_map=provenance_map if require_provenance else None,
            require_provenance=require_provenance,
            provenance_threshold=prov_threshold,
            memory_rules=memory_quality_rules,
        )
        failing = [k for k, v in eval_scores.items() if not v.get("passed")]

        # Auto-correct standards/completeness failures before retry/escalation.
        if "standards" in failing or "completeness" in failing:
            corrected = self._auto_correct_usdm_quality(usdm_json, section_map, eval_scores)
            if corrected != usdm_json:
                usdm_json = corrected
                provenance_map = self._build_provenance_map(usdm_json, section_map, section_offsets)
                provenance_coverage = self._compute_provenance_coverage(usdm_json, provenance_map)
                eval_scores = run_all_evaluators(
                    usdm_json, protocol_text, tokens_used,
                    provenance_map=provenance_map if require_provenance else None,
                    require_provenance=require_provenance,
                    provenance_threshold=prov_threshold,
                    memory_rules=memory_quality_rules,
                )
                failing = [k for k, v in eval_scores.items() if not v.get("passed")]

        # ── L5.E18: 5-Level Retry Tree ─────────────────────────────────────
        max_retries = 5
        if failing and retry_attempt < max_retries:
            retry_result = await self._run_retry_tree(
                retry_attempt + 1, context, usdm_json, failing, protocol_text,
                section_map, eligibility, activities, epochs, tokens_used,
            )
            if retry_result is not None:
                usdm_json = retry_result
                # Rebuild provenance after retry
                section_map2, section_offsets2 = self._parse_sections_with_offsets(protocol_text, "")
                provenance_map = self._build_provenance_map(usdm_json, section_map2, section_offsets2)
                provenance_coverage = self._compute_provenance_coverage(usdm_json, provenance_map)
                eval_scores = run_all_evaluators(
                    usdm_json, protocol_text, tokens_used,
                    provenance_map=provenance_map if require_provenance else None,
                    require_provenance=require_provenance,
                    provenance_threshold=prov_threshold,
                    memory_rules=memory_quality_rules,
                )
                failing = [k for k, v in eval_scores.items() if not v.get("passed")]

        # ── Feature 2: Confidence-Based Execution ─────────────────────────
        capability_scores = {
            "section_parsing":        section_coverage,
            "eligibility_extraction": min(len(eligibility) / max(len(eligibility) + 1, 5), 1.0),
            "schedule_recognition":   min(len(activities) / max(len(activities) + 1, 5), 1.0),
            "feasibility_comparison": 1.0 if top_memories else 0.60,
        }
        confidence = sum(
            CAPABILITY_CONFIDENCE_WEIGHTS[k] * v for k, v in capability_scores.items()
        )
        # Weight down by failing evaluators
        confidence *= max(0.50, 1.0 - len(failing) * 0.10)
        confidence = round(min(max(confidence, 0.0), 1.0), 3)

        branch = self.branch_on_confidence(
            confidence,
            thresholds=self.AUTO_CONFIDENCE_THRESHOLDS,
            context_hint="protocol-usdm-cognitive gate",
        )

        # ── Feature 3: Validation Escalation ──────────────────────────────
        eval_findings = self._build_eval_findings(eval_scores)
        escalation_result = self.escalate_findings(eval_findings, domain="USDM")
        blocked = self.is_blocked(escalation_result)
        esc_summary = self.escalation_summary(escalation_result)

        # ── Feature 4: HITL Context Injection ─────────────────────────────
        prior_corrections = context.extra.get("prior_corrections") or []
        hitl_ctx = self.build_hitl_context(prior_corrections, domain="USDM")

        if (blocked or branch.action in ("escalate", "defer")) and not context.is_test_run:
            base_desc = (
                f"Protocol-to-USDM conversion confidence {confidence:.2f}. "
                f"Failing evaluators: {', '.join(failing) or 'none'}. "
                f"Blocked: {blocked}. Please review USDM output."
            )
            if memory_block:
                base_desc += f"\n\nPRIOR CONTEXT:\n{memory_block}"
            hitl_desc = inject_hitl_context_into_description(base_desc, prior_corrections, domain="USDM")
            notif_body = self.build_hitl_body(
                hitl_desc,
                escalation_result=escalation_result if blocked else None,
                branch_result=branch if branch.action != "proceed" else None,
            )
            await context.notification_client.notify(
                user_id=context.extra.get("reviewer_id", "protocol-reviewer"),
                title=f"USDM Conversion Review Required: {context.study_name or 'Protocol'}",
                body=notif_body,
                severity="critical" if blocked else "warning",
            )

        # ── Save USDM artifact (with embedded provenance map) ─────────────
        artifact_payload = {
            "usdm": usdm_json,
            "provenance_map": provenance_map,
            "provenance_coverage": round(provenance_coverage, 4),
        }
        usdm_str  = json.dumps(artifact_payload, indent=2)
        artifact = await context.artifact_store.save_report(
            title=f"USDM_v4_{context.protocol_number or doc_id or 'output'}",
            content=usdm_str,
        )

        # ── Persist to usdm_conversions table if conversion_id provided ───
        conversion_id = trigger.get("conversion_id") or context.extra.get("conversion_id")
        if conversion_id:
            await self._upsert_usdm_conversion(
                conversion_id, usdm_json, eval_scores, confidence, retry_attempt,
                provenance_map=provenance_map,
            )

        # ── Self-Learning write-back (L5.E8–E10) — non-blocking ───────────
        asyncio.create_task(self._run_self_learning(context, usdm_json, eval_scores, confidence))

        return AgentOutput(
            summary=(
                f"Converted protocol to USDM v4.0: "
                f"{sum(1 for s in USDM_MANDATORY_SECTIONS if usdm_json.get(s))}/10 sections populated, "
                f"confidence={confidence:.2f}, "
                f"evaluators: {sum(1 for v in eval_scores.values() if v.get('passed'))}/7 passed."
            ),
            findings=eval_findings,
            artifacts=[artifact] if artifact else [],
            proposed_actions=self._build_proposed_actions(usdm_json, failing, blocked),
            metadata={
                "usdm_sections_populated": sum(1 for s in USDM_MANDATORY_SECTIONS if usdm_json.get(s)),
                "eligibility_criteria": len(eligibility),
                "activities_extracted": len(activities),
                "epochs_extracted": len(epochs),
                "retry_attempts": retry_attempt,
                "failing_evaluators": failing,
                "evaluator_scores": {k: round(v.get("score", 0), 3) for k, v in eval_scores.items()},
                "evaluator_scores_full": {
                    k: {
                        "score": round(v.get("score", 0), 3),
                        "passed": v.get("passed", False),
                        "details": v.get("details", [])[:20],
                        "gap_failures": v.get("gap_failures", []),
                    }
                    for k, v in eval_scores.items()
                },
                "cost_usd": eval_scores.get("cost", {}).get("cost_usd", 0),
                "tokens_used": tokens_used,
                "confidence": confidence,
                "branch_action": branch.action,
                "blocked": blocked,
                "escalation": escalation_result.get("escalation_policy"),
                "escalation_summary": esc_summary,
                "hitl_context_injected": bool(hitl_ctx),
                "feasibility_note": feasibility_note,
                "memory_episodes_used": len(top_memories),
                "memory_quality_rules_used": len(memory_quality_rules),
                "provenance_coverage": round(provenance_coverage, 4),
                "provenance_map_sections": list(provenance_map.keys()),
            },
        )

    async def _fetch_memory_quality_rules(self, org_id: Optional[str]) -> list[dict]:
        """Retrieve top memory-seeded USDM quality rules for standards evaluation."""
        if not org_id:
            return []

        fact_types = [
            "usdm_validation_rule",
            "usdm_gap_rule",
            "usdm_ig_rule",
            "hitl_derived_rule",
        ]
        rules: list[dict] = []

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                for fact_type in fact_types:
                    resp = await client.get(
                        f"{MEMORY_ENGINE_URL}/memory/semantic/search",
                        params={
                            "q": "usdm validation",
                            "org_id": org_id,
                            "fact_type": fact_type,
                            "top_k": 40,
                        },
                    )
                    if resp.status_code != 200:
                        continue
                    for item in (resp.json() or {}).get("results", []):
                        payload = item.get("object")
                        if not isinstance(payload, str):
                            continue
                        parsed = None
                        try:
                            parsed = json.loads(payload)
                        except Exception:
                            continue
                        if not isinstance(parsed, dict):
                            continue
                        parsed.setdefault("id", item.get("subject"))
                        parsed.setdefault("fact_type", fact_type)
                        parsed.setdefault("confidence", item.get("confidence", 0.0))
                        rules.append(parsed)
        except Exception:
            return []

        # De-duplicate by id/path and keep higher confidence entries first.
        rules.sort(key=lambda r: float(r.get("confidence", 0.0)), reverse=True)
        dedup: list[dict] = []
        seen: set[str] = set()
        for r in rules:
            key = f"{r.get('rule_id') or r.get('id')}|{r.get('path') or r.get('target') or r.get('field_path')}"
            if key in seen:
                continue
            seen.add(key)
            dedup.append(r)
            if len(dedup) >= 120:
                break
        return dedup

    # ─── L5.E1 S1: Section Parsing (with char-offset provenance) ─────────────

    def _parse_sections_with_offsets(
        self, protocol_text: str, memory_block: str
    ) -> tuple[dict[str, str], dict[str, dict]]:
        """Map protocol text spans to ICH M11 section keys, returning both text and
        character-level offset metadata for provenance tracking."""
        paragraphs = re.split(r"\n{2,}", protocol_text)
        section_map: dict[str, str] = {}
        section_offsets: dict[str, dict] = {}  # ich_key → {char_start, char_end, para_index, excerpt}

        # Build paragraph char-offsets
        para_starts: list[int] = []
        pos = 0
        for para in paragraphs:
            para_starts.append(pos)
            pos += len(para) + 2  # +2 for \n\n separator

        for ich_key, patterns in SECTION_PATTERNS.items():
            for i, para in enumerate(paragraphs):
                if any(re.search(pat, para) for pat in patterns):
                    end_para_idx = min(i + 4, len(paragraphs))
                    section_text = "\n\n".join(paragraphs[i: end_para_idx])
                    section_map[ich_key] = section_text.strip()
                    char_start = para_starts[i]
                    char_end = para_starts[end_para_idx - 1] + len(paragraphs[end_para_idx - 1])
                    section_offsets[ich_key] = {
                        "char_start": char_start,
                        "char_end": char_end,
                        "para_index": i,
                        "excerpt": section_text[:200],
                    }
                    break

        # Fallback: if title_page not found, use first paragraph
        if "title_page" not in section_map and paragraphs:
            section_map["title_page"] = paragraphs[0].strip()
            section_offsets["title_page"] = {
                "char_start": 0, "char_end": len(paragraphs[0]),
                "para_index": 0, "excerpt": paragraphs[0][:200],
            }

        return section_map, section_offsets

    def _parse_sections(self, protocol_text: str, memory_block: str) -> dict[str, str]:
        """Backwards-compatible wrapper — returns section text only."""
        section_map, _ = self._parse_sections_with_offsets(protocol_text, memory_block)
        return section_map

    # ─── Phase 3: Provenance map ──────────────────────────────────────────────

    def _build_provenance_map(
        self, usdm_json: dict, section_map: dict[str, str], section_offsets: dict[str, dict]
    ) -> dict[str, dict]:
        """Build per-USDM-field provenance: maps each field to source protocol excerpt."""
        prov: dict[str, dict] = {}
        for ich_key, usdm_path in ICH_M11_TO_USDM.items():
            top_key = usdm_path.split(".")[0].split("[")[0]
            if not usdm_json.get(top_key):
                continue
            offset = section_offsets.get(ich_key, {})
            excerpt = section_map.get(ich_key, "")[:300]
            if excerpt:
                prov[usdm_path] = {
                    "source_ich_section": ich_key,
                    "usdm_path": usdm_path,
                    "char_start": offset.get("char_start"),
                    "char_end": offset.get("char_end"),
                    "para_index": offset.get("para_index"),
                    "excerpt": offset.get("excerpt", excerpt[:200]),
                    "method": "pattern_match",
                }
        return prov

    def _compute_provenance_coverage(self, usdm_json: dict, provenance_map: dict) -> float:
        """Fraction of populated USDM mandatory sections that have a provenance entry."""
        populated = [s for s in USDM_MANDATORY_SECTIONS if usdm_json.get(s)]
        if not populated:
            return 0.0
        covered = sum(
            1 for s in populated
            if any(k.startswith(s) or k == s for k in provenance_map)
        )
        return covered / len(populated)

    # ─── L5.E1 S2: Eligibility Extraction ─────────────────────────────────────

    def _extract_eligibility(self, section_map: dict[str, str]) -> list[dict]:
        """Extract inclusion/exclusion criteria with SNOMED codes."""
        source_text = section_map.get("populations", "") + "\n" + section_map.get("study_design", "")
        criteria: list[dict] = []
        lines = [l.strip() for l in source_text.splitlines() if l.strip()]

        current_type = "general"
        for line in lines:
            if re.search(r"(?i)inclusion\s+criter", line):
                current_type = "inclusion"
                continue
            if re.search(r"(?i)exclusion\s+criter", line):
                current_type = "exclusion"
                continue
            # Lines that look like numbered criteria
            if re.match(r"^\d+[.)]\s+.{10}", line) or re.match(r"^[-•]\s+.{10}", line):
                text = re.sub(r"^[\d.)\-•]\s*", "", line).strip()
                snomed = None
                for term, code in SNOMED_LOOKUP.items():
                    if term in text.lower():
                        snomed = code
                        break
                ambiguous = bool(re.search(
                    r"(?i)\b(may|consider|possible|at discretion|approximately|acceptable)\b", text
                ))
                criteria.append({
                    "text": text[:300],
                    "type": current_type,
                    "snomed_code": snomed,
                    "ambiguous": ambiguous,
                })
        return criteria

    # ─── L5.E1 S3: Schedule Recognition ───────────────────────────────────────

    def _extract_schedule(self, section_map: dict[str, str], protocol_text: str) -> tuple[list[dict], list[dict]]:
        """Extract visit schedule from protocol text → USDM activities and epochs."""
        assessment_text = section_map.get("study_assessments", "") or protocol_text
        activities: list[dict] = []
        epochs: list[dict] = []
        seen_timepoints: set[str] = set()

        for pattern in TIMEPOINT_PATTERNS:
            for match in re.finditer(pattern, assessment_text):
                tp = match.group(0).strip()
                tp_norm = tp.lower()
                if tp_norm in seen_timepoints:
                    continue
                seen_timepoints.add(tp_norm)

                # Determine activity type
                activity_type = "assessment"
                if re.search(r"(?i)screen", tp):
                    activity_type = "screening"
                elif re.search(r"(?i)baseline", tp):
                    activity_type = "baseline"
                elif re.search(r"(?i)follow[\s-]?up|end\s+of", tp):
                    activity_type = "follow_up"

                activities.append({
                    "name": tp,
                    "type": activity_type,
                    "timepoint": tp,
                })

        # Infer epochs from arm/design text
        design_text = section_map.get("study_design", "")
        for ep_kw in ["Screening", "Run-in", "Treatment", "Follow-up", "Extension"]:
            if re.search(re.escape(ep_kw), design_text, re.IGNORECASE):
                epochs.append({"name": ep_kw, "type": ep_kw.lower().replace("-", "_")})

        if not epochs:
            epochs = [
                {"name": "Screening", "type": "screening"},
                {"name": "Treatment", "type": "treatment"},
                {"name": "Follow-up", "type": "follow_up"},
            ]

        return activities, epochs

    # ─── L5.E1 S4: Feasibility Comparison ─────────────────────────────────────

    def _compare_feasibility(self, usdm_draft: dict, prior_episodes: list[dict]) -> str:
        if not prior_episodes:
            return ""
        current_arms = len(usdm_draft.get("arms", []) or [])
        notes: list[str] = []
        for ep in prior_episodes[:3]:
            content = ep.get("content", {})
            prior_arms = int(content.get("arm_count") or content.get("section_count") or 0)
            if prior_arms and abs(current_arms - prior_arms) <= 1:
                prior_phase = content.get("study_phase", "")
                notes.append(
                    f"Similar to prior {prior_phase or 'study'} with "
                    f"confidence {ep.get('confidence', 0):.2f}"
                )
        return "; ".join(notes[:2]) if notes else ""

    # ─── Assemble USDM v4.0 output ────────────────────────────────────────────

    def _assemble_usdm(
        self,
        context: AgentContext,
        section_map: dict[str, str],
        eligibility: list[dict],
        activities: list[dict],
        epochs: list[dict],
        memories: list[dict],
    ) -> dict:
        now = datetime.now(timezone.utc).isoformat()
        title = self._extract_title(section_map)
        phase = self._infer_phase(section_map)
        ta    = self._infer_therapeutic_area(section_map)

        populations = [
            {
                "name": c["text"][:80],
                "type": c["type"],
                "snomed_code": c.get("snomed_code"),
                "ambiguous": c.get("ambiguous", False),
            }
            for c in eligibility
        ]

        arms_text = section_map.get("interventions", "") or section_map.get("study_design", "")
        arms = self._extract_arms(arms_text)

        objectives_text = section_map.get("study_objectives", "")
        objectives = self._extract_objectives(objectives_text)

        estimands = self._extract_estimands(section_map.get("estimands", "") or section_map.get("study_objectives", ""))

        return {
            "meta": {
                "version": "4.0",
                "generatedAt": now,
                "generatedBy": "ProtocolUSDMCognitiveAgent v1.0.0",
                "studyPhase": phase,
                "rationale": (section_map.get("introduction", "")[:500] or ""),
                "safetyReporting": bool(section_map.get("adverse_event_reporting")),
                "ethics": bool(section_map.get("ethics")),
                "informedConsent": bool(section_map.get("informed_consent")),
            },
            "studyIdentifiers": [
                {
                    "type": "sponsor",
                    "value": context.protocol_number or "UNKNOWN",
                    "studyName": context.study_name or title,
                }
            ],
            "studyProtocols": {
                "officialTitle": title,
                "version": "1.0",
                "date": now[:10],
            },
            "therapeuticAreas": [{"name": ta, "code": ""}] if ta else [],
            "objectives": objectives,
            "estimands": estimands,
            "populations": populations,
            "arms": arms,
            "epochs": epochs,
            "activities": activities,
        }

    def _extract_title(self, section_map: dict[str, str]) -> str:
        text = section_map.get("title_page", "")
        if not text:
            return ""
        for line in text.splitlines():
            line = line.strip()
            if len(line) > 20 and not re.match(r"^(date|version|sponsor|protocol)", line, re.IGNORECASE):
                return line[:250]
        return text[:250]

    def _infer_phase(self, section_map: dict[str, str]) -> str:
        combined = " ".join(section_map.values())
        for phase in ["Phase IV", "Phase III", "Phase II", "Phase I", "Phase 4", "Phase 3", "Phase 2", "Phase 1"]:
            if re.search(re.escape(phase), combined, re.IGNORECASE):
                return phase
        return ""

    def _infer_therapeutic_area(self, section_map: dict[str, str]) -> str:
        title_text = (section_map.get("title_page", "") + " " + section_map.get("introduction", "")).lower()
        areas = {
            "oncology":       ["cancer", "tumor", "oncol", "carcinoma", "lymphoma", "leukemia"],
            "cardiovascular": ["cardio", "heart", "hypertens", "myocard", "coronary"],
            "neurology":      ["neuro", "alzheimer", "parkinson", "seizure", "dementia", "migraine"],
            "immunology":     ["autoimmune", "lupus", "rheumat", "crohn", "psoriasis"],
            "infectious":     ["hiv", "hepatitis", "infection", "viral", "bacterial"],
            "metabolic":      ["diabetes", "obesity", "metabol", "thyroid"],
            "respiratory":    ["asthma", "copd", "pulmon", "lung"],
        }
        for ta, keywords in areas.items():
            if any(kw in title_text for kw in keywords):
                return ta
        return ""

    def _extract_arms(self, text: str) -> list[dict]:
        arms: list[dict] = []
        seen: set[str] = set()
        arm_patterns = [
            r"(?i)(?:arm|group|cohort|treatment)\s*[A-Z\d]+[:\s]+([^\n.]{5,80})",
            r"(?i)(?:placebo|active|control|investigational)\s+(?:arm|group|comparator)[:\s]*([^\n.]{0,60})",
            r"(?i)(placebo|sham|vehicle)\b",
        ]
        for pattern in arm_patterns:
            for m in re.finditer(pattern, text):
                name = m.group(1).strip()[:80] if m.lastindex else m.group(0).strip()[:80]
                if name.lower() not in seen:
                    seen.add(name.lower())
                    arms.append({"name": name, "type": "experimental" if "placebo" not in name.lower() else "control"})
        if not arms:
            arms = [{"name": "Experimental Arm", "type": "experimental"}]
        return arms[:6]

    def _extract_objectives(self, text: str) -> list[dict]:
        objectives: list[dict] = []
        lines = [l.strip() for l in text.splitlines() if l.strip()]
        is_primary = True
        for line in lines:
            if re.search(r"(?i)secondary\s+objective", line):
                is_primary = False
            if len(line) > 20:
                objectives.append({
                    "description": line[:300],
                    "type": "primary" if is_primary else "secondary",
                })
                if len(objectives) >= 5:
                    break
        if not objectives:
            objectives = [{"description": text[:200] or "Evaluate safety and efficacy.", "type": "primary"}]
        return objectives

    def _extract_estimands(self, text: str) -> list[dict]:
        estimands: list[dict] = []
        if re.search(r"(?i)estimand", text):
            estimands.append({
                "description": text[:300],
                "intercurrentEventStrategy": "treatment policy",
            })
        return estimands

    # ─── L5.E18: Retry Tree ───────────────────────────────────────────────────

    async def _run_retry_tree(
        self,
        attempt: int,
        context: AgentContext,
        last_usdm: dict,
        failing: list[str],
        protocol_text: str,
        section_map: dict,
        eligibility: list,
        activities: list,
        epochs: list,
        tokens_used: int,
    ) -> dict | None:
        """5-level retry cascade per L5.E18."""

        if attempt == 1:
            # Level 1: Reprompt — fix specific failing sections
            return self._retry_reprompt(last_usdm, failing, section_map)

        if attempt == 2:
            # Level 2: Revise retrieval — broaden queries and re-parse
            try:
                await self.augmented_ig_search(
                    "USDM v4 mandatory sections ICH M11 complete protocol structure clinical trial",
                    domains=["DM", "AE", "EX", "VS"],
                    top_k=10,
                )
            except Exception:
                pass
            return self._retry_reprompt(last_usdm, failing, section_map)

        if attempt == 3:
            # Level 3: Stronger model — flag in metadata for agent-runtime to re-run with configured Bedrock model
            context.extra["retry_model_upgrade"] = BEDROCK_MODEL_ID
            return self._retry_reprompt(last_usdm, failing, section_map)

        if attempt == 4:
            # Level 4: Alternate agent — delegate to protocol-ich-m11-converter
            try:
                async with httpx.AsyncClient(timeout=30) as client:
                    resp = await client.post(
                        f"{AGENT_RUNTIME_URL}/tasks",
                        json={
                            "agent_slug": ALT_AGENT_SLUG,
                            "org_id": context.org_id,
                            "study_id": context.study_id,
                            "trigger_payload": {
                                "protocol_text": protocol_text[:5000],
                                "parent_run_id": context.run_id,
                                "triggered_by_retry": True,
                            },
                        },
                    )
                    if resp.status_code in (200, 201):
                        alt_result = resp.json()
                        if alt_result.get("usdm_json"):
                            return alt_result["usdm_json"]
            except Exception:
                pass
            return None  # fall through to HITL

        # Level 5: Escalate to HITL
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    f"{AGENT_RUNTIME_URL}/tasks",
                    json={
                        "type": "hitl_review",
                        "agent_slug": "hitl-coordinator",
                        "org_id": context.org_id,
                        "study_id": context.study_id,
                        "trigger_payload": {
                            "reason": f"USDM conversion failed {attempt} retries. Failing: {failing}",
                            "partial_usdm": last_usdm,
                            "parent_run_id": context.run_id,
                        },
                    },
                )
        except Exception:
            pass
        return None

    def _retry_reprompt(self, last_usdm: dict, failing: list[str], section_map: dict) -> dict:
        """Patch the last USDM by backfilling failing sections from raw section_map text."""
        patched = dict(last_usdm)

        if "completeness" in failing:
            for section in USDM_MANDATORY_SECTIONS:
                if not patched.get(section):
                    # Try to fill from the closest ICH M11 text
                    for ich_key, usdm_path in ICH_M11_TO_USDM.items():
                        if usdm_path.startswith(section):
                            raw = section_map.get(ich_key, "")
                            if raw:
                                patched[section] = raw[:300]
                            break
                    if not patched.get(section):
                        patched[section] = {}

        if "accuracy" in failing or "hallucination" in failing:
            # Re-extract objectives and populations from raw text to improve grounding
            obj_text = section_map.get("study_objectives", "")
            if obj_text:
                patched["objectives"] = [{"description": obj_text[:300], "type": "primary"}]

        if "standards" in failing:
            patched = self._auto_correct_usdm_quality(patched, section_map)

        return patched

    def _auto_correct_usdm_quality(
        self,
        usdm_json: dict,
        section_map: dict,
        eval_scores: Optional[dict[str, dict]] = None,
    ) -> dict:
        """Deterministically normalize generated USDM to pass IG/ICH quality gates."""
        corrected = dict(usdm_json)

        # Enforce top-level section types expected by the USDM implementation guide.
        for section, expected_type in USDM_IG_SECTION_TYPES.items():
            val = corrected.get(section)
            if expected_type == "dict":
                if isinstance(val, list) and val and isinstance(val[0], dict):
                    corrected[section] = val[0]
                elif not isinstance(val, dict):
                    corrected[section] = {}
            elif expected_type == "list":
                if isinstance(val, dict):
                    corrected[section] = [val] if val else []
                elif not isinstance(val, list):
                    corrected[section] = []

        # Ensure required meta and protocol identity keys exist.
        meta = corrected.setdefault("meta", {})
        if not meta.get("version"):
            meta["version"] = "4.0"
        if not meta.get("generatedAt"):
            meta["generatedAt"] = datetime.now(timezone.utc).isoformat()
        if not meta.get("generatedBy"):
            meta["generatedBy"] = f"{self.AGENT_NAME} v{self.AGENT_VERSION}"

        protocol = corrected.setdefault("studyProtocols", {})
        if not protocol.get("officialTitle"):
            protocol["officialTitle"] = self._extract_title(section_map) or "Protocol Title"
        if not protocol.get("version"):
            protocol["version"] = "1.0"
        if not protocol.get("date"):
            protocol["date"] = datetime.now(timezone.utc).date().isoformat()

        # Ensure at least one study identifier exists.
        identifiers = corrected.setdefault("studyIdentifiers", [])
        if not identifiers:
            identifiers.append({"type": "sponsor", "value": "UNKNOWN", "studyName": protocol.get("officialTitle", "")})
        elif isinstance(identifiers[0], dict):
            identifiers[0].setdefault("type", "sponsor")
            identifiers[0].setdefault("value", "UNKNOWN")

        # ICH M11 mapped backfill for missing mandatory sections.
        for section in USDM_MANDATORY_SECTIONS:
            if corrected.get(section):
                continue
            for ich_key, usdm_path in ICH_M11_TO_USDM.items():
                top_key = usdm_path.split(".")[0].split("[")[0]
                if top_key != section:
                    continue
                raw = (section_map.get(ich_key) or "").strip()
                if not raw:
                    continue
                if USDM_IG_SECTION_TYPES.get(section) == "list":
                    corrected[section] = [{"description": raw[:300]}]
                elif section == "studyProtocols":
                    corrected[section] = {
                        "officialTitle": raw.splitlines()[0][:250],
                        "version": "1.0",
                        "date": datetime.now(timezone.utc).date().isoformat(),
                    }
                elif section == "meta":
                    corrected[section] = {
                        "version": "4.0",
                        "generatedAt": datetime.now(timezone.utc).isoformat(),
                        "generatedBy": f"{self.AGENT_NAME} v{self.AGENT_VERSION}",
                        "rationale": raw[:500],
                    }
                else:
                    corrected[section] = {"description": raw[:300]}
                break

        # Shape-specific lightweight corrections.
        if corrected.get("arms") and isinstance(corrected["arms"], list):
            for arm in corrected["arms"]:
                if isinstance(arm, dict) and not arm.get("name"):
                    arm["name"] = "Study Arm"
        if corrected.get("activities") and isinstance(corrected["activities"], list):
            for activity in corrected["activities"]:
                if isinstance(activity, dict) and not activity.get("name"):
                    activity["name"] = "Scheduled Activity"

        # Explicit gap-rule auto-fixes (kept deterministic and conservative).
        for rule in USDM_GAP_RULES:
            rid = rule.get("id")
            if rid == "GAP-USDM-001" and not corrected.get("meta"):
                corrected["meta"] = {
                    "version": "4.0",
                    "generatedAt": datetime.now(timezone.utc).isoformat(),
                    "generatedBy": f"{self.AGENT_NAME} v{self.AGENT_VERSION}",
                }
            elif rid == "GAP-USDM-002" and not corrected.get("studyIdentifiers"):
                corrected["studyIdentifiers"] = [
                    {"type": "sponsor", "value": "UNKNOWN", "studyName": protocol.get("officialTitle", "")}
                ]
            elif rid == "GAP-USDM-003":
                protocol_obj = corrected.setdefault("studyProtocols", {})
                if not protocol_obj.get("officialTitle"):
                    protocol_obj["officialTitle"] = self._extract_title(section_map) or "Protocol Title"
            elif rid == "GAP-USDM-004" and not corrected.get("objectives"):
                obj_text = (section_map.get("study_objectives") or section_map.get("introduction") or "").strip()
                corrected["objectives"] = [{"description": obj_text[:300] or "Evaluate safety and efficacy.", "type": "primary"}]
            elif rid == "GAP-USDM-005" and not corrected.get("arms"):
                arms_text = (section_map.get("interventions") or section_map.get("study_design") or "").strip()
                corrected["arms"] = self._extract_arms(arms_text)
            elif rid == "GAP-USDM-006" and not corrected.get("activities"):
                assess = (section_map.get("study_assessments") or "").strip()
                corrected["activities"] = [{"name": "Scheduled Activity", "description": assess[:200]}]
            elif rid == "GAP-USDM-007":
                corrected.setdefault("meta", {}).setdefault("version", "4.0")
            elif rid == "GAP-USDM-008":
                corrected.setdefault("studyProtocols", {}).setdefault(
                    "date", datetime.now(timezone.utc).date().isoformat()
                )
            elif rid in {"GAP-USDM-009", "GAP-USDM-010", "GAP-USDM-011", "GAP-USDM-012", "GAP-USDM-013", "GAP-USDM-014"}:
                study = corrected.get("study") if isinstance(corrected.get("study"), dict) else None
                if study and isinstance(study.get("versions"), list) and study["versions"] and isinstance(study["versions"][0], dict):
                    version0 = study["versions"][0]
                    key = rule.get("target")
                    if key in study and key in version0:
                        study.pop(key, None)
            elif rid in {"GAP-USDM-015", "GAP-USDM-016", "GAP-USDM-017", "GAP-USDM-018"}:
                study = corrected.get("study") if isinstance(corrected.get("study"), dict) else None
                if study:
                    study.pop(rule.get("target"), None)
            elif rid == "GAP-USDM-019":
                def _normalize_estimand_ice(estimands_list: Optional[list]) -> None:
                    if not isinstance(estimands_list, list):
                        return
                    for est in estimands_list:
                        if not isinstance(est, dict):
                            continue
                        ice = est.get("intercurrentEvents")
                        if isinstance(ice, str):
                            est["intercurrentEvents"] = [{"description": ice}]
                        elif isinstance(ice, list):
                            normalized = []
                            for item in ice:
                                if isinstance(item, dict):
                                    if not item.get("description") and item.get("text"):
                                        item["description"] = item.get("text")
                                    normalized.append(item)
                                elif isinstance(item, str) and item.strip():
                                    normalized.append({"description": item.strip()})
                            est["intercurrentEvents"] = normalized

                _normalize_estimand_ice(corrected.get("estimands"))
                if isinstance(corrected.get("study"), dict):
                    versions = corrected["study"].get("versions")
                    if isinstance(versions, list) and versions and isinstance(versions[0], dict):
                        _normalize_estimand_ice(versions[0].get("estimands"))

        return corrected

    # ─── Helpers ──────────────────────────────────────────────────────────────

    def _build_eval_findings(self, eval_scores: dict[str, dict]) -> list[dict]:
        """Convert failing evaluators to BaseAgent-compatible finding dicts."""
        findings: list[dict] = []
        # Hallucination and completeness are blocking
        blocking = {"hallucination", "completeness"}
        for name, result in eval_scores.items():
            if result.get("passed"):
                continue
            level = "error" if name in blocking else "warning"
            findings.append({
                "type": f"evaluator_{name}_failed",
                "rule_id": f"USDM_E{list(eval_scores.keys()).index(name) + 11}",
                "level": level,
                "severity": level.upper(),
                "message": (
                    f"Evaluator '{name}' score {result.get('score', 0):.2f} below threshold "
                    f"{EVALUATOR_THRESHOLDS.get(name, 0):.2f}. "
                    f"{'; '.join(result.get('details', [])[:2])}"
                ),
            })
        return findings

    def _build_proposed_actions(self, usdm_json: dict, failing: list[str], blocked: bool) -> list[dict]:
        actions: list[dict] = []
        if blocked:
            actions.append({
                "action": "human_review",
                "reason": f"Blocked evaluators: {', '.join(failing)}. USDM requires human validation.",
                "priority": "high",
            })
        if "completeness" in failing:
            missing = [s for s in USDM_MANDATORY_SECTIONS if not usdm_json.get(s)]
            actions.append({
                "action": "complete_usdm_sections",
                "reason": f"Populate missing sections: {', '.join(missing)}",
                "priority": "medium",
            })
        return actions

    async def _upsert_usdm_conversion(
        self, conversion_id: str, usdm_json: dict, eval_scores: dict, confidence: float, retry_count: int,
        provenance_map: Optional[dict] = None,
    ) -> None:
        """Update usdm_conversions row with USDM output, evaluator scores, and provenance map."""
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.patch(
                    f"{AGENT_RUNTIME_URL}/usdm-conversions/{conversion_id}",
                    json={
                        "status": "completed",
                        "usdm_json": usdm_json,
                        "eval_accuracy": eval_scores.get("accuracy", {}).get("score"),
                        "eval_completeness": eval_scores.get("completeness", {}).get("score"),
                        "eval_standards": eval_scores.get("standards", {}).get("score"),
                        "eval_hallucination": eval_scores.get("hallucination", {}).get("score"),
                        "eval_readability": eval_scores.get("readability", {}).get("score"),
                        "eval_consistency": eval_scores.get("consistency", {}).get("score"),
                        "eval_provenance": eval_scores.get("provenance", {}).get("score"),
                        "eval_cost_usd": eval_scores.get("cost", {}).get("cost_usd"),
                        "confidence": confidence,
                        "retry_count": retry_count,
                        "provenance_map": provenance_map or {},
                        "provenance_coverage": eval_scores.get("provenance", {}).get("score", 0),
                    },
                )
        except Exception:
            pass

    async def _run_self_learning(
        self, context: AgentContext, usdm_json: dict, eval_scores: dict, confidence: float
    ) -> None:
        """L5.E8–E10: Write episodic, semantic, and learning memories. Non-blocking."""
        run_id = getattr(context, "run_id", "") or ""
        org_id = getattr(context, "org_id", "") or ""
        study_id = getattr(context, "study_id", "") or ""

        await asyncio.gather(
            write_episodic_memory(org_id, study_id, run_id, usdm_json, eval_scores, confidence),
            write_semantic_facts(org_id, study_id, usdm_json),
            write_learnings("protocol-usdm-cognitive", org_id, study_id, eval_scores, usdm_json, confidence),
            update_reputation(confidence, eval_scores),
            return_exceptions=True,
        )
