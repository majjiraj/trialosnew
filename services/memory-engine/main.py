"""
TrialOS Memory Engine Service  (port 8014)
==========================================
Layer 3 — Memory + Learnings + Decision Trees.

Manages the persistent intelligence layer:
  • Episodic Memory  — what happened in specific agent runs
  • Semantic Memory  — distilled facts as subject/predicate/object triples
  • Procedural Memory — how-to patterns for task types
  • Performance Memory — agent metrics over time
  • Agent Learnings   — gold patterns, anti-patterns, calibrations
  • Decision Trees    — routing and branching logic
  • Memory Decay      — background importance decay (24h loop)
  • Contradiction Resolution — detects conflicting memories
  • Explainable Recall — returns memories with source attribution chains
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings
import structlog
import asyncpg
import json
import uuid
import asyncio
import httpx
from datetime import datetime, timezone, date
from typing import Optional, Any

try:
    import redis.asyncio as aioredis
    _REDIS_AVAILABLE = True
except ImportError:
    _REDIS_AVAILABLE = False

log = structlog.get_logger()


# ─── Settings ─────────────────────────────────────────────────────────────────

class Settings(BaseSettings):
    database_url: str
    redis_url: str          = "redis://localhost:6379"
    ollama_base_url: str    = "http://localhost:11434"
    embedding_model: str    = "nomic-embed-text"
    embedding_dim: int      = 768
    kafka_brokers: str      = "localhost:9092"
    decay_interval_secs: int = 86400  # 24 hours
    decay_min_importance: float = 0.05

    class Config:
        env_file = ".env"
        extra = 'ignore'


settings      = Settings()
db_pool:      asyncpg.Pool = None
redis_client: Any          = None


# ─── Helpers ──────────────────────────────────────────────────────────────────

async def _embed(text: str) -> list[float]:
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                f"{settings.ollama_base_url}/api/embeddings",
                json={"model": settings.embedding_model, "prompt": text[:4000]},
            )
            r.raise_for_status()
            return r.json().get("embedding", [])
    except Exception as exc:
        log.warning("embed.failed", error=str(exc))
        return []


def _vec_str(v: list[float]) -> str:
    return "[" + ",".join(str(x) for x in v) + "]"


_NIL_UUID = uuid.UUID("00000000-0000-0000-0000-000000000000")

def _parse_org_id(org_id: str) -> uuid.UUID:
    """Convert org_id string to UUID, falling back to the nil UUID for invalid values."""
    if not org_id:
        return _NIL_UUID
    try:
        return uuid.UUID(org_id)
    except (ValueError, AttributeError):
        return _NIL_UUID


# ─── Memory Decay Background Task ────────────────────────────────────────────

async def _memory_decay_loop():
    """Run every 24h. Applies decay to episodic and semantic memories.
    Memories with importance < decay_min_importance are soft-deleted (is_active=FALSE).
    Access frequency slows decay — memories accessed ≥3 times are preserved at full weight.
    """
    while True:
        await asyncio.sleep(settings.decay_interval_secs)
        try:
            async with db_pool.acquire() as conn:
                # Episodic decay
                await conn.execute("""
                    UPDATE episodic_memories
                    SET importance = importance * decay_factor *
                        CASE WHEN access_count < 3 THEN 0.99 ELSE 1.0 END,
                        is_active = CASE
                            WHEN importance * decay_factor < $1 THEN FALSE
                            ELSE is_active END
                    WHERE is_active = TRUE
                    AND expires_at IS NULL OR expires_at > NOW()
                """, settings.decay_min_importance)

                # Semantic decay
                await conn.execute("""
                    UPDATE semantic_memories
                    SET is_active = FALSE
                    WHERE is_active = TRUE
                    AND expires_at IS NOT NULL AND expires_at < NOW()
                """)

                # Mark expired decision trees inactive
                decayed = await conn.fetchval(
                    "SELECT COUNT(*) FROM episodic_memories WHERE is_active = FALSE"
                )
            log.info("memory_decay.run_complete", inactive_memories=decayed)
        except Exception as exc:
            log.warning("memory_decay.failed", error=str(exc))


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
            log.info("memory_engine.redis_connected")
        except Exception as exc:
            log.warning("memory_engine.redis_unavailable", error=str(exc))
            redis_client = None

    asyncio.create_task(_memory_decay_loop())
    log.info("memory_engine.startup", port=8014)
    yield
    await db_pool.close()
    if redis_client:
        await redis_client.aclose()


app = FastAPI(title="TrialOS Memory Engine", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ─── Pydantic Models ──────────────────────────────────────────────────────────

class EpisodicMemoryCreate(BaseModel):
    org_id:              str
    agent_definition_id: str
    study_id:            Optional[str] = None
    run_id:              Optional[str] = None
    episode_type:        str
    context_summary:     str
    outcome_summary:     str
    key_decisions:       list[dict] = []
    evidence_used:       list[dict] = []
    importance:          float = 1.0

class SemanticMemoryCreate(BaseModel):
    org_id:    str
    scope:     str = "org"
    scope_id:  Optional[str] = None
    fact_type: str = "rule"
    subject:   str
    predicate: str
    object:    str
    confidence: float = 1.0
    source_episode_ids: list[str] = []

class ProceduralMemoryCreate(BaseModel):
    org_id:           str
    task_type:        str
    procedure_name:   str
    steps:            list[dict] = []
    preconditions:    dict = {}
    expected_outcome: Optional[str] = None

class LearningCreate(BaseModel):
    org_id:              str
    scope:               str = "agent"
    agent_definition_id: Optional[str] = None
    task_type:           Optional[str] = None
    learning_type:       str
    description:         str
    evidence:            dict = {}
    confidence:          float = 0.8
    study_id:            Optional[str] = None

class RecallRequest(BaseModel):
    query:        str
    memory_types: list[str] = ["semantic", "episodic", "learnings"]
    top_k:        int = 5
    org_id:       Optional[str] = None
    study_id:     Optional[str] = None

class ContradictionResolve(BaseModel):
    contradiction_id: str
    resolution:       str
    resolved_by:      str


# ─── Health ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "memory-engine", "port": 8014}


# ─── Episodic Memory ──────────────────────────────────────────────────────────

@app.post("/memory/episodic", status_code=201)
async def store_episodic_memory(body: EpisodicMemoryCreate):
    embedding = await _embed(body.context_summary + " " + body.outcome_summary)
    vec = _vec_str(embedding) if embedding else None

    async with db_pool.acquire() as conn:
        if vec:
            row = await conn.fetchrow(
                """INSERT INTO episodic_memories
                   (org_id, agent_definition_id, study_id, run_id, episode_type,
                    context_summary, outcome_summary, key_decisions, evidence_used,
                    importance, embedding)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::vector)
                   RETURNING id""",
                uuid.UUID(body.org_id), uuid.UUID(body.agent_definition_id),
                uuid.UUID(body.study_id) if body.study_id else None,
                uuid.UUID(body.run_id) if body.run_id else None,
                body.episode_type, body.context_summary, body.outcome_summary,
                json.dumps(body.key_decisions), json.dumps(body.evidence_used),
                body.importance, vec,
            )
        else:
            row = await conn.fetchrow(
                """INSERT INTO episodic_memories
                   (org_id, agent_definition_id, study_id, run_id, episode_type,
                    context_summary, outcome_summary, key_decisions, evidence_used, importance)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
                   RETURNING id""",
                uuid.UUID(body.org_id), uuid.UUID(body.agent_definition_id),
                uuid.UUID(body.study_id) if body.study_id else None,
                uuid.UUID(body.run_id) if body.run_id else None,
                body.episode_type, body.context_summary, body.outcome_summary,
                json.dumps(body.key_decisions), json.dumps(body.evidence_used),
                body.importance,
            )
    return {"id": str(row["id"])}


@app.get("/memory/episodic/{agent_id}")
async def get_episodic_memories(
    agent_id: str,
    org_id: str = Query(...),
    study_id: Optional[str] = None,
    episode_type: Optional[str] = None,
    limit: int = 20,
):
    # Support /memory/episodic/all by skipping agent filtering when agent_id == "all".
    conditions = ["org_id = $1", "is_active = TRUE"]
    params: list = [_parse_org_id(org_id)]
    n = 2
    if agent_id != "all":
        conditions.insert(0, "agent_definition_id = $1")
        params = [uuid.UUID(agent_id), _parse_org_id(org_id)]
        n = 3
    if study_id:
        conditions.append(f"study_id = ${n}"); params.append(uuid.UUID(study_id)); n += 1
    if episode_type:
        conditions.append(f"episode_type = ${n}"); params.append(episode_type); n += 1
    params.append(limit)
    where = " AND ".join(conditions)

    async with db_pool.acquire() as conn:
        # Update access count for retrieved memories
        await conn.execute(
            f"UPDATE episodic_memories SET access_count = access_count + 1, "
            f"last_accessed = NOW() WHERE {where}",
            *params[:-1],
        )
        rows = await conn.fetch(
            f"SELECT id,episode_type,context_summary,outcome_summary,"
            f"key_decisions,importance,access_count,created_at "
            f"FROM episodic_memories WHERE {where} "
            f"ORDER BY importance DESC, created_at DESC LIMIT ${n}",
            *params,
        )
    return {"agent_id": agent_id, "memories": [dict(r) for r in rows]}


# ─── Semantic Memory ──────────────────────────────────────────────────────────

@app.post("/memory/semantic", status_code=201)
async def store_semantic_memory(body: SemanticMemoryCreate):
    text = f"{body.subject} {body.predicate} {body.object}"
    embedding = await _embed(text)
    vec = _vec_str(embedding) if embedding else None

    async with db_pool.acquire() as conn:
        # Check for existing memory with same subject+predicate
        existing = await conn.fetchrow(
            "SELECT id, support_count FROM semantic_memories "
            "WHERE org_id=$1 AND subject=$2 AND predicate=$3 AND object=$4 AND is_active=TRUE",
            uuid.UUID(body.org_id), body.subject, body.predicate, body.object,
        )
        if existing:
            await conn.execute(
                "UPDATE semantic_memories SET support_count = support_count + 1, "
                "confidence = LEAST(confidence + 0.05, 1.0), updated_at = NOW() "
                "WHERE id = $1",
                existing["id"],
            )
            return {"id": str(existing["id"]), "action": "reinforced",
                    "support_count": existing["support_count"] + 1}

        if vec:
            row = await conn.fetchrow(
                """INSERT INTO semantic_memories
                   (org_id, scope, scope_id, fact_type, subject, predicate, object,
                    confidence, source_episode_ids, embedding)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector)
                   RETURNING id""",
                uuid.UUID(body.org_id), body.scope, body.scope_id, body.fact_type,
                body.subject, body.predicate, body.object, body.confidence,
                [uuid.UUID(x) for x in body.source_episode_ids], vec,
            )
        else:
            row = await conn.fetchrow(
                """INSERT INTO semantic_memories
                   (org_id, scope, scope_id, fact_type, subject, predicate, object,
                    confidence, source_episode_ids)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                   RETURNING id""",
                uuid.UUID(body.org_id), body.scope, body.scope_id, body.fact_type,
                body.subject, body.predicate, body.object, body.confidence,
                [uuid.UUID(x) for x in body.source_episode_ids],
            )
    return {"id": str(row["id"]), "action": "created"}


@app.get("/memory/semantic/search")
async def search_semantic_memory(
    q: str,
    org_id: str = Query(...),
    fact_type: Optional[str] = None,
    top_k: int = 10,
):
    conditions = ["org_id = $1", "is_active = TRUE"]
    params: list = [_parse_org_id(org_id)]
    n = 2
    if fact_type:
        conditions.append(f"fact_type = ${n}"); params.append(fact_type); n += 1
    where = " AND ".join(conditions)

    embedding = await _embed(q)
    if embedding:
        vec = _vec_str(embedding)
        params.append(top_k)
        async with db_pool.acquire() as conn:
            rows = await conn.fetch(
                f"SELECT id,scope,fact_type,subject,predicate,object,confidence,"
                f"support_count,1-(embedding<=>'{vec}'::vector) as similarity "
                f"FROM semantic_memories WHERE {where} AND embedding IS NOT NULL "
                f"ORDER BY embedding<=>'{vec}'::vector LIMIT ${n}",
                *params,
            )
        return {"results": [dict(r) for r in rows], "query": q}

    # Text fallback
    params.append(f"%{q}%"); params.append(top_k)
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT id,scope,fact_type,subject,predicate,object,confidence,support_count "
            f"FROM semantic_memories WHERE {where} "
            f"AND (subject ILIKE ${n} OR object ILIKE ${n} OR predicate ILIKE ${n}) "
            f"ORDER BY confidence DESC LIMIT ${n+1}",
            *params,
        )
    return {"results": [dict(r) for r in rows], "query": q}


# ─── Procedural Memory ────────────────────────────────────────────────────────

@app.post("/memory/procedural", status_code=201)
async def store_procedural_memory(body: ProceduralMemoryCreate):
    text = f"{body.task_type} {body.procedure_name} {body.expected_outcome or ''}"
    embedding = await _embed(text)
    vec = _vec_str(embedding) if embedding else None

    async with db_pool.acquire() as conn:
        if vec:
            row = await conn.fetchrow(
                """INSERT INTO procedural_memories
                   (org_id, task_type, procedure_name, steps, preconditions,
                    expected_outcome, embedding)
                   VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::vector)
                   ON CONFLICT (org_id, task_type, procedure_name)
                   DO UPDATE SET steps=EXCLUDED.steps, updated_at=NOW()
                   RETURNING id""",
                uuid.UUID(body.org_id), body.task_type, body.procedure_name,
                json.dumps(body.steps), json.dumps(body.preconditions),
                body.expected_outcome, vec,
            )
        else:
            row = await conn.fetchrow(
                """INSERT INTO procedural_memories
                   (org_id, task_type, procedure_name, steps, preconditions, expected_outcome)
                   VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
                   ON CONFLICT (org_id, task_type, procedure_name)
                   DO UPDATE SET steps=EXCLUDED.steps, updated_at=NOW()
                   RETURNING id""",
                uuid.UUID(body.org_id), body.task_type, body.procedure_name,
                json.dumps(body.steps), json.dumps(body.preconditions), body.expected_outcome,
            )
    return {"id": str(row["id"])}


@app.get("/memory/procedural/{task_type}")
async def get_procedural_memories(task_type: str, org_id: str = Query(...)):
    async with db_pool.acquire() as conn:
        if task_type == "all":
            rows = await conn.fetch(
                "SELECT id,task_type,procedure_name,steps,preconditions,expected_outcome,"
                "success_rate,run_count FROM procedural_memories "
                "WHERE org_id=$1 AND is_active=TRUE "
                "ORDER BY success_rate DESC NULLS LAST",
                _parse_org_id(org_id),
            )
        else:
            rows = await conn.fetch(
                "SELECT id,procedure_name,steps,preconditions,expected_outcome,"
                "success_rate,run_count FROM procedural_memories "
                "WHERE org_id=$1 AND task_type=$2 AND is_active=TRUE "
                "ORDER BY success_rate DESC NULLS LAST",
                _parse_org_id(org_id), task_type,
            )
    return {"task_type": task_type, "procedures": [dict(r) for r in rows]}


# ─── Learnings ────────────────────────────────────────────────────────────────

@app.post("/learnings/agent", status_code=201)
async def store_agent_learning(body: LearningCreate):
    return await _store_learning(body, "agent")

@app.post("/learnings/task", status_code=201)
async def store_task_learning(body: LearningCreate):
    return await _store_learning(body, "task")

@app.post("/learnings/client", status_code=201)
async def store_client_learning(body: LearningCreate):
    return await _store_learning(body, "client")


async def _store_learning(body: LearningCreate, scope: str) -> dict:
    embedding = await _embed(body.description)
    vec = _vec_str(embedding) if embedding else None
    agent_id = uuid.UUID(body.agent_definition_id) if body.agent_definition_id else None

    async with db_pool.acquire() as conn:
        if vec:
            row = await conn.fetchrow(
                """INSERT INTO agent_learnings
                   (org_id, scope, agent_definition_id, task_type, learning_type,
                    description, evidence, confidence, embedding)
                   VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::vector)
                   RETURNING id""",
                uuid.UUID(body.org_id), scope, agent_id, body.task_type,
                body.learning_type, body.description, json.dumps(body.evidence),
                body.confidence, vec,
            )
        else:
            row = await conn.fetchrow(
                """INSERT INTO agent_learnings
                   (org_id, scope, agent_definition_id, task_type, learning_type,
                    description, evidence, confidence)
                   VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
                   RETURNING id""",
                uuid.UUID(body.org_id), scope, agent_id, body.task_type,
                body.learning_type, body.description, json.dumps(body.evidence),
                body.confidence,
            )
    return {"id": str(row["id"])}


@app.get("/learnings/search")
async def search_learnings(q: str, org_id: str = Query(...), top_k: int = 10):
    embedding = await _embed(q)
    if embedding:
        vec = _vec_str(embedding)
        async with db_pool.acquire() as conn:
            try:
                rows = await conn.fetch(
                    f"SELECT id,scope,task_type,learning_type,description,evidence,confidence,human_verified,created_at,"
                    f"1-(embedding<=>'{vec}'::vector) as similarity "
                    f"FROM agent_learnings WHERE org_id=$1 AND active=TRUE "
                    f"AND embedding IS NOT NULL "
                    f"ORDER BY embedding<=>'{vec}'::vector LIMIT $2",
                    _parse_org_id(org_id), top_k,
                )
            except asyncpg.exceptions.UndefinedColumnError:
                rows = await conn.fetch(
                    f"SELECT id,scope,task_type,learning_type,description,evidence,confidence,created_at,"
                    f"1-(embedding<=>'{vec}'::vector) as similarity "
                    f"FROM agent_learnings WHERE org_id=$1 AND active=TRUE "
                    f"AND embedding IS NOT NULL "
                    f"ORDER BY embedding<=>'{vec}'::vector LIMIT $2",
                    _parse_org_id(org_id), top_k,
                )
        return {"results": [dict(r) for r in rows]}

    async with db_pool.acquire() as conn:
        try:
            rows = await conn.fetch(
                "SELECT id,scope,task_type,learning_type,description,evidence,confidence,human_verified,created_at "
                "FROM agent_learnings WHERE org_id=$1 AND active=TRUE "
                "AND description ILIKE $2 ORDER BY confidence DESC LIMIT $3",
                _parse_org_id(org_id), f"%{q}%", top_k,
            )
        except asyncpg.exceptions.UndefinedColumnError:
            rows = await conn.fetch(
                "SELECT id,scope,task_type,learning_type,description,evidence,confidence,created_at "
                "FROM agent_learnings WHERE org_id=$1 AND active=TRUE "
                "AND description ILIKE $2 ORDER BY confidence DESC LIMIT $3",
                _parse_org_id(org_id), f"%{q}%", top_k,
            )
    return {"results": [dict(r) for r in rows]}


@app.get("/learnings/gold-patterns")
async def get_gold_patterns(org_id: str = Query(...), task_type: Optional[str] = None):
    return await _get_learnings_by_type(org_id, "gold_pattern", task_type)

@app.get("/learnings/anti-patterns")
async def get_anti_patterns(org_id: str = Query(...), task_type: Optional[str] = None):
    return await _get_learnings_by_type(org_id, "anti_pattern", task_type)


async def _get_learnings_by_type(org_id: str, learning_type: str, task_type: Optional[str]) -> dict:
    conditions = ["org_id=$1", "learning_type=$2", "active=TRUE"]
    params: list = [_parse_org_id(org_id), learning_type]
    n = 3
    if task_type:
        conditions.append(f"task_type=${n}"); params.append(task_type); n += 1
    where = " AND ".join(conditions)
    async with db_pool.acquire() as conn:
        try:
            rows = await conn.fetch(
                f"SELECT id,scope,task_type,learning_type,description,evidence,confidence,human_verified,created_at "
                f"FROM agent_learnings WHERE {where} ORDER BY confidence DESC",
                *params,
            )
        except asyncpg.exceptions.UndefinedColumnError:
            rows = await conn.fetch(
                f"SELECT id,scope,task_type,learning_type,description,evidence,confidence,created_at "
                f"FROM agent_learnings WHERE {where} ORDER BY confidence DESC",
                *params,
            )
    return {"learning_type": learning_type, "learnings": [dict(r) for r in rows]}


# ─── Decision Trees ───────────────────────────────────────────────────────────

class DecisionTreeCreate(BaseModel):
    org_id:          str
    tree_name:       str
    task_type:       str
    tree_definition: dict = {}
    created_by:      Optional[str] = None

@app.post("/decision-trees", status_code=201)
async def create_decision_tree(body: DecisionTreeCreate):
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO decision_trees
               (org_id, tree_name, task_type, tree_definition, created_by)
               VALUES ($1,$2,$3,$4::jsonb,$5)
               RETURNING id, version""",
            uuid.UUID(body.org_id), body.tree_name, body.task_type,
            json.dumps(body.tree_definition), body.created_by,
        )
    return {"id": str(row["id"]), "version": row["version"]}


@app.get("/decision-trees/{tree_id}")
async def get_decision_tree(tree_id: str):
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM decision_trees WHERE id=$1 AND is_active=TRUE",
            uuid.UUID(tree_id),
        )
    if not row:
        raise HTTPException(404, "Decision tree not found")
    return dict(row)


@app.post("/decision-trees/{tree_id}/traverse")
async def traverse_decision_tree(tree_id: str, context: dict):
    """Simple decision tree traversal — evaluates conditions against provided context."""
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT tree_definition FROM decision_trees WHERE id=$1 AND is_active=TRUE",
            uuid.UUID(tree_id),
        )
    if not row:
        raise HTTPException(404, "Decision tree not found")

    tree = row["tree_definition"]
    result = _traverse_tree(tree, context)
    return {"tree_id": tree_id, "result": result, "context_keys": list(context.keys())}


def _traverse_tree(tree: dict, context: dict) -> dict:
    """Recursively traverse a simple boolean decision tree."""
    if not tree:
        return {"action": "default", "path": []}

    node = tree.get("root") or tree
    path = []

    def _eval_node(n: dict) -> str:
        if "condition" in n:
            key = n["condition"].get("key", "")
            op  = n["condition"].get("op", "eq")
            val = n["condition"].get("value")
            ctx_val = context.get(key)
            matched = False
            if op == "eq":   matched = ctx_val == val
            elif op == "gt": matched = float(ctx_val or 0) > float(val or 0)
            elif op == "lt": matched = float(ctx_val or 0) < float(val or 0)
            elif op == "in": matched = ctx_val in (val or [])
            elif op == "exists": matched = ctx_val is not None

            path.append({"key": key, "op": op, "value": val, "matched": matched})
            branch = n.get("if_true") if matched else n.get("if_false")
            if branch:
                return _eval_node(branch)
        return n.get("action", "default")

    action = _eval_node(node)
    return {"action": action, "path": path}


# ─── Explainable Recall ───────────────────────────────────────────────────────

@app.post("/recall")
async def recall_memories(body: RecallRequest):
    """Unified recall: search across specified memory types, return with source chains."""
    results: list[dict] = []

    if "semantic" in body.memory_types or not body.memory_types:
        sem = await search_semantic_memory.__wrapped__(body.query, org_id=body.org_id or "", top_k=body.top_k) if body.org_id else {}
        for r in (sem.get("results") or []):
            results.append({**r, "memory_type": "semantic",
                            "source_chain": [f"semantic:{r.get('id','')}"]})

    if "episodic" in body.memory_types and body.org_id:
        emb = await _embed(body.query)
        if emb:
            vec = _vec_str(emb)
            async with db_pool.acquire() as conn:
                rows = await conn.fetch(
                    f"SELECT id,episode_type,context_summary,outcome_summary,"
                    f"importance,1-(embedding<=>'{vec}'::vector) as similarity "
                    f"FROM episodic_memories WHERE org_id=$1 AND is_active=TRUE "
                    f"AND embedding IS NOT NULL "
                    f"ORDER BY embedding<=>'{vec}'::vector LIMIT $2",
                    uuid.UUID(body.org_id), body.top_k,
                )
            for r in rows:
                results.append({**dict(r), "memory_type": "episodic",
                                "source_chain": [f"episodic:{r['id']}"]})

    if "learnings" in body.memory_types and body.org_id:
        lr = await search_learnings.__wrapped__(body.query, org_id=body.org_id or "", top_k=body.top_k)
        for r in (lr.get("results") or []):
            results.append({**r, "memory_type": "learning",
                            "source_chain": [f"learning:{r.get('id','')}"]})

    # Sort by similarity desc, importance desc
    results.sort(key=lambda x: (x.get("similarity") or x.get("importance") or 0), reverse=True)
    return {"query": body.query, "memories": results[:body.top_k],
            "memory_types_searched": body.memory_types}


# Expose inner functions for /recall to call without Query binding issues
search_semantic_memory.__wrapped__ = lambda q, org_id, top_k: search_semantic_memory.__call__(
    q=q, org_id=org_id, top_k=top_k
)
search_learnings.__wrapped__ = lambda q, org_id, top_k: search_learnings.__call__(
    q=q, org_id=org_id, top_k=top_k
)


# ─── Contradiction Detection ──────────────────────────────────────────────────

@app.post("/contradiction/resolve")
async def resolve_contradiction(body: ContradictionResolve):
    async with db_pool.acquire() as conn:
        await conn.execute(
            "UPDATE memory_contradictions SET resolution=$1, resolved_by=$2, "
            "resolved_at=NOW(), status='resolved' WHERE id=$3",
            body.resolution, body.resolved_by, uuid.UUID(body.contradiction_id),
        )
    return {"resolved": True}


@app.get("/contradiction/pending")
async def get_pending_contradictions(org_id: str = Query(...)):
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id,memory_a_id,memory_a_type,memory_b_id,memory_b_type,"
            "contradiction_description,created_at "
            "FROM memory_contradictions WHERE org_id=$1 AND status='pending' "
            "ORDER BY created_at DESC",
            _parse_org_id(org_id),
        )
    return {"contradictions": [dict(r) for r in rows]}


# ─── Performance Memory ───────────────────────────────────────────────────────

@app.post("/memory/performance", status_code=201)
async def store_performance(body: dict):
    org_id = uuid.UUID(body.get("org_id", ""))
    agent_id = uuid.UUID(body.get("agent_definition_id", ""))
    study_id = uuid.UUID(body["study_id"]) if body.get("study_id") else None
    period_start = date.fromisoformat(body.get("period_start", date.today().isoformat()))
    period_end = date.fromisoformat(body.get("period_end", date.today().isoformat()))

    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO performance_memories
               (org_id, agent_definition_id, study_id, period_start, period_end,
                run_count, success_count, hitl_count, avg_confidence,
                avg_duration_secs, avg_cost_usd)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               ON CONFLICT (org_id, agent_definition_id, period_start)
               DO UPDATE SET run_count=EXCLUDED.run_count,
                             success_count=EXCLUDED.success_count,
                             avg_confidence=EXCLUDED.avg_confidence
               RETURNING id""",
            org_id, agent_id, study_id, period_start, period_end,
            body.get("run_count", 0), body.get("success_count", 0),
            body.get("hitl_count", 0), body.get("avg_confidence"),
            body.get("avg_duration_secs"), body.get("avg_cost_usd", 0),
        )
    return {"id": str(row["id"])}


@app.get("/memory/performance/{agent_id}")
async def get_performance(agent_id: str, org_id: str = Query(...), limit: int = 30):
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT period_start,period_end,run_count,success_count,hitl_count,"
            "avg_confidence,avg_duration_secs,avg_cost_usd "
            "FROM performance_memories WHERE org_id=$1 AND agent_definition_id=$2 "
            "ORDER BY period_start DESC LIMIT $3",
            _parse_org_id(org_id), uuid.UUID(agent_id), limit,
        )
    return {"agent_id": agent_id, "performance": [dict(r) for r in rows]}
