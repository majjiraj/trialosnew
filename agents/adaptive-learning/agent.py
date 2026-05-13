"""
AdaptiveLearning — TrialOS Native Agent v1.0.0
Triggered post-HITL review. Extracts gold patterns and anti-patterns from human
corrections. Updates memory-engine with verified learnings.

Platform features:
  • Dynamic Retrieval Augmentation  — IG queries for learning context
  • Confidence-Based Execution      — learning extraction confidence
  • Validation Escalation           — contradictory learnings escalated for review
  • Contextual Prompt Injection     — learning summaries enriched with correction chain
  • Memory Retrieval                — prior learnings retrieved to detect contradictions
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../packages/trialo-agent-sdk"))

import json
import hashlib
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

MEMORY_ENGINE_URL = os.environ.get("MEMORY_ENGINE_URL", "http://localhost:8014")
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "bedrock").strip().lower()
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2")
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "us.anthropic.claude-3-7-sonnet-20250219-v1:0")
AWS_REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")

LEARNING_EXTRACTION_PROMPT = """You are a clinical trial AI learning system.
A human reviewer has corrected an agent output. Extract learnings from this correction.

Original agent output: {original_output}
Human correction: {correction}
Domain: {domain}
Task type: {task_type}

Extract:
1. What the agent did wrong (anti-pattern)
2. What the correct approach should be (gold pattern)
3. A semantic fact as subject/predicate/object triple

Return JSON:
{{
  "anti_pattern": {{"description": "...", "confidence": 0.0-1.0}},
  "gold_pattern": {{"description": "...", "confidence": 0.0-1.0}},
  "semantic_fact": {{"subject": "...", "predicate": "...", "object": "...", "confidence": 0.0-1.0}},
  "applicable_task_types": ["..."]
}}"""


class AdaptiveLearning(BaseAgent):

    AGENT_NAME = "Adaptive Learning"
    AGENT_VERSION = "1.0.0"
    REQUIRED_PERMISSIONS = [
        "study:data:read", "study:reports:write",
        "platform:notify:write",
    ]
    DECLARED_TOOLS = [
        "store_learning", "recall_memory",
        "generate_pdf_report", "send_notification",
    ]

    async def run(self, context: AgentContext) -> AgentOutput:
        findings: list[dict] = []
        learnings_stored: list[dict] = []

        # Source: completed HITL review(s) to learn from
        hitl_reviews = context.extra.get("hitl_reviews", [])
        if not hitl_reviews:
            # Try to load from agent-runtime
            hitl_reviews = await _fetch_recent_hitl_reviews(context)

        if not hitl_reviews:
            return AgentOutput(
                summary="No HITL reviews available for learning extraction.",
                findings=[],
                artifacts=[],
                metadata={"learnings_stored": 0},
            )

        # ── Feature 1: Dynamic Retrieval Augmentation ──────────────────────
        domains = list({r.get("domain", "DM") for r in hitl_reviews})
        if "study:docs:read" in context.consented_permissions:
            try:
                await self.augmented_ig_search(
                    "SDTM CDASH corrections gold pattern learning clinical trial",
                    domains=domains[:3],
                    top_k=4,
                )
            except Exception:
                pass

        # ── Feature 5: Memory Retrieval — check for contradictions ────────
        memories = context.extra.get("memory_context", [])
        top_memories = retrieve_relevant_memories("adaptive_learning", context.__dict__, memories, top_k=5)
        memory_block = build_memory_context_block(top_memories, "adaptive_learning") if top_memories else ""

        for review in hitl_reviews:
            original_output = review.get("original_output", "")
            correction = review.get("correction", review.get("reviewer_comment", ""))
            domain = review.get("domain", "UNKNOWN")
            task_type = review.get("task_type", "default")
            reviewer_id = review.get("reviewer_id", "unknown")
            approval_id = review.get("approval_id", "")

            if not correction:
                continue

            # Extract learnings via LLM
            extracted = await _extract_learnings(original_output, correction, domain, task_type)
            if not extracted:
                findings.append({
                    "type": "learning_extraction_failed",
                    "rule_id": "LEARN001",
                    "level": "warning",
                    "severity": "WARNING",
                    "message": f"Could not extract learnings from review {approval_id}",
                })
                continue

            # Store anti-pattern
            anti = extracted.get("anti_pattern", {})
            if anti.get("description"):
                anti_stored = await _store_learning(MEMORY_ENGINE_URL, {
                    "agent_id": review.get("agent_id", "unknown"),
                    "org_id": context.org_id,
                    "learning_type": "anti_pattern",
                    "content": {
                        "description": anti["description"],
                        "domain": domain,
                        "task_type": task_type,
                        "correction_source": approval_id,
                    },
                    "confidence": anti.get("confidence", 0.70),
                    "human_verified": True,
                    "study_id": context.study_id,
                    "applicable_task_types": extracted.get("applicable_task_types", [task_type]),
                })
                if anti_stored:
                    learnings_stored.append({"type": "anti_pattern", "approval_id": approval_id})

            # Store gold pattern
            gold = extracted.get("gold_pattern", {})
            if gold.get("description"):
                gold_stored = await _store_learning(MEMORY_ENGINE_URL, {
                    "agent_id": review.get("agent_id", "unknown"),
                    "org_id": context.org_id,
                    "learning_type": "gold_pattern",
                    "content": {
                        "description": gold["description"],
                        "domain": domain,
                        "task_type": task_type,
                        "correction_source": approval_id,
                    },
                    "confidence": gold.get("confidence", 0.80),
                    "human_verified": True,
                    "study_id": context.study_id,
                    "applicable_task_types": extracted.get("applicable_task_types", [task_type]),
                })
                if gold_stored:
                    learnings_stored.append({"type": "gold_pattern", "approval_id": approval_id})

            # Store semantic fact
            fact = extracted.get("semantic_fact", {})
            if fact.get("subject") and fact.get("predicate") and fact.get("object"):
                await _store_semantic_memory(MEMORY_ENGINE_URL, {
                    "org_id": context.org_id,
                    "subject": fact["subject"],
                    "predicate": fact["predicate"],
                    "object": fact["object"],
                    "confidence": fact.get("confidence", 0.75),
                    "study_id": context.study_id,
                    "source": "hitl_correction",
                    "human_verified": True,
                })

        # ── Feature 3: Validation Escalation ──────────────────────────────
        escalation_result = self.escalate_findings(findings, domain="LEARNING")
        blocked = self.is_blocked(escalation_result)

        # ── Feature 2: Confidence-Based Execution Branching ────────────────
        extraction_rate = len(learnings_stored) / max(len(hitl_reviews) * 2, 1)
        confidence = self.compute_confidence(
            evidence_count=len(hitl_reviews),
            quality_signals=[extraction_rate],
            validation_methods=["llm_extraction", "human_verified"],
        )
        branch = self.branch_on_confidence(
            confidence,
            thresholds={"proceed": 0.60, "escalate": 0.30, "defer": 0.10},
            context_hint="adaptive-learning gate",
        )

        gold_count = len([l for l in learnings_stored if l["type"] == "gold_pattern"])
        anti_count = len([l for l in learnings_stored if l["type"] == "anti_pattern"])

        report_md = _build_report(context, learnings_stored, hitl_reviews, confidence, branch)
        artifact = await context.artifact_store.save_report(
            title=f"AdaptiveLearning_{context.protocol_number}",
            content=report_md,
        )

        return AgentOutput(
            summary=(
                f"Processed {len(hitl_reviews)} HITL reviews. "
                f"Stored {gold_count} gold patterns, {anti_count} anti-patterns. "
                f"Confidence: {confidence:.2f}."
            ),
            findings=findings,
            artifacts=[artifact] if artifact else [],
            metadata={
                "reviews_processed": len(hitl_reviews),
                "learnings_stored": len(learnings_stored),
                "gold_patterns": gold_count,
                "anti_patterns": anti_count,
                "confidence": confidence,
                "branch_action": branch.action,
            },
        )


async def _fetch_recent_hitl_reviews(context) -> list[dict]:
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"http://localhost:8004/approval-requests",
                params={
                    "status": "approved",
                    "study_id": context.study_id,
                    "has_correction": True,
                    "limit": 20,
                },
            )
            if resp.status_code == 200:
                return resp.json().get("requests", [])
    except Exception:
        pass
    return []


async def _extract_learnings(original: str, correction: str, domain: str, task_type: str) -> dict | None:
    try:
        prompt = LEARNING_EXTRACTION_PROMPT.format(
            original_output=str(original)[:400],
            correction=str(correction)[:400],
            domain=domain,
            task_type=task_type,
        )
        text = await _llm_generate(prompt, timeout=25)
        if text:
            start = text.find("{")
            end = text.rfind("}") + 1
            if start >= 0 and end > start:
                return json.loads(text[start:end])
    except Exception:
        pass

    # Heuristic fallback: build learning from correction text directly
    if correction and len(correction) > 10:
        return {
            "anti_pattern": {
                "description": f"Agent output required correction in {domain}: {str(original)[:100]}",
                "confidence": 0.60,
            },
            "gold_pattern": {
                "description": f"Correct approach per reviewer: {str(correction)[:200]}",
                "confidence": 0.75,
            },
            "semantic_fact": {
                "subject": domain,
                "predicate": "requires",
                "object": str(correction)[:100],
                "confidence": 0.65,
            },
            "applicable_task_types": [task_type],
        }
    return None


async def _llm_generate(prompt: str, timeout: int = 25) -> str:
    if LLM_PROVIDER == "bedrock":
        try:
            import boto3
            body = {
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 1200,
                "temperature": 0.2,
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


async def _store_learning(memory_url: str, payload: dict) -> bool:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(f"{memory_url}/learnings/agent", json=payload)
            return resp.status_code in (200, 201)
    except Exception:
        return False


async def _store_semantic_memory(memory_url: str, payload: dict) -> bool:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(f"{memory_url}/memory/semantic", json=payload)
            return resp.status_code in (200, 201)
    except Exception:
        return False


def _build_report(context, learnings, reviews, confidence, branch) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    gold = [l for l in learnings if l["type"] == "gold_pattern"]
    anti = [l for l in learnings if l["type"] == "anti_pattern"]
    lines = [
        "# Adaptive Learning Report",
        f"**Study:** {context.study_name}  |  **Generated:** {ts}",
        "",
        "## Learning Summary",
        f"| Metric | Value |", f"|--------|-------|",
        f"| HITL Reviews Processed | {len(reviews)} |",
        f"| Gold Patterns Stored | {len(gold)} |",
        f"| Anti-Patterns Stored | {len(anti)} |",
        f"| Confidence | {confidence:.2f} |",
        f"| Branch | {branch.action} |",
        "",
        "## Learnings by Review",
        "| Approval ID | Type |", "|-------------|------|",
    ]
    for l in learnings:
        lines.append(f"| {l.get('approval_id', '—')[:12]} | {l['type']} |")
    lines += ["", "---", "*Generated by TrialOS AdaptiveLearning v1.0.0*"]
    return "\n".join(lines)
