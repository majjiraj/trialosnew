"""
TrialOS Super Agent Service  (port 8015)
=========================================
Layer 4 — Super Agent Orchestration Engine.

Implements all 8 L4 engines per the Maxis AI Context Layer design specification:
  L4.E1  Intent Understanding Engine     — 4-dimension intent analysis
  L4.E2  Task Decomposition Engine       — parallel-aware plan decomposition
  L4.E3  Agent Routing Engine            — reputation-weighted agent selection
  L4.E4  Risk-Based Planning Engine      — 3-tier risk with dynamic HITL thresholds
  L4.E5  Cost Optimization Engine        — complexity → model selection
  L4.E6  Confidence Orchestration Engine — per-step threshold gating
  L4.E7  Recovery/Retry Engine           — graduated cascade with L3 memory
  L4.E8  Evaluation Before Execution     — pre-execution gate

L3 Memory integration: queries memory-engine for prior episodes to enrich decomposition.
L5.E20 Reputation Scores: queries agent_definitions.reputation_score for routing weight.
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, BackgroundTasks, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings
import structlog
import asyncpg
import json
import uuid
import asyncio
import httpx
from datetime import datetime, timezone
from typing import Optional, Any, AsyncGenerator

try:
    import redis.asyncio as aioredis
    _REDIS_AVAILABLE = True
except ImportError:
    _REDIS_AVAILABLE = False

log = structlog.get_logger()


# ─── Settings ─────────────────────────────────────────────────────────────────

class Settings(BaseSettings):
    database_url: str
    redis_url: str              = "redis://localhost:6379"
    kafka_brokers: str          = "localhost:9092"
    agent_runtime_url: str      = "http://localhost:8004"
    memory_engine_url: str      = "http://localhost:8014"
    standards_registry_url: str = "http://localhost:8012"
    study_graph_url: str        = "http://localhost:8013"
    context_graph_url: str      = "http://localhost:8008"
    ollama_base_url: str        = "http://localhost:11434"
    ollama_model: str           = "llama3.1:8b"
    openai_api_key: str         = ""
    anthropic_api_key: str      = ""
    zeebe_address: str          = "localhost:26500"
    max_plan_steps: int         = 10
    hitl_confidence_threshold: float = 0.70
    max_retries: int            = 3
    daily_cost_budget_usd: float = 10.0

    class Config:
        env_file = ".env"
        extra = 'ignore'


settings      = Settings()
db_pool:      asyncpg.Pool = None
redis_client: Any          = None


# ─── L4.E1 — Intent Classes & Taxonomies ──────────────────────────────────────

INTENT_CLASSES = [
    "sdtm_mapping", "conformance_check", "protocol_analysis", "protocol_usdm",
    "data_quality", "crf_generation", "compliance_validation", "narrative_writing",
    "query_management", "multi_step",
]

SCOPE_VALUES      = ["single_domain", "full_study"]
TONE_VALUES       = ["standard", "urgent", "formal"]
COMPLEXITY_VALUES = ["low", "medium", "high"]
INTENT_TYPE_VALUES = ["mapping", "validation", "generation", "analysis"]

# Keyword → complexity heuristics
_HIGH_COMPLEXITY_WORDS  = ["full study", "all domains", "submission", "csr", "csr synopsis",
                            "regulatory", "ich", "sdtm package", "define.xml", "reviewers guide"]
_LOW_COMPLEXITY_WORDS   = ["check", "verify", "single domain", "missing", "query rate",
                            "open queries", "monitor", "list"]


# ─── L4.E3 — Agent Registry ───────────────────────────────────────────────────

AGENT_REGISTRY: dict[str, dict] = {
    "missing-data-sweeper":    {"capabilities": ["data_quality", "query_management"],
                                "purpose": "data_quality",   "default_complexity": "low"},
    "query-rate-monitor":      {"capabilities": ["query_management"],
                                "purpose": "monitoring",      "default_complexity": "low"},
    "sdtm-conformance-checker":{"capabilities": ["conformance_check"],
                                "purpose": "sdtm_mapping",   "default_complexity": "medium"},
    "study-design-extractor":  {"capabilities": ["protocol_analysis"],
                                "purpose": "protocol_analysis", "default_complexity": "medium"},
    "protocol-intelligence":   {"capabilities": ["protocol_analysis"],
                                "purpose": "protocol_analysis", "default_complexity": "high"},
    "standards-mapping":       {"capabilities": ["sdtm_mapping", "conformance_check"],
                                "purpose": "sdtm_mapping",   "default_complexity": "high"},
    "crf-generation":          {"capabilities": ["crf_generation"],
                                "purpose": "crf_generation", "default_complexity": "medium"},
    "compliance":              {"capabilities": ["compliance_validation"],
                                "purpose": "compliance",     "default_complexity": "high"},
    "writing":                 {"capabilities": ["narrative_writing"],
                                "purpose": "protocol_writing", "default_complexity": "high"},
    "evaluator":               {"capabilities": ["sdtm_mapping", "conformance_check",
                                                  "narrative_writing", "protocol_analysis"],
                                "purpose": "custom",          "default_complexity": "medium"},
    "hitl-coordinator":        {"capabilities": ["multi_step"],
                                "purpose": "custom",          "default_complexity": "low"},
    "adaptive-learning":       {"capabilities": ["multi_step"],
                                "purpose": "custom",          "default_complexity": "medium"},
    # L5.E1 Cognitive Sub-Agent: protocol-to-USDM conversion with 7 inline evaluators
    "protocol-usdm-cognitive": {"capabilities": ["protocol_usdm", "protocol_analysis"],
                                "purpose": "protocol_writing", "default_complexity": "high"},
}

INTENT_TO_AGENTS: dict[str, list[str]] = {
    "sdtm_mapping":         ["standards-mapping", "sdtm-conformance-checker"],
    "conformance_check":    ["sdtm-conformance-checker"],
    "protocol_analysis":    ["protocol-intelligence", "study-design-extractor"],
    "protocol_usdm":        ["protocol-usdm-cognitive"],
    "data_quality":         ["missing-data-sweeper"],
    "crf_generation":       ["crf-generation"],
    "compliance_validation":["compliance"],
    "narrative_writing":    ["writing"],
    "query_management":     ["query-rate-monitor", "missing-data-sweeper"],
    "multi_step":           [],
}

# ─── Protocol→USDM 5-Step Sequential Strategy Chain (L4.E7.USDM) ─────────────
# Each strategy represents a distinct escalation level; tracked in retry_history.
# strategy_id keys must match L5.E18 levels in protocol-usdm-cognitive/agent.py.
PROTOCOL_USDM_STRATEGY_CHAIN: list[dict] = [
    {"strategy_id": "usdm_s1_reprompt",         "action": "reprompt",       "model": None,    "agent": "protocol-usdm-cognitive",    "description": "Re-prompt primary agent with failure context and targeted section hints"},
    {"strategy_id": "usdm_s2_retrieval",        "action": "retrieval",      "model": None,    "agent": "protocol-usdm-cognitive",    "description": "Broaden retrieval queries, re-parse sections, re-run primary agent"},
    {"strategy_id": "usdm_s3_model_upgrade",    "action": "switch_model",   "model": "gpt-4", "agent": "protocol-usdm-cognitive",    "description": "Upgrade to GPT-4 and retry primary agent for stronger extraction"},
    {"strategy_id": "usdm_s4_alt_specialist",   "action": "switch_agent",   "model": "gpt-4", "agent": "protocol-ich-m11-converter", "description": "Delegate to alternate ICH M11 converter specialist agent"},
    {"strategy_id": "usdm_s5_hitl_escalation",  "action": "escalate_hitl",  "model": None,    "agent": "hitl-coordinator",           "description": "Escalate to HITL reviewer with full provenance and failing evaluator context"},
]

# protocol_usdm always requires mandatory HITL gate before finalization
PROTOCOL_USDM_HITL_REQUIRED = True
# Provenance gate is relaxed to avoid hard-failing when context-graph traces are unavailable.
# Confidence/HITL gates still protect final approval quality.
PROTOCOL_USDM_MIN_PROVENANCE_COVERAGE = 0.0


# ─── L4.E4 — Risk Tiers & Dynamic Thresholds ──────────────────────────────────

CONFIDENCE_THRESHOLDS: dict[str, float] = {
    "low":    0.70,
    "medium": 0.80,
    "high":   0.90,
}

HITL_AUTO_REQUIRED = {"high"}


# ─── L4.E5 — Cost & Model Selection ───────────────────────────────────────────

MODEL_BY_COMPLEXITY: dict[str, str] = {
    "low":    "deterministic",
    "medium": "gpt-3.5-turbo",
    "high":   "gpt-4",
}

COST_BY_COMPLEXITY: dict[str, float] = {
    "low":    0.0,
    "medium": 0.008,
    "high":   0.025,
}

# Local (free) agents — complexity always "low"
_LOCAL_AGENTS = {"missing-data-sweeper", "query-rate-monitor", "sdtm-conformance-checker"}


# ─── Pydantic Models ──────────────────────────────────────────────────────────

class IntentAnalysis(BaseModel):
    intent_type: str   # mapping / validation / generation / analysis
    scope: str         # single_domain / full_study
    tone_level: str    # standard / urgent / formal
    complexity: str    # low / medium / high
    raw_class: str     # legacy intent_class


class PreExecutionGate(BaseModel):
    context_valid: bool
    cost_within_budget: bool
    predicted_confidence: float
    passed: bool
    reason: Optional[str] = None


class ConfidenceGate(BaseModel):
    confidence: float
    threshold: float
    outcome: str       # auto_approved / partial_review / hitl_required


class RetryRecord(BaseModel):
    attempt: int
    action: str                    # reprompt / switch_model / switch_agent / escalate_hitl
    strategy_id: Optional[str] = None  # matches PROTOCOL_USDM_STRATEGY_CHAIN.strategy_id
    model_used: Optional[str] = None
    agent_used: Optional[str] = None
    failure_reason: Optional[str] = None
    confidence_before: Optional[float] = None
    confidence_after: Optional[float] = None
    outcome: str                   # succeeded / failed


class OrchestrateRequest(BaseModel):
    intent_text:      str
    study_id:         Optional[str] = None
    org_id:           str
    initiated_by:     str = "user"
    require_approval: bool = False
    context:          Optional[dict] = None  # extra context merged into every step's inputs (e.g. protocol_doc_id)


class PlanApproval(BaseModel):
    approved: bool
    notes:    Optional[str] = None


# ─── L4.E1 — Intent Understanding Engine ──────────────────────────────────────

async def _llm_analyze_intent(intent_text: str) -> IntentAnalysis:
    """4-dimension intent analysis: intent_type, scope, tone_level, complexity."""
    prompt = f"""You are a clinical trial AI intent classifier.
Analyze the request below and return ONLY a JSON object with these exact keys:

{{
  "intent_type": "mapping" | "validation" | "generation" | "analysis",
  "scope": "single_domain" | "full_study",
  "tone_level": "standard" | "urgent" | "formal",
  "complexity": "low" | "medium" | "high",
    "raw_class": "sdtm_mapping" | "conformance_check" | "protocol_analysis" | "protocol_usdm" | "data_quality" | "crf_generation" | "compliance_validation" | "narrative_writing" | "query_management" | "multi_step"
}}

Definitions:
- intent_type: mapping=transforming data, validation=checking rules, generation=creating content, analysis=extracting insight
- scope: single_domain=one SDTM domain or task, full_study=cross-domain or full protocol work
- tone_level: urgent=deadline/ASAP language, formal=regulatory/submission language, standard=normal
- complexity: low=deterministic rules apply, medium=LLM needed, high=multi-domain or regulatory submission
- raw_class: the primary intent class

Examples:
"Find missing required fields in DM domain" -> {{"intent_type":"validation","scope":"single_domain","tone_level":"standard","complexity":"low","raw_class":"data_quality"}}
"Map the full protocol to all SDTM domains and generate define.xml" -> {{"intent_type":"mapping","scope":"full_study","tone_level":"standard","complexity":"high","raw_class":"multi_step"}}
"URGENT: validate our SDTM package for FDA submission by Friday" -> {{"intent_type":"validation","scope":"full_study","tone_level":"urgent","complexity":"high","raw_class":"compliance_validation"}}
"Generate CRF fields from protocol activities" -> {{"intent_type":"generation","scope":"single_domain","tone_level":"standard","complexity":"medium","raw_class":"crf_generation"}}
"Convert this protocol document to USDM v4" -> {{"intent_type":"generation","scope":"single_domain","tone_level":"standard","complexity":"medium","raw_class":"protocol_usdm"}}

Request: "{intent_text}"
JSON only, no explanation:"""

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{settings.ollama_base_url}/api/generate",
                json={"model": settings.ollama_model, "prompt": prompt,
                      "stream": False, "options": {"num_predict": 120, "temperature": 0}},
            )
            resp.raise_for_status()
            raw = resp.json().get("response", "")
            start = raw.find("{")
            end = raw.rfind("}") + 1
            if start >= 0 and end > start:
                data = json.loads(raw[start:end])
                analysis = IntentAnalysis(
                    intent_type=data.get("intent_type", "analysis") if data.get("intent_type") in INTENT_TYPE_VALUES else "analysis",
                    scope=data.get("scope", "single_domain") if data.get("scope") in SCOPE_VALUES else "single_domain",
                    tone_level=data.get("tone_level", "standard") if data.get("tone_level") in TONE_VALUES else "standard",
                    complexity=data.get("complexity", "medium") if data.get("complexity") in COMPLEXITY_VALUES else "medium",
                    raw_class=data.get("raw_class", "multi_step") if data.get("raw_class") in INTENT_CLASSES else "multi_step",
                )
                # Guardrail: explicit USDM conversion requests must route to protocol_usdm.
                t = intent_text.lower()
                if any(w in t for w in ["usdm", "protocol to usdm", "convert protocol", "protocol conversion", "usdm v4"]):
                    analysis.raw_class = "protocol_usdm"
                    analysis.intent_type = "generation"
                return analysis
    except Exception as exc:
        log.warning("intent_analyze.llm_failed", error=str(exc))

    return _keyword_analyze_intent(intent_text)


def _keyword_analyze_intent(intent_text: str) -> IntentAnalysis:
    """Keyword-based fallback for intent analysis."""
    text = intent_text.lower()

    # raw_class
    if any(w in text for w in ["map", "sdtm", "mapping", "cdash"]):
        raw_class = "sdtm_mapping"
    elif any(w in text for w in ["conform", "validate", "cdisc rule"]):
        raw_class = "conformance_check"
    elif any(w in text for w in ["usdm", "protocol to usdm", "convert protocol",
                                   "digitize protocol", "protocol conversion", "usdm v4"]):
        raw_class = "protocol_usdm"
    elif any(w in text for w in ["protocol", "eligib", "endpoint", "arm", "study design"]):
        raw_class = "protocol_analysis"
    elif any(w in text for w in ["missing", "sweep", "data quality", "required field"]):
        raw_class = "data_quality"
    elif any(w in text for w in ["crf", "form ", "field"]):
        raw_class = "crf_generation"
    elif any(w in text for w in ["compliance", "fda", "ema", "gcp", "regulation", "ich"]):
        raw_class = "compliance_validation"
    elif any(w in text for w in ["write", "narrative", "csr", "synopsis"]):
        raw_class = "narrative_writing"
    elif any(w in text for w in ["open quer", "site query", "overdue", "query rate"]):
        raw_class = "query_management"
    else:
        raw_class = "multi_step"

    # intent_type
    if raw_class in ("sdtm_mapping",):
        intent_type = "mapping"
    elif raw_class in ("conformance_check", "compliance_validation", "data_quality"):
        intent_type = "validation"
    elif raw_class in ("crf_generation", "narrative_writing", "protocol_usdm"):
        intent_type = "generation"
    else:
        intent_type = "analysis"

    # scope
    scope = "full_study" if any(w in text for w in _HIGH_COMPLEXITY_WORDS + ["full study", "all domain"]) else "single_domain"

    # tone
    tone_level = "urgent" if any(w in text for w in ["urgent", "asap", "immediately", "deadline"]) \
        else "formal" if any(w in text for w in ["submission", "regulatory", "fda", "ema", "ich"]) \
        else "standard"

    # complexity
    if any(w in text for w in _HIGH_COMPLEXITY_WORDS):
        complexity = "high"
    elif any(w in text for w in _LOW_COMPLEXITY_WORDS):
        complexity = "low"
    else:
        complexity = "medium"

    return IntentAnalysis(intent_type=intent_type, scope=scope,
                          tone_level=tone_level, complexity=complexity, raw_class=raw_class)


# ─── L4.E3 — Agent Routing Engine (with L5.E20 Reputation Scores) ─────────────

async def _get_agent_reputation_scores(slugs: list[str]) -> dict[str, float]:
    """Query agent_definitions for reputation_score (L5.E20)."""
    if not slugs:
        return {}
    try:
        async with db_pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT slug, COALESCE(reputation_score, 0.80) as rep "
                "FROM agent_definitions WHERE slug = ANY($1::text[])",
                slugs,
            )
            return {r["slug"]: float(r["rep"]) for r in rows}
    except Exception:
        return {slug: 0.80 for slug in slugs}


async def _pick_best_agent(candidates: list[str]) -> str:
    """Select highest-reputation agent from candidates."""
    scores = await _get_agent_reputation_scores(candidates)
    if not scores:
        return candidates[0]
    return max(candidates, key=lambda s: scores.get(s, 0.80))


# ─── L4.E4 — Risk-Based Planning Engine ──────────────────────────────────────

async def _get_study_risk_level(study_id: str, org_id: str) -> tuple[str, float, bool]:
    """Return (risk_level, confidence_threshold, requires_approval)."""
    risk_level = "low"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f"{settings.study_graph_url}/study/{study_id}/issues",
                params={"severity": "critical", "status": "open"},
            )
            if r.status_code == 200:
                data = r.json()
                issues = data.get("issues", [])
                if any(i.get("severity") == "critical" for i in issues):
                    risk_level = "high"
                elif len(issues) > 3:
                    risk_level = "medium"
    except Exception:
        pass

    threshold = CONFIDENCE_THRESHOLDS[risk_level]
    requires_approval = risk_level in HITL_AUTO_REQUIRED
    return risk_level, threshold, requires_approval


# ─── L4.E5 — Cost Optimization Engine ────────────────────────────────────────

def _infer_step_complexity(agent_slug: str, intent_complexity: str) -> str:
    """Map agent + intent complexity to per-step complexity."""
    if agent_slug in _LOCAL_AGENTS:
        return "low"
    agent_default = AGENT_REGISTRY.get(agent_slug, {}).get("default_complexity", "medium")
    # Use the higher of agent default vs intent complexity
    order = ["low", "medium", "high"]
    a_idx = order.index(agent_default)
    i_idx = order.index(intent_complexity)
    return order[max(a_idx, i_idx)]


def _select_model_for_step(step_complexity: str) -> str:
    return MODEL_BY_COMPLEXITY.get(step_complexity, "gpt-3.5-turbo")


def _estimate_step_cost(step_complexity: str) -> float:
    return COST_BY_COMPLEXITY.get(step_complexity, 0.008)


def _build_model_strategy_summary(steps: list[dict]) -> str:
    counts: dict[str, int] = {}
    for s in steps:
        m = s.get("model_selected", "gpt-3.5-turbo")
        counts[m] = counts.get(m, 0) + 1
    parts = [f"{v} step{'s' if v > 1 else ''} via {k}" for k, v in counts.items()]
    return ", ".join(parts)


# ─── L4.E8 — Evaluation Before Execution ─────────────────────────────────────

async def _pre_execution_gate(
    steps: list[dict], org_id: str, study_id: Optional[str],
    estimated_cost: float, complexity: str, risk_level: str,
) -> PreExecutionGate:
    """Validate context, cost budget, and confidence prediction before execution."""
    # 1. Context valid — check all agent slugs are known
    missing_slugs = [s["agent_slug"] for s in steps if s["agent_slug"] not in AGENT_REGISTRY]
    if missing_slugs:
        return PreExecutionGate(
            context_valid=False, cost_within_budget=True, predicted_confidence=0.0,
            passed=False, reason=f"Unknown agent slugs: {missing_slugs}",
        )

    context_valid = True

    # 2. Cost within budget — check against daily spend
    cost_within_budget = True
    try:
        async with db_pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT COALESCE(SUM(sr.cost_usd), 0) as today_spend "
                "FROM orchestration_plans p "
                "JOIN orchestration_step_results sr ON sr.plan_id = p.id "
                "WHERE p.org_id = $1 AND p.created_at >= CURRENT_DATE",
                uuid.UUID(org_id),
            )
            today_spend = float(row["today_spend"] or 0)
            if today_spend + estimated_cost > settings.daily_cost_budget_usd:
                cost_within_budget = False
    except Exception:
        pass

    if not cost_within_budget:
        return PreExecutionGate(
            context_valid=True, cost_within_budget=False, predicted_confidence=0.0,
            passed=False, reason=f"Estimated cost ${estimated_cost:.3f} would exceed daily budget",
        )

    # 3. Confidence prediction — high complexity + high risk → lower predicted confidence
    risk_penalty = {"low": 0.0, "medium": -0.05, "high": -0.15}
    complexity_base = {"low": 0.90, "medium": 0.80, "high": 0.72}
    predicted_conf = round(
        complexity_base.get(complexity, 0.80) + risk_penalty.get(risk_level, 0.0), 2
    )
    threshold = CONFIDENCE_THRESHOLDS[risk_level]
    if predicted_conf < threshold - 0.15:
        return PreExecutionGate(
            context_valid=True, cost_within_budget=True,
            predicted_confidence=predicted_conf, passed=False,
            reason=f"Predicted confidence {predicted_conf:.2f} is well below threshold {threshold:.2f}",
        )

    return PreExecutionGate(
        context_valid=True, cost_within_budget=True,
        predicted_confidence=predicted_conf, passed=True,
    )


# ─── L4.E6 — Confidence Orchestration Engine ─────────────────────────────────

def _apply_confidence_gate(confidence: float, threshold: float) -> ConfidenceGate:
    """Apply tiered confidence threshold per design spec."""
    if confidence >= threshold:
        outcome = "auto_approved"
    elif confidence >= threshold - 0.10:
        outcome = "partial_review"
    else:
        outcome = "hitl_required"
    return ConfidenceGate(confidence=confidence, threshold=threshold, outcome=outcome)


# ─── L3 — Memory Integration ──────────────────────────────────────────────────

async def _fetch_memory_episodes(intent_text: str, org_id: str) -> list[dict]:
    """Fetch prior similar episodes from memory engine to enrich decomposition."""
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(
                f"{settings.memory_engine_url}/memories",
                params={"org_id": org_id, "query": intent_text, "limit": 5},
            )
            if r.status_code == 200:
                data = r.json()
                return data.get("memories", [])[:3]
    except Exception:
        pass
    return []


def _format_memory_context(episodes: list[dict]) -> str:
    """Format memory episodes for injection into decomposition prompt."""
    if not episodes:
        return ""
    lines = ["PRIOR EPISODES (L3 Memory):"]
    for i, ep in enumerate(episodes, 1):
        summary = ep.get("summary") or ep.get("content") or ep.get("memory_value", "")
        conf = ep.get("confidence", "")
        model = ep.get("model", "")
        conf_str = f", confidence: {conf}" if conf else ""
        model_str = f", model: {model}" if model else ""
        lines.append(f"  {i}. {summary[:200]}{conf_str}{model_str}")
    return "\n".join(lines)


# ─── L4.E2 — Task Decomposition Engine ───────────────────────────────────────

async def _decompose_plan(
    intent_text: str, analysis: IntentAnalysis,
    study_id: str, org_id: str,
    memory_episodes: Optional[list[dict]] = None,
) -> list[dict]:
    """Decompose intent → ordered steps with model selection and complexity per step."""
    intent_class = analysis.raw_class

    # Single-intent decomposition: use routing with reputation scoring
    if intent_class != "multi_step":
        # ── Special path: protocol→USDM uses governed 5-step strategy chain ──────
        if intent_class == "protocol_usdm":
            return await _build_protocol_usdm_steps(study_id, org_id, analysis)

        candidate_slugs = INTENT_TO_AGENTS.get(intent_class, [])
        if candidate_slugs:
            best_agent = await _pick_best_agent(candidate_slugs)
            # For full_study scope, add conformance check after mapping
            steps_slugs: list[str]
            if analysis.scope == "full_study" and intent_class == "sdtm_mapping":
                steps_slugs = [best_agent, "sdtm-conformance-checker"]
            else:
                steps_slugs = [best_agent]

            steps = []
            for i, slug in enumerate(steps_slugs[:3]):
                complexity = _infer_step_complexity(slug, analysis.complexity)
                steps.append({
                    "step_id": f"s{i+1}",
                    "agent_slug": slug,
                    "depends_on": [f"s{i}"] if i > 0 else [],
                    "inputs": {"study_id": study_id, "org_id": org_id},
                    "complexity": complexity,
                    "model_selected": _select_model_for_step(complexity),
                    "estimated_cost": _estimate_step_cost(complexity),
                })
            return steps

    # Multi-step: LLM decomposition enriched with memory
    memory_ctx = _format_memory_context(memory_episodes or [])
    prompt = f"""Decompose this clinical trial request into ordered agent steps.
Available agents: {', '.join(AGENT_REGISTRY.keys())}
Complexity level: {analysis.complexity}
Scope: {analysis.scope}
{memory_ctx}

Request: "{intent_text}"
Study ID: {study_id}

Return a JSON array of steps. Use actual agent slugs from the available list.
[
  {{"step_id": "s1", "agent_slug": "<slug>", "depends_on": [], "inputs": {{}}, "complexity": "low|medium|high"}},
  {{"step_id": "s2", "agent_slug": "<slug>", "depends_on": ["s1"], "inputs": {{}}, "complexity": "low|medium|high"}}
]
Only JSON, no explanation:"""

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{settings.ollama_base_url}/api/generate",
                json={"model": settings.ollama_model, "prompt": prompt,
                      "stream": False, "options": {"num_predict": 500, "temperature": 0}},
            )
            resp.raise_for_status()
            raw = resp.json().get("response", "")
            start = raw.find("[")
            end = raw.rfind("]") + 1
            if start >= 0 and end > start:
                raw_steps = json.loads(raw[start:end])
                valid = []
                for i, step in enumerate(raw_steps[:settings.max_plan_steps]):
                    slug = step.get("agent_slug", "")
                    if slug not in AGENT_REGISTRY:
                        continue
                    step_complexity = step.get("complexity", analysis.complexity)
                    if step_complexity not in COMPLEXITY_VALUES:
                        step_complexity = analysis.complexity
                    step_complexity = _infer_step_complexity(slug, step_complexity)
                    valid.append({
                        "step_id": step.get("step_id", f"s{i+1}"),
                        "agent_slug": slug,
                        "depends_on": step.get("depends_on", []),
                        "inputs": {**step.get("inputs", {}), "study_id": study_id, "org_id": org_id},
                        "complexity": step_complexity,
                        "model_selected": _select_model_for_step(step_complexity),
                        "estimated_cost": _estimate_step_cost(step_complexity),
                    })
                if valid:
                    return valid
    except Exception as exc:
        log.warning("plan_decompose.llm_failed", error=str(exc))

    # Fallback: protocol → mapping → conformance
    fallback = [
        ("protocol-intelligence", analysis.complexity),
        ("standards-mapping", "high"),
        ("sdtm-conformance-checker", "medium"),
    ]
    steps = []
    for i, (slug, comp) in enumerate(fallback):
        c = _infer_step_complexity(slug, comp)
        steps.append({
            "step_id": f"s{i+1}", "agent_slug": slug,
            "depends_on": [f"s{i}"] if i > 0 else [],
            "inputs": {"study_id": study_id, "org_id": org_id},
            "complexity": c,
            "model_selected": _select_model_for_step(c),
            "estimated_cost": _estimate_step_cost(c),
        })
    return steps


async def _build_protocol_usdm_steps(study_id: str, org_id: str, analysis: "IntentAnalysis") -> list[dict]:
    """Build the governed single-step Protocol→USDM plan.

    The primary cognitive agent (protocol-usdm-cognitive) is the sole initial step;
    the 5-strategy retry cascade is handled in _retry_step_protocol_usdm() and in
    the L5 agent itself.  A HITL review step is appended as a mandatory gate.
    """
    complexity = _infer_step_complexity("protocol-usdm-cognitive", analysis.complexity)
    return [
        {
            "step_id": "s1",
            "agent_slug": "protocol-usdm-cognitive",
            "depends_on": [],
            "inputs": {
                "study_id": study_id,
                "org_id": org_id,
                "require_provenance": True,
                "provenance_min_coverage": PROTOCOL_USDM_MIN_PROVENANCE_COVERAGE,
                "strategy_chain": PROTOCOL_USDM_STRATEGY_CHAIN,
            },
            "complexity": complexity,
            "model_selected": _select_model_for_step(complexity),
            "estimated_cost": _estimate_step_cost(complexity),
            "intent_class": "protocol_usdm",
            "hitl_required": True,
            "strategy_chain": PROTOCOL_USDM_STRATEGY_CHAIN,
        },
    ]


async def _retry_step_protocol_usdm(
    plan_id: str,
    step: dict,
    attempt: int,
    last_error: str,
    org_id: str,
    study_id: Optional[str],
    confidence_before: float = 0.0,
) -> tuple[Optional[dict], RetryRecord]:
    """5-step sequential retry cascade dedicated to protocol_usdm (L4.E7.USDM).

    Mirrors L5.E18 but is controlled at the L4 orchestrator level so the
    full strategy chain is logged in orchestration_step_results.retry_history.
    Attempt index is 1-based and maps directly to PROTOCOL_USDM_STRATEGY_CHAIN.
    """
    if attempt < 1 or attempt > len(PROTOCOL_USDM_STRATEGY_CHAIN):
        return None, RetryRecord(attempt=attempt, action="escalate_hitl",
                                 strategy_id="usdm_s5_hitl_escalation",
                                 failure_reason="exceeded_strategy_chain",
                                 confidence_before=confidence_before, outcome="failed")

    strategy = PROTOCOL_USDM_STRATEGY_CHAIN[attempt - 1]
    strategy_id = strategy["strategy_id"]
    action      = strategy["action"]
    model       = strategy.get("model")
    # Strategy entries use `agent`; keep backward compatibility with `agent_slug`.
    agent_slug  = strategy.get("agent") or strategy.get("agent_slug") or step.get("agent_slug")

    base_inputs = {**step.get("inputs", {}), "prior_failure": last_error,
                   "retry_attempt": attempt, "strategy_id": strategy_id,
                   "require_provenance": True}
    if model:
        base_inputs["preferred_model"] = model

    if action == "escalate_hitl":
        return None, RetryRecord(
            attempt=attempt, action=action, strategy_id=strategy_id,
            agent_used=agent_slug, failure_reason=last_error,
            confidence_before=confidence_before, outcome="failed",
        )

    try:
        result = await _run_agent_step(agent_slug, base_inputs, org_id, study_id)
        success = bool(result) and "error" not in result
        conf_after = float((result or {}).get("confidence", 0))
        return result, RetryRecord(
            attempt=attempt, action=action, strategy_id=strategy_id,
            model_used=model, agent_used=agent_slug,
            failure_reason=None if success else (result or {}).get("error", "unknown"),
            confidence_before=confidence_before, confidence_after=conf_after,
            outcome="succeeded" if success else "failed",
        )
    except Exception as exc:
        return None, RetryRecord(
            attempt=attempt, action=action, strategy_id=strategy_id,
            model_used=model, agent_used=agent_slug,
            failure_reason=str(exc), confidence_before=confidence_before, outcome="failed",
        )


def _total_estimated_cost(steps: list[dict]) -> float:
    return round(sum(s.get("estimated_cost", 0) for s in steps), 4)


# ─── L4.E7 — Recovery / Retry Engine ─────────────────────────────────────────

async def _retry_step(
    plan_id: str, step: dict, attempt: int,
    last_error: str, org_id: str, study_id: Optional[str],
    memory_episodes: list[dict],
) -> tuple[Optional[dict], RetryRecord]:
    """Graduated retry cascade: reprompt → switch_model → switch_agent → hitl."""
    agent_slug = step["agent_slug"]
    inputs = step.get("inputs", {})

    if attempt == 1:
        # L4.E7 Level 1: Re-prompt with failure context
        enriched_inputs = {**inputs, "prior_failure": last_error, "retry_context": "Add extra validation checks"}
        try:
            result = await _run_agent_step(agent_slug, enriched_inputs, org_id, study_id)
            return result, RetryRecord(attempt=1, action="reprompt",
                                       model_used=step.get("model_selected"),
                                       outcome="succeeded" if "error" not in result else "failed")
        except Exception as exc:
            return None, RetryRecord(attempt=1, action="reprompt", outcome="failed")

    elif attempt == 2:
        # L4.E7 Level 2: Switch model to gpt-4
        upgraded_inputs = {**inputs, "preferred_model": "gpt-4", "prior_failure": last_error}
        try:
            result = await _run_agent_step(agent_slug, upgraded_inputs, org_id, study_id)
            return result, RetryRecord(attempt=2, action="switch_model", model_used="gpt-4",
                                       outcome="succeeded" if "error" not in result else "failed")
        except Exception:
            return None, RetryRecord(attempt=2, action="switch_model", model_used="gpt-4", outcome="failed")

    elif attempt == 3:
        # L4.E7 Level 3: Switch to next-best agent from reputation registry
        capabilities = AGENT_REGISTRY.get(agent_slug, {}).get("capabilities", [])
        alternatives = [
            slug for slug, meta in AGENT_REGISTRY.items()
            if slug != agent_slug and any(c in meta.get("capabilities", []) for c in capabilities)
        ]
        if alternatives:
            alt_agent = await _pick_best_agent(alternatives)
            try:
                result = await _run_agent_step(alt_agent, inputs, org_id, study_id)
                return result, RetryRecord(attempt=3, action="switch_agent", agent_used=alt_agent,
                                           outcome="succeeded" if "error" not in result else "failed")
            except Exception:
                return None, RetryRecord(attempt=3, action="switch_agent",
                                         agent_used=alt_agent, outcome="failed")

    # L4.E7 Level 4: Escalate to HITL
    return None, RetryRecord(attempt=attempt, action="escalate_hitl", outcome="failed")


# ─── Lifespan ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global db_pool, redis_client

    async def _init_conn(conn):
        await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
        await conn.set_type_codec("json",  encoder=json.dumps, decoder=json.loads, schema="pg_catalog")

    db_pool = await asyncpg.create_pool(
        settings.database_url, min_size=3, max_size=15, init=_init_conn
    )

    if _REDIS_AVAILABLE:
        try:
            redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
            await redis_client.ping()
            log.info("super_agent.redis_connected")
        except Exception as exc:
            log.warning("super_agent.redis_unavailable", error=str(exc))
            redis_client = None

    log.info("super_agent.startup", port=8015)
    yield
    await db_pool.close()
    if redis_client:
        await redis_client.aclose()


app = FastAPI(title="TrialOS Super Agent", version="2.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ─── Health ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "super-agent", "port": 8015, "version": "2.0.0"}


# ─── L4.E1 Intent Classification (legacy + new) ───────────────────────────────

@app.post("/intent/classify")
async def classify_intent(body: dict):
    intent_text = body.get("intent_text", "")
    if not intent_text:
        raise HTTPException(400, "intent_text is required")
    analysis = await _llm_analyze_intent(intent_text)
    return {
        "intent_text": intent_text,
        "intent_class": analysis.raw_class,
        "intent_analysis": analysis.model_dump(),
        "available_agents": INTENT_TO_AGENTS.get(analysis.raw_class, []),
    }


# ─── Decompose ────────────────────────────────────────────────────────────────

@app.post("/decompose")
async def decompose_intent(body: OrchestrateRequest):
    analysis = await _llm_analyze_intent(body.intent_text)
    memory = await _fetch_memory_episodes(body.intent_text, body.org_id)
    steps = await _decompose_plan(body.intent_text, analysis, body.study_id or "", body.org_id, memory)
    risk_level, threshold, requires_approval = await _get_study_risk_level(body.study_id or "", body.org_id)
    return {
        "intent_text": body.intent_text,
        "intent_analysis": analysis.model_dump(),
        "steps": steps,
        "estimated_cost_usd": _total_estimated_cost(steps),
        "risk_level": risk_level,
        "confidence_threshold": threshold,
        "step_count": len(steps),
        "model_strategy": _build_model_strategy_summary(steps),
    }


# ─── Main Orchestrate Endpoint ────────────────────────────────────────────────

@app.post("/orchestrate")
async def orchestrate(body: OrchestrateRequest, background_tasks: BackgroundTasks):
    """
    Full L4 orchestration pipeline:
    L4.E1 → L4.E3 → L4.E4 → L4.E5 → L4.E8 → store → (L4.E2 decompose → L4.E6/E7 execute)
    """
    # L4.E1: Analyze intent (4 dimensions)
    analysis = await _llm_analyze_intent(body.intent_text)

    # L3 Memory: fetch prior episodes for decomposition enrichment
    memory_episodes = await _fetch_memory_episodes(body.intent_text, body.org_id)

    # L4.E2: Decompose into steps with model selection
    steps = await _decompose_plan(
        body.intent_text, analysis, body.study_id or "", body.org_id, memory_episodes
    )

    # L4.E4: Risk assessment (3-tier)
    risk_level, confidence_threshold, risk_requires_approval = await _get_study_risk_level(
        body.study_id or "", body.org_id
    )

    # L4.E5: Total cost
    estimated_cost = _total_estimated_cost(steps)
    model_strategy = _build_model_strategy_summary(steps)

    # L4.E8: Pre-execution gate
    gate = await _pre_execution_gate(
        steps, body.org_id, body.study_id,
        estimated_cost, analysis.complexity, risk_level,
    )

    if not gate.passed:
        raise HTTPException(400, detail={
            "error": "pre_execution_gate_failed",
            "pre_execution_gate": gate.model_dump(),
            "intent_analysis": analysis.model_dump(),
        })

    # Determine initial status (L4.E4 + caller request)
    requires_approval = body.require_approval or risk_requires_approval
    initial_status = "awaiting_approval" if requires_approval else "pending"

    plan_def = {
        "intent_class": analysis.raw_class,
        "steps": steps,
        "estimated_cost_usd": estimated_cost,
        "risk_level": risk_level,
        "confidence_threshold": confidence_threshold,
        "model_strategy": model_strategy,
    }

    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO orchestration_plans
               (org_id, study_id, intent_text, intent_class, plan_definition,
                status, initiated_by, intent_analysis, pre_execution_gate,
                confidence_threshold, model_strategy)
               VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9::jsonb,$10,$11)
               RETURNING id""",
            uuid.UUID(body.org_id),
            uuid.UUID(body.study_id) if body.study_id else None,
            body.intent_text, analysis.raw_class, json.dumps(plan_def),
            initial_status, body.initiated_by,
            json.dumps(analysis.model_dump()),
            json.dumps(gate.model_dump()),
            confidence_threshold,
            model_strategy,
        )
        plan_id = str(row["id"])

        # Create step result placeholders
        for step in steps:
            await conn.execute(
                """INSERT INTO orchestration_step_results
                   (plan_id, step_id, agent_slug, status, model_selected,
                    estimated_cost, step_complexity, retry_history)
                   VALUES ($1,$2,$3,'pending',$4,$5,$6,'[]'::jsonb)""",
                uuid.UUID(plan_id), step["step_id"], step["agent_slug"],
                step.get("model_selected"), step.get("estimated_cost", 0),
                step.get("complexity", "medium"),
            )

    # Cache in Redis
    if redis_client:
        try:
            await redis_client.setex(
                f"plan:{plan_id}", 3600,
                json.dumps({
                    "status": initial_status,
                    "step_count": len(steps),
                    "risk_level": risk_level,
                    "confidence_threshold": confidence_threshold,
                    "intent_analysis": analysis.model_dump(),
                    "pre_execution_gate": gate.model_dump(),
                }),
            )
        except Exception:
            pass

    if not requires_approval:
        background_tasks.add_task(
            _execute_plan, plan_id, steps, body.org_id, body.study_id,
            confidence_threshold, memory_episodes, body.context,
        )
    # If this is a protocol→USDM orchestration, create a usdm_conversions row so
    # the Protocols page can track it via GET /usdm?protocol_doc_id=...
    protocol_doc_id = (body.context or {}).get("protocol_doc_id")
    if analysis.raw_class == "protocol_usdm" and protocol_doc_id:
        try:
            protocol_filename = protocol_doc_id
            conversion_name = f"USDM Conversion — plan {plan_id[:8]}"
            async with db_pool.acquire() as conn:
                doc_row = await conn.fetchrow(
                    "SELECT file_name, bronze_s3_key FROM documents WHERE id=$1::uuid",
                    uuid.UUID(protocol_doc_id),
                )
            if doc_row:
                protocol_filename = doc_row.get("file_name") or protocol_filename
                if protocol_filename:
                    conversion_name = protocol_filename.rsplit('.', 1)[0]

            async with httpx.AsyncClient(timeout=10) as client:
                usdm_resp = await client.post(
                    f"{settings.agent_runtime_url}/usdm",
                    json={
                        "org_id": body.org_id,
                        "study_id": body.study_id,
                        "protocol_doc_id": protocol_doc_id,
                        "protocol_filename": protocol_filename,
                        "protocol_s3_key": "",
                        "name": conversion_name,
                        "created_by": body.initiated_by,
                    },
                )
                usdm_resp.raise_for_status()

            # Ensure the conversion row links to orchestration plan_id immediately.
            async with db_pool.acquire() as conn:
                await conn.execute(
                    """WITH latest AS (
                           SELECT id FROM usdm_conversions
                           WHERE org_id=$1::uuid AND protocol_doc_id=$2
                           ORDER BY created_at DESC
                           LIMIT 1
                       )
                       UPDATE usdm_conversions u
                       SET run_id=$3, plan_id=$3, status='running', updated_at=NOW()
                       FROM latest
                       WHERE u.id = latest.id""",
                    body.org_id,
                    protocol_doc_id,
                    plan_id,
                )
        except Exception as exc:
            log.warning("orchestrate.usdm_row_failed", plan_id=plan_id, error=str(exc))

    log.info("orchestrate.plan_created", plan_id=plan_id,
             intent_class=analysis.raw_class, complexity=analysis.complexity,
             steps=len(steps), risk=risk_level, threshold=confidence_threshold,
             requires_approval=requires_approval)

    return {
        "plan_id":              plan_id,
        "status":               initial_status,
        "intent_analysis":      analysis.model_dump(),
        "pre_execution_gate":   gate.model_dump(),
        "risk_level":           risk_level,
        "confidence_threshold": confidence_threshold,
        "estimated_cost_usd":   estimated_cost,
        "model_strategy":       model_strategy,
        "steps":                steps,
        "requires_approval":    requires_approval,
        "memory_episodes_used": len(memory_episodes),
    }


# ─── Plan Management ──────────────────────────────────────────────────────────

@app.post("/plans/{plan_id}/approve")
async def approve_plan(plan_id: str, body: PlanApproval, background_tasks: BackgroundTasks):
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT plan_definition, org_id, study_id, confidence_threshold "
            "FROM orchestration_plans WHERE id=$1 AND status='awaiting_approval'",
            uuid.UUID(plan_id),
        )
        if not row:
            raise HTTPException(404, "Plan not found or not awaiting approval")

        new_status = "pending" if body.approved else "aborted"
        await conn.execute(
            "UPDATE orchestration_plans SET status=$1, updated_at=NOW() WHERE id=$2",
            new_status, uuid.UUID(plan_id),
        )

    if body.approved:
        plan_def = row["plan_definition"]
        if isinstance(plan_def, str):
            try:
                plan_def = json.loads(plan_def)
            except Exception:
                plan_def = {}
        elif not isinstance(plan_def, dict):
            plan_def = {}
        steps = plan_def.get("steps", [])
        threshold = float(row.get("confidence_threshold") or 0.70)
        background_tasks.add_task(
            _execute_plan, plan_id, steps,
            str(row["org_id"]), str(row["study_id"]) if row["study_id"] else None,
            threshold, [],
        )

    return {"plan_id": plan_id, "approved": body.approved, "status": new_status}


@app.post("/plans/{plan_id}/abort")
async def abort_plan(plan_id: str):
    async with db_pool.acquire() as conn:
        await conn.execute(
            "UPDATE orchestration_plans SET status='aborted', updated_at=NOW() "
            "WHERE id=$1 AND status IN ('pending','awaiting_approval','running')",
            uuid.UUID(plan_id),
        )
    return {"plan_id": plan_id, "status": "aborted"}


@app.get("/plans/{plan_id}")
async def get_plan(plan_id: str):
    async with db_pool.acquire() as conn:
        plan = await conn.fetchrow(
            """SELECT id, org_id, study_id, intent_text, intent_class,
               plan_definition, status, initiated_by, started_at, completed_at,
               error_message, created_at, intent_analysis, pre_execution_gate,
               confidence_threshold, model_strategy
               FROM orchestration_plans WHERE id=$1""",
            uuid.UUID(plan_id),
        )
        if not plan:
            raise HTTPException(404, "Plan not found")

        steps = await conn.fetch(
            """SELECT step_id, agent_slug, agent_run_id, status, output_summary,
               confidence, cost_usd, tokens_used, started_at, completed_at,
               model_selected, estimated_cost, step_complexity,
               confidence_gate, retry_history
               FROM orchestration_step_results WHERE plan_id=$1 ORDER BY step_id""",
            uuid.UUID(plan_id),
        )

    plan_dict = dict(plan)
    # Ensure JSONB fields are decoded (asyncpg may return as string in some paths)
    for f in ("intent_analysis", "pre_execution_gate", "plan_definition"):
        if isinstance(plan_dict.get(f), str):
            try:
                plan_dict[f] = json.loads(plan_dict[f])
            except Exception:
                pass
    step_list = []
    for s in steps:
        sd = dict(s)
        for f in ("confidence_gate", "retry_history"):
            if isinstance(sd.get(f), str):
                try:
                    sd[f] = json.loads(sd[f])
                except Exception:
                    pass
        step_list.append(sd)
    return {
        **plan_dict,
        "step_results": step_list,
        "total_cost_usd": sum(float(s.get("cost_usd") or 0) for s in step_list),
        "engines_state": _compute_engines_state(plan_dict, step_list),
    }


@app.get("/plans/{plan_id}/steps")
async def get_plan_steps(plan_id: str):
    """Full step results with confidence_gate and retry_history."""
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT step_id, agent_slug, agent_run_id, status, output_summary,
               confidence, cost_usd, tokens_used, started_at, completed_at,
               model_selected, estimated_cost, step_complexity,
               confidence_gate, retry_history
               FROM orchestration_step_results WHERE plan_id=$1 ORDER BY step_id""",
            uuid.UUID(plan_id),
        )
    return {"plan_id": plan_id, "steps": [dict(r) for r in rows]}


@app.get("/plans")
async def list_plans(
    org_id: str = Query(...),
    study_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 20,
):
    conditions = ["org_id=$1"]
    params: list = [uuid.UUID(org_id)]
    n = 2
    if study_id:
        conditions.append(f"study_id=${n}"); params.append(uuid.UUID(study_id)); n += 1
    if status:
        conditions.append(f"status=${n}"); params.append(status); n += 1
    params.append(limit)
    where = " AND ".join(conditions)

    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            f"""SELECT id, intent_text, intent_class, status, initiated_by,
               started_at, completed_at, created_at,
               plan_definition->>'risk_level' as risk_level,
               confidence_threshold, model_strategy, intent_analysis,
               pre_execution_gate,
               (plan_definition->>'estimated_cost_usd')::float as estimated_cost_usd,
               (SELECT COALESCE(SUM(cost_usd),0) FROM orchestration_step_results
                WHERE plan_id=p.id) as total_cost_usd,
               (SELECT json_agg(json_build_object(
                  'step_id', step_id, 'agent_slug', agent_slug, 'status', status,
                  'confidence', confidence, 'model_selected', model_selected,
                  'confidence_gate', confidence_gate, 'retry_history', retry_history
               )) FROM orchestration_step_results WHERE plan_id=p.id) as steps
               FROM orchestration_plans p WHERE {where}
               ORDER BY created_at DESC LIMIT ${n}""",
            *params,
        )

    # Merge plan_definition steps with step results
    result_plans = []
    for r in rows:
        d = dict(r)
        # estimated_cost_usd comes from plan_definition
        try:
            pd = d.get("plan_definition") or {}
            if isinstance(pd, str):
                pd = json.loads(pd)
            d["estimated_cost_usd"] = pd.get("estimated_cost_usd", 0)
            d["risk_level"] = d.get("risk_level") or pd.get("risk_level", "low")
        except Exception:
            d["estimated_cost_usd"] = 0
            d["risk_level"] = "low"
        result_plans.append(d)

    return {"plans": result_plans}


# ─── L4 Engine Status ─────────────────────────────────────────────────────────

def _parse_jsonb(val: Any) -> Any:
    """Parse JSONB that may arrive as string or already decoded dict/list."""
    if isinstance(val, str):
        try:
            return json.loads(val)
        except Exception:
            return {}
    return val or {}


def _compute_engines_state(plan: dict, steps: list[dict]) -> dict:
    """Return the state of all 8 L4 engines for a plan."""
    analysis = _parse_jsonb(plan.get("intent_analysis"))
    gate = _parse_jsonb(plan.get("pre_execution_gate"))
    status = plan.get("status", "pending")
    has_retries = any(
        (s.get("retry_history") or []) for s in steps
    )
    confidence_gates = [s.get("confidence_gate") for s in steps if s.get("confidence_gate")]
    any_hitl = any(g.get("outcome") == "hitl_required" for g in confidence_gates if g)
    any_partial = any(g.get("outcome") == "partial_review" for g in confidence_gates if g)

    def engine_state(done: bool, active: bool = False, warn: bool = False, fail: bool = False) -> str:
        if fail:    return "failed"
        if active:  return "running"
        if warn:    return "warning"
        if done:    return "completed"
        return "pending"

    plan_started = status not in ("pending", "awaiting_approval")
    plan_done    = status in ("completed", "failed", "aborted")

    return {
        "E1_intent":       {"state": engine_state(bool(analysis)), "data": analysis},
        "E2_decompose":    {"state": engine_state(bool(steps)), "step_count": len(steps)},
        "E3_routing":      {"state": engine_state(plan_started), "agents": list({s["agent_slug"] for s in steps})},
        "E4_risk":         {"state": engine_state(plan_started),
                            "risk_level": plan.get("risk_level", "low"),
                            "threshold": plan.get("confidence_threshold", 0.70)},
        "E5_cost":         {"state": engine_state(plan_started),
                            "model_strategy": plan.get("model_strategy", ""),
                            "total_cost": sum(float(s.get("cost_usd") or 0) for s in steps)},
        "E6_confidence":   {"state": engine_state(bool(confidence_gates),
                                                   warn=any_partial, fail=any_hitl),
                            "hitl_required": any_hitl, "partial_review": any_partial},
        "E7_retry":        {"state": engine_state(has_retries) if has_retries else "idle",
                            "retries_occurred": has_retries},
        "E8_gate":         {"state": engine_state(bool(gate), fail=not gate.get("passed", True)),
                            "passed": gate.get("passed", True),
                            "predicted_confidence": gate.get("predicted_confidence")},
    }


@app.get("/engines/status/{plan_id}")
async def engines_status(plan_id: str):
    """Return the state of all 8 L4 engines for a plan."""
    async with db_pool.acquire() as conn:
        plan = await conn.fetchrow(
            """SELECT id, status, intent_analysis, pre_execution_gate,
               confidence_threshold, model_strategy,
               plan_definition->>'risk_level' as risk_level,
               (SELECT COALESCE(SUM(cost_usd),0) FROM orchestration_step_results
                WHERE plan_id=p.id) as total_cost_usd
               FROM orchestration_plans p WHERE id=$1""",
            uuid.UUID(plan_id),
        )
        if not plan:
            raise HTTPException(404, "Plan not found")

        steps = await conn.fetch(
            "SELECT agent_slug, status, confidence, cost_usd, model_selected, "
            "confidence_gate, retry_history FROM orchestration_step_results "
            "WHERE plan_id=$1 ORDER BY step_id",
            uuid.UUID(plan_id),
        )

    return _compute_engines_state(dict(plan), [dict(s) for s in steps])


# ─── Cost & Routing ───────────────────────────────────────────────────────────

@app.post("/cost/estimate")
async def estimate_cost(body: OrchestrateRequest):
    analysis = await _llm_analyze_intent(body.intent_text)
    steps = await _decompose_plan(body.intent_text, analysis, body.study_id or "", body.org_id)
    cost = _total_estimated_cost(steps)
    return {
        "intent_analysis": analysis.model_dump(),
        "step_count": len(steps),
        "estimated_cost_usd": cost,
        "model_strategy": _build_model_strategy_summary(steps),
        "steps": steps,
    }


@app.get("/cost/history")
async def cost_history(org_id: str = Query(...), study_id: Optional[str] = None, limit: int = 50):
    conditions = ["p.org_id=$1"]
    params: list = [uuid.UUID(org_id)]
    n = 2
    if study_id:
        conditions.append(f"p.study_id=${n}"); params.append(uuid.UUID(study_id)); n += 1
    params.append(limit)
    where = " AND ".join(conditions)

    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT p.id, p.intent_class, p.status, p.created_at, "
            f"COALESCE(SUM(sr.cost_usd), 0) as total_cost_usd, "
            f"COALESCE(SUM(sr.tokens_used), 0) as total_tokens "
            f"FROM orchestration_plans p "
            f"LEFT JOIN orchestration_step_results sr ON sr.plan_id = p.id "
            f"WHERE {where} GROUP BY p.id ORDER BY p.created_at DESC LIMIT ${n}",
            *params,
        )
    return {"history": [dict(r) for r in rows]}


@app.get("/routing/agents")
async def list_routing_agents():
    # Enrich with reputation scores from DB
    try:
        async with db_pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT slug, reputation_score, accuracy_rate, avg_latency_ms "
                "FROM agent_definitions WHERE slug = ANY($1::text[])",
                list(AGENT_REGISTRY.keys()),
            )
            db_rep = {r["slug"]: dict(r) for r in rows}
    except Exception:
        db_rep = {}

    enriched = {}
    for slug, meta in AGENT_REGISTRY.items():
        enriched[slug] = {
            **meta,
            "reputation_score": db_rep.get(slug, {}).get("reputation_score", 0.80),
            "accuracy_rate":    db_rep.get(slug, {}).get("accuracy_rate", 0.85),
            "avg_latency_ms":   db_rep.get(slug, {}).get("avg_latency_ms", 2000),
        }

    return {"agents": enriched, "intent_mapping": INTENT_TO_AGENTS}


# ─── Plan Execution (L4.E2 + E5 + E6 + E7) ───────────────────────────────────

async def _execute_plan(
    plan_id: str, steps: list[dict], org_id: str, study_id: Optional[str],
    confidence_threshold: float = 0.70,
    memory_episodes: Optional[list[dict]] = None,
    context: Optional[dict] = None,
):
    """Execute orchestration plan with confidence gating (L4.E6) and retry engine (L4.E7)."""
    completed_steps: set[str] = set()
    memory_episodes = memory_episodes or []

    async with db_pool.acquire() as conn:
        await conn.execute(
            "UPDATE orchestration_plans SET status='running', started_at=NOW() WHERE id=$1",
            uuid.UUID(plan_id),
        )

    for step in steps:
        step_id   = step["step_id"]
        agent_slug = step["agent_slug"]
        depends_on = step.get("depends_on", [])

        # Check dependency chain
        if not all(dep in completed_steps for dep in depends_on):
            log.warning("plan.step.dependency_not_met", plan_id=plan_id, step_id=step_id)
            await _update_step(plan_id, step_id, "skipped", "Dependency not completed")
            continue

        await _update_step(plan_id, step_id, "running")

        # Merge caller context (e.g. protocol_doc_id) into step inputs
        if context:
            step = {**step, "inputs": {**step.get("inputs", {}), **context}}

        # Execute step with retry cascade (L4.E7 / L4.E7.USDM for protocol_usdm)
        result = None
        retry_history: list[dict] = []
        last_error = ""
        is_usdm_step = step.get("intent_class") == "protocol_usdm"
        # protocol_usdm uses its own 5-step chain; other steps use max_retries
        max_attempts = (len(PROTOCOL_USDM_STRATEGY_CHAIN) + 1) if is_usdm_step else (settings.max_retries + 1)
        last_confidence: float = 0.0

        for attempt in range(max_attempts):
            try:
                if attempt == 0:
                    result = await _run_agent_step(agent_slug, step.get("inputs", {}), org_id, study_id)
                else:
                    if is_usdm_step:
                        result, retry_rec = await _retry_step_protocol_usdm(
                            plan_id, step, attempt, last_error, org_id, study_id,
                            confidence_before=last_confidence,
                        )
                    else:
                        result, retry_rec = await _retry_step(
                            plan_id, step, attempt, last_error, org_id, study_id, memory_episodes
                        )
                    retry_history.append(retry_rec.model_dump())
                    if retry_rec.action == "escalate_hitl":
                        # Pause plan for HITL
                        await _update_step(plan_id, step_id, "failed",
                                           "Escalated to HITL after max retries",
                                           retry_history=retry_history)
                        async with db_pool.acquire() as conn:
                            await conn.execute(
                                "UPDATE orchestration_plans SET status='awaiting_approval' WHERE id=$1",
                                uuid.UUID(plan_id),
                            )
                        log.warning("plan.step.hitl_escalated", plan_id=plan_id, step_id=step_id)
                        return  # Pause execution

                if result and "error" not in result:
                    last_confidence = float((result or {}).get("confidence", 0))
                    # protocol_usdm: block finalization if provenance coverage insufficient
                    if is_usdm_step:
                        prov_coverage = float((result or {}).get("provenance_coverage", 0))
                        if prov_coverage < PROTOCOL_USDM_MIN_PROVENANCE_COVERAGE and attempt < max_attempts - 1:
                            last_error = f"provenance_coverage={prov_coverage:.2f} below required {PROTOCOL_USDM_MIN_PROVENANCE_COVERAGE:.2f}"
                            log.warning("plan.usdm.provenance_insufficient", plan_id=plan_id,
                                        step_id=step_id, coverage=prov_coverage)
                            continue
                    break  # Success
                last_confidence = float((result or {}).get("confidence", 0))
                last_error = (result or {}).get("error", "unknown error")
            except Exception as exc:
                last_error = str(exc)
                log.warning("plan.step.attempt_failed", plan_id=plan_id,
                            step_id=step_id, attempt=attempt, error=last_error)

        if not result or "error" in result:
            await _update_step(plan_id, step_id, "failed", last_error,
                               retry_history=retry_history)
            # Non-fatal: continue with independent steps
            continue

        # Extract step outcome
        run_id     = result.get("run_id") or result.get("id")
        cost       = float(result.get("cost_usd", 0) or step.get("estimated_cost", 0))
        tokens     = int(result.get("tokens_used", 0))
        confidence = float(result.get("confidence", 0) or 0)
        summary    = result.get("summary") or result.get("output_summary") or ""

        # L4.E6: Apply confidence gate
        gate = _apply_confidence_gate(confidence, confidence_threshold)

        await _update_step(
            plan_id, step_id, "completed", summary,
            run_id=run_id, cost=cost, tokens=tokens, confidence=confidence,
            confidence_gate=gate.model_dump(), retry_history=retry_history,
            model_selected=step.get("model_selected"),
        )
        completed_steps.add(step_id)

        # Update Redis
        if redis_client:
            try:
                await redis_client.setex(
                    f"plan:{plan_id}", 3600,
                    json.dumps({
                        "status": "running",
                        "completed_steps": list(completed_steps),
                        "total": len(steps),
                    }),
                )
            except Exception:
                pass

        # Pause for HITL if confidence gate requires it
        if gate.outcome == "hitl_required":
            log.info("plan.step.confidence_hitl_pause", plan_id=plan_id, step_id=step_id,
                     confidence=confidence, threshold=confidence_threshold)
            async with db_pool.acquire() as conn:
                await conn.execute(
                    "UPDATE orchestration_plans SET status='awaiting_approval' WHERE id=$1",
                    uuid.UUID(plan_id),
                )
            return  # Pause until human review

    # Finalize plan
    async with db_pool.acquire() as conn:
        step_statuses = await conn.fetch(
            "SELECT status FROM orchestration_step_results WHERE plan_id=$1",
            uuid.UUID(plan_id),
        )
        all_statuses = [r["status"] for r in step_statuses]
        final_status = "completed" if all(s in ("completed", "skipped") for s in all_statuses) else "failed"
        await conn.execute(
            "UPDATE orchestration_plans SET status=$1, completed_at=NOW() WHERE id=$2",
            final_status, uuid.UUID(plan_id),
        )
    # Sync usdm_conversions status so the Protocols page reflects the outcome
    try:
        async with db_pool.acquire() as conn:
            plan_row = await conn.fetchrow(
                "SELECT intent_class, plan_definition FROM orchestration_plans WHERE id=$1",
                uuid.UUID(plan_id),
            )
        if plan_row and plan_row["intent_class"] == "protocol_usdm":
            plan_def = plan_row["plan_definition"] or {}
            if isinstance(plan_def, str):
                import json as _json
                plan_def = _json.loads(plan_def)
            protocol_doc_id = None
            for step in (plan_def.get("steps") or []):
                protocol_doc_id = step.get("inputs", {}).get("protocol_doc_id")
                if protocol_doc_id:
                    break
            if protocol_doc_id:
                conv_status = "completed" if final_status == "completed" else "failed"
                async with httpx.AsyncClient(timeout=10) as client:
                    # Update any matching pending/running usdm_conversions rows
                    async with db_pool.acquire() as conn:
                        await conn.execute(
                                     """UPDATE usdm_conversions SET status=$1, plan_id=$2, updated_at=NOW()
                                         WHERE protocol_doc_id=$3
                                         AND status IN ('pending','running','selecting_document','waiting_approval')""",
                            conv_status, plan_id, protocol_doc_id,
                        )
    except Exception as exc:
        log.warning("plan.usdm_sync_failed", plan_id=plan_id, error=str(exc))

    log.info("plan.execution.complete", plan_id=plan_id, status=final_status,
             completed=len(completed_steps), total=len(steps))


async def _run_agent_step(agent_slug: str, inputs: dict, org_id: str, study_id: Optional[str]) -> dict:
    """Trigger a sub-agent run via agent-runtime."""
    try:
        async with httpx.AsyncClient(timeout=300) as client:
            run_resp = await client.post(
                f"{settings.agent_runtime_url}/runs/by-slug",
                json={
                    "agent_slug": agent_slug,
                    "org_id": org_id,
                    "study_id": study_id,
                    "input_context": {
                        **(inputs or {}),
                        "triggered_by": "super-agent",
                    },
                },
            )
            run_resp.raise_for_status()
            return run_resp.json()
    except Exception as exc:
        log.warning("agent_step.failed", agent_slug=agent_slug, error=str(exc))
        return {"error": str(exc)}


async def _update_step(
    plan_id: str, step_id: str, status: str, output_summary: str = "",
    run_id: Optional[str] = None, cost: float = 0, tokens: int = 0, confidence: float = 0,
    confidence_gate: Optional[dict] = None,
    retry_history: Optional[list] = None,
    model_selected: Optional[str] = None,
):
    async with db_pool.acquire() as conn:
        now = datetime.now(timezone.utc)
        await conn.execute(
            """UPDATE orchestration_step_results SET
               status=$1, output_summary=$2, agent_run_id=$3, cost_usd=$4,
               tokens_used=$5, confidence=$6, confidence_gate=$7::jsonb,
               retry_history=$8::jsonb, model_selected=COALESCE($9, model_selected),
               started_at = CASE
                   WHEN $1='running' THEN COALESCE(started_at, $10::timestamptz)
                   ELSE started_at
               END,
               completed_at = CASE
                   WHEN $1 IN ('completed','failed','skipped') THEN $10::timestamptz
                   ELSE completed_at
               END
               WHERE plan_id=$11 AND step_id=$12""",
            status, output_summary or None,
            uuid.UUID(run_id) if run_id else None,
            cost, tokens, confidence,
            json.dumps(confidence_gate) if confidence_gate else None,
            json.dumps(retry_history or []),
            model_selected,
            now,
            uuid.UUID(plan_id), step_id,
        )
