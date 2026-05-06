"""
Evaluator — TrialOS Native Agent v1.0.0
6-dimension quality scoring for agent run outputs.
Writes results to run_evaluator_results with weighted_score and score_breakdown.
Detects false confidence conditions.

Dimensions: accuracy, compliance, hallucination, readability, consistency, completeness
Weights are task-type specific (sdtm_mapping, conformance_check, narrative_writing, etc.)

Platform features:
  • Dynamic Retrieval Augmentation  — IG + evaluation benchmark queries
  • Confidence-Based Execution      — evaluation confidence reflects evidence quality
  • Validation Escalation           — critical quality failures escalated
  • Contextual Prompt Injection     — HITL descriptions include dimension breakdowns
  • Memory Retrieval                — prior evaluation patterns and calibration data
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

LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "bedrock").strip().lower()
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2")
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "us.anthropic.claude-3-7-sonnet-20250219-v1:0")
AWS_REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")

EVALUATION_WEIGHTS: dict[str, dict[str, float]] = {
    "sdtm_mapping": {
        "accuracy": 0.30, "compliance": 0.30, "hallucination": 0.20,
        "readability": 0.05, "consistency": 0.10, "completeness": 0.05,
    },
    "conformance_check": {
        "accuracy": 0.25, "compliance": 0.35, "hallucination": 0.20,
        "readability": 0.05, "consistency": 0.10, "completeness": 0.05,
    },
    "narrative_writing": {
        "accuracy": 0.20, "compliance": 0.15, "hallucination": 0.25,
        "readability": 0.25, "consistency": 0.10, "completeness": 0.05,
    },
    "protocol_analysis": {
        "accuracy": 0.30, "compliance": 0.25, "hallucination": 0.20,
        "readability": 0.10, "consistency": 0.10, "completeness": 0.05,
    },
    "data_quality": {
        "accuracy": 0.35, "compliance": 0.25, "hallucination": 0.15,
        "readability": 0.05, "consistency": 0.15, "completeness": 0.05,
    },
    "default": {
        "accuracy": 0.25, "compliance": 0.25, "hallucination": 0.20,
        "readability": 0.10, "consistency": 0.10, "completeness": 0.10,
    },
}

LLM_JUDGE_PROMPT = """You are an expert clinical trial AI output evaluator.
Evaluate the following agent output across 6 dimensions. Score each 0.0 to 1.0.

Task type: {task_type}
Agent output summary: {summary}
Agent findings count: {findings_count}
Agent confidence: {agent_confidence}
Evidence count: {evidence_count}

Dimensions:
- accuracy: factual correctness, grounded in source data
- compliance: adherence to CDISC/ICH/FDA standards
- hallucination: absence of fabricated data (1.0 = no hallucination)
- readability: clarity and professional quality
- consistency: internal consistency with prior outputs
- completeness: all required elements present

Return JSON only:
{{"accuracy": 0.0, "compliance": 0.0, "hallucination": 0.0, "readability": 0.0, "consistency": 0.0, "completeness": 0.0, "rationale": "..."}}"""


class Evaluator(BaseAgent):

    AGENT_NAME = "Evaluator"
    AGENT_VERSION = "1.0.0"
    REQUIRED_PERMISSIONS = [
        "study:data:read", "study:reports:write",
        "platform:notify:write",
    ]
    DECLARED_TOOLS = [
        "recall_memory", "generate_pdf_report", "send_notification",
    ]

    async def run(self, context: AgentContext) -> AgentOutput:
        findings: list[dict] = []

        # Target run to evaluate
        target_run = context.extra.get("target_run", {})
        target_run_id = target_run.get("run_id") or context.extra.get("target_run_id")
        task_type = target_run.get("task_type") or context.extra.get("task_type", "default")
        agent_output = target_run.get("output") or context.extra.get("agent_output", {})
        agent_confidence = float(target_run.get("confidence", agent_output.get("metadata", {}).get("confidence", 0.5)))
        evidence_count = int(agent_output.get("metadata", {}).get("evidence_count", 0))

        # ── Feature 1: Dynamic Retrieval Augmentation ──────────────────────
        if "study:docs:read" in context.consented_permissions:
            try:
                await self.augmented_ig_search(
                    f"evaluation quality {task_type} scoring dimensions accuracy compliance",
                    domains=["AE", "DM"],
                    top_k=4,
                )
            except Exception:
                pass

        # ── Feature 5: Memory Retrieval — calibration data ────────────────
        memories = context.extra.get("memory_context", [])
        top_memories = retrieve_relevant_memories(task_type, context.__dict__, memories, top_k=3)
        memory_block = build_memory_context_block(top_memories, task_type) if top_memories else ""

        # Get task-type weights
        weights = EVALUATION_WEIGHTS.get(task_type, EVALUATION_WEIGHTS["default"])

        # Score via LLM judge
        summary = agent_output.get("summary", "No summary available")
        findings_count = len(agent_output.get("findings", []))
        scores = await _llm_judge(task_type, summary, findings_count, agent_confidence, evidence_count)

        # Compute weighted score
        weighted_score = sum(scores.get(dim, 0.0) * weight for dim, weight in weights.items())

        # Detect false confidence
        false_confidence = _detect_false_confidence(agent_confidence, evidence_count,
                                                     scores.get("hallucination", 1.0),
                                                     findings_count)
        if false_confidence:
            findings.append({
                "type": "false_confidence_detected",
                "rule_id": "EVAL001",
                "level": "warning",
                "severity": "WARNING",
                "message": (
                    f"False confidence detected: confidence={agent_confidence:.2f}, "
                    f"evidence={evidence_count}, hallucination_score={scores.get('hallucination', 1.0):.2f}"
                ),
            })

        # Flag low dimension scores
        for dim, score in scores.items():
            if dim == "rationale":
                continue
            threshold = 0.50 if dim in ("compliance", "accuracy") else 0.40
            if score < threshold:
                level = "error" if dim in ("compliance", "accuracy") else "warning"
                findings.append({
                    "type": f"low_{dim}_score",
                    "rule_id": f"EVAL00{list(scores.keys()).index(dim) + 2}",
                    "level": level,
                    "severity": level.upper(),
                    "message": f"Low {dim} score: {score:.2f} (threshold: {threshold:.2f})",
                })

        acceptance = "accepted" if weighted_score >= 0.70 else (
            "conditional" if weighted_score >= 0.55 else "rejected"
        )

        # ── Feature 3: Validation Escalation ──────────────────────────────
        escalation_result = self.escalate_findings(findings, domain="EVALUATION")
        blocked = self.is_blocked(escalation_result)
        esc_summary = self.escalation_summary(escalation_result)

        # ── Feature 2: Confidence-Based Execution Branching ────────────────
        eval_confidence = self.compute_confidence(
            evidence_count=findings_count + evidence_count,
            quality_signals=[weighted_score],
            validation_methods=["llm_judge", "false_confidence_check"],
        )
        branch = self.branch_on_confidence(
            eval_confidence,
            thresholds={"proceed": 0.65, "escalate": 0.40, "defer": 0.20},
            context_hint="evaluator gate",
        )

        # Write evaluation results back to agent-runtime
        await _write_evaluation_result(context, target_run_id, scores, weights,
                                       weighted_score, acceptance, false_confidence)

        # ── Feature 4: Contextual Prompt Injection for HITL ───────────────
        if acceptance == "rejected" and not context.is_test_run:
            prior_corrections = context.extra.get("prior_corrections", [])
            hitl_ctx = self.build_hitl_context(prior_corrections, domain="EVALUATION")
            base_desc = (
                f"Agent run {target_run_id} evaluation: {acceptance.upper()}. "
                f"Weighted score: {weighted_score:.2f}. "
                f"False confidence: {false_confidence}. "
                f"Low scores: {', '.join(d for d, s in scores.items() if isinstance(s, float) and s < 0.50)}. "
                f"Please review output quality."
            )
            hitl_desc = inject_hitl_context_into_description(base_desc, hitl_ctx)
            await context.notification_client.notify(
                user_id=context.extra.get("reviewer_id", "quality-reviewer"),
                title=f"Quality Review Required: {task_type} — {context.study_name}",
                body=hitl_desc,
                severity="error",
            )

        report_md = _build_report(context, scores, weights, weighted_score,
                                  acceptance, false_confidence, findings, eval_confidence, branch)
        artifact = await context.artifact_store.save_report(
            title=f"Evaluation_{target_run_id or context.protocol_number}",
            content=report_md,
        )

        return AgentOutput(
            summary=(
                f"Evaluated {task_type} run. Weighted score: {weighted_score:.2f}. "
                f"Decision: {acceptance}. False confidence: {false_confidence}."
            ),
            findings=findings,
            artifacts=[artifact] if artifact else [],
            metadata={
                "target_run_id": target_run_id,
                "task_type": task_type,
                "score_breakdown": scores,
                "weights": weights,
                "weighted_score": weighted_score,
                "acceptance_decision": acceptance,
                "false_confidence_detected": false_confidence,
                "eval_confidence": eval_confidence,
                "branch_action": branch.action,
                "escalation": escalation_result.get("escalation_policy"),
            },
        )


def _detect_false_confidence(confidence: float, evidence_count: int,
                              hallucination_score: float, tool_calls: int) -> bool:
    if confidence > 0.80 and evidence_count == 0:
        return True
    if confidence > 0.75 and hallucination_score < 0.85:
        return True
    if confidence > 0.70 and tool_calls == 0:
        return True
    return False


async def _llm_judge(task_type: str, summary: str, findings_count: int,
                     agent_confidence: float, evidence_count: int) -> dict:
    try:
        prompt = LLM_JUDGE_PROMPT.format(
            task_type=task_type,
            summary=summary[:500],
            findings_count=findings_count,
            agent_confidence=agent_confidence,
            evidence_count=evidence_count,
        )
        text = await _llm_generate(prompt, timeout=25)
        if text:
            start = text.find("{")
            end = text.rfind("}") + 1
            if start >= 0 and end > start:
                data = json.loads(text[start:end])
                return {k: float(v) if isinstance(v, (int, float)) else v
                        for k, v in data.items()}
    except Exception:
        pass
    # Heuristic fallback
    base = min(0.70, 0.50 + agent_confidence * 0.30)
    return {
        "accuracy": base,
        "compliance": base * 0.95,
        "hallucination": 0.80 if evidence_count > 0 else 0.60,
        "readability": 0.75,
        "consistency": 0.70,
        "completeness": min(0.90, 0.60 + (findings_count / max(findings_count + 1, 1)) * 0.30),
        "rationale": "Heuristic scoring (LLM unavailable)",
    }


async def _llm_generate(prompt: str, timeout: int = 25) -> str:
    if LLM_PROVIDER == "bedrock":
        try:
            import boto3
            body = {
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 1200,
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


async def _write_evaluation_result(context, run_id: str | None, scores: dict,
                                    weights: dict, weighted_score: float,
                                    acceptance: str, false_confidence: bool) -> None:
    if not run_id or context.is_test_run:
        return
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.patch(
                f"http://localhost:8004/runs/{run_id}/evaluation",
                json={
                    "score_breakdown": {k: v for k, v in scores.items() if k != "rationale"},
                    "weighted_score": weighted_score,
                    "weight_config": weights,
                    "acceptance_decision": acceptance,
                    "false_confidence_detected": false_confidence,
                },
            )
    except Exception:
        pass


def _build_report(context, scores, weights, weighted_score, acceptance,
                  false_confidence, findings, confidence, branch) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    decision_icon = "✅" if acceptance == "accepted" else ("⚠️" if acceptance == "conditional" else "❌")
    lines = [
        "# Evaluation Report",
        f"**Study:** {context.study_name}  |  **Generated:** {ts}",
        "",
        f"## Decision: {decision_icon} {acceptance.upper()}",
        f"**Weighted Score:** {weighted_score:.3f}  |  **False Confidence:** {'Yes' if false_confidence else 'No'}",
        "",
        "## Score Breakdown",
        "| Dimension | Score | Weight | Contribution |",
        "|-----------|-------|--------|-------------|",
    ]
    for dim, weight in weights.items():
        score = scores.get(dim, 0.0)
        if not isinstance(score, float):
            continue
        contrib = score * weight
        lines.append(f"| {dim.title()} | {score:.3f} | {weight:.2f} | {contrib:.3f} |")
    if scores.get("rationale"):
        lines += ["", f"*Rationale: {scores['rationale']}*"]
    if findings:
        lines += ["", "## Issues Found"]
        for f in findings[:10]:
            lines.append(f"- [{f['level'].upper()}] {f['message']}")
    lines += [
        "", f"**Eval Confidence:** {confidence:.2f}  |  **Branch:** {branch.action}",
        "", "---", "*Generated by TrialOS Evaluator v1.0.0*",
    ]
    return "\n".join(lines)
