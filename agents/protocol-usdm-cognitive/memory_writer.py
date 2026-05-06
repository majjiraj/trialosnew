"""
Self-learning write-back for the Protocol-to-USDM Cognitive Agent.

Implements L5.E8–E10 learning mechanisms:
  L5.E8   In-Flow Adaptation   — episodic memory after every run
  L5.E9   Cross-Flow Learning  — semantic fact triples from USDM output
  L5.E10  Fleet Learning       — gold/anti patterns + reputation update

All writes are best-effort: exceptions are silently swallowed so learning
failure never blocks agent output delivery.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

import json
import logging
import httpx
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger(__name__)

MEMORY_ENGINE_URL = os.environ.get("MEMORY_ENGINE_URL", "http://localhost:8014")
AGENT_RUNTIME_URL = os.environ.get("AGENT_RUNTIME_URL", "http://localhost:8004")

AGENT_SLUG = "protocol-usdm-cognitive"


# ─── L5.E8: Episodic Memory ───────────────────────────────────────────────────

async def write_episodic_memory(
    org_id: str,
    study_id: str,
    run_id: str,
    usdm_json: dict,
    eval_scores: dict[str, dict],
    confidence: float,
) -> bool:
    """Record this conversion run as a prior episode for future retrieval."""
    sections_populated = [
        k for k in ("meta", "studyIdentifiers", "studyProtocols", "therapeuticAreas",
                     "objectives", "estimands", "populations", "arms", "epochs", "activities")
        if usdm_json.get(k)
    ]
    payload = {
        "agent_id": AGENT_SLUG,
        "org_id": org_id,
        "study_id": study_id,
        "run_id": run_id,
        "episode_type": "protocol_usdm_conversion",
        "content": {
            "sections_populated": sections_populated,
            "section_count": len(sections_populated),
            "study_phase": _extract_study_phase(usdm_json),
            "therapeutic_area": _extract_therapeutic_area(usdm_json),
            "evaluator_summary": {k: round(v.get("score", 0), 3) for k, v in eval_scores.items()},
            "all_passed": all(v.get("passed", False) for v in eval_scores.values()),
        },
        "confidence": round(confidence, 3),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    return await _post(f"{MEMORY_ENGINE_URL}/memory/episodic", payload)


# ─── L5.E9: Semantic Memory ───────────────────────────────────────────────────

async def write_semantic_facts(
    org_id: str,
    study_id: str,
    usdm_json: dict,
) -> int:
    """Extract and store subject/predicate/object triples from USDM output."""
    triples = _extract_semantic_triples(usdm_json, study_id)
    stored = 0
    for triple in triples:
        payload = {
            "org_id": org_id,
            "study_id": study_id,
            "source": AGENT_SLUG,
            "human_verified": False,
            **triple,
        }
        if await _post(f"{MEMORY_ENGINE_URL}/memory/semantic", payload):
            stored += 1
    return stored


def _extract_semantic_triples(usdm_json: dict, study_id: str) -> list[dict]:
    triples: list[dict] = []

    # Study phase
    phase = _extract_study_phase(usdm_json)
    if phase:
        triples.append({"subject": study_id, "predicate": "has_phase", "object": phase, "confidence": 0.90})

    # Therapeutic area
    ta = _extract_therapeutic_area(usdm_json)
    if ta:
        triples.append({"subject": study_id, "predicate": "has_therapeutic_area", "object": ta, "confidence": 0.85})

    # Arms count
    arms = usdm_json.get("arms", [])
    if isinstance(arms, list) and arms:
        triples.append({"subject": study_id, "predicate": "has_arm_count",
                         "object": str(len(arms)), "confidence": 0.95})

    # Primary objective
    objectives = usdm_json.get("objectives", [])
    if isinstance(objectives, list) and objectives:
        first = objectives[0]
        if isinstance(first, dict):
            obj_text = first.get("description") or first.get("text") or ""
        else:
            obj_text = str(first)
        if obj_text:
            triples.append({"subject": study_id, "predicate": "has_primary_objective",
                             "object": obj_text[:200], "confidence": 0.80})

    return triples


# ─── L5.E10: Fleet Learning (gold/anti patterns + reputation) ─────────────────

async def write_learnings(
    agent_id: str,
    org_id: str,
    study_id: str,
    eval_scores: dict[str, dict],
    usdm_json: dict,
    confidence: float,
) -> int:
    """Store gold patterns (all pass) or anti-patterns (per failing evaluator)."""
    stored = 0
    all_passed = all(v.get("passed", False) for v in eval_scores.values())

    if all_passed and confidence >= 0.80:
        payload = {
            "agent_id": agent_id,
            "org_id": org_id,
            "learning_type": "gold_pattern",
            "content": {
                "description": (
                    f"Successful USDM conversion: {len([k for k in usdm_json if usdm_json[k]])} "
                    f"sections populated, confidence={confidence:.2f}, all evaluators passed."
                ),
                "study_phase": _extract_study_phase(usdm_json),
                "therapeutic_area": _extract_therapeutic_area(usdm_json),
                "task_type": "protocol_usdm_conversion",
                "evaluator_scores": {k: round(v.get("score", 0), 3) for k, v in eval_scores.items()},
            },
            "confidence": round(confidence, 3),
            "human_verified": False,
            "study_id": study_id,
            "applicable_task_types": ["protocol_usdm_conversion"],
        }
        if await _post(f"{MEMORY_ENGINE_URL}/learnings/agent", payload):
            stored += 1
    else:
        for evaluator_name, result in eval_scores.items():
            if result.get("passed"):
                continue
            payload = {
                "agent_id": agent_id,
                "org_id": org_id,
                "learning_type": "anti_pattern",
                "content": {
                    "description": (
                        f"Evaluator '{evaluator_name}' failed: score={result.get('score', 0):.2f}. "
                        f"Issues: {'; '.join(result.get('details', [])[:2])}"
                    ),
                    "evaluator": evaluator_name,
                    "score": result.get("score", 0),
                    "task_type": "protocol_usdm_conversion",
                },
                "confidence": 0.75,
                "human_verified": False,
                "study_id": study_id,
                "applicable_task_types": ["protocol_usdm_conversion"],
            }
            if await _post(f"{MEMORY_ENGINE_URL}/learnings/agent", payload):
                stored += 1

    return stored


async def update_reputation(
    confidence: float,
    eval_scores: dict[str, dict],
) -> bool:
    """Update agent_definitions.accuracy_rate with a rolling average."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{AGENT_RUNTIME_URL}/agent-definitions/{AGENT_SLUG}")
            if resp.status_code != 200:
                return False
            agent_def = resp.json()
            current_accuracy = float(agent_def.get("accuracy_rate") or 0.85)
            all_passed = all(v.get("passed", False) for v in eval_scores.values())
            run_accuracy = confidence if all_passed else confidence * 0.85
            # Exponential moving average (α = 0.15)
            new_accuracy = round(current_accuracy * 0.85 + run_accuracy * 0.15, 4)
            new_reputation = round(
                (agent_def.get("reputation_score") or 0.80) * 0.90 + confidence * 0.10, 4
            )
            patch = await client.patch(
                f"{AGENT_RUNTIME_URL}/agent-definitions/{AGENT_SLUG}",
                json={"accuracy_rate": new_accuracy, "reputation_score": new_reputation},
            )
            return patch.status_code in (200, 204)
    except Exception as exc:
        log.warning("protocol_usdm_cognitive.reputation_update_failed", error=str(exc))
        return False


# ─── Internal helpers ─────────────────────────────────────────────────────────

async def _post(url: str, payload: dict) -> bool:
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.post(url, json=payload)
            return resp.status_code in (200, 201, 204)
    except Exception as exc:
        log.debug("memory_writer.post_failed url=%s error=%s", url, exc)
        return False


def _extract_study_phase(usdm_json: dict) -> str:
    for path in (
        ["meta", "studyPhase"],
        ["studyProtocols", "studyPhase"],
        ["studyProtocols", 0, "studyPhase"],
    ):
        val: Any = usdm_json
        for key in path:
            if isinstance(val, dict):
                val = val.get(key)
            elif isinstance(val, list) and isinstance(key, int):
                val = val[key] if len(val) > key else None
            else:
                val = None
            if val is None:
                break
        if val and isinstance(val, str):
            return val
    return ""


def _extract_therapeutic_area(usdm_json: dict) -> str:
    ta = usdm_json.get("therapeuticAreas")
    if isinstance(ta, list) and ta:
        first = ta[0]
        if isinstance(first, dict):
            return first.get("name") or first.get("code") or ""
        return str(first)
    if isinstance(ta, dict):
        return ta.get("name") or ta.get("code") or ""
    return ""
