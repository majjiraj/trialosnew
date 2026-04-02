"""
TrialOS Context Graph Service  (port 8008)
============================================
Builds and queries the knowledge graph that underpins every agent interaction.

Responsibilities
----------------
1. Document graph building  — after ingestion, build nodes/edges/entities
2. Document type detection  — LLM-powered auto-classification
3. Context query            — agents query here (not raw DB); returns cited sources
4. Decision trace recording — captures agent reasoning for explainability
5. Feedback processing      — adjusts node weights; improves future context quality
6. Event-driven updates     — Kafka consumer keeps graph current
7. Lineage traversal        — full provenance for any context item

Design Principles
-----------------
• Agents NEVER query raw tables directly — they go through /context/query
• Every answer carries a sources_cited list (chunk_id, doc_name, score, excerpt)
• Feedback on an output cascades to the contributing nodes' importance_weight
• Graph is stored in PostgreSQL (adjacency tables + recursive CTEs) — no extra DB
"""

from contextlib import asynccontextmanager
from dataclasses import dataclass, field, asdict
from fastapi import FastAPI, HTTPException, BackgroundTasks, Query
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings
import structlog
import asyncpg
import json
import uuid
import asyncio
import re
import hashlib
from datetime import datetime, timezone
from typing import Optional, Any, List
import httpx
import time as _time

try:
    import redis.asyncio as aioredis
    _REDIS_AVAILABLE = True
except ImportError:
    _REDIS_AVAILABLE = False

log = structlog.get_logger()


# ─── Settings ────────────────────────────────────────────────────────────────

class Settings(BaseSettings):
    database_url: str
    ollama_base_url: str        = "http://localhost:11434"
    ollama_model: str           = "llama3.1:8b"
    embedding_provider: str     = "ollama"
    embedding_model: str        = "nomic-embed-text"
    embedding_dim: int          = 768
    kafka_brokers: str          = "localhost:9092"
    context_graph_url: str      = "http://localhost:8008"
    max_entity_batch: int       = 5    # chunks to process in one LLM entity-extract call
    max_entity_chunks: int      = 100  # max chunks to run entity extraction on (avoids multi-hour runs on large docs)
    min_type_confidence: float  = 0.70 # below this → pending classification
    platform_org_id: str        = "00000000-0000-0000-0000-000000000000"
    redis_url: str              = "redis://localhost:6379"
    drift_check_interval_secs: int = 1800   # 30 minutes
    drift_threshold: float      = 0.20      # >20% unindexed → needs_reindex
    neo4j_url: str              = "bolt://localhost:7687"
    neo4j_username: str         = "neo4j"
    neo4j_password: str         = "trialo_dev"

    class Config:
        env_file = ".env"


settings     = Settings()
db_pool:     asyncpg.Pool   = None
redis_client: Any           = None   # aioredis.Redis or None
_neo4j_driver: Any          = None   # neo4j AsyncDriver or None


async def _emit_log(conn, doc_id: str, org_id: str, step: str, event: str,
                    message: str, metadata: dict = None):
    try:
        await conn.execute(
            "INSERT INTO processing_logs "
            "(document_id, org_id, step, event, message, metadata) "
            "VALUES ($1,$2,$3,$4,$5,$6)",
            doc_id, org_id, step, event, message,
            json.dumps(metadata or {}))
    except Exception as exc:
        log.warning("processing_log.emit_failed", error=str(exc))


@asynccontextmanager
async def lifespan(app: FastAPI):
    global db_pool, redis_client, _neo4j_driver
    db_pool = await asyncpg.create_pool(settings.database_url, min_size=3, max_size=15)
    if _REDIS_AVAILABLE:
        try:
            redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
            await redis_client.ping()
            log.info("context_graph.redis_connected")
        except Exception as exc:
            log.warning("context_graph.redis_unavailable", error=str(exc))
            redis_client = None
    # Neo4j — non-fatal if unavailable
    try:
        from neo4j import AsyncGraphDatabase
        _neo4j_driver = AsyncGraphDatabase.driver(
            settings.neo4j_url,
            auth=(settings.neo4j_username, settings.neo4j_password),
        )
        await _neo4j_run("RETURN 1")  # connectivity check
        await _neo4j_init_constraints()
        log.info("context_graph.neo4j_connected", url=settings.neo4j_url)
    except Exception as exc:
        log.warning("context_graph.neo4j_unavailable", error=str(exc))
        _neo4j_driver = None
    log.info("context_graph.startup")
    asyncio.create_task(_kafka_consumer())
    asyncio.create_task(_drift_detection_loop())
    yield
    await db_pool.close()
    if redis_client:
        await redis_client.aclose()
    if _neo4j_driver:
        await _neo4j_driver.close()


app = FastAPI(title="TrialOS Context Graph", version="1.0.0", lifespan=lifespan)

from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Neo4j Helpers ────────────────────────────────────────────────────────────

async def _neo4j_run(cypher: str, params: dict = None) -> list:
    """Execute a Cypher statement. Returns list of record dicts. Non-fatal."""
    if not _neo4j_driver:
        return []
    try:
        async with _neo4j_driver.session() as session:
            result = await session.run(cypher, params or {})
            return await result.data()
    except Exception as exc:
        log.warning("neo4j.query.failed", cypher=cypher[:80], error=str(exc))
        return []


async def _neo4j_init_constraints():
    """Create uniqueness constraints for all reasoning node labels."""
    for label in ("AgentRun", "DecisionTrace", "Score", "Feedback",
                  "RetrievalRecipe", "SkillInvocation", "PromptTemplate", "Chunk"):
        await _neo4j_run(
            f"CREATE CONSTRAINT IF NOT EXISTS FOR (n:{label}) REQUIRE n.id IS UNIQUE"
        )


# ─── Helpers ─────────────────────────────────────────────────────────────────

async def _llm_call(prompt: str, system: str = "", max_tokens: int = 1024) -> str:
    """Call Ollama /api/generate and return the response text."""
    try:
        full_prompt = f"{system}\n\n{prompt}".strip() if system else prompt
        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(
                f"{settings.ollama_base_url}/api/generate",
                json={
                    "model": settings.ollama_model,
                    "prompt": full_prompt,
                    "stream": False,
                    "options": {"num_predict": max_tokens, "temperature": 0},
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("response", "")
    except Exception as exc:
        log.warning("llm_call.failed", error=str(exc))
        return ""


async def _embed(texts: list[str]) -> list[list[float]]:
    """Embed texts via Ollama /api/embeddings."""
    if not texts:
        return []
    base_url = settings.ollama_base_url.rstrip("/")
    model    = settings.embedding_model
    results: list[list[float]] = []
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            for text in texts:
                r = await client.post(
                    f"{base_url}/api/embeddings",
                    json={"model": model, "prompt": text[:4000]},
                )
                r.raise_for_status()
                results.append(r.json()["embedding"])
        return results
    except Exception as exc:
        log.warning("embed.failed", error=str(exc))
        return [[] for _ in texts]


def _vec_str(v: list[float]) -> str:
    return "[" + ",".join(str(x) for x in v) + "]"


# ─── Document Type Detection ─────────────────────────────────────────────────

SYSTEM_TYPE_DETECTION = """You are a clinical trial document classification expert.
Given a document excerpt, identify the document type and extract key metadata.
Respond ONLY with valid JSON matching the schema exactly:
{
  "detected_type": "protocol|sap|crf|csr|sdtm_ig|adam_ig|lab_manual|dmp|icf|lab_report|study_budget|other|unknown",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation",
  "alternative_types": [{"type": "...", "confidence": 0.0}],
  "metadata_extracted": {
    "study_name": "...",
    "protocol_number": "...",
    "version": "...",
    "date": "...",
    "sponsor": "...",
    "compound": "..."
  },
  "key_phrases": ["phrase1", "phrase2"],
  "structure_description": "brief description of document structure"
}"""

async def detect_document_type(text_excerpt: str, filename: str) -> dict:
    """Use LLM to auto-detect document type from text excerpt."""
    prompt = f"""Filename: {filename}

Document excerpt (first 3000 chars):
---
{text_excerpt[:3000]}
---

Classify this clinical document. Return JSON only."""

    raw = await _llm_call(prompt, system=SYSTEM_TYPE_DETECTION, max_tokens=512)

    try:
        # Extract JSON from the response (sometimes LLMs add extra text)
        start = raw.find("{")
        end   = raw.rfind("}") + 1
        if start >= 0 and end > start:
            return json.loads(raw[start:end])
    except json.JSONDecodeError:
        pass

    # Fallback: keyword-based detection
    return _keyword_type_detection(text_excerpt, filename)


def _keyword_type_detection(text: str, filename: str) -> dict:
    """Fallback keyword-based document type detection."""
    text_lower = text.lower()
    fname_lower = filename.lower()

    rules = [
        ("protocol",    ["protocol number", "inclusion criteria", "exclusion criteria", "investigational product"], 0.0),
        ("sap",         ["statistical analysis plan", "analysis sets", "primary endpoint analysis", "multiplicity"], 0.0),
        ("crf",         ["case report form", "data entry", "visit schedule form"], 0.0),
        ("csr",         ["clinical study report", "study results", "synopsis", "patient disposition"], 0.0),
        ("sdtm_ig",     ["sdtm", "cdisc", "domain model", "controlled terminology"], 0.0),
        ("adam_ig",     ["adam", "analysis dataset", "adsl", "derivation"], 0.0),
        ("lab_manual",  ["specimen collection", "sample handling", "normal range", "laboratory manual"], 0.0),
        ("dmp",         ["data management plan", "database lock", "query management", "edit check"], 0.0),
        ("icf",         ["informed consent", "voluntary participation", "risks and benefits"], 0.0),
        ("lab_report",  ["laboratory results", "test results", "reference range", "lab values"], 0.0),
        ("study_budget",["budget", "payment", "per visit", "site payment", "milestones"], 0.0),
    ]
    for type_code, keywords, _ in rules:
        score = sum(1 for kw in keywords if kw in text_lower) / len(keywords)
        if type_code in fname_lower:
            score = max(score, 0.6)
        rules[rules.index(next(r for r in rules if r[0] == type_code))] = (type_code, keywords, score)

    best = max(rules, key=lambda r: r[2])
    confidence = min(best[2], 0.65)  # cap keyword detection at 0.65
    return {
        "detected_type": best[0] if confidence > 0.3 else "unknown",
        "confidence": confidence,
        "reasoning": "keyword-based detection (LLM unavailable)",
        "alternative_types": [],
        "metadata_extracted": {},
        "key_phrases": [],
        "structure_description": "",
    }


# ─── Entity Extraction ────────────────────────────────────────────────────────

# Generic clinical document entity extraction
SYSTEM_ENTITY_EXTRACT = """You are a clinical NLP expert extracting entities from clinical trial documents.
Extract entities and return ONLY valid JSON:
{
  "entities": [
    {
      "text": "original text",
      "normalized": "canonical form",
      "type": "endpoint|drug|biomarker|criterion|procedure|timepoint|regulatory_ref|role|organization|other",
      "confidence": 0.0-1.0,
      "context": "short surrounding context"
    }
  ]
}
Focus on: primary/secondary endpoints, drugs/doses, inclusion/exclusion criteria,
procedures, lab parameters, regulatory references (ICH/FDA/CDISC), timepoints."""

# SDTM IG-specific entity extraction — builds domain/variable/codelist graph + generic entities
SYSTEM_SDTM_ENTITY_EXTRACT = """You are a CDISC SDTM expert and clinical NLP specialist. Extract ALL entities from these document chunks.
Return ONLY valid JSON:
{
  "entities": [
    {
      "text": "AETERM",
      "normalized": "AETERM",
      "type": "sdtm_variable",
      "domain": "AE",
      "label": "Reported Term for the Adverse Event",
      "core": "Req",
      "codelist": null,
      "confidence": 0.95
    },
    {
      "text": "Adverse Events",
      "normalized": "AE",
      "type": "sdtm_domain",
      "label": "Adverse Events",
      "confidence": 0.99
    },
    {
      "text": "AESEV",
      "normalized": "AESEV",
      "type": "sdtm_variable",
      "domain": "AE",
      "label": "Severity/Intensity",
      "core": "Perm",
      "codelist": "AESEV",
      "confidence": 0.9
    },
    {
      "text": "MILD",
      "normalized": "MILD",
      "type": "codelist_term",
      "codelist": "AESEV",
      "confidence": 0.85
    },
    {
      "text": "21 CFR Part 11",
      "normalized": "21 CFR Part 11",
      "type": "regulatory_ref",
      "confidence": 0.9,
      "context": "compliance requirement"
    }
  ]
}
Entity types — extract ALL that appear:
SDTM-specific:
- sdtm_variable: SDTM variable name (uppercase, 2-8 chars) e.g. AETERM, AESEV, USUBJID. Include domain, label, core (Req/Exp/Perm), codelist.
- sdtm_domain:   2-letter domain code e.g. AE, LB, VS, CM, DM. Include label.
- codelist:      controlled terminology list name e.g. AESEV, AEDECOD, RACE
- codelist_term: individual codelist value e.g. MILD, MODERATE, SEVERE, MALE, FEMALE. Include codelist name.
Generic clinical:
- endpoint, drug, biomarker, criterion, procedure, timepoint, regulatory_ref, role, organization, other

Extract ALL SDTM variable names, domain codes, controlled terminology, AND any regulatory references, procedures, or clinical concepts mentioned."""


async def extract_entities_from_chunks(chunks: list[dict], doc_type: str = "other") -> list[dict]:
    """Extract entities using doc-type-appropriate prompt."""
    if doc_type in {"sdtm_ig", "adam_ig"}:
        return await _extract_sdtm_entities(chunks)
    return await _extract_clinical_entities(chunks)


async def _extract_clinical_entities(chunks: list[dict]) -> list[dict]:
    combined = "\n\n---CHUNK BOUNDARY---\n\n".join(
        f"[Chunk {i}] Section: {c.get('section','')}\n{c['text'][:600]}"
        for i, c in enumerate(chunks[:settings.max_entity_batch])
    )
    prompt = f"Extract clinical entities from these document chunks:\n\n{combined}\n\nReturn JSON only."
    raw    = await _llm_call(prompt, system=SYSTEM_ENTITY_EXTRACT, max_tokens=800)
    try:
        s, e = raw.find("{"), raw.rfind("}") + 1
        if s >= 0 and e > s:
            return json.loads(raw[s:e]).get("entities", [])
    except Exception:
        pass
    return []


async def _extract_sdtm_entities(chunks: list[dict]) -> list[dict]:
    """SDTM-specific extraction: prioritises table chunks (variable definitions)."""
    # Sort batch: table chunks first — they are the richest source of variables
    sorted_chunks = sorted(
        chunks[:settings.max_entity_batch],
        key=lambda c: 0 if (c.get("metadata") or {}).get("content_type") == "table" else 1
    )
    combined = "\n\n---CHUNK BOUNDARY---\n\n".join(
        f"[Chunk {i}] Section: {c.get('section','')}\nType: {(c.get('metadata') or {}).get('content_type','text')}\n{c['text'][:800]}"
        for i, c in enumerate(sorted_chunks)
    )
    prompt = f"Extract SDTM entities from these chunks:\n\n{combined}\n\nReturn JSON only."
    raw    = await _llm_call(prompt, system=SYSTEM_SDTM_ENTITY_EXTRACT, max_tokens=1800)
    try:
        s, e = raw.find("{"), raw.rfind("}") + 1
        if s >= 0 and e > s:
            return json.loads(raw[s:e]).get("entities", [])
    except Exception:
        pass
    return []


def _extract_sdtm_entities_from_table_row(chunk: dict) -> list[dict]:
    """
    Deterministic entity extraction from a pre-structured table_row chunk.
    No LLM needed — all fields are already parsed in chunk metadata.
    """
    meta     = chunk.get("metadata") or {}
    var_name = (meta.get("variable") or "").strip()
    domain   = (meta.get("domain") or "").strip().upper()
    label    = (meta.get("label") or "").strip()
    core     = (meta.get("core") or "").strip()

    if not var_name or not re.match(r'^[A-Z][A-Z0-9]{1,7}$', var_name):
        return []

    entities = [{
        "text":       var_name,
        "normalized": var_name,
        "type":       "sdtm_variable",
        "domain":     domain,
        "label":      label,
        "core":       core,
        "codelist":   None,
        "confidence": 0.99,
    }]

    if domain and re.match(r'^[A-Z]{2}$', domain):
        entities.append({
            "text":       domain,
            "normalized": domain,
            "type":       "sdtm_domain",
            "label":      label,
            "confidence": 0.99,
        })

    # Use structured codelist from chunk metadata (captured from the controlled terms column)
    codelist_ref = (meta.get("codelist") or "").strip()
    if codelist_ref:
        entities[0]["codelist"] = codelist_ref
    else:
        # Fallback: text regex for chunks that predate the structured column extraction
        cl_match = re.search(
            r'\b([A-Z]{2,10}(?:CL|CAT)?)\b.*?(?:controlled terminology|CDISC CT)',
            chunk.get("text", ""), re.IGNORECASE
        )
        if cl_match:
            entities[0]["codelist"] = cl_match.group(1)
            codelist_ref = cl_match.group(1)

    # Emit a codelist entity so the codelist node/concept gets created
    if codelist_ref:
        entities.append({
            "text":       codelist_ref,
            "normalized": codelist_ref,
            "type":       "codelist",
            "domain":     domain,
            "confidence": 0.95,
        })

    return entities


# ─── Graph Building ───────────────────────────────────────────────────────────

async def _upsert_node(conn, node_type: str, external_id: str, org_id: str,
                       study_id: Optional[str], label: str, metadata: dict,
                       embedding: Optional[list[float]] = None) -> str:
    """Insert or return existing context node. Returns node UUID."""
    existing = await conn.fetchval(
        "SELECT id FROM context_nodes WHERE external_id=$1 AND node_type=$2 AND org_id=$3",
        external_id, node_type, org_id
    )
    if existing:
        # Update embedding if we now have one but the stored node doesn't
        if embedding:
            emb_str = _vec_str(embedding)
            await conn.execute(
                "UPDATE context_nodes SET embedding=$1::vector WHERE id=$2 AND embedding IS NULL",
                emb_str, existing,
            )
        return str(existing)

    node_id = str(uuid.uuid4())
    emb_str = _vec_str(embedding) if embedding else None
    await conn.execute("""
        INSERT INTO context_nodes (id, node_type, external_id, org_id, study_id, label, metadata, embedding)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector)
    """, node_id, node_type, external_id, org_id, study_id, label,
        json.dumps(metadata),
        emb_str)
    return node_id


async def _upsert_edge(conn, source_id: str, target_id: str, edge_type: str,
                       weight: float = 1.0, metadata: dict = None) -> None:
    await conn.execute("""
        INSERT INTO context_edges (source_node_id, target_node_id, edge_type, weight, metadata)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (source_node_id, target_node_id, edge_type) DO UPDATE
            SET weight = EXCLUDED.weight, metadata = EXCLUDED.metadata
    """, source_id, target_id, edge_type, weight, json.dumps(metadata or {}))


async def build_document_graph(doc_id: str, org_id: str, study_id: Optional[str]):
    """
    Build the context graph for a processed document.

    Graph strategy varies by document type:
    ─────────────────────────────────────────
    Generic:  document → chunk → entity → concept
              Section-level context index (Tier 1) + entity cluster index (Tier 2)

    SDTM IG:  document → chunk → sdtm_domain → sdtm_variable → codelist → codelist_term
              Dedicated index entries per domain, per variable table (Tier 3).
              Entity extraction prioritises table chunks (richest variable definitions).

    Content-type awareness:
      • Table chunks → nodes tagged content_type=table, domain-aware index entries
      • Text chunks  → section-level index entries (same as generic)
      • Figure chunks→ tagged but not separately indexed (low signal for SDTM IG)
    """
    log.info("graph.build.start", doc_id=doc_id)

    async with db_pool.acquire() as conn:
        doc = await conn.fetchrow(
            "SELECT id, name, document_type, study_id, org_id FROM documents WHERE id=$1", doc_id
        )
        if not doc:
            log.warning("graph.build.doc_not_found", doc_id=doc_id)
            return

        chunks = await conn.fetch(
            "SELECT id, chunk_index, section, page_number, content, metadata, embedding "
            "FROM document_chunks WHERE document_id=$1 ORDER BY chunk_index",
            doc_id
        )
        if not chunks:
            log.warning("graph.build.no_chunks", doc_id=doc_id)
            return

        doc_type     = doc["document_type"]
        eff_study_id = (study_id or str(doc["study_id"])) if doc["study_id"] else None

        # ── 1. Document node ────────────────────────────────────────────────
        doc_node_id = await _upsert_node(
            conn, "document", doc_id, org_id, eff_study_id,
            doc["name"],
            {"document_type": doc_type, "name": doc["name"]},
        )

        # ── 2. Chunk nodes + contains edges ─────────────────────────────────
        chunk_nodes: dict[str, str] = {}
        for chunk in chunks:
            chunk_emb = _parse_embedding(chunk["embedding"])
            meta_raw  = chunk["metadata"]
            meta      = json.loads(meta_raw) if isinstance(meta_raw, str) else (dict(meta_raw) if meta_raw else {})

            chunk_node_id = await _upsert_node(
                conn, "chunk", str(chunk["id"]), org_id, eff_study_id,
                f"{doc['name']} § {chunk['section'] or chunk['chunk_index']}",
                {
                    "section":      chunk["section"],
                    "page":         chunk["page_number"],
                    "chunk_index":  chunk["chunk_index"],
                    "document_id":  doc_id,
                    "content_type": meta.get("content_type", "text"),
                    "domain":       meta.get("domain"),
                    "columns":      meta.get("columns"),
                },
                chunk_emb,
            )
            chunk_nodes[str(chunk["id"])] = chunk_node_id
            await _upsert_edge(conn, doc_node_id, chunk_node_id, "contains")

        # ── 3a. Tier-1 section index — makes doc searchable immediately ─────
        await _update_context_index(doc_id, org_id, eff_study_id, doc_type)

        # ── XPT: lightweight deterministic graph (no LLM needed) ─────────────
        if doc_type in ("sdtm_dataset", "adam_dataset"):
            await _build_xpt_entity_nodes(
                conn, doc_id, org_id, eff_study_id, doc_node_id, doc["name"]
            )
            log.info("graph.build.done", doc_id=doc_id,
                     chunks=len(chunks), doc_type=doc_type)
            return

        t_build = _time.monotonic()
        await _emit_log(conn, doc_id, org_id, "graph_build", "started",
            f"Building graph — {doc_type}", {"doc_type": doc_type})

        # ── 3b. Entity extraction — two-pass strategy ────────────────────────
        all_chunk_dicts = [
            {
                "id":      str(c["id"]),
                "text":    c["content"],
                "section": c["section"],
                "metadata": json.loads(c["metadata"]) if isinstance(c["metadata"], str)
                            else (dict(c["metadata"]) if c["metadata"] else {}),
            }
            for c in chunks
        ]
        entities: list[dict] = []

        if doc_type in {"sdtm_ig", "adam_ig"}:
            strategy = "sdtm_table_row+prose_llm"
            await _emit_log(conn, doc_id, org_id, "entity_extraction", "started",
                f"Extracting entities from {len(all_chunk_dicts)} chunks",
                {"strategy": strategy, "llm_model": settings.ollama_model,
                 "total_chunks": len(all_chunk_dicts)})

            # Pass 1: ALL table_row chunks — deterministic regex (no LLM, no cap)
            table_row_chunks = [
                c for c in all_chunk_dicts
                if c["metadata"].get("content_type") == "table_row"
            ]
            for c in table_row_chunks:
                entities.extend(_extract_sdtm_entities_from_table_row(c))

            # Pass 2: generic LLM extraction on text prose chunks (capped)
            # SDTM variables/domains are fully covered by the regex Pass 1, so the
            # prose LLM pass uses the GENERIC clinical prompt to extract regulatory refs,
            # organizations, roles, and procedures. Using the SDTM-specific prompt here
            # causes the model to focus on SDTM types and skip generic entities entirely.
            text_chunks = [
                c for c in all_chunk_dicts
                if c["metadata"].get("content_type") == "text"
            ]
            sampled = text_chunks[:settings.max_entity_chunks]
            for i in range(0, len(sampled), settings.max_entity_batch):
                batch      = sampled[i:i + settings.max_entity_batch]
                batch_ents = await _extract_clinical_entities(batch)
                entities.extend(batch_ents)
                batch_num = i // settings.max_entity_batch + 1
                await _emit_log(conn, doc_id, org_id, "entity_extraction", "progress",
                    f"Batch {batch_num}: {len(batch_ents)} entities (total: {len(entities)})",
                    {"batch": batch_num, "batch_entities": len(batch_ents),
                     "running_total": len(entities), "llm_model": settings.ollama_model})

            log.info("entity_extraction.done",
                     table_row_chunks=len(table_row_chunks),
                     table_row_entities=len([e for e in entities if e.get("type") == "sdtm_variable"]),
                     llm_prose_chunks=len(sampled),
                     total_entities=len(entities))
        else:
            strategy = "llm_batch"
            await _emit_log(conn, doc_id, org_id, "entity_extraction", "started",
                f"Extracting entities from {len(all_chunk_dicts)} chunks",
                {"strategy": strategy, "llm_model": settings.ollama_model,
                 "total_chunks": len(all_chunk_dicts)})

            # Non-SDTM: original capped LLM pass
            chunk_dicts = all_chunk_dicts[:settings.max_entity_chunks]
            for i in range(0, len(chunk_dicts), settings.max_entity_batch):
                batch      = chunk_dicts[i:i + settings.max_entity_batch]
                batch_ents = await extract_entities_from_chunks(batch, doc_type=doc_type)
                entities.extend(batch_ents)
                batch_num = i // settings.max_entity_batch + 1
                await _emit_log(conn, doc_id, org_id, "entity_extraction", "progress",
                    f"Batch {batch_num}: {len(batch_ents)} entities (total: {len(entities)})",
                    {"batch": batch_num, "batch_entities": len(batch_ents),
                     "running_total": len(entities), "llm_model": settings.ollama_model})

        by_type_ents: dict[str, int] = {}
        for e in entities:
            et = e.get("type", "?")
            by_type_ents[et] = by_type_ents.get(et, 0) + 1
        await _emit_log(conn, doc_id, org_id, "entity_extraction", "completed",
            f"{len(entities)} entities across {len(by_type_ents)} types",
            {"total_entities": len(entities), "by_type": by_type_ents,
             "llm_model": settings.ollama_model})

        # ── 4. Entity nodes ─────────────────────────────────────────────────
        SDTM_TYPES = {"sdtm_variable", "sdtm_domain", "codelist", "codelist_term"}
        if doc_type in {"sdtm_ig", "adam_ig"}:
            # Split: SDTM-specific types get the domain/variable graph;
            # generic types (endpoint, regulatory_ref, etc.) get entity/concept nodes
            sdtm_ents    = [e for e in entities if e.get("type") in SDTM_TYPES]
            generic_ents = [e for e in entities if e.get("type") not in SDTM_TYPES]
            await _build_sdtm_entity_nodes(
                conn, sdtm_ents, doc_id, doc_node_id, org_id, eff_study_id
            )
            if generic_ents:
                await _build_generic_entity_nodes(
                    conn, generic_ents, doc_id, doc_node_id, org_id, eff_study_id
                )
        else:
            await _build_generic_entity_nodes(
                conn, entities, doc_id, doc_node_id, org_id, eff_study_id
            )

        await _emit_log(conn, doc_id, org_id, "graph_build", "completed",
            f"Graph: {len(chunks)} chunks, {len(entities)} entities",
            {"chunk_nodes": len(chunks), "entity_nodes": len(entities),
             "duration_ms": int((_time.monotonic() - t_build) * 1000)})

        log.info("graph.build.done", doc_id=doc_id,
                 chunks=len(chunks), entities=len(entities), doc_type=doc_type)

    # ── 5. Tier-2 / Tier-3 index (entities now exist) ───────────────────────
    await _update_context_index(doc_id, org_id, eff_study_id, doc_type)


def _parse_embedding(raw) -> Optional[list[float]]:
    if not raw:
        return None
    try:
        return json.loads(raw) if isinstance(raw, str) else list(raw)
    except Exception:
        return None


async def _build_generic_entity_nodes(
    conn, entities: list[dict], doc_id: str, doc_node_id: str,
    org_id: str, study_id: Optional[str]
):
    concept_cache: dict[str, str] = {}
    for ent in entities:
        normalized = ent.get("normalized", ent.get("text", "")).strip()
        ent_type   = ent.get("type", "other")
        if not normalized:
            continue
        ent_node_id = await _upsert_node(
            conn, "entity", f"{doc_id}::{normalized}", org_id, study_id,
            normalized,
            {"type": ent_type, "original_text": ent.get("text"),
             "confidence": ent.get("confidence", 1.0)},
        )
        concept_key = f"{ent_type}::{normalized.lower()}"
        if concept_key not in concept_cache:
            concept_node_id = await _upsert_node(
                conn, "concept", concept_key, org_id, None,
                normalized, {"entity_type": ent_type},
            )
            concept_cache[concept_key] = concept_node_id
            # Upsert into canonical map so future queries can find this entity by alias
            raw_text = ent.get("text", "")
            if raw_text and raw_text.lower() != normalized.lower():
                try:
                    await conn.execute("""
                        INSERT INTO entity_canonical_map (org_id, canonical_form, entity_type, aliases, concept_node_id)
                        VALUES ($1::uuid, $2, $3, $4, $5)
                        ON CONFLICT (org_id, canonical_form, entity_type)
                        DO UPDATE SET aliases = ARRAY(
                            SELECT DISTINCT unnest(entity_canonical_map.aliases || EXCLUDED.aliases)
                        ), updated_at = NOW()
                    """, org_id, normalized, ent_type,
                        [raw_text, raw_text.lower()], concept_cache[concept_key])
                except Exception:
                    pass  # canonical map is advisory; don't fail graph build
        await _upsert_edge(conn, ent_node_id,
                           concept_cache[concept_key], "is_type",
                           float(ent.get("confidence") or 1.0))
        await _upsert_edge(conn, ent_node_id, doc_node_id, "extracted_from")


async def _build_sdtm_entity_nodes(
    conn, entities: list[dict], doc_id: str, doc_node_id: str,
    org_id: str, study_id: Optional[str]
):
    """
    Build SDTM-aware graph nodes and edges:

      SDTMDomain ──has_variable──► SDTMVariable ──uses_codelist──► Codelist
          │                             │                              │
       describes                  extracted_from                   has_term
          ▼                             ▼                              ▼
       Document                      Chunk                       CodelistTerm

    Nodes are org-scoped so different orgs' IG interpretations stay separate.
    """
    domain_cache:   dict[str, str] = {}   # domain code → node_id
    variable_cache: dict[str, str] = {}   # "AE::AETERM" → node_id
    codelist_cache: dict[str, str] = {}   # codelist name → node_id

    # Process sdtm_domain entities FIRST so domain_cache is populated before
    # sdtm_variable processing. Without this, the sdtm_variable handler's
    # "elif domain:" branch adds the domain to domain_cache, causing the
    # sdtm_domain handler to skip entity/concept creation entirely.
    _type_order = {"sdtm_domain": 0, "sdtm_variable": 1, "codelist": 2, "codelist_term": 3}
    entities = sorted(entities, key=lambda e: _type_order.get(e.get("type", "other"), 9))

    for ent in entities:
        normalized = ent.get("normalized", ent.get("text", "")).strip()
        ent_type   = ent.get("type", "other")
        if not normalized:
            continue
        conf = float(ent.get("confidence") or 1.0)

        if ent_type == "sdtm_domain":
            domain = normalized.upper()
            if domain not in domain_cache:
                nid = await _upsert_node(
                    conn, "sdtm_domain", f"{org_id}::domain::{domain}",
                    org_id, study_id, domain,
                    {"domain": domain, "label": ent.get("label", ""), "doc_id": doc_id},
                )
                domain_cache[domain] = nid
                await _upsert_edge(conn, nid, doc_node_id, "described_in", conf)

                # Create entity + concept pair so every SDTM domain is discoverable
                # via the generic entity/concept graph — LLM extraction is unreliable
                # for spec documents so we do this deterministically.
                ent_nid = await _upsert_node(
                    conn, "entity", f"{doc_id}::domain::{domain}",
                    org_id, study_id, domain,
                    {"type": "sdtm_domain", "original_text": ent.get("text", domain),
                     "confidence": conf},
                )
                concept_key = f"sdtm_domain::{domain.lower()}"
                concept_nid = await _upsert_node(
                    conn, "concept", concept_key, org_id, None,
                    domain, {"entity_type": "sdtm_domain"},
                )
                await _upsert_edge(conn, ent_nid, concept_nid, "is_type", conf)
                await _upsert_edge(conn, ent_nid, doc_node_id, "extracted_from", conf)

        elif ent_type == "sdtm_variable":
            domain   = (ent.get("domain") or "").upper()
            var_key  = f"{domain}::{normalized}"
            if var_key not in variable_cache:
                nid = await _upsert_node(
                    conn, "sdtm_variable",
                    f"{org_id}::var::{var_key}",
                    org_id, study_id, normalized,
                    {
                        "variable": normalized, "domain": domain,
                        "label":    ent.get("label", ""),
                        "core":     ent.get("core", ""),
                        "codelist": ent.get("codelist"),
                        "doc_id":   doc_id,
                    },
                )
                variable_cache[var_key] = nid
                await _upsert_edge(conn, nid, doc_node_id, "extracted_from", conf)

                # If codelist found, patch it into any pre-existing node that lacked it
                if ent.get("codelist"):
                    await conn.execute("""
                        UPDATE context_nodes
                        SET metadata = jsonb_set(metadata::jsonb, '{codelist}', $1::jsonb)
                        WHERE id = $2 AND (metadata::jsonb->>'codelist' IS NULL
                                           OR metadata::jsonb->>'codelist' = ''
                                           OR metadata::jsonb->>'codelist' = 'null')
                    """, json.dumps(ent["codelist"]), nid)

                # Concept node for this variable (org-scoped, 1 per unique variable across all uploads)
                concept_key_var = f"sdtm_variable::{var_key.lower()}"
                concept_nid_var = await _upsert_node(
                    conn, "concept", concept_key_var, org_id, None,
                    f"{domain}.{normalized}",
                    {
                        "entity_type": "sdtm_variable",
                        "domain":      domain,
                        "label":       ent.get("label", ""),
                        "core":        ent.get("core", ""),
                        "codelist":    ent.get("codelist") or "",
                    },
                )
                await _upsert_edge(conn, nid, concept_nid_var, "is_type", conf)

                # Link to domain node
                if domain and domain in domain_cache:
                    await _upsert_edge(conn, domain_cache[domain], nid, "has_variable", conf)
                elif domain:
                    # Ensure domain node exists even if not yet extracted
                    d_nid = await _upsert_node(
                        conn, "sdtm_domain", f"{org_id}::domain::{domain}",
                        org_id, study_id, domain,
                        {"domain": domain, "doc_id": doc_id},
                    )
                    domain_cache[domain] = d_nid
                    await _upsert_edge(conn, d_nid, nid, "has_variable", conf)

        elif ent_type == "codelist":
            cl_name = normalized
            if cl_name not in codelist_cache:
                nid = await _upsert_node(
                    conn, "codelist", f"{org_id}::cl::{cl_name}",
                    org_id, study_id, cl_name,
                    {"codelist": cl_name, "doc_id": doc_id},
                )
                codelist_cache[cl_name] = nid
                await _upsert_edge(conn, nid, doc_node_id, "extracted_from", conf)

                # Concept node for this codelist (org-scoped, 1 per unique codelist)
                concept_key_cl = f"codelist::{cl_name.lower()}"
                concept_nid_cl = await _upsert_node(
                    conn, "concept", concept_key_cl, org_id, None,
                    cl_name, {"entity_type": "codelist"},
                )
                await _upsert_edge(conn, nid, concept_nid_cl, "is_type", conf)

        elif ent_type == "codelist_term":
            cl_name = ent.get("codelist", "")
            if cl_name:
                if cl_name not in codelist_cache:
                    nid = await _upsert_node(
                        conn, "codelist", f"{org_id}::cl::{cl_name}",
                        org_id, study_id, cl_name,
                        {"codelist": cl_name, "doc_id": doc_id},
                    )
                    codelist_cache[cl_name] = nid
                term_nid = await _upsert_node(
                    conn, "codelist_term",
                    f"{org_id}::term::{cl_name}::{normalized}",
                    org_id, study_id, normalized,
                    {"term": normalized, "codelist": cl_name, "doc_id": doc_id},
                )
                await _upsert_edge(conn, codelist_cache[cl_name], term_nid, "has_term", conf)

    # Second pass: link variables to their codelists
    for ent in entities:
        if ent.get("type") == "sdtm_variable" and ent.get("codelist"):
            domain  = (ent.get("domain") or "").upper()
            var_key = f"{domain}::{ent.get('normalized', ent.get('text', '')).strip()}"
            cl_name = ent["codelist"]
            var_nid = variable_cache.get(var_key)
            if var_nid:
                if cl_name not in codelist_cache:
                    nid = await _upsert_node(
                        conn, "codelist", f"{org_id}::cl::{cl_name}",
                        org_id, study_id, cl_name,
                        {"codelist": cl_name, "doc_id": doc_id},
                    )
                    codelist_cache[cl_name] = nid
                await _upsert_edge(conn, var_nid, codelist_cache[cl_name],
                                   "uses_codelist", float(ent.get("confidence") or 1.0))


async def _build_xpt_entity_nodes(
    conn, doc_id: str, org_id: str, study_id: Optional[str],
    doc_node_id: str, doc_name: str,
):
    """
    Build graph nodes and context_index entries for XPT dataset documents.
    Deterministic — no LLM. Uses the variable-definitions table chunk
    (content_type='table') created by chunk_xpt().
    """
    t_xpt = _time.monotonic()
    table_chunk = await conn.fetchrow("""
        SELECT metadata FROM document_chunks
        WHERE document_id=$1 AND (metadata::jsonb->>'content_type') = 'table'
        LIMIT 1
    """, doc_id)

    if not table_chunk:
        log.warning("xpt.graph.no_table_chunk", doc_id=doc_id)
        return

    meta_raw        = table_chunk["metadata"]
    meta            = json.loads(meta_raw) if isinstance(meta_raw, str) else dict(meta_raw or {})
    variable_labels = meta.get("variable_labels") or {}
    domain          = meta.get("domain") or ""
    actual_cols     = list(variable_labels.keys())

    await _emit_log(conn, doc_id, org_id, "xpt_graph", "started",
        f"Building XPT variable graph for {domain}",
        {"domain": domain, "variables": len(actual_cols)})

    # n_rows from the header text chunk
    n_rows = 0
    hdr = await conn.fetchrow("""
        SELECT metadata FROM document_chunks
        WHERE document_id=$1 AND (metadata::jsonb->>'content_type') = 'text'
        LIMIT 1
    """, doc_id)
    if hdr:
        hm     = json.loads(hdr["metadata"]) if isinstance(hdr["metadata"], str) else dict(hdr["metadata"] or {})
        n_rows = hm.get("row_count", 0)

    # ── Domain node (shared with SDTM IG entries) ─────────────────────────────
    domain_node_id = None
    if domain:
        domain_node_id = await _upsert_node(
            conn, "sdtm_domain", f"{org_id}::domain::{domain}",
            org_id, study_id,
            f"SDTM {domain} domain",
            {"domain": domain, "source": "xpt_dataset"},
        )
        await _upsert_edge(conn, domain_node_id, doc_node_id, "extracted_from")

    # ── Per-variable nodes ────────────────────────────────────────────────────
    var_node_ids: list[str] = []
    for col in actual_cols:
        label       = variable_labels.get(col, col)
        var_node_id = await _upsert_node(
            conn, "sdtm_variable", f"{org_id}::var::{domain}::{col}",
            org_id, study_id,
            label or col,
            {"variable": col, "domain": domain, "label": label, "source": "xpt_dataset"},
        )
        var_node_ids.append(var_node_id)
        await _upsert_edge(conn, var_node_id, doc_node_id, "extracted_from")
        if domain_node_id:
            await _upsert_edge(conn, domain_node_id, var_node_id, "has_variable")

        # Per-variable context_index entry (DELETE + INSERT to handle NULL study_id)
        summary    = (
            f"SDTM variable {col} label: {label} "
            f"domain: {domain} source: XPT dataset {doc_name}"
        )
        entity_key = f"sdtm_variable_{domain}_{col}_{doc_id[:8]}"
        embs       = await _embed([summary])
        emb_str    = _vec_str(embs[0]) if embs and embs[0] else None

        await conn.execute(
            "DELETE FROM context_index WHERE org_id=$1 AND entity_key=$2",
            org_id, entity_key,
        )
        await conn.execute("""
            INSERT INTO context_index
                (id, org_id, study_id, entity_key, entity_type, summary, source_node_ids, embedding)
            VALUES (gen_random_uuid(),$1,$2,$3,'sdtm_variable',$4,$5::uuid[],$6::vector)
        """, org_id, study_id, entity_key, summary, [var_node_id], emb_str)

    # ── Domain-level summary context_index entry ──────────────────────────────
    if actual_cols:
        col_list   = ", ".join(
            f"{c}({variable_labels.get(c, c)})" for c in actual_cols[:30]
        )
        summary    = (
            f"SDTM {domain} dataset ({doc_name}). "
            f"{len(actual_cols)} variables: {col_list}. "
            f"{n_rows} records."
        )
        entity_key = f"sdtm_xpt_{domain}_{doc_id[:8]}"
        embs       = await _embed([summary])
        emb_str    = _vec_str(embs[0]) if embs and embs[0] else None

        await conn.execute(
            "DELETE FROM context_index WHERE org_id=$1 AND entity_key=$2",
            org_id, entity_key,
        )
        await conn.execute("""
            INSERT INTO context_index
                (id, org_id, study_id, entity_key, entity_type, summary, source_node_ids, embedding)
            VALUES (gen_random_uuid(),$1,$2,$3,'sdtm_xpt_dataset',$4,$5::uuid[],$6::vector)
        """, org_id, study_id, entity_key, summary, var_node_ids[:50], emb_str)

    # ── Dataset statistics context_index entry (unique patients, rows) ────────
    stats_chunk = await conn.fetchrow("""
        SELECT content FROM document_chunks
        WHERE document_id=$1 AND (metadata::jsonb->>'content_type') = 'statistics'
        LIMIT 1
    """, doc_id)
    if stats_chunk:
        import re as _re_stats
        sc = stats_chunk["content"]
        subj_m = _re_stats.search(r'Unique (?:patients|subjects)[^:]*:\s*(\d+)', sc)
        row_m  = _re_stats.search(r'Total records[^:]*:\s*(\d+)', sc)
        if subj_m or row_m:
            n_unique = subj_m.group(1) if subj_m else "unknown"
            n_total  = row_m.group(1) if row_m else str(n_rows)
            stats_summary = (
                f"SDTM {domain} dataset ({doc_name}) contains {n_unique} unique patients "
                f"(distinct USUBJID values) across {n_total} total records. "
                f"To answer 'how many patients', 'how many subjects', or 'unique patients' "
                f"use: {n_unique} unique patients."
            )
            stats_key = f"sdtm_stats_{domain}_{doc_id[:8]}"
            stats_embs = await _embed([stats_summary])
            stats_emb_str = _vec_str(stats_embs[0]) if stats_embs and stats_embs[0] else None
            await conn.execute(
                "DELETE FROM context_index WHERE org_id=$1 AND entity_key=$2",
                org_id, stats_key,
            )
            await conn.execute("""
                INSERT INTO context_index
                    (id, org_id, study_id, entity_key, entity_type, summary, source_node_ids, embedding)
                VALUES (gen_random_uuid(),$1,$2,$3,'sdtm_xpt_dataset',$4,$5::uuid[],$6::vector)
            """, org_id, study_id, stats_key, stats_summary, var_node_ids[:5], stats_emb_str)

    await _emit_log(conn, doc_id, org_id, "xpt_graph", "completed",
        f"Created {len(actual_cols)} variable nodes · {domain} domain",
        {"domain": domain, "variables": len(actual_cols),
         "index_entries": len(actual_cols) + 1,
         "embedding_model": settings.embedding_model,
         "duration_ms": int((_time.monotonic() - t_xpt) * 1000)})

    log.info("xpt.graph.built", doc_id=doc_id, domain=domain,
             variables=len(actual_cols), doc_name=doc_name)


async def _update_context_index(doc_id: str, org_id: str, study_id: Optional[str],
                                doc_type: str = "other"):
    """
    Regenerate context index entries for a document.
    Two tiers:
      1. Section-level entries — built directly from chunk text; always runs.
      2. Entity-type entries  — built from extracted entities; skipped when none exist.
    Tier 1 ensures agents can search even when LLM entity extraction was unavailable.
    """
    async with db_pool.acquire() as conn:
        # ── Clear stale index entries for this document ───────────────────────
        # ON CONFLICT doesn't deduplicate when study_id IS NULL (NULL!=NULL in SQL),
        # so we delete existing entries keyed to this document before reinserting.
        await conn.execute("""
            DELETE FROM context_index
            WHERE org_id = $1 AND entity_key LIKE $2
        """, org_id, f"%_{doc_id[:8]}")

        # ── Tier 1: section-level index entries from raw chunks ───────────────
        section_rows = await conn.fetch("""
            SELECT
                COALESCE(section, 'General') AS section,
                string_agg(content, ' ' ORDER BY chunk_index) AS body,
                array_agg(cn.id ORDER BY dc.chunk_index) FILTER (WHERE cn.id IS NOT NULL) AS node_ids
            FROM document_chunks dc
            LEFT JOIN context_nodes cn
                   ON cn.external_id = dc.id::text AND cn.node_type = 'chunk'
            WHERE dc.document_id = $1
            GROUP BY COALESCE(section, 'General')
        """, doc_id)

        for row in section_rows:
            section  = row["section"]
            body     = (row["body"] or "")[:2000]   # cap for embedding
            node_ids = [str(nid) for nid in (row["node_ids"] or []) if nid]
            if not body.strip():
                continue

            entity_key = f"section_{section[:40]}_{doc_id[:8]}"
            summary    = f"[{section}] {body[:500]}"

            embeddings = await _embed([body])
            emb_str    = _vec_str(embeddings[0]) if embeddings and embeddings[0] else None

            await conn.execute("""
                INSERT INTO context_index
                    (id, org_id, study_id, entity_key, entity_type, summary, source_node_ids, embedding)
                VALUES (gen_random_uuid(),$1,$2,$3,'section',$4,$5::uuid[],$6::vector)
                ON CONFLICT (org_id, study_id, entity_key) DO UPDATE
                    SET summary=EXCLUDED.summary, source_node_ids=EXCLUDED.source_node_ids,
                        embedding=EXCLUDED.embedding, last_updated=NOW()
            """, org_id, study_id, entity_key, summary, node_ids, emb_str)

        index_entries = len(section_rows)
        log.info("context_index.sections_indexed", doc_id=doc_id, sections=len(section_rows))

        # ── Tier 2: entity-type entries (requires LLM extraction) ────────────
        entity_nodes = await conn.fetch("""
            SELECT cn.id, cn.label, cn.metadata
            FROM context_nodes cn
            JOIN context_edges ce ON ce.source_node_id = cn.id
            JOIN context_nodes doc_n ON doc_n.id = ce.target_node_id
            WHERE doc_n.external_id=$1 AND cn.node_type='entity'
        """, doc_id)

        # ── Tier 2: entity-type entries ───────────────────────────────────────
        if entity_nodes:
            by_type: dict[str, list] = {}
            for n in entity_nodes:
                meta = json.loads(n["metadata"]) if isinstance(n["metadata"], str) else dict(n["metadata"])
                ent_type = meta.get("type", "other")
                by_type.setdefault(ent_type, []).append(n["label"])

            for ent_type, labels in by_type.items():
                entity_key = f"{ent_type}s_from_{doc_id[:8]}"
                summary    = f"{ent_type.replace('_',' ').title()} entities: " + "; ".join(labels[:20])

                embeddings = await _embed([summary])
                emb_str    = _vec_str(embeddings[0]) if embeddings and embeddings[0] else None

                node_ids = [str(n["id"]) for n in entity_nodes if
                            (json.loads(n["metadata"]) if isinstance(n["metadata"], str) else dict(n["metadata"])).get("type") == ent_type]

                await conn.execute("""
                    INSERT INTO context_index
                        (id, org_id, study_id, entity_key, entity_type, summary, source_node_ids, embedding)
                    VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6::uuid[],$7::vector)
                    ON CONFLICT (org_id, study_id, entity_key) DO UPDATE
                        SET summary=EXCLUDED.summary, source_node_ids=EXCLUDED.source_node_ids,
                            embedding=EXCLUDED.embedding, last_updated=NOW()
                """, org_id, study_id, entity_key, ent_type, summary, node_ids, emb_str)

        # ── Tier 3: SDTM-specific index entries — always runs for sdtm_ig ────
        if doc_type in {"sdtm_ig", "adam_ig"}:
            await _index_sdtm_entities(conn, doc_id, org_id, study_id)

        await conn.execute(
            "INSERT INTO processing_logs "
            "(document_id, org_id, step, event, message, metadata) "
            "VALUES ($1,$2,$3,$4,$5,$6)",
            doc_id, org_id, "indexing", "completed",
            f"{index_entries} context index entries created",
            json.dumps({"entries": index_entries,
                        "embedding_model": settings.embedding_model}))


async def _index_sdtm_entities(conn, doc_id: str, org_id: str, study_id: Optional[str]):
    """
    Build Tier-3 context index entries for SDTM IG documents.

    Index strategy per content type:
      table  → one entry per domain's variable table  (entity_type='sdtm_variable_table')
      domain → one entry per SDTM domain node        (entity_type='sdtm_domain')
      var    → one entry per variable cluster          (entity_type='sdtm_variable')
    """
    # ── Domain nodes — org-scoped (shared across documents) ──────────────────
    domain_nodes = await conn.fetch("""
        SELECT cn.id, cn.label, cn.metadata
        FROM context_nodes cn
        WHERE cn.node_type='sdtm_domain' AND cn.org_id=$1
    """, org_id)

    for dn in domain_nodes:
        meta   = json.loads(dn["metadata"]) if isinstance(dn["metadata"], str) else dict(dn["metadata"] or {})
        domain = meta.get("domain", dn["label"])
        label  = meta.get("label", "")
        summary = f"SDTM {domain} domain ({label}). Contains all SDTM variables for the {domain} dataset."
        embs    = await _embed([summary])
        emb_str = _vec_str(embs[0]) if embs and embs[0] else None
        await conn.execute("""
            INSERT INTO context_index
                (id, org_id, study_id, entity_key, entity_type, summary, source_node_ids, embedding)
            VALUES (gen_random_uuid(),$1,$2,$3,'sdtm_domain',$4,$5::uuid[],$6::vector)
            ON CONFLICT (org_id, study_id, entity_key) DO UPDATE
                SET summary=EXCLUDED.summary, embedding=EXCLUDED.embedding, last_updated=NOW()
        """, org_id, study_id,
             f"sdtm_domain_{domain}_{doc_id[:8]}",
             summary, [str(dn["id"])], emb_str)

    # ── Variable table chunks (content_type='table') ──────────────────────────
    # Group table chunks by domain; build one index entry per domain's tables
    table_chunks = await conn.fetch("""
        SELECT dc.id, dc.section, dc.content, dc.metadata,
               cn.id AS node_id
        FROM document_chunks dc
        LEFT JOIN context_nodes cn ON cn.external_id = dc.id::text AND cn.node_type='chunk'
        WHERE dc.document_id=$1
          AND (dc.metadata::jsonb->>'content_type') = 'table'
    """, doc_id)

    by_domain: dict[str, list] = {}
    for tc in table_chunks:
        meta   = json.loads(tc["metadata"]) if isinstance(tc["metadata"], str) else dict(tc["metadata"] or {})
        domain = meta.get("domain") or "General"
        cols   = meta.get("columns") or []
        by_domain.setdefault(domain, []).append({
            "node_id": str(tc["node_id"]) if tc["node_id"] else None,
            "cols":    cols,
            "section": tc["section"] or "",
            "content": tc["content"][:300],
        })

    for domain, tbl_list in by_domain.items():
        all_cols = []
        for t in tbl_list:
            all_cols.extend(t["cols"])
        unique_cols = list(dict.fromkeys(c for c in all_cols if c))[:20]
        summary = (
            f"SDTM variable definition table for {domain} domain. "
            f"Columns: {', '.join(unique_cols)}. "
            f"{len(tbl_list)} table chunk(s)."
        )
        embs    = await _embed([summary])
        emb_str = _vec_str(embs[0]) if embs and embs[0] else None
        nids    = [t["node_id"] for t in tbl_list if t["node_id"]]
        await conn.execute("""
            INSERT INTO context_index
                (id, org_id, study_id, entity_key, entity_type, summary, source_node_ids, embedding)
            VALUES (gen_random_uuid(),$1,$2,$3,'sdtm_variable_table',$4,$5::uuid[],$6::vector)
            ON CONFLICT (org_id, study_id, entity_key) DO UPDATE
                SET summary=EXCLUDED.summary, embedding=EXCLUDED.embedding, last_updated=NOW()
        """, org_id, study_id,
             f"sdtm_table_{domain}_{doc_id[:8]}",
             summary, nids, emb_str)

    log.info("context_index.sdtm_indexed", doc_id=doc_id,
             domains=len(domain_nodes), table_groups=len(by_domain))

    # ── Tier 3b: per-variable detail index ───────────────────────────────────
    variable_nodes = await conn.fetch("""
        SELECT cn.id, cn.label, cn.metadata
        FROM context_nodes cn
        WHERE cn.node_type = 'sdtm_variable' AND cn.org_id = $1
    """, org_id)

    indexed_count = 0
    for var_node in variable_nodes:
        meta     = json.loads(var_node["metadata"]) if isinstance(var_node["metadata"], str) \
                   else dict(var_node["metadata"] or {})
        domain   = meta.get("domain", "")
        label    = meta.get("label", "")
        core     = meta.get("core", "")
        codelist = meta.get("codelist")

        # Find the definition chunk linked to this variable node
        def_chunk = await conn.fetchrow("""
            SELECT dc.content, dc.section
            FROM context_edges ce
            JOIN context_nodes chunk_n ON chunk_n.id = ce.source_node_id
              AND chunk_n.node_type = 'chunk'
            JOIN document_chunks dc ON dc.id::text = chunk_n.external_id
            WHERE ce.target_node_id = $1
              AND ce.edge_type IN ('extracted_from', 'contains')
            LIMIT 1
        """, var_node["id"])

        summary = (
            f"SDTM variable {var_node['label']} in {domain} domain. "
            f"Status: {core or 'unknown'}. "
            + (f"Codelist: {codelist}. " if codelist else "")
            + (f"Definition: {def_chunk['content'][:250]}" if def_chunk else "")
        )

        embs    = await _embed([summary])
        emb_str = _vec_str(embs[0]) if embs and embs[0] else None

        entity_key = f"var_{domain}_{var_node['label']}_{doc_id[:8]}"
        await conn.execute("""
            DELETE FROM context_index
            WHERE org_id = $1 AND entity_key = $2
        """, org_id, entity_key)
        await conn.execute("""
            INSERT INTO context_index
                (id, org_id, study_id, entity_key, entity_type, summary,
                 source_node_ids, embedding)
            VALUES (gen_random_uuid(),$1,$2,$3,'sdtm_variable_detail',$4,$5::uuid[],$6::vector)
        """, org_id, study_id,
             entity_key,
             summary, [str(var_node["id"])], emb_str)
        indexed_count += 1

    log.info("context_index.variables_indexed", doc_id=doc_id, count=indexed_count)

    # ── Tier 3c: one context_index entry per unique codelist ──────────────────
    # Edge direction: sdtm_variable --uses_codelist--> codelist
    # sdtm_variable nodes are org-scoped, so we query across all of them for this org.
    cl_rows = await conn.fetch("""
        SELECT n.label as cl_name, n.id as cl_nid,
               array_agg(DISTINCT (v.metadata->>'variable') || ' (' || (v.metadata->>'domain') || ')') as vars,
               array_agg(DISTINCT v.metadata->>'domain') as domains
        FROM context_nodes n
        JOIN context_edges e ON e.target_node_id = n.id AND e.edge_type = 'uses_codelist'
        JOIN context_nodes v ON v.id = e.source_node_id AND v.node_type = 'sdtm_variable'
        WHERE n.node_type = 'codelist' AND n.org_id = $1
        GROUP BY n.label, n.id
    """, org_id)

    cl_indexed = 0
    for cl_row in cl_rows:
        cl_name    = cl_row["cl_name"]
        var_list   = ", ".join((cl_row["vars"] or [])[:20])
        domain_list = ", ".join(d for d in (cl_row["domains"] or []) if d)
        summary = (
            f"CDISC controlled terminology codelist {cl_name}. "
            f"Used in domains: {domain_list}. "
            f"Referenced by variables: {var_list}."
        )
        embs    = await _embed([summary])
        emb_str = _vec_str(embs[0]) if embs and embs[0] else None
        key     = f"codelist_{cl_name}_{doc_id[:8]}"
        await conn.execute(
            "DELETE FROM context_index WHERE entity_key=$1 AND org_id=$2",
            key, org_id
        )
        await conn.execute("""
            INSERT INTO context_index
              (id, org_id, study_id, entity_type, entity_key,
               summary, source_node_ids, embedding)
            VALUES (gen_random_uuid(),$1,$2,'codelist',$3,$4,$5::uuid[],$6::vector)
        """, org_id, study_id, key, summary,
            [str(cl_row["cl_nid"])],
            emb_str)
        cl_indexed += 1

    log.info("context_index.codelists_indexed", doc_id=doc_id, count=cl_indexed)


# ─── Retrieval & Reasoning Engine ────────────────────────────────────────────

@dataclass
class ScopePolicy:
    org_id: str
    study_id: Optional[str]
    installation_id: Optional[str]
    in_scope_doc_ids: list = field(default_factory=list)  # empty = all docs in scope
    include_platform_graphs: bool = True
    consented_permissions: list = field(default_factory=list)
    allow_blinded_data: bool = False
    allow_pii: bool = False
    boost_chunk_ids: list = field(default_factory=list)    # external_ids of approved chunks
    penalize_chunk_ids: list = field(default_factory=list) # external_ids of corrected chunks
    max_tokens: int = 4000


@dataclass
class ContextPack:
    pack_hash: str
    chunks: list
    token_estimate: int
    sources_cited: list
    scope_summary: dict
    from_cache: bool = False


async def _redis_get(key: str) -> Optional[str]:
    """Safe Redis get — returns None on any error or if Redis unavailable."""
    if not redis_client:
        return None
    try:
        return await redis_client.get(key)
    except Exception:
        return None


async def _redis_set(key: str, value: str, ex: int = 900) -> None:
    """Safe Redis set — silently ignores errors."""
    if not redis_client:
        return
    try:
        await redis_client.set(key, value, ex=ex)
    except Exception:
        pass


async def _redis_delete(key: str) -> None:
    """Safe Redis delete — silently ignores errors."""
    if not redis_client:
        return
    try:
        await redis_client.delete(key)
    except Exception:
        pass


class RetrievalEngine:
    """
    Orchestrates policy-scoped, graph-aware, bias-corrected retrieval.

    Pipeline:
      resolve_scope()        → ScopePolicy from agent installation + decision history
      _canonicalize_query()  → normalize abbreviations before embedding
      _graph_prune()         → warm-start candidate set from graph walk
      _vector_rank()         → embed + search with bias multipliers applied
      _assemble_pack()       → dedup, token-budget, deterministic hash
      get_or_create_pack()   → Redis cache wrapper around full pipeline
      _frame_prompt()        → inject constraints + [SOURCE N] citations
      record_used_in_decision() → write USED_IN_DECISION edges post-output
    """

    def __init__(self, pool: asyncpg.Pool):
        self.pool = pool

    async def resolve_scope(self, installation_id: Optional[str],
                             org_id: str, study_id: Optional[str]) -> ScopePolicy:
        """Build ScopePolicy from agent installation + recent decision feedback."""
        scope = ScopePolicy(org_id=org_id, study_id=study_id,
                            installation_id=installation_id)

        # Check Redis bias cache first
        bias_key = f"ctx_bias:{org_id}:{study_id or 'null'}"
        cached_bias = await _redis_get(bias_key)
        if cached_bias:
            try:
                bias = json.loads(cached_bias)
                scope.boost_chunk_ids   = bias.get("boost", [])
                scope.penalize_chunk_ids = bias.get("penalize", [])
            except Exception:
                pass

        async with self.pool.acquire() as conn:
            # Resolve agent installation permissions
            if installation_id:
                row = await conn.fetchrow("""
                    SELECT ai.consented_permissions, ai.is_active, s.is_blinded
                    FROM agent_installations ai
                    LEFT JOIN studies s ON s.id = $2::uuid
                    WHERE ai.id = $1::uuid
                """, installation_id, study_id or "00000000-0000-0000-0000-000000000001")
                if row:
                    perms = row["consented_permissions"] or []
                    scope.consented_permissions = list(perms)
                    scope.allow_blinded_data = ("study:blinded:read" in perms)
                    scope.allow_pii = ("study:pii:read" in perms)
                    blinded = row.get("is_blinded") or False
                    if blinded and not scope.allow_blinded_data:
                        # Restrict to non-blinded document types when study is blinded
                        blind_safe_types = ["protocol", "sap", "sdtm_ig", "adam_ig",
                                            "lab_manual", "dmp", "crf"]
                        safe_docs = await conn.fetch("""
                            SELECT id FROM documents
                            WHERE study_id=$1::uuid AND document_type = ANY($2)
                        """, study_id, blind_safe_types)
                        scope.in_scope_doc_ids = [str(r["id"]) for r in safe_docs]

            # Build boost/penalize from recent decision traces (only if cache missed)
            if not scope.boost_chunk_ids and not scope.penalize_chunk_ids:
                bias_rows = await conn.fetch("""
                    WITH recent_decisions AS (
                        SELECT dt.id AS trace_id,
                               cn.id AS decision_node_id,
                               cf.feedback_type
                        FROM decision_traces dt
                        JOIN context_nodes cn
                          ON cn.external_id = dt.id::text
                         AND cn.node_type IN ('decision','mistake')
                        LEFT JOIN context_feedback cf
                          ON cf.decision_trace_id = dt.id
                        WHERE dt.org_id = $1::uuid
                          AND ($2::text IS NULL OR dt.study_id::text = $2)
                        ORDER BY dt.created_at DESC
                        LIMIT 50
                    )
                    SELECT
                        cn_chunk.external_id AS chunk_ext_id,
                        rd.feedback_type
                    FROM recent_decisions rd
                    JOIN context_edges ce
                      ON (ce.source_node_id = rd.decision_node_id
                          AND ce.edge_type IN ('cites','used_in_decision')
                         )
                      OR (ce.target_node_id = rd.decision_node_id
                          AND ce.edge_type = 'used_in_decision'
                         )
                    JOIN context_nodes cn_chunk
                      ON cn_chunk.id = CASE
                            WHEN ce.edge_type = 'used_in_decision'
                                 AND ce.target_node_id = rd.decision_node_id
                                 THEN ce.source_node_id
                            ELSE ce.target_node_id
                         END
                     AND cn_chunk.node_type = 'chunk'
                """, org_id, study_id)

                for r in bias_rows:
                    ext_id = r["chunk_ext_id"]
                    fb     = r["feedback_type"]
                    if fb in ("endorsement",) and ext_id:
                        scope.boost_chunk_ids.append(ext_id)
                    elif fb in ("correction", "rejection") and ext_id:
                        scope.penalize_chunk_ids.append(ext_id)

                # Cache the bias result for 5 minutes
                await _redis_set(bias_key, json.dumps({
                    "boost":    scope.boost_chunk_ids[:50],
                    "penalize": scope.penalize_chunk_ids[:50],
                }), ex=300)

        return scope

    async def _canonicalize_query(self, query: str, org_id: str) -> str:
        """Replace known aliases with canonical forms before embedding."""
        async with self.pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT canonical_form, aliases FROM entity_canonical_map
                WHERE org_id = $1::uuid
            """, org_id)
        for r in rows:
            canonical = r["canonical_form"]
            for alias in (r["aliases"] or []):
                # Word-boundary aware replacement, case-insensitive
                pattern = re.compile(r'\b' + re.escape(alias) + r'\b', re.IGNORECASE)
                if pattern.search(query):
                    query = pattern.sub(canonical, query, count=1)
                    break
        return query

    async def _graph_prune(self, scope: ScopePolicy,
                            query_embedding: Optional[list]) -> list:
        """Walk 2-hop graph neighbourhood from boost chunks to warm-start ranking."""
        if not scope.boost_chunk_ids:
            return []
        async with self.pool.acquire() as conn:
            candidate_rows = await conn.fetch("""
                WITH seed AS (
                    SELECT id FROM context_nodes
                    WHERE external_id = ANY($1) AND node_type='chunk'
                ),
                hop1 AS (
                    SELECT ce.target_node_id AS id FROM context_edges ce
                    JOIN seed s ON s.id = ce.source_node_id
                    WHERE ce.edge_type IN ('co_occurs_with','contains','references')
                    UNION
                    SELECT ce.source_node_id AS id FROM context_edges ce
                    JOIN seed s ON s.id = ce.target_node_id
                    WHERE ce.edge_type IN ('co_occurs_with','contains')
                ),
                hop2 AS (
                    SELECT ce.target_node_id AS id FROM context_edges ce
                    JOIN hop1 h ON h.id = ce.source_node_id
                    WHERE ce.edge_type IN ('co_occurs_with','contains')
                )
                SELECT DISTINCT cn.external_id FROM context_nodes cn
                WHERE cn.id IN (SELECT id FROM hop1 UNION SELECT id FROM hop2)
                  AND cn.node_type = 'chunk'
                  AND cn.external_id IS NOT NULL
                LIMIT 200
            """, scope.boost_chunk_ids)
        return [r["external_id"] for r in candidate_rows]

    async def _vector_rank(self, scope: ScopePolicy, query: str,
                            query_embedding: Optional[list],
                            prune_candidates: list, top_k: int = 8,
                            context_types: list = None) -> list:
        """Run biased vector search across context_index + document_chunks."""
        if not query_embedding:
            return []

        vec_str = _vec_str(query_embedding)
        platform_org = settings.platform_org_id
        is_platform  = scope.org_id == platform_org
        results: list[dict] = []

        doc_filter = ""
        doc_params_offset = 0
        params: list = [scope.org_id, vec_str]
        if scope.study_id:
            params.append(scope.study_id)
            # Include docs with no study assignment (platform-level/global docs) alongside study-scoped ones
            study_filter = "AND (study_id=$3 OR study_id IS NULL)"
            doc_params_offset = 1
        else:
            study_filter = ""

        type_filter = ""
        if context_types:
            params.append(context_types)
            # Always include sdtm_xpt_dataset entries — they hold authoritative
            # dataset statistics (unique patients, row counts) regardless of caller filter
            type_filter = f"AND (entity_type = ANY(${len(params)}::text[]) OR entity_type = 'sdtm_xpt_dataset')"

        if scope.in_scope_doc_ids:
            params.append(list(scope.in_scope_doc_ids))
            doc_filter = f"AND source_node_ids && (SELECT ARRAY_AGG(id) FROM context_nodes WHERE external_id = ANY(${len(params)}::text[]))"

        params.append(top_k * 3)
        lim_param = f"${len(params)}"

        async with self.pool.acquire() as conn:
            # ── Tier 1: context_index ────────────────────────────────────────
            if not is_platform:
                idx_rows = await conn.fetch(f"""
                    SELECT entity_key, entity_type, summary AS text,
                           source_node_ids, quality_score,
                           1 - (embedding <=> $2::vector) AS raw_score
                    FROM context_index
                    WHERE org_id=$1 {study_filter} {type_filter} {doc_filter}
                      AND embedding IS NOT NULL
                    UNION ALL
                    SELECT ci.entity_key, ci.entity_type, ci.summary,
                           ci.source_node_ids, ci.quality_score,
                           1 - (ci.embedding <=> $2::vector) AS raw_score
                    FROM context_index ci
                    JOIN standard_context_graphs scg
                      ON ci.org_id::text = '{platform_org}'
                    WHERE scg.is_published = TRUE
                      AND scg.org_id IS NULL
                      AND ci.org_id = '{platform_org}'::uuid
                      AND ci.embedding IS NOT NULL
                    ORDER BY raw_score DESC
                    LIMIT {lim_param}
                """, *params)
            else:
                idx_rows = await conn.fetch(f"""
                    SELECT entity_key, entity_type, summary AS text,
                           source_node_ids, quality_score,
                           1 - (embedding <=> $2::vector) AS raw_score
                    FROM context_index
                    WHERE org_id=$1 {study_filter} {type_filter} {doc_filter}
                      AND embedding IS NOT NULL
                    ORDER BY raw_score DESC
                    LIMIT {lim_param}
                """, *params)

            boost_set   = set(scope.boost_chunk_ids)
            penalize_set = set(scope.penalize_chunk_ids)

            for r in idx_rows:
                raw  = float(r["raw_score"] or 0)
                qual = float(r["quality_score"] or 1.0)
                # Bias multiplier: source_node_ids cross-checked against boost/penalize
                multiplier = 1.0
                node_ids_here = [str(x) for x in (r["source_node_ids"] or [])]
                if any(n in boost_set for n in node_ids_here):
                    multiplier = 1.3
                elif any(n in penalize_set for n in node_ids_here):
                    multiplier = 0.5
                score = raw * qual * multiplier
                results.append({
                    "text": r["text"], "score": score,
                    "entity_type": r["entity_type"],
                    "entity_key": r["entity_key"],
                    "node_ids": node_ids_here,
                    "source": "context_index",
                })

            # ── Tier 2: document_chunks ───────────────────────────────────────
            doc_id_filter = ""
            if scope.in_scope_doc_ids:
                # When specific document IDs are requested, skip org_id filter —
                # docs may belong to the platform org but user has explicit access.
                chunk_params: list = [vec_str]
                chunk_params.append(list(scope.in_scope_doc_ids))
                doc_id_filter = f"AND dc.document_id = ANY(${len(chunk_params)}::uuid[])"
                # No LIMIT when scoped to specific docs — fetch all chunks so header/summary always surfaces
                chunk_rows = await conn.fetch(f"""
                    SELECT dc.id AS chunk_id, dc.document_id,
                           dc.content, dc.metadata, dc.section, dc.page_number,
                           d.name AS doc_name, d.document_type,
                           cn.id AS node_id, cn.importance_weight,
                           1 - (dc.embedding <=> $1::vector) AS raw_score,
                           EXTRACT(EPOCH FROM (NOW() - dc.created_at)) / 86400.0 AS age_days
                    FROM document_chunks dc
                    JOIN documents d ON d.id = dc.document_id
                    LEFT JOIN context_nodes cn
                      ON cn.external_id = dc.id::text AND cn.node_type='chunk'
                    WHERE dc.embedding IS NOT NULL {doc_id_filter}
                    ORDER BY raw_score DESC
                """, *chunk_params)
            else:
                chunk_params: list = [scope.org_id, vec_str]
                c_study = ""
                if scope.study_id:
                    chunk_params.append(scope.study_id)
                    # Include docs with no study assignment (platform-level/global docs)
                    c_study = "AND (dc.study_id=$3 OR dc.study_id IS NULL)"
                chunk_params.append(top_k * 2)
                lim_chunk_param = f"${len(chunk_params)}"
                chunk_rows = await conn.fetch(f"""
                    SELECT dc.id AS chunk_id, dc.document_id,
                           dc.content, dc.metadata, dc.section, dc.page_number,
                           d.name AS doc_name, d.document_type,
                           cn.id AS node_id, cn.importance_weight,
                           1 - (dc.embedding <=> $2::vector) AS raw_score,
                           EXTRACT(EPOCH FROM (NOW() - dc.created_at)) / 86400.0 AS age_days
                    FROM document_chunks dc
                    JOIN documents d ON d.id = dc.document_id
                    LEFT JOIN context_nodes cn
                      ON cn.external_id = dc.id::text AND cn.node_type='chunk'
                    WHERE dc.org_id=$1 {c_study}
                      AND dc.embedding IS NOT NULL
                    ORDER BY raw_score DESC
                    LIMIT {lim_chunk_param}
                """, *chunk_params)

            for r in chunk_rows:
                raw   = float(r["raw_score"] or 0)
                iw    = float(r["importance_weight"] or 1.0)
                age   = float(r["age_days"] or 0)
                stale = min(0.05, age / 365 * 0.05)    # max −0.05 staleness penalty
                cid   = str(r["chunk_id"])
                multiplier = 1.0
                if cid in boost_set:
                    multiplier = 1.3
                elif cid in penalize_set:
                    multiplier = 0.5
                # Boost dataset header/summary chunks so they surface above raw row data
                section_lower = (r["section"] or "").lower()
                if any(kw in section_lower for kw in ("header", "summary", "variable", "dataset")):
                    multiplier = max(multiplier, 1.4)
                score = (raw * iw * multiplier) - stale
                results.append({
                    "text": r["content"],
                    "score": score,
                    "entity_type": "chunk",
                    "chunk_id": cid,
                    "document_id": str(r["document_id"]),
                    "doc_name": r["doc_name"],
                    "doc_type": r["document_type"],
                    "section": r["section"],
                    "page_number": r["page_number"],
                    "node_id": str(r["node_id"]) if r["node_id"] else None,
                    "source": "document_chunks",
                })

        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:top_k]

    def _assemble_pack(self, ranked: list, scope: ScopePolicy, query: str) -> ContextPack:
        """Dedup + token-budget assembly → deterministic hash."""
        seen_keys: set[str] = set()
        chunks: list[dict]  = []
        sources_cited: list[dict] = []
        token_estimate = 0

        MAX_CHUNK_TOKENS = 600  # cap any single chunk so budget isn't dominated by huge row-data chunks
        for item in ranked:
            text = item.get("text", "")
            # Truncate oversized chunks (large row-data blocks) to keep budget balanced
            if len(text) // 4 > MAX_CHUNK_TOKENS:
                text = text[:MAX_CHUNK_TOKENS * 4]
                item = {**item, "text": text}
            tok  = len(text) // 4
            if token_estimate + tok > scope.max_tokens:
                break
            # Dedup: same document + section + >60% char overlap → skip
            dedup_key = f"{item.get('document_id','')}|{item.get('section','')}"
            if dedup_key in seen_keys and dedup_key != "|":
                # Check overlap
                existing = next((c for c in chunks
                                 if c.get("document_id") == item.get("document_id")
                                 and c.get("section") == item.get("section")), None)
                if existing:
                    a, b = existing.get("text",""), text
                    shorter = min(len(a), len(b))
                    if shorter > 0 and len(set(a[:shorter]) & set(b[:shorter])) / shorter > 0.6:
                        continue

            seen_keys.add(dedup_key)
            chunks.append(item)
            token_estimate += tok
            if item.get("source") == "document_chunks":
                sources_cited.append({
                    "doc_name": item.get("doc_name",""),
                    "doc_type": item.get("doc_type",""),
                    "doc_id":   item.get("document_id",""),
                    "chunk_id": item.get("chunk_id",""),
                    "node_id":  item.get("node_id"),
                    "score":    item.get("score", 0),
                    "section":  item.get("section",""),
                    "excerpt":  text[:400],
                })

        # Deterministic hash
        chunk_ids = sorted(c.get("chunk_id","") or c.get("entity_key","") for c in chunks)
        raw = f"{scope.org_id}:{scope.study_id}:{','.join(chunk_ids)}"
        pack_hash = hashlib.sha256(raw.encode()).hexdigest()

        scope_summary = {
            "org_id": scope.org_id,
            "study_id": scope.study_id,
            "installation_id": scope.installation_id,
            "allow_blinded_data": scope.allow_blinded_data,
            "allow_pii": scope.allow_pii,
            "doc_scope": "restricted" if scope.in_scope_doc_ids else "all",
            "boost_count": len(scope.boost_chunk_ids),
            "penalize_count": len(scope.penalize_chunk_ids),
        }
        return ContextPack(pack_hash=pack_hash, chunks=chunks, token_estimate=token_estimate,
                           sources_cited=sources_cited, scope_summary=scope_summary)

    async def get_or_create_pack(self, scope: ScopePolicy, query: str,
                                  query_embedding: Optional[list],
                                  top_k: int = 8,
                                  context_types: list = None) -> ContextPack:
        """Cache-first: return cached pack or run full pipeline and cache result."""
        # We need the pack_hash before we have the pack — derive a query hash first
        query_hash = hashlib.sha256(
            f"{scope.org_id}:{scope.study_id}:{query}:{top_k}".encode()
        ).hexdigest()
        cache_key = f"ctx_pack:{query_hash}"

        cached = await _redis_get(cache_key)
        if cached:
            try:
                data = json.loads(cached)
                data["from_cache"] = True
                return ContextPack(**data)
            except Exception:
                pass

        # Full pipeline
        prune_candidates = await self._graph_prune(scope, query_embedding)
        ranked = await self._vector_rank(scope, query, query_embedding,
                                          prune_candidates, top_k=top_k,
                                          context_types=context_types or [])
        pack = self._assemble_pack(ranked, scope, query)

        # Cache for 15 minutes — skip caching empty packs so stale misses don't persist
        if pack.chunks:
            await _redis_set(cache_key, json.dumps(asdict(pack)), ex=900)

        # Log to DB (non-fatal)
        try:
            chunk_ids = [c.get("chunk_id") for c in pack.chunks if c.get("chunk_id")]
            async with self.pool.acquire() as conn:
                await conn.execute("""
                    INSERT INTO context_pack_log
                        (pack_hash, org_id, study_id, query_text, chunk_ids, token_count, scope_policy, cache_hit)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE)
                    ON CONFLICT (pack_hash, org_id) DO NOTHING
                """, pack.pack_hash, scope.org_id, scope.study_id, query,
                    [uuid.UUID(c) for c in chunk_ids if _is_valid_uuid(c)],
                    pack.token_estimate, json.dumps(pack.scope_summary))
        except Exception as exc:
            log.warning("context_pack_log.insert_failed", error=str(exc))

        return pack

    def _frame_prompt(self, pack: ContextPack, scope: ScopePolicy,
                       base_prompt: str) -> str:
        """Prepend CONTEXT CONSTRAINTS block + annotate chunks with [SOURCE N] tags."""
        constraints = ["## CONTEXT CONSTRAINTS"]
        if not scope.allow_blinded_data:
            constraints.append("- You must NOT reference unblinded patient outcome data.")
        if not scope.allow_pii:
            constraints.append("- You must NOT reproduce personally identifiable information.")
        if scope.in_scope_doc_ids:
            constraints.append(f"- Context is restricted to {len(scope.in_scope_doc_ids)} document(s).")
        constraints.append(f"- {len(pack.chunks)} context item(s) provided below.\n")

        context_block = ["## RETRIEVED CONTEXT"]
        for i, chunk in enumerate(pack.chunks, 1):
            section = chunk.get("section") or chunk.get("entity_key") or ""
            doc     = chunk.get("doc_name") or ""
            ref     = f"{doc} §{section}".strip(" §") if (doc or section) else f"Source {i}"
            context_block.append(f"\n[SOURCE {i}] {ref}\n{chunk.get('text','')}")

        return "\n".join(constraints) + "\n" + "\n".join(context_block) + "\n\n" + base_prompt

    async def record_used_in_decision(self, trace_id: str, chunk_node_ids: list,
                                       conn: asyncpg.Connection) -> None:
        """Write used_in_decision edges (chunk→decision) and back-link graph_node_id."""
        decision_node = await conn.fetchrow("""
            SELECT id FROM context_nodes WHERE external_id=$1 AND node_type IN ('decision','mistake')
        """, trace_id)
        if not decision_node:
            return
        decision_node_id = decision_node["id"]

        for chunk_node_id in chunk_node_ids[:20]:  # cap at 20 edges per trace
            await _upsert_edge(conn, chunk_node_id, str(decision_node_id),
                               "used_in_decision", metadata={"trace_id": trace_id})

        # Back-link on decision_traces
        await conn.execute(
            "UPDATE decision_traces SET graph_node_id=$1 WHERE id=$2::uuid",
            decision_node_id, trace_id)


def _is_valid_uuid(val: str) -> bool:
    try:
        uuid.UUID(str(val))
        return True
    except (ValueError, AttributeError):
        return False


# ─── Drift Detection Loop ─────────────────────────────────────────────────────

async def _drift_detection_loop():
    """Background loop: every 30 min check for unindexed chunks and trigger reindex."""
    await asyncio.sleep(30)  # brief startup delay
    while True:
        try:
            await _check_indexing_drift()
        except Exception as exc:
            log.error("drift_detection.failed", error=str(exc))
        await asyncio.sleep(settings.drift_check_interval_secs)


async def _check_indexing_drift(org_id: Optional[str] = None):
    """Upsert document_index_state and queue reindex for docs with high drift."""
    async with db_pool.acquire() as conn:
        org_filter = "AND d.org_id=$2::uuid" if org_id else ""
        params: list = []
        params.append(settings.drift_threshold)
        if org_id:
            params.append(org_id)

        await conn.execute(f"""
            INSERT INTO document_index_state
                (document_id, org_id, indexed_chunks_count, total_chunks_count,
                 drift_score, needs_reindex, last_checked_at)
            SELECT
                dc.document_id,
                dc.org_id,
                COUNT(cn.id)::int                                           AS indexed_chunks_count,
                COUNT(dc.id)::int                                           AS total_chunks_count,
                1.0 - COUNT(cn.id)::float / NULLIF(COUNT(dc.id), 0)        AS drift_score,
                (1.0 - COUNT(cn.id)::float / NULLIF(COUNT(dc.id), 0)) > $1 AS needs_reindex,
                NOW()
            FROM document_chunks dc
            JOIN documents d ON d.id = dc.document_id
            LEFT JOIN context_nodes cn
              ON cn.external_id = dc.id::text AND cn.node_type = 'chunk'
            WHERE d.status = 'indexed' {org_filter}
            GROUP BY dc.document_id, dc.org_id
            ON CONFLICT (document_id) DO UPDATE
                SET indexed_chunks_count = EXCLUDED.indexed_chunks_count,
                    total_chunks_count   = EXCLUDED.total_chunks_count,
                    drift_score          = EXCLUDED.drift_score,
                    needs_reindex        = EXCLUDED.needs_reindex,
                    last_checked_at      = NOW()
        """, *params)

        # Queue reindex for documents with high drift
        stale_docs = await conn.fetch("""
            SELECT dis.document_id, dis.org_id, d.study_id
            FROM document_index_state dis
            JOIN documents d ON d.id = dis.document_id
            WHERE dis.needs_reindex = TRUE
            LIMIT 20
        """)

    for doc in stale_docs:
        log.info("drift.reindex_triggered", document_id=str(doc["document_id"]))
        asyncio.create_task(_sync_chunk_nodes(
            str(doc["document_id"]), str(doc["org_id"]),
            str(doc["study_id"]) if doc["study_id"] else None))


async def _sync_chunk_nodes(document_id: str, org_id: str, study_id: Optional[str]):
    """
    Idempotent: upsert context_nodes for every document_chunk that lacks a node.
    Updates document_index_state on completion.
    """
    async with db_pool.acquire() as conn:
        chunks = await conn.fetch("""
            SELECT dc.id, dc.content, dc.metadata, dc.embedding, dc.section
            FROM document_chunks dc
            LEFT JOIN context_nodes cn
              ON cn.external_id = dc.id::text AND cn.node_type='chunk'
            WHERE dc.document_id=$1::uuid AND cn.id IS NULL
        """, document_id)

        doc_node = await conn.fetchrow(
            "SELECT id FROM context_nodes WHERE external_id=$1 AND node_type='document'",
            document_id)

        for chunk in chunks:
            chunk_id_str = str(chunk["id"])
            meta = dict(chunk["metadata"]) if chunk["metadata"] else {}
            chunk_node_id = await _upsert_node(
                conn, "chunk", chunk_id_str, org_id, study_id,
                f"Chunk {meta.get('chunk_index','')} §{chunk['section'] or ''}",
                {"document_id": document_id, "section": chunk["section"], **meta},
                embedding=list(chunk["embedding"]) if chunk["embedding"] else None,
            )
            if doc_node:
                await _upsert_edge(conn, str(doc_node["id"]), chunk_node_id, "contains")

        # Update drift state
        await conn.execute("""
            UPDATE document_index_state
               SET needs_reindex = FALSE,
                   last_indexed_at = NOW(),
                   drift_score = 0.0
             WHERE document_id = $1::uuid
        """, document_id)

    log.info("sync_chunk_nodes.done", document_id=document_id, synced=len(chunks))


# ─── Context Query API ────────────────────────────────────────────────────────

class ContextQueryRequest(BaseModel):
    query: str
    org_id: str
    study_id: Optional[str] = None
    top_k: int = Field(default=8, le=20)
    include_lineage: bool = False
    context_types: list[str] = Field(default_factory=list)  # filter by entity_type


class ContextQueryResponse(BaseModel):
    query: str
    results: list[dict]   # [{text, score, entity_type, source_doc, chunk_id, node_id, lineage?}]
    sources_cited: list[dict]  # [{doc_name, doc_type, chunk_id, score, excerpt}]
    context_node_ids: list[str]  # for decision trace recording
    search_method: str


@app.post("/context/query", response_model=ContextQueryResponse)
async def query_context(req: ContextQueryRequest):
    """
    Primary query endpoint for agents.
    Returns semantically relevant context with full citation trail.
    """
    query_vecs = await _embed([req.query])
    query_vec  = query_vecs[0] if query_vecs and query_vecs[0] else None

    results:       list[dict] = []
    sources_cited: list[dict] = []
    node_ids:      list[str]  = []
    search_method = "text"

    platform_org = uuid.UUID(settings.platform_org_id)
    tenant_org   = uuid.UUID(req.org_id)
    is_platform  = tenant_org == platform_org

    async with db_pool.acquire() as conn:
        # ── 1. Vector search on context_index ────────────────────────────────
        if query_vec:
            vec_str = _vec_str(query_vec)
            where_study  = "AND study_id=$3" if req.study_id else ""
            where_type   = f"AND entity_type = ANY(${4 if req.study_id else 3}::text[])" if req.context_types else ""
            params: list = [req.org_id, vec_str]
            if req.study_id: params.append(req.study_id)
            if req.context_types: params.append(req.context_types)
            params.append(req.top_k * 3)

            # For non-platform orgs, UNION with platform org published context
            if not is_platform:
                idx_rows = await conn.fetch(f"""
                    SELECT id, entity_key, entity_type, summary, source_node_ids,
                           quality_score,
                           1 - (embedding <=> $2::vector) AS score
                    FROM context_index
                    WHERE org_id=$1 {where_study} {where_type}
                      AND embedding IS NOT NULL
                    UNION ALL
                    SELECT ci.id, ci.entity_key, ci.entity_type, ci.summary,
                           ci.source_node_ids, ci.quality_score,
                           1 - (ci.embedding <=> $2::vector) AS score
                    FROM context_index ci
                    WHERE ci.org_id = '{settings.platform_org_id}'
                      AND ci.embedding IS NOT NULL
                      AND EXISTS (
                          SELECT 1 FROM standard_context_graphs scg
                          WHERE scg.is_published = TRUE
                      )
                    ORDER BY score DESC
                    LIMIT ${len(params)}
                """, *params)
            else:
                idx_rows = await conn.fetch(f"""
                    SELECT id, entity_key, entity_type, summary, source_node_ids,
                           quality_score,
                           1 - (embedding <=> $2::vector) AS score
                    FROM context_index
                    WHERE org_id=$1 {where_study} {where_type}
                      AND embedding IS NOT NULL
                    ORDER BY embedding <=> $2::vector
                    LIMIT ${len(params)}
                """, *params)
            search_method = "vector_index" if idx_rows else "fallback"

            for row in idx_rows:
                snids = [str(nid) for nid in (row["source_node_ids"] or [])]
                node_ids.extend(snids)
                results.append({
                    "text": row["summary"],
                    "score": float(row["score"]) * float(row["quality_score"]),
                    "entity_type": row["entity_type"],
                    "entity_key": row["entity_key"],
                    "node_ids": snids,
                })

            # ── 2. Vector search on chunk embeddings (for exact text retrieval) ──
            chunk_params = [req.org_id, vec_str]
            if req.study_id: chunk_params.append(req.study_id)
            study_filter = "AND dc.study_id=$3" if req.study_id else ""
            chunk_params.append(min(req.top_k, 10))

            if not is_platform:
                chunk_rows = await conn.fetch(f"""
                    SELECT dc.id, dc.content, dc.section, dc.page_number,
                           d.name AS doc_name, d.document_type, d.id AS doc_id,
                           cn.id AS node_id,
                           1 - (dc.embedding <=> $2::vector) AS score
                    FROM document_chunks dc
                    JOIN documents d ON d.id = dc.document_id
                    LEFT JOIN context_nodes cn ON cn.external_id = dc.id::text AND cn.node_type='chunk'
                    WHERE dc.org_id=$1 {study_filter}
                      AND dc.embedding IS NOT NULL
                    UNION ALL
                    SELECT dc.id, dc.content, dc.section, dc.page_number,
                           d.name AS doc_name, d.document_type, d.id AS doc_id,
                           cn.id AS node_id,
                           1 - (dc.embedding <=> $2::vector) AS score
                    FROM document_chunks dc
                    JOIN documents d ON d.id = dc.document_id
                    LEFT JOIN context_nodes cn ON cn.external_id = dc.id::text AND cn.node_type='chunk'
                    WHERE dc.org_id = '{settings.platform_org_id}'
                      AND dc.embedding IS NOT NULL
                      AND d.id IN (
                          SELECT unnest(document_ids)
                          FROM standard_context_graphs WHERE is_published=TRUE
                      )
                    ORDER BY score DESC
                    LIMIT ${len(chunk_params)}
                """, *chunk_params)
            else:
                chunk_rows = await conn.fetch(f"""
                    SELECT dc.id, dc.content, dc.section, dc.page_number,
                           d.name AS doc_name, d.document_type, d.id AS doc_id,
                           cn.id AS node_id,
                           1 - (dc.embedding <=> $2::vector) AS score
                    FROM document_chunks dc
                    JOIN documents d ON d.id = dc.document_id
                    LEFT JOIN context_nodes cn ON cn.external_id = dc.id::text AND cn.node_type='chunk'
                    WHERE dc.org_id=$1 {study_filter}
                      AND dc.embedding IS NOT NULL
                    ORDER BY dc.embedding <=> $2::vector
                    LIMIT ${len(chunk_params)}
                """, *chunk_params)

            for row in chunk_rows:
                score = float(row["score"])
                if score < 0.3:
                    continue
                if row["node_id"]:
                    node_ids.append(str(row["node_id"]))
                sources_cited.append({
                    "doc_name":  row["doc_name"],
                    "doc_type":  row["document_type"],
                    "doc_id":    str(row["doc_id"]),
                    "chunk_id":  str(row["id"]),
                    "node_id":   str(row["node_id"]) if row["node_id"] else None,
                    "score":     score,
                    "section":   row["section"],
                    "excerpt":   row["content"][:400],
                })

            # Update access counts
            if idx_rows:
                await conn.execute(
                    "UPDATE context_index SET access_count = access_count + 1 WHERE id = ANY($1)",
                    [str(r["id"]) for r in idx_rows]
                )

        # ── 3. Fallback: text search ──────────────────────────────────────────
        if not sources_cited:
            search_method = "text"
            text_params = [req.org_id, f"%{req.query[:50]}%"]
            if req.study_id: text_params.append(req.study_id)
            study_f = "AND dc.study_id=$3" if req.study_id else ""

            rows = await conn.fetch(f"""
                SELECT dc.id, dc.content, dc.section, d.name AS doc_name, d.document_type
                FROM document_chunks dc
                JOIN documents d ON d.id = dc.document_id
                WHERE dc.org_id=$1 AND dc.content ILIKE $2 {study_f}
                LIMIT 8
            """, *text_params)

            for row in rows:
                sources_cited.append({
                    "doc_name": row["doc_name"],
                    "doc_type": row["document_type"],
                    "chunk_id": str(row["id"]),
                    "score": 0.5,
                    "section": row["section"],
                    "excerpt": row["content"][:400],
                })

        # ── 4. Lineage traversal (if requested) ──────────────────────────────
        if req.include_lineage and node_ids:
            lineage_rows = await conn.fetch("""
                WITH RECURSIVE lineage AS (
                    SELECT id, source_node_id, target_node_id, edge_type, 0 AS depth
                    FROM context_edges WHERE source_node_id = ANY($1)
                    UNION ALL
                    SELECT ce.id, ce.source_node_id, ce.target_node_id, ce.edge_type, l.depth+1
                    FROM context_edges ce
                    JOIN lineage l ON ce.source_node_id = l.target_node_id
                    WHERE l.depth < 3
                )
                SELECT DISTINCT l.source_node_id, l.target_node_id, l.edge_type,
                       n.label AS target_label, n.node_type AS target_type
                FROM lineage l
                JOIN context_nodes n ON n.id = l.target_node_id
                LIMIT 50
            """, node_ids)

            for r in results:
                r["lineage"] = [
                    {"from": str(lr["source_node_id"]), "to": str(lr["target_node_id"]),
                     "edge": lr["edge_type"], "label": lr["target_label"]}
                    for lr in lineage_rows
                    if str(lr["source_node_id"]) in r.get("node_ids", [])
                ]

    return ContextQueryResponse(
        query=req.query,
        results=results,
        sources_cited=sources_cited[:req.top_k],
        context_node_ids=list(set(node_ids))[:20],
        search_method=search_method,
    )


# ─── Decision Trace Recording ─────────────────────────────────────────────────

def _build_scorecard_from_validation(validation_layer: dict, confidence: float) -> dict:
    """Build a structured scorecard dict from the validation_layer for the UI."""
    if not validation_layer:
        return {}

    schema_check      = validation_layer.get("schema_consistency_check") or {}
    completeness      = validation_layer.get("mapping_completeness_check") or {}
    phantom_check     = validation_layer.get("phantom_source_column_check") or {}
    non_ig_check      = validation_layer.get("non_ig_variable_check") or {}
    dup_check         = validation_layer.get("duplicate_sdtm_variable_check") or {}
    low_conf_check    = validation_layer.get("low_confidence_mapping_check") or {}
    rule_validation   = validation_layer.get("rule_validation") or {}
    per_domain        = validation_layer.get("per_domain_validation") or {}
    error_count       = validation_layer.get("error_count", 0)
    warning_count     = validation_layer.get("warning_count", 0)
    validation_passed = validation_layer.get("validation_passed", schema_check.get("passed", True))
    missing_required  = schema_check.get("missing_required_vars", 0)
    coverage_pct      = completeness.get("overall_completeness_pct") or completeness.get("coverage_pct", 100)

    # ── per-dimension scores (0–1) ─────────────────────────────────────────
    schema_score       = 1.0 if schema_check.get("passed", True) else max(0.0, 1.0 - missing_required * 0.1)
    completeness_score = round((coverage_pct or 0) / 100, 3)
    phantom_score      = 1.0 if phantom_check.get("passed", True) else 0.5
    non_ig_score       = 1.0 if non_ig_check.get("passed", True) else 0.7
    dup_score          = 1.0 if dup_check.get("passed", True) else 0.8
    pre_map_pct        = rule_validation.get("exact_match_pct", 0)
    determinism_score  = round(0.5 + pre_map_pct / 200, 3)  # 0.5–1.0 based on exact-match rate
    hitl_score         = None  # pending until HITL completes

    # composite: weighted average of available scores
    _scores = [s for s in [schema_score, completeness_score, phantom_score,
                            non_ig_score, dup_score, determinism_score] if s is not None]
    composite = round(sum(_scores) / len(_scores), 3) if _scores else None

    # letter grade
    def _grade(score):
        if score is None: return "N/A"
        if score >= 0.95: return "A"
        if score >= 0.85: return "B"
        if score >= 0.70: return "C"
        if score >= 0.50: return "D"
        return "F"

    scorecard: dict = {
        # ── overall ────────────────────────────────────────────────────────
        "outcome":              "valid" if validation_passed else "invalid",
        "validation_passed":    validation_passed,
        "confidence":           round(confidence, 3),
        "composite_score":      composite,
        "composite_grade":      _grade(composite),
        "error_count":          error_count,
        "warning_count":        warning_count,
        # ── per-dimension scores ───────────────────────────────────────────
        "dimensions": {
            "required_vars_coverage": {
                "score": round(schema_score, 3),
                "grade": _grade(schema_score),
                "passed": schema_check.get("passed", True),
                "missing_required_vars": missing_required,
                "missing_by_domain": schema_check.get("missing_by_domain", {}),
            },
            "column_coverage": {
                "score": completeness_score,
                "grade": _grade(completeness_score),
                "coverage_pct": coverage_pct,
                "total_columns": completeness.get("total_columns"),
                "mapped": completeness.get("mapped"),
            },
            "source_column_validity": {
                "score": round(phantom_score, 3),
                "grade": _grade(phantom_score),
                "passed": phantom_check.get("passed", True),
                "phantom_columns": phantom_check.get("phantom_cols", []),
            },
            "ig_variable_validity": {
                "score": round(non_ig_score, 3),
                "grade": _grade(non_ig_score),
                "passed": non_ig_check.get("passed", True),
                "non_ig_vars": non_ig_check.get("non_ig_vars", []),
            },
            "deduplication": {
                "score": round(dup_score, 3),
                "grade": _grade(dup_score),
                "passed": dup_check.get("passed", True),
                "duplicates": dup_check.get("duplicates", []),
            },
            "mapping_determinism": {
                "score": determinism_score,
                "grade": _grade(determinism_score),
                "exact_match_pct": pre_map_pct,
                "note": "Higher exact-match rate = more deterministic, less LLM-dependent",
            },
            "hitl_review": {
                "score": hitl_score,
                "grade": "N/A",
                "status": "pending",
                "note": "Score updated after human review completes",
            },
        },
        # ── per-domain breakdown ───────────────────────────────────────────
        "per_domain": {
            d: {
                "passed":               ds.get("passed", True),
                "completeness_pct":     ds.get("completeness_pct", 0),
                "required_mapped":      ds.get("required_vars_mapped", 0),
                "required_total":       ds.get("required_vars_total", 0),
                "required_missing":     ds.get("required_vars_missing", 0),
                "low_conf_vars":        ds.get("low_confidence_mappings", []),
                "grade":                _grade(ds.get("completeness_pct", 0) / 100),
            }
            for d, ds in per_domain.items()
        },
        # ── validation methods applied ─────────────────────────────────────
        "validation_methods_applied": validation_layer.get("validation_methods_applied", []),
        "hitl_required_before_output": validation_layer.get("hitl_required_before_output", True),
    }
    return scorecard


def _build_validation_result_from_layer(validation_layer: dict) -> dict:
    """Build a validation_result summary from the stored validation_layer."""
    if not validation_layer:
        return {}
    methods      = validation_layer.get("validation_methods_applied") or validation_layer.get("validation_methods", [])
    schema_check = validation_layer.get("schema_consistency_check") or {}
    passed       = validation_layer.get("validation_passed", schema_check.get("passed", True))
    missing      = schema_check.get("missing_required_vars", 0)
    error_count  = validation_layer.get("error_count", 0)
    warning_count = validation_layer.get("warning_count", 0)
    # Confidence from stored value or derived
    validator_conf = validation_layer.get("validator_confidence") or (
        0.95 if passed and warning_count == 0
        else 0.80 if passed
        else 0.60
    )
    return {
        "outcome":                  "valid" if passed else "invalid",
        "validator_method":         ", ".join(methods) if methods else "multi_engine",
        "validator_confidence":     round(validator_conf, 3),
        "schema_consistency_passed": passed,
        "missing_required_vars":    missing,
        "error_count":              error_count,
        "warning_count":            warning_count,
        "validation_methods_applied": methods,
        "hitl_validation_status":   validation_layer.get("hitl_validation_status", "pending"),
        "issues_count":             error_count + warning_count,
    }


class DecisionTraceRequest(BaseModel):
    agent_run_id: Optional[str]   = None
    org_id: str
    study_id: Optional[str]          = None
    trace_type: str                   = "tool_call"
    input_context: dict               = Field(default_factory=dict)
    reasoning_steps: list[dict]       = Field(default_factory=list)
    sources_cited: list[dict]         = Field(default_factory=list)
    context_node_ids: list[str]       = Field(default_factory=list)
    output: dict                      = Field(default_factory=dict)
    confidence: float                 = 1.0
    # New optional fields (backward compatible)
    mistake_type: Optional[str]       = None
        # 'hallucination' | 'wrong_source' | 'scope_violation' | 'other'
    used_chunk_node_ids: list[str]    = Field(default_factory=list)
        # context_node IDs explicitly consumed by this decision (for used_in_decision edges)
    trace_version: int                = 1
    intent_resolution: dict           = Field(default_factory=dict)
    retrieval_plan: dict              = Field(default_factory=dict)
    evidence_assembly: dict           = Field(default_factory=dict)
    execution_mode: dict              = Field(default_factory=dict)
    answer_construction: dict         = Field(default_factory=dict)
    outcome_learning: dict            = Field(default_factory=dict)
    confidence_decomposition: dict    = Field(default_factory=dict)
    decision_lineage: dict            = Field(default_factory=dict)
    audit_evidence: dict              = Field(default_factory=dict)
    # Gap layers — previously silently dropped; now persisted
    retrieval_reasoning: dict         = Field(default_factory=dict)
    decision_alternatives: list       = Field(default_factory=list)
    validation_layer: dict            = Field(default_factory=dict)
    learning_recommendation: dict     = Field(default_factory=dict)
    feedback_validation: dict         = Field(default_factory=dict)
    step_linkage: dict                = Field(default_factory=dict)


@app.post("/traces", status_code=201)
async def record_decision_trace(req: DecisionTraceRequest):
    """Record an agent decision trace for explainability and reproducibility."""
    trace_id = str(uuid.uuid4())
    # When mistake_type is set, node_type becomes 'mistake' for graph differentiation
    graph_node_type = "mistake" if req.mistake_type else "decision"

    # Sanitize study_id — drop non-UUID values to avoid FK errors
    study_id = req.study_id
    if study_id:
        try:
            uuid.UUID(study_id)
        except (ValueError, AttributeError):
            study_id = None

    trace_v2 = {
        "trace_version": req.trace_version,
        "intent_resolution": req.intent_resolution,
        "retrieval_plan": req.retrieval_plan,
        "evidence_assembly": req.evidence_assembly,
        "execution_mode": req.execution_mode,
        "answer_construction": req.answer_construction,
        "outcome_learning": req.outcome_learning,
        "confidence_decomposition": req.confidence_decomposition,
        "decision_lineage": req.decision_lineage,
        "audit_evidence": req.audit_evidence,
        # Gap layers — now persisted
        "retrieval_reasoning": req.retrieval_reasoning,
        "decision_alternatives": req.decision_alternatives,
        "validation_layer": req.validation_layer,
        "learning_recommendation": req.learning_recommendation,
        "feedback_validation": req.feedback_validation,
        "step_linkage": req.step_linkage,
        # Build a scorecard from validation_layer for the UI
        "scorecard": _build_scorecard_from_validation(req.validation_layer, req.confidence),
    }
    has_v2_payload = req.trace_version >= 2 or any(bool(v) for v in trace_v2.values() if isinstance(v, dict))
    merged_output = dict(req.output or {})
    if has_v2_payload:
        # Keep v2 trace payload additive and backward-compatible by nesting in output.
        merged_output["_trace_v2"] = trace_v2

    async with db_pool.acquire() as conn:
        await conn.execute("""
            INSERT INTO decision_traces
                (id, agent_run_id, org_id, study_id, trace_type,
                 input_context, reasoning_steps, sources_cited, output, confidence,
                 mistake_type)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        """, trace_id,
            req.agent_run_id, req.org_id, study_id, req.trace_type,
            json.dumps(req.input_context), json.dumps(req.reasoning_steps),
            json.dumps(req.sources_cited), json.dumps(merged_output), req.confidence,
            req.mistake_type)

        # Create decision/mistake node in graph and link to agent_run
        if req.agent_run_id:
            run_node_id = await _upsert_node(
                conn, "agent_run", req.agent_run_id, req.org_id, req.study_id,
                f"Agent Run {req.agent_run_id[:8]}", {"run_id": req.agent_run_id}
            )
            decision_node_id = await _upsert_node(
                conn, graph_node_type, trace_id, req.org_id, req.study_id,
                f"{req.trace_type} @ {datetime.now(timezone.utc).isoformat()[:19]}",
                {
                    "trace_type": req.trace_type,
                    "confidence": req.confidence,
                    "trace_version": req.trace_version,
                    "mistake_type": req.mistake_type,
                    "output_keys": list(merged_output.keys()),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
            )
            await _upsert_edge(conn, decision_node_id, run_node_id, "produced_by")

            # cites edges: decision → chunk/entity (existing forward edges)
            for node_id in req.context_node_ids[:10]:
                await _upsert_edge(conn, decision_node_id, node_id, "cites",
                                   metadata={"trace_id": trace_id})

            # used_in_decision edges: chunk → decision (NEW reverse edges)
            engine = RetrievalEngine(db_pool)
            await engine.record_used_in_decision(trace_id, req.used_chunk_node_ids, conn)

    # ── Neo4j: lightweight DecisionTrace node + edges ──────────────────────────
    if req.agent_run_id:
        trace_label = f"{(req.trace_type or 'decision').title()} step"
        await _neo4j_run("""
            MERGE (run:AgentRun {id: $run_id})
              ON CREATE SET run.org_id = $org_id, run.study_id = $study_id
            MERGE (dt:DecisionTrace {id: $trace_id})
              ON CREATE SET dt.org_id      = $org_id,
                            dt.trace_type  = $trace_type,
                            dt.confidence  = $confidence,
                            dt.created_at  = $created_at,
                            dt.label       = $label
            MERGE (run)-[:HAS_DECISION]->(dt)
        """, {
            "run_id": req.agent_run_id, "org_id": str(req.org_id),
            "study_id": req.study_id, "trace_id": trace_id,
            "trace_type": req.trace_type or "reasoning",
            "confidence": req.confidence,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "label": trace_label,
        })
        # USED_IN_DECISION edges: DecisionTrace → Chunk (lightweight cross-ref to PG IDs)
        for src in (req.sources_cited or [])[:15]:
            chunk_ref = src.get("chunk_id") or src.get("node_id")
            if chunk_ref:
                await _neo4j_run("""
                    MERGE (ch:Chunk {id: $chunk_id})
                    MERGE (dt:DecisionTrace {id: $trace_id})
                    MERGE (dt)-[:USED_IN_DECISION {score: $score}]->(ch)
                """, {"chunk_id": str(chunk_ref), "trace_id": trace_id,
                      "score": float(src.get("score", 1.0))})

    log.info("trace.recorded", trace_id=trace_id, run_id=req.agent_run_id,
             mistake_type=req.mistake_type)
    return {"trace_id": trace_id}


class TracePatchRequest(BaseModel):
    """Patch specific blocks of an existing decision trace without full re-emission.
    Only provided keys are updated — omitted keys are left unchanged.
    """
    sources_cited:           Optional[list]  = None
    retrieval_plan:          Optional[dict]  = None
    evidence_assembly:       Optional[dict]  = None
    reasoning_steps:         Optional[list]  = None
    intent_resolution:       Optional[dict]  = None
    answer_construction:     Optional[dict]  = None
    outcome_learning:        Optional[dict]  = None
    learning_recommendation: Optional[dict]  = None
    validation_layer:        Optional[dict]  = None
    confidence_decomposition: Optional[dict] = None
    step_linkage:            Optional[dict]  = None
    feedback_validation:     Optional[dict]  = None
    retrieval_reasoning:     Optional[dict]  = None
    decision_alternatives:   Optional[list]  = None


@app.patch("/traces/{trace_id}", status_code=200)
async def patch_decision_trace(trace_id: str, req: TracePatchRequest):
    """Patch specific blocks of an existing decision trace.
    Supports retroactive enrichment of stored traces (e.g. adding query_type to
    sources_cited, fixing auto-generated retrieval_plan, enriching reasoning_steps).
    Only supplied fields are updated; all others remain unchanged.
    """
    async with db_pool.acquire() as conn:
        # Fetch the existing trace
        row = await conn.fetchrow(
            """SELECT id, output, sources_cited, reasoning_steps
               FROM decision_traces WHERE id=$1""",
            trace_id
        )
        if not row:
            raise HTTPException(status_code=404, detail=f"Trace {trace_id} not found")

        existing_output = _decode_json_value(row["output"], {})
        existing_v2 = existing_output.get("_trace_v2", {})

        # Build patched _trace_v2 — only update supplied keys
        patch_fields = req.model_dump(exclude_none=True)
        # sources_cited and reasoning_steps are top-level columns; others are in _trace_v2
        new_sources_cited = json.dumps(req.sources_cited) if req.sources_cited is not None \
                            else row["sources_cited"]
        new_reasoning_steps = json.dumps(req.reasoning_steps) if req.reasoning_steps is not None \
                              else row["reasoning_steps"]

        # Patch _trace_v2 sub-keys
        v2_keys = {k: v for k, v in patch_fields.items()
                   if k not in ("sources_cited", "reasoning_steps")}
        patched_v2 = {**existing_v2, **v2_keys}

        patched_output = {**existing_output, "_trace_v2": patched_v2}

        await conn.execute(
            """UPDATE decision_traces
               SET sources_cited=$1, reasoning_steps=$2, output=$3
               WHERE id=$4""",
            new_sources_cited,
            new_reasoning_steps,
            json.dumps(patched_output),
            trace_id,
        )

    log.info("trace.patched", trace_id=trace_id, patched_keys=list(patch_fields.keys()))
    return {"trace_id": trace_id, "patched_keys": list(patch_fields.keys()), "status": "ok"}


@app.get("/traces/{run_id}")
async def get_traces_for_run(run_id: str):
    """Get all decision traces for an agent run."""
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, trace_type, input_context, reasoning_steps, sources_cited,
                      output, confidence, mistake_type, created_at
               FROM decision_traces WHERE agent_run_id=$1 ORDER BY created_at""",
            run_id
        )
        feedback_rows = await conn.fetch(
            """SELECT id, decision_trace_id, feedback_type, feedback_value,
                      submitted_by, processed, created_at
               FROM context_feedback
               WHERE agent_run_id=$1 OR decision_trace_id = ANY(
                   SELECT id FROM decision_traces WHERE agent_run_id=$1
               )
               ORDER BY created_at DESC""",
            run_id,
        )
        eval_row = await conn.fetchrow(
            """SELECT faithfulness_score, reasoning_score, tool_usage_accuracy,
                      hallucination_detected, hallucination_rate, judge_verdict
               FROM agent_run_evaluations
               WHERE run_id::text=$1
               ORDER BY created_at DESC
               LIMIT 1""",
            run_id,
        )
        run_row = await conn.fetchrow(
            """SELECT input_context, output_summary, checkpoint_data, step_traces,
                      artifacts, llm_model, status, started_at, completed_at
               FROM agent_runs
               WHERE id::text=$1
               LIMIT 1""",
            run_id,
        )
        usdm_conversion_row = await conn.fetchrow(
            """SELECT id, approval_id, protocol_doc_id, protocol_filename, protocol_s3_key,
                      usdm_json, status, updated_at
               FROM usdm_conversions
               WHERE run_id=$1
               ORDER BY updated_at DESC
               LIMIT 1""",
            run_id,
        )
        approval_rows = await conn.fetch(
            """SELECT id, title, status, decision_by, decision_at, proposed_action, modified_action,
                      created_at, description
               FROM approval_requests
               WHERE run_id=$1
               ORDER BY created_at""",
            run_id,
        )

    run_input_context = run_row.get("input_context") if run_row else {}
    if isinstance(run_input_context, str):
        try:
            run_input_context = json.loads(run_input_context)
        except Exception:
            run_input_context = {}
    if not isinstance(run_input_context, dict):
        run_input_context = {}
    run_output_summary = str(run_row.get("output_summary") or "") if run_row else ""
    run_checkpoint_data = _decode_json_value(run_row.get("checkpoint_data") if run_row else {}, {})
    if not isinstance(run_checkpoint_data, dict):
        run_checkpoint_data = {}
    run_step_traces = _decode_json_value(run_row.get("step_traces") if run_row else [], [])
    if not isinstance(run_step_traces, list):
        run_step_traces = []
    run_artifacts = _decode_json_value(run_row.get("artifacts") if run_row else [], [])
    if not isinstance(run_artifacts, list):
        run_artifacts = []
    run_metadata = {
        "run_id": run_id,
        "output_summary": run_output_summary,
        "checkpoint_data": run_checkpoint_data,
        "step_traces": run_step_traces,
        "artifacts": run_artifacts,
        "llm_model": str(run_row.get("llm_model") or "") if run_row else "",
        "status": str(run_row.get("status") or "") if run_row else "",
        "started_at": run_row.get("started_at") if run_row else None,
        "completed_at": run_row.get("completed_at") if run_row else None,
        "input_context": run_input_context,
    }
    usdm_conversion = dict(usdm_conversion_row) if usdm_conversion_row else {}
    if usdm_conversion:
        usdm_conversion["usdm_json"] = _decode_json_value(usdm_conversion.get("usdm_json"), {})
        if not isinstance(usdm_conversion.get("usdm_json"), dict):
            usdm_conversion["usdm_json"] = {}
    approval_records = []
    for approval_row in approval_rows:
        approval_record = dict(approval_row)
        approval_record["proposed_action"] = _decode_json_value(approval_record.get("proposed_action"), {})
        approval_record["modified_action"] = _decode_json_value(approval_record.get("modified_action"), {})
        if not isinstance(approval_record.get("proposed_action"), dict):
            approval_record["proposed_action"] = {}
        if not isinstance(approval_record.get("modified_action"), dict):
            approval_record["modified_action"] = {}
        approval_records.append(approval_record)

    feedback_by_trace: dict[str, list[dict]] = {}
    for fb in feedback_rows:
        d = dict(fb)
        dtid = str(d.get("decision_trace_id")) if d.get("decision_trace_id") else None
        if not dtid:
            continue
        feedback_value = _decode_json_value(d.get("feedback_value"), {})
        if not isinstance(feedback_value, dict):
            feedback_value = {}
        feedback_by_trace.setdefault(dtid, []).append({
            "id": str(d.get("id")),
            "feedback_type": d.get("feedback_type"),
            "feedback_value": feedback_value,
            "submitted_by": d.get("submitted_by"),
            "processed": bool(d.get("processed")),
            "created_at": d.get("created_at"),
        })

    run_scorecard = {}
    run_validation_result = {}
    run_learning_recommendation = {}
    if eval_row:
        run_scorecard = {
            "retrieval_score": eval_row.get("faithfulness_score"),
            "evidence_sufficiency_score": eval_row.get("reasoning_score"),
            "tool_correctness_score": eval_row.get("tool_usage_accuracy"),
            "groundedness_score": eval_row.get("faithfulness_score"),
            "compliance_score": 0.0 if eval_row.get("hallucination_detected") else 1.0,
            "human_agreement_score": None,
        }
        components = [v for v in run_scorecard.values() if isinstance(v, (int, float))]
        run_scorecard["composite_response_quality_score"] = (
            sum(components) / len(components)
        ) if components else None
        run_validation_result = {
            "outcome": "invalid" if eval_row.get("hallucination_detected") else "valid",
            "validator_method": "llm_judge",
            "validator_confidence": 0.8,
            "judge_verdict": eval_row.get("judge_verdict"),
            "hallucination_rate": eval_row.get("hallucination_rate"),
        }
        if eval_row.get("hallucination_detected"):
            run_learning_recommendation = {
                "recommendation": "lower_confidence_and_require_stronger_evidence",
                "reason": "Hallucination detected by judge",
            }

    traces = []
    for row in rows:
        item = dict(row)
        trace_id = str(item.get("id")) if item.get("id") else ""
        item["input_context"] = _decode_json_value(item.get("input_context"), {})
        item["reasoning_steps"] = _decode_json_value(item.get("reasoning_steps"), [])
        item["sources_cited"] = _decode_json_value(item.get("sources_cited"), [])
        item["output"] = _decode_json_value(item.get("output"), {})
        output = item.get("output") or {}
        trace_v2 = output.get("_trace_v2") if isinstance(output, dict) else None
        if isinstance(trace_v2, dict):
            item["trace_version"] = int(trace_v2.get("trace_version", 1) or 1)
            item["intent_resolution"] = trace_v2.get("intent_resolution") or {}
            item["retrieval_plan"] = trace_v2.get("retrieval_plan") or {}
            item["evidence_assembly"] = trace_v2.get("evidence_assembly") or {}
            item["execution_mode"] = trace_v2.get("execution_mode") or {}
            item["answer_construction"] = trace_v2.get("answer_construction") or {}
            item["outcome_learning"] = trace_v2.get("outcome_learning") or {}
            item["confidence_decomposition"] = trace_v2.get("confidence_decomposition") or {}
            item["decision_lineage"] = trace_v2.get("decision_lineage") or {}
            item["audit_evidence"] = trace_v2.get("audit_evidence") or {}
            # Gap layers — now extracted from stored trace_v2
            item["retrieval_reasoning"] = trace_v2.get("retrieval_reasoning") or {}
            item["decision_alternatives"] = trace_v2.get("decision_alternatives") or []
            item["validation_layer"] = trace_v2.get("validation_layer") or {}
            item["step_linkage"] = trace_v2.get("step_linkage") or {}
            item["feedback_validation"] = trace_v2.get("feedback_validation") or {}
        else:
            inferred = _legacy_trace_to_stage_payload(item, run_input_context, run_output_summary)
            item["trace_version"] = inferred.get("trace_version", 1)
            item["intent_resolution"] = inferred.get("intent_resolution", {})
            item["retrieval_plan"] = inferred.get("retrieval_plan", {})
            item["evidence_assembly"] = inferred.get("evidence_assembly", {})
            item["execution_mode"] = inferred.get("execution_mode", {})
            item["answer_construction"] = inferred.get("answer_construction", {})
            item["outcome_learning"] = inferred.get("outcome_learning", {})
            item["confidence_decomposition"] = inferred.get("confidence_decomposition", {})
            item["decision_lineage"] = inferred.get("decision_lineage", {})
            item["audit_evidence"] = inferred.get("audit_evidence", {})
            item["retrieval_reasoning"] = {}
            item["decision_alternatives"] = []
            item["validation_layer"] = {}
            item["step_linkage"] = {}
            item["feedback_validation"] = {}

        _enrich_usdm_trace_payload(item, run_metadata, usdm_conversion, approval_records)

        item["human_readable_summary"] = _build_human_readable_trace_summary(item)

        feedback_events = feedback_by_trace.get(trace_id, [])
        item["feedback_events"] = feedback_events

        latest_validation = None
        latest_learning = None
        for fb in feedback_events:
            fb_value = fb.get("feedback_value") or {}
            if isinstance(fb_value, str):
                try:
                    fb_value = json.loads(fb_value)
                except Exception:
                    fb_value = {}
            if not isinstance(fb_value, dict):
                fb_value = {}
            if isinstance(fb_value.get("validation_result"), dict) and not latest_validation:
                latest_validation = fb_value.get("validation_result")
            if isinstance(fb_value.get("learning_recommendation"), dict) and not latest_learning:
                latest_learning = fb_value.get("learning_recommendation")

        # Build validation_result from stored validation_layer (works for all trace types)
        stored_validation_layer = item.get("validation_layer") or {}
        trace_scorecard = None
        if isinstance(trace_v2, dict):
            trace_scorecard = trace_v2.get("scorecard") if isinstance(trace_v2.get("scorecard"), dict) and trace_v2.get("scorecard") else None

        if item.get("trace_type") == "output":
            item["validation_result"] = (
                latest_validation or
                (_build_validation_result_from_layer(stored_validation_layer) if stored_validation_layer else None) or
                run_validation_result or
                None
            )
            item["scorecard"] = (
                trace_scorecard or
                (_build_scorecard_from_validation(stored_validation_layer, item.get("confidence", 1.0)) if stored_validation_layer else None) or
                (run_scorecard if run_scorecard else None)
            )
            item["learning_recommendation"] = (
                latest_learning or
                (trace_v2.get("learning_recommendation") if isinstance(trace_v2, dict) else None) or
                run_learning_recommendation or
                item.get("outcome_learning") or
                None
            )
        else:
            # For reasoning/planning/tool_call traces: show their own validation layer
            item["validation_result"] = (
                latest_validation or
                (_build_validation_result_from_layer(stored_validation_layer) if stored_validation_layer else None)
            )
            item["scorecard"] = (
                trace_scorecard or
                (_build_scorecard_from_validation(stored_validation_layer, item.get("confidence", 1.0)) if stored_validation_layer else None)
            )
            item["learning_recommendation"] = (
                latest_learning or
                (trace_v2.get("learning_recommendation") if isinstance(trace_v2, dict) and trace_v2.get("learning_recommendation") else None)
            )

        traces.append(item)
    return {"run_id": run_id, "traces": traces}


def _first_non_empty_text(*values: Any) -> str:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def _decode_json_value(value: Any, fallback: Any) -> Any:
    if value is None:
        return fallback
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return fallback
    return value


def _stable_json_hash(value: Any) -> str:
    try:
        payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    except Exception:
        payload = str(value)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _extract_step_result_count(step_traces: list, step_name_fragment: str) -> int:
    for step in step_traces:
        if not isinstance(step, dict):
            continue
        if step_name_fragment.lower() not in str(step.get("name") or "").lower():
            continue
        preview = step.get("output_preview") if isinstance(step.get("output_preview"), dict) else {}
        for key in ("section_count", "example_count", "count"):
            value = preview.get(key)
            if isinstance(value, (int, float)):
                return int(value)
    return 0


def _extract_step_preview(step_traces: list, step_name_fragment: str) -> dict:
    for step in step_traces:
        if not isinstance(step, dict):
            continue
        if step_name_fragment.lower() not in str(step.get("name") or "").lower():
            continue
        preview = step.get("output_preview") if isinstance(step.get("output_preview"), dict) else {}
        if preview:
            return preview
    return {}


def _build_usdm_field_lineage_summary(usdm_json: dict, protocol_filename: str, example_names: list[str]) -> list[dict]:
    study = usdm_json.get("study") if isinstance(usdm_json.get("study"), dict) else {}
    designs = study.get("studyDesigns") if isinstance(study.get("studyDesigns"), list) else []
    primary_design = designs[0] if designs and isinstance(designs[0], dict) else {}
    return [
        {
            "field_group": "study.studyTitle",
            "value_preview": study.get("studyTitle") or "",
            "source_types": ["protocol_document"],
            "supporting_artifacts": [protocol_filename] if protocol_filename else [],
            "rationale": "Study title should be extracted directly from the source protocol.",
        },
        {
            "field_group": "study.studyIdentifiers",
            "value_count": len(study.get("studyIdentifiers") or []),
            "source_types": ["protocol_document"],
            "supporting_artifacts": [protocol_filename] if protocol_filename else [],
            "rationale": "Protocol identifiers are derived from the protocol header and metadata.",
        },
        {
            "field_group": "study.studyDesigns[*].objectives",
            "value_count": len(primary_design.get("objectives") or []),
            "source_types": ["protocol_document", "implementation_guide", "past_approved_examples"],
            "supporting_artifacts": example_names,
            "rationale": "Objectives are mapped from the protocol and normalized using the USDM implementation guide and approved examples.",
        },
        {
            "field_group": "study.studyDesigns[*].studyArms",
            "value_count": len(primary_design.get("studyArms") or []),
            "source_types": ["protocol_document", "implementation_guide"],
            "supporting_artifacts": [protocol_filename] if protocol_filename else [],
            "rationale": "Arm structure is extracted from the protocol and normalized to USDM concepts.",
        },
        {
            "field_group": "study.studyDesigns[*].studyPopulations",
            "value_count": len(primary_design.get("studyPopulations") or []),
            "source_types": ["protocol_document", "implementation_guide"],
            "supporting_artifacts": [protocol_filename] if protocol_filename else [],
            "rationale": "Population and eligibility criteria are grounded in protocol sections and normalized using USDM guidance.",
        },
    ]


def _enrich_usdm_trace_payload(item: dict, run_metadata: dict, usdm_conversion: dict, approval_records: list[dict]) -> None:
    intent = item.get("intent_resolution") if isinstance(item.get("intent_resolution"), dict) else {}
    inferred_intent = str(intent.get("inferred_intent") or "")
    if inferred_intent not in {"protocol_to_usdm_conversion", "approval_and_publish"}:
        return

    checkpoint = run_metadata.get("checkpoint_data") if isinstance(run_metadata.get("checkpoint_data"), dict) else {}
    step_traces = run_metadata.get("step_traces") if isinstance(run_metadata.get("step_traces"), list) else []
    run_input = run_metadata.get("input_context") if isinstance(run_metadata.get("input_context"), dict) else {}
    artifacts = run_metadata.get("artifacts") if isinstance(run_metadata.get("artifacts"), list) else []
    protocol_filename = _first_non_empty_text(
        run_input.get("protocol_filename"),
        usdm_conversion.get("protocol_filename"),
        checkpoint.get("protocol_filename"),
        item.get("input_context", {}).get("filename") if isinstance(item.get("input_context"), dict) else "",
    )
    protocol_doc_id = _first_non_empty_text(run_input.get("protocol_doc_id"), usdm_conversion.get("protocol_doc_id"))
    protocol_s3_key = _first_non_empty_text(run_input.get("protocol_s3_key"), usdm_conversion.get("protocol_s3_key"))
    conversion_id = _first_non_empty_text(checkpoint.get("conversion_id"), usdm_conversion.get("id"))
    approval_id = _first_non_empty_text(checkpoint.get("approval_id"), usdm_conversion.get("approval_id"))
    llm_model = _first_non_empty_text(run_metadata.get("llm_model"))

    selected_approval = None
    if approval_id:
        for approval in approval_records:
            if str(approval.get("id") or "") == approval_id:
                selected_approval = approval
                break
    if not selected_approval and approval_records:
        selected_approval = approval_records[-1]

    retrieval_plan = item.get("retrieval_plan") if isinstance(item.get("retrieval_plan"), dict) else {}
    evidence_assembly = item.get("evidence_assembly") if isinstance(item.get("evidence_assembly"), dict) else {}
    execution_mode = item.get("execution_mode") if isinstance(item.get("execution_mode"), dict) else {}
    answer_construction = item.get("answer_construction") if isinstance(item.get("answer_construction"), dict) else {}
    outcome_learning = item.get("outcome_learning") if isinstance(item.get("outcome_learning"), dict) else {}
    decision_lineage = item.get("decision_lineage") if isinstance(item.get("decision_lineage"), dict) else {}
    audit_evidence = item.get("audit_evidence") if isinstance(item.get("audit_evidence"), dict) else {}
    output = item.get("output") if isinstance(item.get("output"), dict) else {}
    reasoning_steps = item.get("reasoning_steps") if isinstance(item.get("reasoning_steps"), list) else []
    sources_cited = item.get("sources_cited") if isinstance(item.get("sources_cited"), list) else []

    ig_queries = [
        "USDM v4 study design structure unified study definition model",
        "USDM objective endpoint estimand population criteria",
        "USDM v4 arm epoch activity biomedical concept",
    ]
    example_preview = _extract_step_preview(step_traces, "Loading Past USDM Conversions")
    example_names = [str(name) for name in (example_preview.get("examples") or []) if name]
    ig_count = _extract_step_result_count(step_traces, "Implementation Guide") or int(retrieval_plan.get("candidate_sources_considered") or 0)
    example_count = _extract_step_result_count(step_traces, "Past USDM Conversions") or len(example_names)
    selected_sources = []
    for source in sources_cited:
        if not isinstance(source, dict):
            continue
        selected_sources.append({
            "doc_name": source.get("doc_name") or source.get("document_name"),
            "doc_type": source.get("doc_type"),
            "section": source.get("section"),
            "chunk_id": source.get("chunk_id"),
            "excerpt_hash": _stable_json_hash(source.get("excerpt") or source.get("text") or ""),
            "excerpt_preview": str(source.get("excerpt") or source.get("text") or "")[:280],
        })
    for example_name in example_names:
        selected_sources.append({
            "doc_name": example_name,
            "doc_type": "approved_usdm_example",
            "section": None,
            "chunk_id": None,
            "excerpt_hash": None,
            "excerpt_preview": None,
        })

    if inferred_intent == "protocol_to_usdm_conversion":
        if not intent.get("raw_user_query"):
            intent["raw_user_query"] = f"Convert protocol '{protocol_filename}' to USDM v4 JSON." if protocol_filename else "Convert source protocol to USDM v4 JSON."
        if not intent.get("normalized_query"):
            intent["normalized_query"] = _normalize_query_text(intent.get("raw_user_query") or "")
        intent.setdefault("request_origin", {
            "trigger_type": "workflow_run",
            "run_id": run_metadata.get("run_id"),
            "conversion_id": conversion_id,
            "protocol_doc_id": protocol_doc_id,
        })

        retrieval_plan.setdefault("retrieval_queries", ig_queries)
        retrieval_plan.setdefault("query_bundle_hash", _stable_json_hash(ig_queries))
        retrieval_plan.setdefault("candidate_source_breakdown", {
            "implementation_guide_sections": ig_count,
            "past_approved_examples": example_count,
        })
        retrieval_plan.setdefault("selected_source_records", selected_sources)
        retrieval_plan.setdefault("replay_ready", True)

        evidence_assembly.setdefault("selected_sources", selected_sources)
        evidence_assembly.setdefault("selected_chunk_ids", [str(src.get("chunk_id")) for src in selected_sources if src.get("chunk_id")])
        evidence_assembly.setdefault("field_level_lineage_summary", _build_usdm_field_lineage_summary(usdm_conversion.get("usdm_json") or output, protocol_filename, example_names))
        evidence_assembly.setdefault("ambiguity_register", [] if selected_sources else ["missing_selected_source_records"])

        execution_mode.setdefault("tool_invocation_details", [
            {
                "step": step.get("step"),
                "action": step.get("action"),
                "thought": step.get("thought"),
                "result_count": step.get("result_count"),
            }
            for step in reasoning_steps if isinstance(step, dict)
        ])
        execution_mode.setdefault("model_context", {"llm_model": llm_model, "human_review_required": True})

        answer_construction.setdefault("output_summary", {
            "design_count": output.get("designs"),
            "objective_count": output.get("objectives"),
            "conversion_id": conversion_id,
        })

        if not decision_lineage:
            decision_lineage = {
                "lineage_version": "v1",
                "source_protocol": {
                    "protocol_doc_id": protocol_doc_id,
                    "protocol_filename": protocol_filename,
                    "protocol_s3_key": protocol_s3_key,
                },
                "retrieval_replay": {
                    "recipe": retrieval_plan.get("retrieval_recipe"),
                    "recipe_version": retrieval_plan.get("recipe_version"),
                    "queries": ig_queries,
                    "candidate_source_breakdown": retrieval_plan.get("candidate_source_breakdown"),
                },
                "example_lineage": {
                    "example_names": example_names,
                    "example_count": example_count,
                },
                "field_level_lineage_summary": evidence_assembly.get("field_level_lineage_summary"),
                "decision_steps": execution_mode.get("tool_invocation_details"),
            }

        if not audit_evidence:
            audit_evidence = {
                "audit_grade": "high_with_provenance_gaps",
                "provenance_bundle": {
                    "run_id": run_metadata.get("run_id"),
                    "conversion_id": conversion_id,
                    "approval_id": approval_id,
                    "protocol_doc_id": protocol_doc_id,
                    "protocol_filename": protocol_filename,
                    "protocol_s3_key": protocol_s3_key,
                },
                "auditor_questions_answered": {
                    "who_or_what_triggered_this_run": intent.get("raw_user_query"),
                    "which_protocol_document_was_used": protocol_filename,
                    "which_reference_materials_were_consulted": {
                        "implementation_guide_sections": ig_count,
                        "approved_usdm_examples": example_names,
                    },
                    "which_tools_or_models_produced_the_mapping": {
                        "tools": execution_mode.get("tools_invoked") or [],
                        "llm_model": llm_model,
                    },
                    "which_controls_make_this_regulatory_safe": {
                        "human_review_required": True,
                        "approval_id": approval_id,
                    },
                },
                "audit_gaps": [
                    gap for gap in [
                        "selected_chunk_ids_not_persisted" if not evidence_assembly.get("selected_chunk_ids") else None,
                        "field_level_source_spans_not_persisted",
                    ] if gap
                ],
            }

    if inferred_intent == "approval_and_publish":
        final_usdm = usdm_conversion.get("usdm_json") if isinstance(usdm_conversion.get("usdm_json"), dict) else {}
        artifact = artifacts[0] if artifacts and isinstance(artifacts[0], dict) else {}
        final_hash = _stable_json_hash(final_usdm) if final_usdm else ""
        proposed_hash = _stable_json_hash(selected_approval.get("proposed_action") or {}) if selected_approval else ""
        modified_hash = _stable_json_hash(selected_approval.get("modified_action") or {}) if selected_approval and selected_approval.get("modified_action") else proposed_hash
        reviewer_modified = bool(selected_approval and selected_approval.get("status") == "modified")

        outcome_learning.setdefault("regulatory_controls", {
            "human_review_completed": True,
            "reviewer_modified_content": reviewer_modified,
            "approval_id": approval_id,
        })
        answer_construction.setdefault("artifact_provenance", {
            "artifact_name": artifact.get("name"),
            "artifact_s3_key": artifact.get("s3_key"),
            "artifact_size_bytes": artifact.get("size"),
            "final_output_sha256": final_hash,
        })

        if not decision_lineage:
            decision_lineage = {
                "lineage_version": "v1",
                "approval_gate": {
                    "approval_id": approval_id,
                    "approval_status": selected_approval.get("status") if selected_approval else "",
                    "decision_by": selected_approval.get("decision_by") if selected_approval else "",
                    "decision_at": selected_approval.get("decision_at") if selected_approval else None,
                    "reviewer_modified_content": reviewer_modified,
                },
                "artifact_publication": {
                    "artifact_name": artifact.get("name"),
                    "artifact_s3_key": artifact.get("s3_key"),
                    "artifact_sha256": final_hash,
                },
                "approval_payload_hashes": {
                    "proposed_action_sha256": proposed_hash,
                    "modified_action_sha256": modified_hash,
                    "final_output_sha256": final_hash,
                },
            }

        if not audit_evidence:
            audit_evidence = {
                "audit_grade": "high",
                "approval_record": {
                    "approval_id": approval_id,
                    "status": selected_approval.get("status") if selected_approval else "",
                    "decision_by": selected_approval.get("decision_by") if selected_approval else "",
                    "decision_at": selected_approval.get("decision_at") if selected_approval else None,
                    "reviewer_modified_content": reviewer_modified,
                },
                "artifact_record": {
                    "artifact_name": artifact.get("name"),
                    "artifact_s3_key": artifact.get("s3_key"),
                    "artifact_sha256": final_hash,
                },
                "auditor_questions_answered": {
                    "who_approved_the_output": selected_approval.get("decision_by") if selected_approval else "",
                    "when_was_it_approved": selected_approval.get("decision_at") if selected_approval else None,
                    "was_the_ai_output_modified_before_approval": reviewer_modified,
                    "what_exact_payload_was_published": {
                        "final_output_sha256": final_hash,
                        "artifact_s3_key": artifact.get("s3_key"),
                    },
                },
                "audit_gaps": [],
            }

    item["intent_resolution"] = intent
    item["retrieval_plan"] = retrieval_plan
    item["evidence_assembly"] = evidence_assembly
    item["execution_mode"] = execution_mode
    item["answer_construction"] = answer_construction
    item["outcome_learning"] = outcome_learning
    item["decision_lineage"] = decision_lineage
    item["audit_evidence"] = audit_evidence


def _normalize_query_text(raw_query: str) -> str:
    if not raw_query:
        return ""
    return re.sub(r"\s+", " ", raw_query.strip().lower())


def _extract_selected_chunks(sources: list, steps: list) -> list[str]:
    selected = []
    for src in sources:
        if not isinstance(src, dict):
            continue
        chunk_id = src.get("chunk_id") or src.get("node_id")
        if chunk_id:
            selected.append(str(chunk_id))

    for step in steps:
        if not isinstance(step, dict):
            continue
        chunk_ids = step.get("selected_chunk_ids") or step.get("chunk_ids")
        if isinstance(chunk_ids, list):
            for chunk_id in chunk_ids:
                if chunk_id is not None:
                    selected.append(str(chunk_id))

    return list(dict.fromkeys([c for c in selected if c]))


def _estimate_candidates_considered(sources: list, steps: list) -> int:
    max_seen = 0
    for step in steps:
        if not isinstance(step, dict):
            continue
        for key in ("result_count", "candidate_count", "results_count", "retrieved_count"):
            value = step.get(key)
            if isinstance(value, (int, float)):
                max_seen = max(max_seen, int(value))
    return max(max_seen, len(sources))


def _legacy_trace_to_stage_payload(item: dict, run_input_context: dict, run_output_summary: str) -> dict:
    trace_type = str(item.get("trace_type") or "")
    ctx = item.get("input_context") if isinstance(item.get("input_context"), dict) else {}
    steps = item.get("reasoning_steps") if isinstance(item.get("reasoning_steps"), list) else []
    sources = item.get("sources_cited") if isinstance(item.get("sources_cited"), list) else []
    output = item.get("output") if isinstance(item.get("output"), dict) else {}
    confidence = float(item.get("confidence") or 0.0)
    protocol_filename = _first_non_empty_text(run_input_context.get("protocol_filename"))
    conversion_id = _first_non_empty_text(run_input_context.get("conversion_id"))

    raw_query = _first_non_empty_text(
        ctx.get("user_message"),
        ctx.get("query"),
        ctx.get("question"),
        run_input_context.get("user_message"),
        run_input_context.get("query"),
        run_input_context.get("question"),
    )
    if not raw_query and protocol_filename:
        raw_query = f"Convert protocol '{protocol_filename}' to USDM v4 JSON."
    elif not raw_query and conversion_id:
        raw_query = f"Complete conversion workflow for conversion ID {conversion_id}."
    elif not raw_query:
        raw_query = _first_non_empty_text(output.get("summary"), output.get("content"), run_output_summary)

    selected_chunk_ids = _extract_selected_chunks(sources, steps)
    candidate_sources_considered = _estimate_candidates_considered(sources, steps)
    candidate_sources_rejected = max(candidate_sources_considered - len(selected_chunk_ids), 0)

    intent_resolution = {
        "raw_user_query": raw_query,
        "normalized_query": _normalize_query_text(raw_query),
        "inferred_intent": (
            "context_retrieval" if trace_type == "tool_call"
            else "answer_synthesis" if trace_type == "synthesis"
            else "reasoning" if trace_type == "reasoning"
            else "final_answer_delivery" if trace_type == "output"
            else "unknown"
        ),
        "inferred_task_class": (
            "retrieval" if trace_type == "tool_call"
            else "narrative_response" if trace_type == "synthesis"
            else "analysis" if trace_type == "reasoning"
            else "output_delivery" if trace_type == "output"
            else "unknown"
        ),
        "intent_confidence": max(0.5, min(0.95, confidence if confidence > 0 else 0.7)),
        "alternate_intents_considered": [],
        "human_readable": (
            f"The system interpreted this step as {trace_type or 'an unknown'} work"
            f" with intent confidence {round(max(0.5, min(0.95, confidence if confidence > 0 else 0.7)) * 100)}%."
            f" Query context: {raw_query or 'No direct user query was recorded; context came from run metadata.'}"
        ),
    }

    retrieval_plan = {
        "retrieval_recipe": "legacy_inferred_from_trace_history",
        "recipe_version": "v1",
        "retrieval_mode": (
            "hybrid" if len(sources) > 0
            else "retrieved_without_citations" if candidate_sources_considered > 0
            else "none"
        ),
        "candidate_sources_considered": candidate_sources_considered,
        "candidate_sources_rejected": candidate_sources_rejected,
        "human_readable": (
            f"Retrieval mode was {('hybrid' if len(sources) > 0 else 'none')} with"
            f" {candidate_sources_considered} candidates considered and"
            f" {candidate_sources_rejected} rejected before final selection."
        ),
    }

    evidence_score = max(0.3, min(0.95, confidence if confidence > 0 else 0.65))
    if not selected_chunk_ids:
        evidence_score = min(evidence_score, 0.45)
    if candidate_sources_considered == 0:
        evidence_score = min(evidence_score, 0.4)

    evidence_gaps = []
    if not sources:
        evidence_gaps.append("no_cited_sources")
    if candidate_sources_considered == 0:
        evidence_gaps.append("no_retrieval_candidates")
    if not selected_chunk_ids:
        evidence_gaps.append("no_selected_chunks")

    evidence_assembly = {
        "selected_chunk_ids": selected_chunk_ids,
        "evidence_sufficiency_score": evidence_score,
        "evidence_gaps": evidence_gaps,
        "human_readable": (
            f"Selected {len(selected_chunk_ids)} supporting chunks with evidence sufficiency"
            f" score {round(evidence_score, 2)}."
            f" Gaps: {', '.join(evidence_gaps) if evidence_gaps else 'none identified'}."
        ),
    }

    tools = []
    for step in steps:
        if isinstance(step, dict) and step.get("tool_used"):
            tools.append(str(step.get("tool_used")))
    tools = list(dict.fromkeys([t for t in tools if t]))

    execution_mode = {
        "reasoning_mode": "tool_execution" if tools else "direct_answer",
        "tools_invoked": tools,
        "fallback_paths_used": [],
    }

    answer_construction = {
        "answer_type": "summary" if output.get("summary") or output.get("content") else "structured",
        "output_schema": "legacy_output",
        "citations_attached": len(sources) > 0,
    }

    confidence_decomposition = {
        "retrieval_confidence": max(0.3, min(1.0, confidence if sources else confidence * 0.6 if confidence > 0 else 0.5)),
        "evidence_sufficiency_confidence": max(0.3, min(1.0, confidence if sources else 0.4)),
        "tool_correctness_confidence": max(0.3, min(1.0, confidence if tools else 0.7)),
        "response_formulation_confidence": max(0.3, min(1.0, confidence if confidence > 0 else 0.7)),
    }

    return {
        "trace_version": 1,
        "intent_resolution": intent_resolution,
        "retrieval_plan": retrieval_plan,
        "evidence_assembly": evidence_assembly,
        "execution_mode": execution_mode,
        "answer_construction": answer_construction,
        "outcome_learning": {},
        "confidence_decomposition": confidence_decomposition,
    }


def _build_human_readable_trace_summary(item: dict) -> str:
    trace_type = str(item.get("trace_type") or "unknown")
    ir = item.get("intent_resolution") if isinstance(item.get("intent_resolution"), dict) else {}
    rp = item.get("retrieval_plan") if isinstance(item.get("retrieval_plan"), dict) else {}
    ea = item.get("evidence_assembly") if isinstance(item.get("evidence_assembly"), dict) else {}
    audit_evidence = item.get("audit_evidence") if isinstance(item.get("audit_evidence"), dict) else {}

    raw_query = _first_non_empty_text(ir.get("raw_user_query"), "No direct user query was recorded")
    inferred_intent = _first_non_empty_text(ir.get("inferred_intent"), "unknown")
    task_class = _first_non_empty_text(ir.get("inferred_task_class"), "unknown")
    intent_conf = ir.get("intent_confidence")

    retrieval_mode = _first_non_empty_text(rp.get("retrieval_mode"), "none")
    recipe = _first_non_empty_text(rp.get("retrieval_recipe"), "unknown")
    considered = int(rp.get("candidate_sources_considered") or 0)
    rejected = int(rp.get("candidate_sources_rejected") or 0)

    selected = ea.get("selected_chunk_ids") if isinstance(ea.get("selected_chunk_ids"), list) else []
    selected_sources = ea.get("selected_sources") if isinstance(ea.get("selected_sources"), list) else []
    sufficiency = ea.get("evidence_sufficiency_score")
    gaps = ea.get("evidence_gaps") if isinstance(ea.get("evidence_gaps"), list) else []
    audit_gaps = audit_evidence.get("audit_gaps") if isinstance(audit_evidence.get("audit_gaps"), list) else []

    confidence_text = (
        f"{round(float(intent_conf) * 100)}%" if isinstance(intent_conf, (int, float)) else "unknown"
    )
    sufficiency_text = (
        f"{round(float(sufficiency), 2)}" if isinstance(sufficiency, (int, float)) else "unknown"
    )
    gap_list = [str(g) for g in gaps if g]
    gaps_text = ", ".join(gap_list) if gap_list else "none"
    selected_evidence_count = len(selected) if selected else len(selected_sources)

    if retrieval_mode == "none" and considered == 0:
        why_text = (
            "No retrievable evidence was captured for this step, so the trace relies on run-level context "
            "instead of cited chunks."
        )
    elif selected_evidence_count == 0:
        why_text = (
            "Retrieval appears to have started, but no fully persisted evidence selection record was stored for final assembly."
        )
    elif gap_list:
        why_text = f"Some evidence gaps were detected: {gaps_text}."
    else:
        why_text = "Evidence coverage looks complete for this step."

    next_actions = []
    if "no_cited_sources" in gap_list:
        next_actions.append("attach at least one citation to the generated answer")
    if "no_retrieval_candidates" in gap_list:
        next_actions.append("rerun retrieval with a broader or reformulated query")
    if "no_selected_chunks" in gap_list and not selected_sources:
        next_actions.append("review chunk ranking and selection thresholds")
    if not next_actions and retrieval_mode == "none":
        next_actions.append("verify whether this workflow intentionally runs without document retrieval")
    if "field_level_source_spans_not_persisted" in audit_gaps:
        next_actions.append("persist field-level source spans for exact audit replay")
    if "selected_chunk_ids_not_persisted" in audit_gaps and selected_sources:
        next_actions.append("persist chunk identifiers for selected evidence records")

    actions_text = "; then ".join(next_actions) if next_actions else "no immediate action required"

    return (
        f"What happened: This {trace_type} step was classified as '{inferred_intent}' "
        f"(task class '{task_class}', confidence {confidence_text}) using input context: {raw_query}. "
        f"Retrieval ran in '{retrieval_mode}' mode with recipe '{recipe}', considering {considered} candidates, "
        f"rejecting {rejected}, and selecting {selected_evidence_count} evidence records (evidence sufficiency {sufficiency_text}). "
        f"Why details are limited: {why_text} "
        f"What to do next: {actions_text}."
    )


# ─── Feedback Processing ──────────────────────────────────────────────────────

class FeedbackRequest(BaseModel):
    agent_run_id: Optional[str]       = None
    decision_trace_id: Optional[str]  = None
    org_id: str
    feedback_type: str   # rating|correction|endorsement|rejection
    feedback_value: dict = Field(default_factory=dict)
    submitted_by: str


_ALLOWED_FEEDBACK_TYPES = {"rating", "correction", "endorsement", "rejection"}
_ALLOWED_STORAGE_FEEDBACK_TYPES = {
    "rating",
    "correction",
    "endorsement",
    "rejection",
    "mapping_correction",
    "wrong_answer",
    "incomplete_answer",
    "wrong_source_context",
    "wrong_reasoning_path",
    "bad_formatting",
    "wrong_confidence",
    "policy_compliance_issue",
}
_FEEDBACK_TYPE_ALIASES = {
    "mapping_correction": "correction",
    "wrong_answer": "correction",
    "incomplete_answer": "correction",
    "wrong_source_context": "rejection",
    "wrong_reasoning_path": "rejection",
    "bad_formatting": "correction",
    "wrong_confidence": "correction",
    "policy_compliance_issue": "rejection",
}
_ALLOWED_FEEDBACK_CATEGORIES = {
    "wrong_answer",
    "incomplete_answer",
    "wrong_source_context",
    "wrong_reasoning_path",
    "bad_formatting",
    "wrong_confidence",
    "policy_compliance_issue",
    "other",
}


def _normalize_feedback_type(raw_type: str) -> str:
    t = (raw_type or "").strip().lower()
    if t in _ALLOWED_STORAGE_FEEDBACK_TYPES:
        return t
    return _FEEDBACK_TYPE_ALIASES.get(t, "correction")


def _normalize_feedback_category(raw_category: Optional[str], fallback_type: str) -> str:
    c = (raw_category or "").strip().lower()
    if c in _ALLOWED_FEEDBACK_CATEGORIES:
        return c
    if fallback_type == "endorsement":
        return "other"
    if fallback_type == "rejection":
        return "wrong_source_context"
    if fallback_type == "correction":
        return "wrong_answer"
    return "other"


def _extract_numeric(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        m = re.search(r"-?\d+(?:\.\d+)?", value)
        if m:
            try:
                return float(m.group(0))
            except ValueError:
                return None
    return None


def _build_validation_result_from_correction(correction_payload: dict, trace_output: dict) -> dict:
    expected = correction_payload.get("expected_value")
    if expected is None:
        return {
            "outcome": "inconclusive",
            "validator_method": "correction_payload_check",
            "validator_confidence": 0.4,
            "reason": "No expected_value provided; deterministic validation not possible",
        }

    observed_text = ""
    if isinstance(trace_output, dict):
        observed_text = str(trace_output.get("content") or trace_output.get("summary") or "")

    expected_num = _extract_numeric(expected)
    observed_num = _extract_numeric(observed_text)
    if expected_num is not None and observed_num is not None:
        is_match = abs(expected_num - observed_num) < 1e-9
        return {
            "outcome": "valid" if is_match else "invalid",
            "validator_method": "deterministic_numeric_match",
            "validator_confidence": 0.95,
            "expected_value": expected_num,
            "observed_value": observed_num,
        }

    expected_text = str(expected).strip().lower()
    observed_norm = observed_text.strip().lower()
    if expected_text and observed_norm:
        return {
            "outcome": "partially_valid" if expected_text in observed_norm else "invalid",
            "validator_method": "string_contains_match",
            "validator_confidence": 0.7,
            "expected_value": str(expected),
            "observed_value": observed_text[:500],
        }

    return {
        "outcome": "inconclusive",
        "validator_method": "correction_payload_check",
        "validator_confidence": 0.4,
    }


def _derive_signal_type(feedback_type: str, feedback_category: Optional[str]) -> str:
    ft = (feedback_type or "").strip().lower()
    if ft in _ALLOWED_FEEDBACK_TYPES:
        return ft
    if ft in _FEEDBACK_TYPE_ALIASES:
        return _FEEDBACK_TYPE_ALIASES[ft]

    cat = (feedback_category or "").strip().lower()
    if cat in ("wrong_source_context", "wrong_reasoning_path", "policy_compliance_issue"):
        return "rejection"
    if cat in ("wrong_answer", "incomplete_answer", "bad_formatting", "wrong_confidence"):
        return "correction"
    return "correction"


def _infer_task_class(correction_payload: dict, trace_input_context: dict) -> str:
    targeted_stage = str(correction_payload.get("targeted_stage") or "").lower()
    if "mapping" in targeted_stage:
        return "mapping"

    if correction_payload.get("corrected_mapping") is not None:
        return "mapping"

    q = str((trace_input_context or {}).get("query") or (trace_input_context or {}).get("user_message") or "").lower()
    if any(k in q for k in ["how many", "count", "total", "sum", "average", "unique"]):
        return "aggregation"
    if any(k in q for k in ["which domain", "domains", "metadata", "present"]):
        return "metadata"
    return "retrieval_narrative"


def _validate_metadata(correction_payload: dict, trace_output: dict, trace_sources: list) -> dict:
    expected = correction_payload.get("expected_value")
    domains = []
    if isinstance(trace_output, dict):
        out_domains = trace_output.get("domains")
        if isinstance(out_domains, list):
            domains = [str(d).strip().upper() for d in out_domains if d]

    if expected is not None and domains:
        expected_set = {x.strip().upper() for x in str(expected).replace(";", ",").split(",") if x.strip()}
        actual_set = set(domains)
        if expected_set and expected_set == actual_set:
            return {
                "outcome": "valid",
                "validator_method": "metadata_domain_set_match",
                "validator_confidence": 0.95,
                "expected": sorted(expected_set),
                "observed": sorted(actual_set),
            }
        return {
            "outcome": "invalid",
            "validator_method": "metadata_domain_set_match",
            "validator_confidence": 0.95,
            "expected": sorted(expected_set),
            "observed": sorted(actual_set),
        }

    if trace_sources:
        return {
            "outcome": "partially_valid",
            "validator_method": "metadata_source_presence_check",
            "validator_confidence": 0.7,
            "observed_source_count": len(trace_sources),
        }

    return {
        "outcome": "inconclusive",
        "validator_method": "metadata_check",
        "validator_confidence": 0.4,
    }


def _validate_aggregation(correction_payload: dict, trace_output: dict) -> dict:
    base = _build_validation_result_from_correction(correction_payload, trace_output)
    return {
        **base,
        "validator_method": "aggregation_" + str(base.get("validator_method", "deterministic_check")),
    }


def _validate_mapping(correction_payload: dict, trace_output: dict) -> dict:
    corrected_mapping = correction_payload.get("corrected_mapping")
    if isinstance(corrected_mapping, dict) and corrected_mapping:
        return {
            "outcome": "valid",
            "validator_method": "mapping_payload_shape_check",
            "validator_confidence": 0.9,
            "mapping_fields": sorted(list(corrected_mapping.keys()))[:50],
        }
    if isinstance(corrected_mapping, list) and corrected_mapping:
        return {
            "outcome": "valid",
            "validator_method": "mapping_payload_list_check",
            "validator_confidence": 0.85,
            "mapping_items": len(corrected_mapping),
        }

    if isinstance(trace_output, dict) and trace_output.get("total_mappings") is not None:
        return {
            "outcome": "partially_valid",
            "validator_method": "mapping_output_presence_check",
            "validator_confidence": 0.7,
            "total_mappings": trace_output.get("total_mappings"),
        }

    return {
        "outcome": "inconclusive",
        "validator_method": "mapping_check",
        "validator_confidence": 0.4,
    }


def _validate_retrieval_narrative(correction_payload: dict, trace_sources: list) -> dict:
    expected = str(correction_payload.get("expected_value") or correction_payload.get("corrected_answer") or "").strip().lower()
    if not trace_sources:
        return {
            "outcome": "invalid",
            "validator_method": "retrieval_grounding_check",
            "validator_confidence": 0.85,
            "reason": "No cited evidence found",
        }

    if expected:
        for src in trace_sources:
            excerpt = str((src or {}).get("excerpt") or "").lower()
            if expected and expected in excerpt:
                return {
                    "outcome": "valid",
                    "validator_method": "retrieval_excerpt_match",
                    "validator_confidence": 0.9,
                }
        return {
            "outcome": "partially_valid",
            "validator_method": "retrieval_evidence_presence",
            "validator_confidence": 0.7,
            "observed_source_count": len(trace_sources),
        }

    return {
        "outcome": "partially_valid",
        "validator_method": "retrieval_evidence_presence",
        "validator_confidence": 0.7,
        "observed_source_count": len(trace_sources),
    }


def _run_task_class_validator(task_class: str, correction_payload: dict,
                              trace_input_context: dict, trace_output: dict,
                              trace_sources: list) -> dict:
    if task_class == "metadata":
        result = _validate_metadata(correction_payload, trace_output, trace_sources)
    elif task_class == "aggregation":
        result = _validate_aggregation(correction_payload, trace_output)
    elif task_class == "mapping":
        result = _validate_mapping(correction_payload, trace_output)
    else:
        result = _validate_retrieval_narrative(correction_payload, trace_sources)

    return {
        **result,
        "task_class": task_class,
    }


@app.post("/feedback", status_code=201)
async def submit_feedback(req: FeedbackRequest, background_tasks: BackgroundTasks):
    """
    Submit feedback on an agent output.
    Triggers async weight adjustment on contributing context nodes.
    """
    fb_id = str(uuid.uuid4())
    normalized_type = _normalize_feedback_type(req.feedback_type)

    raw_payload = dict(req.feedback_value or {})
    correction_payload = dict(raw_payload.get("correction_payload") or {})
    if not correction_payload and raw_payload.get("corrected_text"):
        correction_payload = {
            "corrected_answer": raw_payload.get("corrected_text"),
            "expected_value": raw_payload.get("expected_value"),
            "corrected_ranking": raw_payload.get("corrected_ranking"),
            "corrected_mapping": raw_payload.get("corrected_mapping"),
            "targeted_stage": raw_payload.get("targeted_stage"),
            "targeted_reasoning_step": raw_payload.get("targeted_reasoning_step"),
        }

    normalized_payload = {
        **raw_payload,
        "feedback_category": _normalize_feedback_category(raw_payload.get("feedback_category"), normalized_type),
        "correction_payload": correction_payload,
        "feedback_type_original": req.feedback_type,
    }

    if req.decision_trace_id and _derive_signal_type(normalized_type, normalized_payload.get("feedback_category")) in ("correction", "rejection"):
        async with db_pool.acquire() as conn:
            trace_row = await conn.fetchrow(
                "SELECT input_context, output, sources_cited FROM decision_traces WHERE id=$1::uuid",
                req.decision_trace_id,
            )
            trace_input = (trace_row.get("input_context") if trace_row else {}) or {}
            trace_output = (trace_row.get("output") if trace_row else {}) or {}
            trace_sources = (trace_row.get("sources_cited") if trace_row else []) or []
            if isinstance(trace_output, dict):
                task_class = _infer_task_class(correction_payload, trace_input if isinstance(trace_input, dict) else {})
                normalized_payload["validation_result"] = _run_task_class_validator(
                    task_class,
                    correction_payload,
                    trace_input if isinstance(trace_input, dict) else {},
                    trace_output,
                    trace_sources if isinstance(trace_sources, list) else [],
                )
                normalized_payload["learning_recommendation"] = {
                    "task_class": task_class,
                    "recommendation": (
                        "route_to_aggregation_tools"
                        if task_class == "aggregation"
                        else "prefer_graph_only_retrieval"
                        if task_class == "metadata"
                        else "enforce_mapping_schema_checks"
                        if task_class == "mapping"
                        else "increase_grounded_citation_requirements"
                    ),
                }

    req.feedback_type = normalized_type
    req.feedback_value = normalized_payload

    async with db_pool.acquire() as conn:
        await conn.execute("""
            INSERT INTO context_feedback
                (id, agent_run_id, decision_trace_id, org_id, feedback_type, feedback_value, submitted_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
        """, fb_id, req.agent_run_id, req.decision_trace_id,
            req.org_id, req.feedback_type, json.dumps(req.feedback_value), req.submitted_by)

    # ── Neo4j: lightweight Feedback node ──────────────────────────────────────
    asyncio.ensure_future(_neo4j_write_feedback(fb_id, req))

    background_tasks.add_task(_process_feedback, fb_id, req)
    log.info("feedback.received", fb_id=fb_id, type=req.feedback_type)
    return {"feedback_id": fb_id}


async def _neo4j_write_feedback(fb_id: str, req: "FeedbackRequest"):
    if req.agent_run_id:
        await _neo4j_run("""
            MERGE (run:AgentRun {id: $run_id})
              ON CREATE SET run.org_id = $org_id
            MERGE (fb:Feedback {id: $fb_id})
              ON CREATE SET fb.org_id        = $org_id,
                            fb.feedback_type = $fb_type,
                            fb.submitted_by  = $submitted_by,
                            fb.created_at    = $created_at
            MERGE (run)-[:HAS_FEEDBACK]->(fb)
        """, {
            "run_id": req.agent_run_id, "org_id": str(req.org_id),
            "fb_id": fb_id, "fb_type": req.feedback_type,
            "submitted_by": req.submitted_by,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
    if req.decision_trace_id:
        await _neo4j_run("""
            MATCH (fb:Feedback {id: $fb_id})
            MERGE (dt:DecisionTrace {id: $dt_id})
            MERGE (fb)-[:CORRECTS]->(dt)
        """, {"fb_id": fb_id, "dt_id": str(req.decision_trace_id)})


async def _process_feedback(fb_id: str, req: FeedbackRequest):
    """Adjust context node weights based on feedback signal."""
    signal_type = _derive_signal_type(req.feedback_type, (req.feedback_value or {}).get("feedback_category"))
    # Map feedback type to weight delta
    delta_map = {"endorsement": +0.05, "rating": 0.0, "correction": -0.03, "rejection": -0.08}
    delta = delta_map.get(signal_type, 0.0)

    if signal_type == "rating":
        rating = float(req.feedback_value.get("rating", 3))
        delta  = (rating - 3) * 0.02  # 0.02 per point above/below neutral

    if abs(delta) < 0.001:
        # Mark processed even if no weight change
        async with db_pool.acquire() as conn:
            await conn.execute("UPDATE context_feedback SET processed=TRUE WHERE id=$1", fb_id)
        return

    async with db_pool.acquire() as conn:
        # Find context nodes cited by this decision trace
        if req.decision_trace_id:
            cited = await conn.fetch("""
                SELECT target_node_id FROM context_edges
                WHERE source_node_id = (
                    SELECT id FROM context_nodes
                    WHERE external_id=$1 AND node_type IN ('decision','mistake')
                    LIMIT 1
                ) AND edge_type IN ('cites','used_in_decision')
            """, req.decision_trace_id)

            node_ids = [str(r["target_node_id"]) for r in cited]

            if node_ids:
                # EXISTING: Clamp weights to [0.1, 2.0]
                await conn.execute("""
                    UPDATE context_nodes
                    SET importance_weight = GREATEST(0.1, LEAST(2.0, importance_weight + $1)),
                        updated_at = NOW()
                    WHERE id = ANY($2)
                """, delta, node_ids)

                # EXISTING: Update quality scores on context_index entries
                await conn.execute("""
                    UPDATE context_index
                    SET quality_score = GREATEST(0.1, LEAST(2.0, quality_score + $1)),
                        last_updated  = NOW()
                    WHERE source_node_ids && $2::uuid[]
                """, delta, node_ids)

        # NEW: For corrections — create a permanent 'correction' graph node (21 CFR Part 11)
        if signal_type == "correction" and req.decision_trace_id:
            correction_payload = req.feedback_value.get("correction_payload") or {}
            correction_node_id = await _upsert_node(
                conn, "correction", f"correction::{fb_id}",
                req.org_id, None,
                f"Correction by {req.submitted_by}",
                {
                    "corrected_text": correction_payload.get("corrected_answer", req.feedback_value.get("corrected_text", "")),
                    "expected_value": correction_payload.get("expected_value"),
                    "corrected_ranking": correction_payload.get("corrected_ranking"),
                    "corrected_mapping": correction_payload.get("corrected_mapping"),
                    "targeted_stage": correction_payload.get("targeted_stage"),
                    "targeted_reasoning_step": correction_payload.get("targeted_reasoning_step"),
                    "reason":         req.feedback_value.get("reason", ""),
                    "feedback_category": req.feedback_value.get("feedback_category", "other"),
                    "validation_result": req.feedback_value.get("validation_result", {}),
                    "author_id":      req.submitted_by,
                    "feedback_id":    fb_id,
                    # 21 CFR Part 11 required audit fields:
                    "system_entry_timestamp": datetime.now(timezone.utc).isoformat(),
                    "feedback_type":  req.feedback_type,
                    "feedback_signal_type": signal_type,
                }
            )
            # corrects edge: correction_node → decision_node
            decision_node = await conn.fetchrow("""
                SELECT id FROM context_nodes
                WHERE external_id=$1 AND node_type IN ('decision','mistake')
                LIMIT 1
            """, req.decision_trace_id)
            if decision_node:
                await _upsert_edge(conn, correction_node_id, str(decision_node["id"]),
                                   "corrects", metadata={"fb_id": fb_id})

        await conn.execute("UPDATE context_feedback SET processed=TRUE WHERE id=$1", fb_id)

    # Bust bias cache so next retrieval picks up the new correction signal
    study_id_for_cache = getattr(req, "study_id", None)
    await _redis_delete(f"ctx_bias:{req.org_id}:{study_id_for_cache or 'null'}")

    log.info("feedback.processed", fb_id=fb_id, delta=delta, type=req.feedback_type)


# ─── Retrieval API (scoped, pack-aware) ───────────────────────────────────────

class RetrievalRequest(BaseModel):
    query: str
    org_id: str
    study_id: Optional[str]         = None
    installation_id: Optional[str]  = None
    agent_run_id: Optional[str]     = None   # when set, writes RetrievalRecipe to Neo4j
    top_k: int                       = Field(default=8, le=20)
    max_tokens: int                  = Field(default=4000, le=16000)
    include_framing: bool            = False
    context_types: list[str]         = Field(default_factory=list)
    base_prompt: str                 = ""
    document_ids: list[str]          = Field(default_factory=list)


@app.post("/retrieval/query")
async def retrieval_query(req: RetrievalRequest):
    """
    Scoped, bias-corrected, pack-assembled retrieval.
    Replaces /context/query for agent-driven calls.
    Always enforces scope policy, applies decision-trace bias, and returns
    a deterministic, cacheable context pack.
    """
    engine = RetrievalEngine(db_pool)

    # Sanitize study_id — must be a valid UUID for DB queries; drop it if not
    study_id = req.study_id
    if study_id:
        try:
            uuid.UUID(study_id)
        except (ValueError, AttributeError):
            study_id = None

    # Step 1: Resolve scope (permissions + bias from decision history)
    scope = await engine.resolve_scope(req.installation_id, req.org_id, study_id)
    scope.max_tokens = req.max_tokens

    # Override in_scope_doc_ids when caller provides explicit document IDs
    if req.document_ids:
        scope.in_scope_doc_ids = req.document_ids

    # Step 2: Canonicalize query
    canonical_query = await engine._canonicalize_query(req.query, req.org_id)
    if canonical_query != req.query:
        log.info("retrieval.query_canonicalized",
                 original=req.query, canonical=canonical_query)

    # Step 3: Embed
    vecs = await _embed([canonical_query])
    query_vec = vecs[0] if vecs and vecs[0] else None

    # Step 4: Cache-first full pipeline
    pack = await engine.get_or_create_pack(
        scope, canonical_query, query_vec,
        top_k=req.top_k, context_types=req.context_types)

    response: dict = {
        "query":          canonical_query,
        "original_query": req.query,
        "pack_hash":      pack.pack_hash,
        "from_cache":     pack.from_cache,
        "chunks":         pack.chunks,
        "sources_cited":  pack.sources_cited,
        "context_node_ids": [c.get("node_id") for c in pack.chunks if c.get("node_id")],
        "scope_summary":  pack.scope_summary,
        "search_method":  "retrieval_engine",
        "token_estimate": pack.token_estimate,
    }

    if req.include_framing and req.base_prompt:
        response["framed_prompt"] = engine._frame_prompt(pack, scope, req.base_prompt)

    # ── Neo4j: RetrievalRecipe node (only when caller provides a run context) ──
    if req.agent_run_id and pack.pack_hash:
        asyncio.ensure_future(_neo4j_run("""
            MERGE (run:AgentRun {id: $run_id})
              ON CREATE SET run.org_id = $org_id
            MERGE (rr:RetrievalRecipe {id: $pack_hash})
              ON CREATE SET rr.org_id        = $org_id,
                            rr.query_preview = $query_preview,
                            rr.sources_count = $count,
                            rr.method        = $method,
                            rr.created_at    = $created_at
            MERGE (run)-[:USED_RECIPE]->(rr)
        """, {
            "run_id": req.agent_run_id, "org_id": str(req.org_id),
            "pack_hash": pack.pack_hash,
            "query_preview": canonical_query[:120],
            "count": len(pack.chunks),
            "method": "retrieval_engine",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }))

    return response


# ─── Neo4j Score / SkillInvocation recording ─────────────────────────────────

class ScoreRequest(BaseModel):
    run_id: str
    org_id: str
    study_id: Optional[str]          = None
    faithfulness_score: float        = 0.0
    reasoning_score: float           = 0.0
    judge_verdict: str               = "unknown"
    hallucination_detected: bool     = False


@app.post("/scores", status_code=201)
async def record_score(req: ScoreRequest):
    """Write a lightweight Score node to Neo4j (Postgres write stays in agent-runtime)."""
    score_id = str(uuid.uuid4())
    await _neo4j_run("""
        MERGE (run:AgentRun {id: $run_id})
          ON CREATE SET run.org_id = $org_id, run.study_id = $study_id
        MERGE (sc:Score {id: $score_id})
          ON CREATE SET sc.org_id                = $org_id,
                        sc.faithfulness           = $faithfulness,
                        sc.reasoning_score        = $reasoning,
                        sc.judge_verdict          = $verdict,
                        sc.hallucination_detected = $hallucination,
                        sc.created_at             = $created_at
        MERGE (run)-[:HAS_SCORE]->(sc)
    """, {
        "run_id": req.run_id, "org_id": str(req.org_id),
        "study_id": req.study_id, "score_id": score_id,
        "faithfulness": req.faithfulness_score,
        "reasoning": req.reasoning_score,
        "verdict": req.judge_verdict,
        "hallucination": req.hallucination_detected,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    log.info("neo4j.score_recorded", score_id=score_id, run_id=req.run_id)
    return {"score_id": score_id}


class SkillInvocationRequest(BaseModel):
    run_id: str
    org_id: str
    skill_id: str
    skill_name: str
    skill_type: str   # function | prompt


@app.post("/graph/skill-invocation", status_code=201)
async def record_skill_invocation(req: SkillInvocationRequest):
    """Record a skill invocation in Neo4j and link PromptTemplate for prompt skills."""
    inv_id = str(uuid.uuid4())
    await _neo4j_run("""
        MERGE (run:AgentRun {id: $run_id})
          ON CREATE SET run.org_id = $org_id
        MERGE (si:SkillInvocation {id: $inv_id})
          ON CREATE SET si.org_id     = $org_id,
                        si.skill_id   = $skill_id,
                        si.skill_name = $skill_name,
                        si.skill_type = $skill_type,
                        si.created_at = $created_at
        MERGE (run)-[:INVOKED_SKILL]->(si)
    """, {
        "run_id": req.run_id, "org_id": str(req.org_id),
        "inv_id": inv_id, "skill_id": req.skill_id,
        "skill_name": req.skill_name, "skill_type": req.skill_type,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    if req.skill_type == "prompt":
        await _neo4j_run("""
            MERGE (pt:PromptTemplate {id: $skill_id})
              ON CREATE SET pt.org_id     = $org_id,
                            pt.name       = $skill_name,
                            pt.skill_type = 'prompt'
            MERGE (si:SkillInvocation {id: $inv_id})-[:USES_TEMPLATE]->(pt)
        """, {"skill_id": req.skill_id, "org_id": str(req.org_id),
              "skill_name": req.skill_name, "inv_id": inv_id})
    log.info("neo4j.skill_invocation_recorded", inv_id=inv_id, run_id=req.run_id)
    return {"invocation_id": inv_id}


# ─── Neo4j Run Graph endpoint ─────────────────────────────────────────────────

@app.get("/graph/run/{run_id}")
async def get_run_graph(run_id: str, org_id: str):
    """
    Return the full reasoning subgraph for an agent run from Neo4j.
    Response shape mirrors /graph/document/{id}: {nodes, edges}.
    """
    rows = await _neo4j_run("""
        MATCH (run:AgentRun {id: $run_id})
        OPTIONAL MATCH (run)-[:HAS_DECISION]->(dt:DecisionTrace)
        OPTIONAL MATCH (run)-[:HAS_SCORE]->(sc:Score)
        OPTIONAL MATCH (run)-[:HAS_FEEDBACK]->(fb:Feedback)
        OPTIONAL MATCH (run)-[:USED_RECIPE]->(rr:RetrievalRecipe)
        OPTIONAL MATCH (run)-[:INVOKED_SKILL]->(si:SkillInvocation)
        OPTIONAL MATCH (si)-[:USES_TEMPLATE]->(pt:PromptTemplate)
        OPTIONAL MATCH (fb)-[:CORRECTS]->(corr_dt:DecisionTrace)
        OPTIONAL MATCH (dt)-[:USED_IN_DECISION]->(ch:Chunk)
        RETURN run,
               collect(DISTINCT dt)      AS decisions,
               collect(DISTINCT sc)      AS scores,
               collect(DISTINCT fb)      AS feedbacks,
               collect(DISTINCT rr)      AS recipes,
               collect(DISTINCT si)      AS skills,
               collect(DISTINCT pt)      AS templates,
               collect(DISTINCT corr_dt) AS corrected,
               collect(DISTINCT ch)      AS chunks
    """, {"run_id": run_id})

    if not rows or rows[0].get("run") is None:
        return {"nodes": [], "edges": []}

    row = rows[0]
    nodes: list = []
    edges: list = []
    seen_node_ids: set = set()

    def _add_node(node_obj, node_type: str, importance: float = 1.0):
        if node_obj is None:
            return None
        props = dict(node_obj)
        nid = props.get("id")
        if not nid or nid in seen_node_ids:
            return nid
        seen_node_ids.add(nid)
        nodes.append({
            "id": nid,
            "node_type": node_type,
            "label": props.get("label") or props.get("skill_name") or props.get("name") or node_type,
            "metadata": {k: v for k, v in props.items() if k not in ("id", "label")},
            "importance": importance,
        })
        return nid

    run_id_node = _add_node(row["run"], "agent_run", 1.0)
    for dt in (row["decisions"] or []):
        dt_id = _add_node(dt, "decision_trace", 0.9)
        if run_id_node and dt_id:
            edges.append({"source": run_id_node, "target": dt_id, "type": "HAS_DECISION", "weight": 1.0})
    for sc in (row["scores"] or []):
        sc_id = _add_node(sc, "score", 0.85)
        if run_id_node and sc_id:
            edges.append({"source": run_id_node, "target": sc_id, "type": "HAS_SCORE", "weight": 1.0})
    for fb in (row["feedbacks"] or []):
        fb_id_node = _add_node(fb, "feedback", 0.8)
        if run_id_node and fb_id_node:
            edges.append({"source": run_id_node, "target": fb_id_node, "type": "HAS_FEEDBACK", "weight": 1.0})
    for rr in (row["recipes"] or []):
        rr_id = _add_node(rr, "retrieval_recipe", 0.75)
        if run_id_node and rr_id:
            edges.append({"source": run_id_node, "target": rr_id, "type": "USED_RECIPE", "weight": 1.0})
    for si in (row["skills"] or []):
        si_id = _add_node(si, "skill_invocation", 0.8)
        if run_id_node and si_id:
            edges.append({"source": run_id_node, "target": si_id, "type": "INVOKED_SKILL", "weight": 1.0})
    for pt in (row["templates"] or []):
        pt_id = _add_node(pt, "prompt_template", 0.7)
        # link each template to the skill invocation that uses it
        for si in (row["skills"] or []):
            si_props = dict(si) if si else {}
            if si_props.get("skill_id") == (dict(pt) if pt else {}).get("id") and pt_id:
                si_id_ref = si_props.get("id")
                if si_id_ref and pt_id:
                    edges.append({"source": si_id_ref, "target": pt_id, "type": "USES_TEMPLATE", "weight": 1.0})
    # CORRECTS edges: Feedback → DecisionTrace
    fb_nodes_map = {dict(fb).get("id"): dict(fb) for fb in (row["feedbacks"] or []) if fb}
    for corr_dt in (row["corrected"] or []):
        corr_dt_id = _add_node(corr_dt, "decision_trace", 0.9)
        for fb in (row["feedbacks"] or []):
            fb_props = dict(fb) if fb else {}
            fb_id_val = fb_props.get("id")
            if fb_id_val and corr_dt_id:
                edges.append({"source": fb_id_val, "target": corr_dt_id, "type": "CORRECTS", "weight": 1.0})
    # USED_IN_DECISION: DecisionTrace → Chunk (lightweight refs)
    for ch in (row["chunks"] or []):
        ch_id = _add_node(ch, "chunk", 0.6)
        # link to any decision trace (will show all dt→chunk edges)
        for dt in (row["decisions"] or []):
            dt_props = dict(dt) if dt else {}
            dt_id_val = dt_props.get("id")
            if dt_id_val and ch_id:
                edges.append({"source": dt_id_val, "target": ch_id, "type": "USED_IN_DECISION", "weight": 0.8})

    return {"nodes": nodes, "edges": edges, "run_id": run_id}


# ─── Dataset Statistics (deterministic, no vector search) ─────────────────────

class DatasetStatsRequest(BaseModel):
    org_id: str
    study_id: Optional[str] = None


@app.post("/retrieval/dataset_stats")
async def get_dataset_stats(req: DatasetStatsRequest):
    """Return pre-computed statistics chunks directly from document_chunks.
    No vector search, no LLM — purely deterministic row/patient count lookup."""
    if db_pool is None:
        raise HTTPException(status_code=503, detail="Database not available")
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT dc.content, dc.section, d.name AS doc_name
            FROM document_chunks dc
            JOIN documents d ON d.id = dc.document_id
            WHERE d.org_id = $1
              AND ($2::text IS NULL OR d.study_id = $2 OR d.study_id IS NULL)
              AND dc.section LIKE '% Statistics'
            ORDER BY d.name, dc.section
            """,
            req.org_id, req.study_id,
        )
    return {
        "datasets": [
            {"doc_name": r["doc_name"], "section": r["section"], "content": r["content"]}
            for r in rows
        ]
    }


# ─── Domain Aggregation (top N variable values, SQL-based) ────────────────────

class DomainAggregationRequest(BaseModel):
    org_id: str
    study_id: Optional[str] = None
    domain: str          # SDTM domain, e.g. "AE"
    variable: Optional[str] = None   # single variable (legacy); if omitted, variables list is used
    variables: Optional[List[str]] = None  # list of variables to aggregate, e.g. ["AETERM", "USUBJID", "AESEV"]
    top_n: int = 10
    # Filtered aggregation: count `variable` only for rows where filter_field=filter_value
    filter_field: Optional[str] = None   # e.g. "AESEV"
    filter_value: Optional[str] = None  # e.g. "SEVERE"


# Y/N flag variables — single character values
_YN_VARIABLES = {"AESDTH", "AESER", "AESLIFE", "AESCONG", "AESDISAB", "AESHOSP", "AESMIE"}


async def _aggregate_filtered(conn, domain: str, variable: str, filter_field: str, filter_value: str,
                               org_id: str, study_id: Optional[str], top_n: int) -> str:
    """Count `variable` values only for rows where `filter_field`=`filter_value` (line-level filter)."""
    if variable in _YN_VARIABLES:
        val_pattern = f"{variable}=([YN])"
    elif variable == "USUBJID":
        val_pattern = r"USUBJID=([0-9]{2}-[0-9]{3}-[0-9]{4})"
    else:
        val_pattern = f"{variable}=([A-Z0-9][A-Z0-9 /,()\\-]+?)  "
    rows = await conn.fetch(
        """
        SELECT trim((regexp_matches(line, $1))[1]) AS value,
               COUNT(*) AS frequency
        FROM document_chunks dc
        JOIN documents d ON d.id = dc.document_id,
             unnest(string_to_array(dc.content, E'\\n')) AS line
        WHERE d.org_id = $2
          AND ($3::text IS NULL OR d.study_id = $3 OR d.study_id IS NULL)
          AND dc.section LIKE $4
          AND line LIKE $5
          AND line ~ $1
        GROUP BY value
        ORDER BY frequency DESC
        LIMIT $6
        """,
        val_pattern, org_id, study_id,
        f"{domain} rows%", f"%{filter_field}={filter_value}%", top_n,
    )
    results = [{"value": r["value"], "count": int(r["frequency"])} for r in rows if r["value"]]
    if not results:
        return ""
    # Q&A format so small LLMs can't confuse these pre-computed answers with raw distributions
    _qa_templates = {
        ("AETERM", "AESEV", "SEVERE"):  ("Q: Which adverse event (AETERM) has the most SEVERE cases?",
                                          "A: {top_value} — {top_count} severe occurrence(s) (AESEV=SEVERE)"),
        ("AETERM", "AESER", "Y"):       ("Q: Which adverse event (AETERM) is most commonly a SERIOUS AE?",
                                          "A: {top_value} — {top_count} serious occurrence(s) (AESER=Y)"),
        ("USUBJID", "AESEV", "SEVERE"): ("Q: Which patients had the most SEVERE adverse events?",
                                          "A: {top_value} — {top_count} severe AE(s)"),
        ("USUBJID", "AESER", "Y"):      ("Q: Which patients had the most SERIOUS adverse events?",
                                          "A: {top_value} — {top_count} serious AE(s)"),
    }
    key = (variable, filter_field, filter_value)
    if key == ("AETERM", "AESDTH", "Y"):
        # Build a self-contained A: line listing ALL death AEs so the LLM doesn't need the ranked list
        names = [r["value"] for r in results]
        if len(names) == 1:
            a_line = f"A: {names[0]} — 1 adverse event resulted in death (AESDTH=Y)"
        else:
            joined = ", ".join(names)
            a_line = f"A: {len(names)} adverse events resulted in death (AESDTH=Y): {joined}"
        lines = [
            "Q: Which adverse events resulted in DEATH (AESDTH=Y)? / reasons for death / deceased patients",
            a_line,
            "Full ranked list:",
        ]
    elif key in _qa_templates:
        q_line, a_line = _qa_templates[key]
        top = results[0]
        lines = [
            q_line,
            a_line.format(top_value=top["value"], top_count=top["count"]),
            f"Full ranked list:",
        ]
    else:
        lines = [f"Top {variable} values where {filter_field}={filter_value}:"]
    for i, r in enumerate(results, 1):
        lines.append(f"  {i}. {r['value']} — {r['count']} occurrence(s)")
    return "\n".join(lines)

async def _aggregate_one_variable(conn, domain: str, variable: str, org_id: str, study_id: Optional[str], top_n: int) -> str:
    """Run aggregation for a single variable and return a human-readable block."""
    if variable == "USUBJID":
        pattern = r"USUBJID=([0-9]{2}-[0-9]{3}-[0-9]{4})"
    elif variable in _YN_VARIABLES:
        # Y/N flag fields — single character value followed by space or end-of-field
        pattern = f"{variable}=([YN])"
    else:
        pattern = f"{variable}=([A-Z0-9][A-Z0-9 /,()\\-]+?)  "
    rows = await conn.fetch(
        """
        SELECT
            trim((regexp_matches(dc.content, $1, 'g'))[1]) AS value,
            COUNT(*) AS frequency
        FROM document_chunks dc
        JOIN documents d ON d.id = dc.document_id
        WHERE d.org_id = $2
          AND ($3::text IS NULL OR d.study_id = $3 OR d.study_id IS NULL)
          AND dc.section LIKE $4
        GROUP BY value
        ORDER BY frequency DESC
        LIMIT $5
        """,
        pattern, org_id, study_id,
        f"{domain} rows%", top_n,
    )
    results = [{"value": r["value"], "count": int(r["frequency"])} for r in rows]
    if not results:
        return f"No {variable} data found for domain {domain}."

    # For Y/N flag variables, produce a direct factual statement instead of a table
    _yn_meanings = {
        "AESDTH": ("resulted in death",        "DID result in death",    "did NOT result in death"),
        "AESER":  ("was a serious AE",          "were SERIOUS",           "were NOT serious"),
        "AESLIFE": ("was life-threatening",     "were LIFE-THREATENING",  "were NOT life-threatening"),
        "AESHOSP": ("required hospitalisation", "required HOSPITALISATION","did NOT require hospitalisation"),
    }
    if variable in _yn_meanings:
        desc, yes_label, no_label = _yn_meanings[variable]
        counts = {r["value"]: r["count"] for r in results}
        y_count = counts.get("Y", 0)
        n_count = counts.get("N", 0)
        answer = "YES" if y_count > 0 else "NO"
        return (
            f"FACT — {variable} ({desc}) in SDTM {domain} domain:\n"
            f"  {answer}, there are {y_count} adverse event record(s) that {yes_label} (AESDTH=Y).\n"
            f"  {n_count} adverse event record(s) {no_label} (AESDTH=N)."
        ).replace("AESDTH=Y", f"{variable}=Y").replace("AESDTH=N", f"{variable}=N")

    if variable == "USUBJID":
        label = "patients by AE count (most adverse events)"
    elif variable == "AESEV":
        # Rename to avoid confusion with "which AE is most severe"
        label = "severity level distribution (MILD/MODERATE/SEVERE — not AE term names)"
    else:
        label = f"{variable} values"
    lines = [f"Top {len(results)} {label} in SDTM {domain} domain:"]
    for i, r in enumerate(results, 1):
        lines.append(f"  {i}. {r['value']} — {r['count']} occurrences")
    return "\n".join(lines)


@app.post("/retrieval/domain_aggregation")
async def get_domain_aggregation(req: DomainAggregationRequest):
    """Aggregate top N values for one or more variables across all row chunks of a domain.
    Uses regex on document_chunks text — no need for a separate SDTM table."""
    if db_pool is None:
        raise HTTPException(status_code=503, detail="Database not available")
    domain = req.domain.upper()

    # Determine which variables to aggregate
    if req.variables:
        var_list = [v.upper() for v in req.variables]
    elif req.variable:
        var_list = [req.variable.upper()]
    else:
        # Default: run key AE aggregations (AESEV omitted — covered by cross-tab ANSWER blocks)
        var_list = ["AETERM", "USUBJID", "AEBODSYS", "AESDTH", "AESER"]

    # Filtered aggregation (e.g. top AETERM where AESEV=SEVERE)
    if req.filter_field and req.filter_value:
        async with db_pool.acquire() as conn:
            summary = await _aggregate_filtered(
                conn, domain, var_list[0] if var_list else "AETERM",
                req.filter_field.upper(), req.filter_value.upper(),
                req.org_id, req.study_id, req.top_n
            )
        return {"domain": domain, "variables": var_list, "filter": f"{req.filter_field.upper()}={req.filter_value.upper()}", "summary": summary or "No results found."}

    async with db_pool.acquire() as conn:
        cross_blocks = []
        std_blocks = []
        # For AE domain: pre-compute cross-tabulations FIRST (they answer specific clinical questions)
        if domain == "AE":
            for ff, fv in [("AESEV", "SEVERE"), ("AESER", "Y"), ("AESDTH", "Y")]:
                cross = await _aggregate_filtered(
                    conn, domain, "AETERM", ff, fv,
                    req.org_id, req.study_id, req.top_n
                )
                if cross:
                    cross_blocks.append(cross)
        for var in var_list:
            block = await _aggregate_one_variable(conn, domain, var, req.org_id, req.study_id, req.top_n)
            std_blocks.append(block)

    summary = "\n\n".join(cross_blocks + std_blocks)
    return {"domain": domain, "variables": var_list, "summary": summary}


# ─── Domain Record Lookup (first/last event by date field) ─────────────────────

class DomainRecordLookupRequest(BaseModel):
    org_id: str
    study_id: Optional[str] = None
    domain: str          # SDTM domain, e.g. "AE"
    date_field: str      # e.g. "AESTDTC", "AEENDTC"
    order: str = "ASC"   # ASC = earliest, DESC = latest
    limit: int = 3
    # Extra fields to extract in addition to date_field and USUBJID
    extra_fields: List[str] = ["AETERM", "AESEV", "AESDTH"]


@app.post("/retrieval/domain_record_lookup")
async def domain_record_lookup(req: DomainRecordLookupRequest):
    """Find the first or last N records in a domain sorted by a date field.
    Extracts USUBJID, the date field, and any extra fields from the raw chunk text."""
    if db_pool is None:
        raise HTTPException(status_code=503, detail="Database not available")
    domain = req.domain.upper()
    date_field = req.date_field.upper()
    order = "ASC" if req.order.upper() != "DESC" else "DESC"
    date_pattern = f"{date_field}=([0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}})"

    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT
                (regexp_matches(dc.content, $1))[1]                             AS date_val,
                (regexp_matches(dc.content, $2))[1]                             AS usubjid,
                dc.content
            FROM document_chunks dc
            JOIN documents d ON d.id = dc.document_id
            WHERE d.org_id = $3
              AND ($4::text IS NULL OR d.study_id = $4 OR d.study_id IS NULL)
              AND dc.section LIKE $5
              AND dc.content ~ $1
            ORDER BY date_val {order}
            LIMIT $6
            """,
            date_pattern,
            r"USUBJID=([0-9]{2}-[0-9]{3}-[0-9]{4})",
            req.org_id, req.study_id,
            f"{domain} rows%", req.limit,
        )

    def _extract(content: str, field: str) -> str:
        import re
        m = re.search(rf"{field}=([A-Z0-9][A-Z0-9 /,().:-]{{0,60}}?)  ", content)
        if m:
            return m.group(1).strip()
        # For date fields
        m = re.search(rf"{field}=([0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}})", content)
        return m.group(1) if m else "unknown"

    records = []
    for r in rows:
        rec: dict = {"date": r["date_val"], "USUBJID": r["usubjid"]}
        for f in req.extra_fields:
            rec[f] = _extract(r["content"], f.upper())
        records.append(rec)

    if not records:
        return {"domain": domain, "records": [], "summary": f"No records with {date_field} found in {domain} domain."}

    label = "earliest" if order == "ASC" else "latest"
    lines = [f"The {label} {domain} record(s) by {date_field}:"]
    for i, rec in enumerate(records, 1):
        detail = ", ".join(f"{k}={v}" for k, v in rec.items())
        lines.append(f"  {i}. {detail}")
    summary = "\n".join(lines)
    return {"domain": domain, "date_field": date_field, "order": order, "records": records, "summary": summary}


# ─── Domain Subject Set-Difference ────────────────────────────────────────────

class DomainSubjectsDiffRequest(BaseModel):
    org_id: str
    study_id: Optional[str] = None
    primary_domain: str    # e.g. "DM" — the domain whose subjects form the full set
    exclude_domain: str    # e.g. "AE" — subjects present here are excluded


@app.post("/retrieval/domain_subjects_diff")
async def domain_subjects_diff(req: DomainSubjectsDiffRequest):
    """
    Return ALL USUBJIDs that appear in primary_domain but NOT in exclude_domain.
    Used for questions like 'list all subjects who don't have any adverse events'.
    Scans document_chunks via regex — same approach as the rest of the retrieval layer.
    """
    if db_pool is None:
        raise HTTPException(status_code=503, detail="Database not available")

    primary = req.primary_domain.upper()
    exclude = req.exclude_domain.upper()
    # USUBJID pattern: NN-NNN-NNNN (standard CDISC format)
    usubjid_re = r"USUBJID=([0-9]{2}-[0-9]{3}-[0-9]{4})"

    async def _fetch_subjects(domain: str) -> set:
        import re as _re
        async with db_pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT dc.content
                FROM document_chunks dc
                JOIN documents d ON d.id = dc.document_id
                WHERE d.org_id = $1
                  AND ($2::text IS NULL OR d.study_id = $2 OR d.study_id IS NULL)
                  AND dc.section LIKE $3
                  AND dc.content ~ $4
                """,
                req.org_id, req.study_id, f"{domain} rows%", usubjid_re,
            )
        subjects: set = set()
        for r in rows:
            for m in _re.finditer(usubjid_re, r["content"]):
                subjects.add(m.group(1))
        return subjects

    primary_subjects = await _fetch_subjects(primary)
    exclude_subjects = await _fetch_subjects(exclude)
    diff = sorted(primary_subjects - exclude_subjects)

    if not diff:
        summary = (
            f"All {len(primary_subjects)} subjects in the {primary} domain "
            f"also appear in the {exclude} domain. No subjects found exclusively in {primary}."
        )
    else:
        subject_list = "\n".join(f"  {i+1}. {s}" for i, s in enumerate(diff))
        summary = (
            f"Subjects in {primary} domain (cdisc_{primary.lower()}.xpt) "
            f"with NO records in {exclude} domain (cdisc_{exclude.lower()}.xpt) "
            f"— {len(diff)} subject(s) out of {len(primary_subjects)} total:\n"
            f"{subject_list}"
        )

    return {
        "primary_domain": primary,
        "exclude_domain": exclude,
        "primary_count": len(primary_subjects),
        "exclude_count": len(exclude_subjects),
        "diff_count": len(diff),
        "subjects": diff,
        "summary": summary,
    }


# ─── Graph Sync / Drift Endpoints ─────────────────────────────────────────────

class SyncChunksRequest(BaseModel):
    document_id: str
    org_id: str
    study_id: Optional[str] = None


@app.post("/graph/sync-chunks", status_code=202)
async def sync_chunk_nodes(req: SyncChunksRequest, background_tasks: BackgroundTasks):
    """Idempotent: upsert context_nodes for any document_chunks without a node."""
    background_tasks.add_task(_sync_chunk_nodes, req.document_id, req.org_id, req.study_id)
    return {"status": "queued", "document_id": req.document_id}


@app.post("/graph/drift-check", status_code=202)
async def trigger_drift_check(org_id: str, background_tasks: BackgroundTasks):
    """Manually trigger indexing drift detection for an org."""
    background_tasks.add_task(_check_indexing_drift, org_id)
    return {"status": "queued", "org_id": org_id}


@app.get("/graph/drift-report")
async def drift_report(org_id: str = Query(...)):
    """Return documents with indexing drift above threshold."""
    async with db_pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT dis.document_id, d.name AS document_name, dis.org_id,
                   dis.indexed_chunks_count, dis.total_chunks_count,
                   dis.drift_score, dis.needs_reindex,
                   dis.last_checked_at, dis.last_indexed_at
            FROM document_index_state dis
            JOIN documents d ON d.id = dis.document_id
            WHERE dis.org_id=$1::uuid AND dis.drift_score > 0.1
            ORDER BY dis.drift_score DESC
            LIMIT 50
        """, org_id)
    return {"org_id": org_id, "documents": [dict(r) for r in rows]}


# ─── Canonicalization Endpoint ────────────────────────────────────────────────

class CanonicalizeRequest(BaseModel):
    org_id: str
    canonical_form: str
    entity_type: str
    aliases: list[str]


@app.post("/graph/canonicalize", status_code=201)
async def add_canonical_mapping(req: CanonicalizeRequest):
    """Add or extend an alias mapping in entity_canonical_map."""
    async with db_pool.acquire() as conn:
        await conn.execute("""
            INSERT INTO entity_canonical_map (org_id, canonical_form, entity_type, aliases)
            VALUES ($1::uuid, $2, $3, $4)
            ON CONFLICT (org_id, canonical_form, entity_type)
            DO UPDATE SET aliases = ARRAY(
                SELECT DISTINCT unnest(entity_canonical_map.aliases || EXCLUDED.aliases)
            ), updated_at = NOW()
        """, req.org_id, req.canonical_form, req.entity_type, req.aliases)
    return {"status": "ok", "canonical_form": req.canonical_form,
            "entity_type": req.entity_type, "aliases": req.aliases}


# ─── Trace Graph Endpoint (21 CFR audit view) ─────────────────────────────────

@app.get("/graph/pack-log")
async def get_pack_log(org_id: str = Query(...),
                        study_id: Optional[str] = Query(None),
                        limit: int = Query(20)):
    """Return recent context pack log entries for debugging."""
    async with db_pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT id, pack_hash, query_text, token_count, scope_policy, cache_hit, created_at
            FROM context_pack_log
            WHERE org_id=$1::uuid
              AND ($2::uuid IS NULL OR study_id=$2::uuid)
            ORDER BY created_at DESC
            LIMIT $3
        """, org_id, study_id, limit)
    return {"packs": [dict(r) for r in rows]}


@app.get("/traces/{run_id}/graph")
async def get_trace_graph(run_id: str, org_id: str = Query(...)):
    """
    Return the full decision subgraph for a run — for 21 CFR Part 11 audit UI.
    Includes: decision/mistake nodes, correction nodes, chunk nodes, all edges.
    """
    async with db_pool.acquire() as conn:
        # Find all decision/mistake nodes for this run
        run_node = await conn.fetchrow("""
            SELECT id FROM context_nodes WHERE external_id=$1 AND node_type='agent_run'
        """, run_id)
        if not run_node:
            raise HTTPException(404, "No graph nodes found for this run")

        # Get all nodes reachable within 2 hops from the run node
        nodes_rows = await conn.fetch("""
            WITH run_decisions AS (
                SELECT cn.id, cn.node_type, cn.label, cn.metadata, cn.created_at
                FROM context_nodes cn
                JOIN context_edges ce ON ce.source_node_id = cn.id
                WHERE ce.target_node_id = $1
                  AND ce.edge_type = 'produced_by'
            ),
            related AS (
                SELECT cn.id, cn.node_type, cn.label, cn.metadata, cn.created_at
                FROM context_edges ce
                JOIN run_decisions rd ON rd.id = ce.source_node_id OR rd.id = ce.target_node_id
                JOIN context_nodes cn ON cn.id = CASE
                    WHEN ce.source_node_id = rd.id THEN ce.target_node_id
                    ELSE ce.source_node_id
                END
            )
            SELECT * FROM run_decisions
            UNION ALL
            SELECT * FROM related
        """, run_node["id"])

        node_ids = [r["id"] for r in nodes_rows]
        edges_rows = await conn.fetch("""
            SELECT id, source_node_id, target_node_id, edge_type, weight, metadata, created_at
            FROM context_edges
            WHERE source_node_id = ANY($1) OR target_node_id = ANY($1)
        """, node_ids)

    return {
        "run_id": run_id,
        "nodes": [dict(r) for r in nodes_rows],
        "edges": [dict(r) for r in edges_rows],
    }


# ─── Document Classification Endpoints ───────────────────────────────────────

class ClassifyDocumentRequest(BaseModel):
    document_id: str
    text_excerpt: str
    filename: str
    org_id: str
    study_id: Optional[str] = None


@app.post("/classify", status_code=201)
async def classify_document(req: ClassifyDocumentRequest, background_tasks: BackgroundTasks):
    """Auto-detect document type and create pending_classification if uncertain."""
    result = await detect_document_type(req.text_excerpt, req.filename)

    detected_type = result.get("detected_type", "unknown")
    confidence    = float(result.get("confidence", 0.0))

    if confidence >= settings.min_type_confidence and detected_type != "unknown":
        # High confidence — update document directly
        async with db_pool.acquire() as conn:
            await conn.execute(
                "UPDATE documents SET document_type=$1 WHERE id=$2",
                detected_type, req.document_id
            )
        return {
            "status": "classified",
            "document_type": detected_type,
            "confidence": confidence,
            "metadata": result.get("metadata_extracted", {}),
        }

    # Low confidence → create pending classification for user review
    suggested = [detected_type] + [a["type"] for a in result.get("alternative_types", [])]
    conf_scores = {detected_type: confidence}
    for alt in result.get("alternative_types", []):
        conf_scores[alt["type"]] = alt.get("confidence", 0.0)

    async with db_pool.acquire() as conn:
        await conn.execute("""
            INSERT INTO pending_classifications
                (document_id, org_id, auto_detected_hints, llm_analysis,
                 suggested_type_codes, confidence_scores, metadata_extracted)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (document_id) DO UPDATE
                SET auto_detected_hints = EXCLUDED.auto_detected_hints,
                    llm_analysis        = EXCLUDED.llm_analysis,
                    suggested_type_codes = EXCLUDED.suggested_type_codes,
                    confidence_scores   = EXCLUDED.confidence_scores,
                    metadata_extracted  = EXCLUDED.metadata_extracted
        """,
            req.document_id, req.org_id,
            json.dumps({"key_phrases": result.get("key_phrases", []),
                        "structure": result.get("structure_description", "")}),
            result.get("reasoning", "") + "\n\nAnalysis: " + result.get("structure_description", ""),
            suggested[:5], json.dumps(conf_scores),
            json.dumps(result.get("metadata_extracted", {}))
        )

    return {
        "status": "pending_classification",
        "document_id": req.document_id,
        "suggested_types": suggested[:5],
        "confidence_scores": conf_scores,
        "llm_analysis": result.get("reasoning", ""),
        "metadata_extracted": result.get("metadata_extracted", {}),
    }


@app.get("/classify/pending")
async def list_pending_classifications(org_id: str):
    """List documents awaiting manual type classification."""
    async with db_pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT pc.id, pc.document_id, d.name AS file_name, d.file_size_bytes,
                   pc.suggested_type_codes, pc.confidence_scores, pc.llm_analysis,
                   pc.metadata_extracted, pc.created_at
            FROM pending_classifications pc
            JOIN documents d ON d.id = pc.document_id
            WHERE pc.org_id=$1 AND pc.status='pending'
            ORDER BY pc.created_at DESC
        """, org_id)
    return {"pending": [dict(r) for r in rows], "count": len(rows)}


class ResolveClassificationRequest(BaseModel):
    resolved_type: str
    resolved_by: str


@app.post("/classify/{classification_id}/resolve")
async def resolve_classification(classification_id: str, req: ResolveClassificationRequest):
    """User maps pending document to a known or new document type."""
    async with db_pool.acquire() as conn:
        pc = await conn.fetchrow(
            "SELECT document_id, org_id FROM pending_classifications WHERE id=$1", classification_id
        )
        if not pc:
            raise HTTPException(404, "Classification not found")

        await conn.execute("""
            UPDATE pending_classifications
            SET status='mapped', resolved_type=$1, resolved_by=$2, resolved_at=NOW()
            WHERE id=$3
        """, req.resolved_type, req.resolved_by, classification_id)

        await conn.execute(
            "UPDATE documents SET document_type=$1 WHERE id=$2",
            req.resolved_type, str(pc["document_id"])
        )

    return {"status": "resolved", "document_type": req.resolved_type}


# ─── Graph Build Trigger ──────────────────────────────────────────────────────

class BuildGraphRequest(BaseModel):
    document_id: str
    org_id: str
    study_id: Optional[str] = None


@app.post("/graph/build")
async def trigger_graph_build(req: BuildGraphRequest, background_tasks: BackgroundTasks):
    """Trigger context graph build for a document (called by ingestion after processing)."""
    background_tasks.add_task(build_document_graph, req.document_id, req.org_id, req.study_id)
    return {"status": "queued", "document_id": req.document_id}


# ─── Lineage API ─────────────────────────────────────────────────────────────

@app.get("/lineage/{node_id}")
async def get_lineage(node_id: str, depth: int = 4):
    """Return full provenance tree for a context node (up to `depth` hops)."""
    async with db_pool.acquire() as conn:
        rows = await conn.fetch("""
            WITH RECURSIVE lineage(id, source_id, target_id, edge_type, depth, path) AS (
                SELECT gen_random_uuid(), $1::uuid, $1::uuid, 'root', 0,
                       ARRAY[$1::uuid]
                UNION ALL
                SELECT gen_random_uuid(), ce.source_node_id, ce.target_node_id,
                       ce.edge_type, l.depth+1, l.path || ce.target_node_id
                FROM context_edges ce
                JOIN lineage l ON ce.source_node_id = l.target_id
                WHERE l.depth < $2 AND NOT ce.target_node_id = ANY(l.path)
            )
            SELECT DISTINCT l.source_id, l.target_id, l.edge_type, l.depth,
                   s.label AS source_label, s.node_type AS source_type,
                   t.label AS target_label, t.node_type AS target_type
            FROM lineage l
            JOIN context_nodes s ON s.id = l.source_id
            JOIN context_nodes t ON t.id = l.target_id
            WHERE l.depth > 0
            ORDER BY l.depth
        """, node_id, depth)

    return {
        "node_id": node_id,
        "lineage": [
            {"from": {"id": str(r["source_id"]), "label": r["source_label"], "type": r["source_type"]},
             "to":   {"id": str(r["target_id"]), "label": r["target_label"], "type": r["target_type"]},
             "edge": r["edge_type"], "depth": r["depth"]}
            for r in rows
        ],
    }


# ─── Document Type Registry ───────────────────────────────────────────────────

@app.get("/document-types")
async def list_document_types(org_id: str):
    """List all known document types (system + org-custom)."""
    async with db_pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT type_code, type_name, description, is_system, detection_patterns, schema_hints
            FROM document_type_registry
            WHERE is_system=TRUE OR org_id=$1
            ORDER BY is_system DESC, type_name
        """, org_id)
    return {"types": [dict(r) for r in rows]}


@app.post("/document-types", status_code=201)
async def create_document_type(body: dict):
    """Register a new custom document type (org-level)."""
    async with db_pool.acquire() as conn:
        row_id = await conn.fetchval("""
            INSERT INTO document_type_registry
                (type_code, type_name, description, detection_patterns, schema_hints, is_system, org_id)
            VALUES ($1,$2,$3,$4,$5,FALSE,$6)
            RETURNING id
        """,
            body["type_code"], body["type_name"],
            body.get("description", ""),
            json.dumps(body.get("detection_patterns", [])),
            json.dumps(body.get("schema_hints", {})),
            body["org_id"]
        )
    return {"id": str(row_id), "type_code": body["type_code"]}


# ─── Kafka Consumer (event-driven graph updates) ──────────────────────────────

async def _kafka_consumer():
    """
    Consume events from Kafka and update context graph accordingly.
    Events handled:
      • trialo.events.data   — document.processed → build_document_graph
      • trialo.events.agents — agent_run.completed → no-op (trace recorded inline)
    """
    try:
        from aiokafka import AIOKafkaConsumer  # type: ignore
        consumer = AIOKafkaConsumer(
            "trialo.events.data",
            bootstrap_servers=settings.kafka_brokers,
            group_id="context-graph-consumer",
            value_deserializer=lambda m: json.loads(m.decode("utf-8")),
            auto_offset_reset="latest",
        )
        await consumer.start()
        log.info("kafka_consumer.started")
        try:
            async for msg in consumer:
                event = msg.value
                event_type = event.get("type") or event.get("event_type", "")
                try:
                    await _handle_kafka_event(event_type, event)
                except Exception as exc:
                    log.warning("kafka.event.error", event_type=event_type, error=str(exc))
        finally:
            await consumer.stop()
    except Exception as exc:
        log.warning("kafka_consumer.unavailable", error=str(exc))


async def _handle_kafka_event(event_type: str, payload: dict):
    """Route a Kafka event to the appropriate graph update handler."""
    if event_type == "document.processed":
        doc_id   = payload.get("document_id")
        org_id   = payload.get("org_id")
        study_id = payload.get("study_id")
        if doc_id and org_id:
            await build_document_graph(doc_id, org_id, study_id)

    # Record event for audit/replay
    async with db_pool.acquire() as conn:
        await conn.execute("""
            INSERT INTO context_events (event_type, source, payload, processed)
            VALUES ($1,$2,$3,TRUE)
        """, event_type, payload.get("source", "kafka"), json.dumps(payload))


# ─── Document Graph View ─────────────────────────────────────────────────────

@app.get("/graph/document/{document_id}")
async def get_document_graph(document_id: str, org_id: str):
    """
    Return the full context graph for a document: nodes grouped by type,
    all edges between them, and vector/index statistics.
    Used by the frontend graph visualizer.
    """
    async with db_pool.acquire() as conn:
        # 1. Document node
        doc_node = await conn.fetchrow("""
            SELECT id, node_type, label, metadata, importance_weight,
                   (embedding IS NOT NULL) AS has_embedding
            FROM context_nodes
            WHERE external_id=$1 AND node_type='document' AND org_id=$2
        """, document_id, org_id)

        if not doc_node:
            return {"nodes": [], "edges": [], "stats": {"status": "not_indexed"}}

        doc_node_id = str(doc_node["id"])

        # 2. Accurate chunk counts (no row fetch)
        total_chunks = await conn.fetchval("""
            SELECT COUNT(*) FROM context_edges
            WHERE source_node_id = $1 AND edge_type = 'contains'
        """, doc_node_id)

        embedded_chunks = await conn.fetchval("""
            SELECT COUNT(*) FROM context_nodes cn
            JOIN context_edges ce ON ce.target_node_id = cn.id
            WHERE ce.source_node_id = $1 AND ce.edge_type = 'contains'
              AND cn.embedding IS NOT NULL
        """, doc_node_id)

        # Visualization sample only (LIMIT 100)
        chunk_rows = await conn.fetch("""
            SELECT cn.id, cn.node_type, cn.label, cn.metadata, cn.importance_weight,
                   (cn.embedding IS NOT NULL) AS has_embedding
            FROM context_nodes cn
            JOIN context_edges ce ON ce.target_node_id = cn.id
            WHERE ce.source_node_id=$1 AND ce.edge_type='contains'
            ORDER BY (cn.metadata->>'chunk_index')::int NULLS LAST
            LIMIT 100
        """, doc_node_id)

        chunk_ids = [str(r["id"]) for r in chunk_rows]

        # 3. Entity nodes — extracted_from edges point to doc_node_id (not chunks).
        #    sdtm_domain nodes use 'described_in' instead of 'extracted_from'.
        entity_rows = await conn.fetch("""
            SELECT cn.id, cn.node_type, cn.label, cn.metadata, cn.importance_weight,
                   (cn.embedding IS NOT NULL) AS has_embedding
            FROM context_nodes cn
            JOIN context_edges ce ON ce.source_node_id = cn.id
            WHERE ce.target_node_id = $1
              AND ce.edge_type IN ('extracted_from', 'described_in')
            LIMIT 100
        """, doc_node_id)

        entity_ids = [str(r["id"]) for r in entity_rows]

        # 4. Concept nodes (connected via 'is_type' edges from entity nodes)
        concept_rows = []
        if entity_ids:
            concept_rows = await conn.fetch("""
                SELECT DISTINCT cn.id, cn.node_type, cn.label, cn.metadata,
                       cn.importance_weight, (cn.embedding IS NOT NULL) AS has_embedding
                FROM context_nodes cn
                JOIN context_edges ce ON ce.target_node_id = cn.id
                WHERE ce.source_node_id = ANY($1::uuid[]) AND ce.edge_type='is_type'
                LIMIT 40
            """, entity_ids)

        concept_ids = [str(r["id"]) for r in concept_rows]

        # 5. All edges between the above nodes
        all_ids = [doc_node_id] + chunk_ids + entity_ids + concept_ids
        edge_rows = await conn.fetch("""
            SELECT source_node_id, target_node_id, edge_type, weight
            FROM context_edges
            WHERE source_node_id = ANY($1::uuid[])
              AND target_node_id = ANY($1::uuid[])
        """, all_ids)

        # 6. Vector / index stats
        index_entries = await conn.fetchval("""
            SELECT COUNT(*) FROM context_index WHERE org_id=$1
        """, org_id) if doc_node else 0

        index_quality = await conn.fetchval("""
            SELECT AVG(quality_score) FROM context_index WHERE org_id=$1
        """, org_id) if doc_node else None

        indexed_node_count = await conn.fetchval("""
            SELECT COUNT(*) FROM context_nodes WHERE org_id=$1 AND embedding IS NOT NULL
        """, org_id)
        index_health = "ready" if (indexed_node_count or 0) > 100 else "insufficient_data"

        # Query actual stored dimension rather than relying on hardcoded settings
        actual_dim = await conn.fetchval("""
            SELECT vector_dims(embedding) FROM context_nodes
            WHERE org_id=$1 AND embedding IS NOT NULL LIMIT 1
        """, org_id)

    def _node(r: dict) -> dict:
        meta = r["metadata"]
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except Exception:
                meta = {}
        return {
            "id":              str(r["id"]),
            "type":            r["node_type"],
            "label":           r["label"],
            "metadata":        meta,
            "importance":      float(r["importance_weight"] or 1.0),
            "has_embedding":   r["has_embedding"],
        }

    return {
        "document_id": document_id,
        "nodes": (
            [_node(doc_node)]
            + [_node(r) for r in chunk_rows]
            + [_node(r) for r in entity_rows]
            + [_node(r) for r in concept_rows]
        ),
        "edges": [
            {
                "source": str(r["source_node_id"]),
                "target": str(r["target_node_id"]),
                "type":   r["edge_type"],
                "weight": float(r["weight"] or 1.0),
            }
            for r in edge_rows
        ],
        "stats": {
            "status":           "indexed",
            "total_chunks":     int(total_chunks or 0),
            "embedded_chunks":  int(embedded_chunks or 0),
            "chunks_capped":    int(total_chunks or 0) > 100,
            "total_entities":   len(entity_rows),
            "total_concepts":   len(concept_rows),
            "context_index_entries": int(index_entries or 0),
            "index_quality":    round(float(index_quality), 3) if index_quality else None,
            "embedding_dim":    int(actual_dim) if actual_dim else settings.embedding_dim,
            "embedding_model":  settings.embedding_model,
            "index_type":       "IVFFlat (pgvector)",
            "index_health":     index_health,
        },
    }


@app.get("/graph/status/{document_id}")
async def graph_status(document_id: str, org_id: str = Query(...)):
    """Lightweight breakdown of node/edge types for a document — for verification."""
    async with db_pool.acquire() as conn:
        doc_node = await conn.fetchrow("""
            SELECT id FROM context_nodes
            WHERE external_id=$1 AND node_type='document' AND org_id=$2
        """, document_id, org_id)

        if not doc_node:
            return {"status": "not_indexed", "document_id": document_id}

        doc_node_id = str(doc_node["id"])

        chunk_id_rows = await conn.fetch("""
            SELECT target_node_id FROM context_edges
            WHERE source_node_id=$1 AND edge_type='contains'
        """, doc_node_id)
        chunk_uuid_list = [r["target_node_id"] for r in chunk_id_rows]

        entity_counts = await conn.fetch("""
            SELECT cn.node_type, COUNT(*) as cnt
            FROM context_nodes cn
            JOIN context_edges ce ON ce.source_node_id = cn.id AND ce.edge_type = 'extracted_from'
            WHERE ce.target_node_id = ANY($1::uuid[])
            GROUP BY cn.node_type ORDER BY cnt DESC
        """, chunk_uuid_list) if chunk_uuid_list else []

        concept_count = await conn.fetchval("""
            SELECT COUNT(*) FROM context_nodes WHERE org_id=$1 AND node_type='concept'
        """, org_id)

        edge_counts = await conn.fetch("""
            SELECT edge_type, COUNT(*) as cnt
            FROM context_edges ce
            JOIN context_nodes n ON n.id = ce.source_node_id AND n.org_id = $1
            GROUP BY edge_type ORDER BY cnt DESC
        """, org_id)

        index_entries = await conn.fetchval("""
            SELECT COUNT(*) FROM context_index WHERE org_id=$1
        """, org_id)

    return {
        "status": "indexed",
        "document_id": document_id,
        "chunk_nodes": len(chunk_uuid_list),
        "entity_nodes": [
            {"type": r["node_type"], "count": int(r["cnt"])}
            for r in entity_counts
        ],
        "concept_nodes_org": int(concept_count or 0),
        "edge_breakdown": [
            {"type": r["edge_type"], "count": int(r["cnt"])}
            for r in edge_counts
        ],
        "context_index_entries": int(index_entries or 0),
    }


# ─── Graph Delete ────────────────────────────────────────────────────────────

@app.delete("/graph/document/{document_id}")
async def delete_document_graph(document_id: str, org_id: str = Query(...)):
    """
    Wipe all graph data for a document before reprocessing:
    - context_nodes for the doc + all its chunks
    - context_edges connected to those nodes
    - context_index entries (org-scoped; rebuilt cleanly after reprocess)
    - entity/concept nodes exclusively connected to this document are pruned
    """
    async with db_pool.acquire() as conn:
        doc_node = await conn.fetchrow("""
            SELECT id FROM context_nodes
            WHERE external_id=$1 AND node_type='document' AND org_id=$2
        """, document_id, org_id)

        if not doc_node:
            return {"deleted": False, "reason": "no graph data found"}

        doc_node_id = doc_node["id"]

        # Collect chunk node IDs
        chunk_ids = [r["target_node_id"] for r in await conn.fetch("""
            SELECT target_node_id FROM context_edges
            WHERE source_node_id=$1 AND edge_type='contains'
        """, doc_node_id)]

        # Collect entity node IDs attached to this document
        entity_ids = [r["source_node_id"] for r in await conn.fetch("""
            SELECT source_node_id FROM context_edges
            WHERE target_node_id=$1 AND edge_type IN ('extracted_from', 'described_in')
        """, doc_node_id)]

        all_node_ids = [doc_node_id] + chunk_ids + entity_ids

        # Delete edges involving any of these nodes
        await conn.execute("""
            DELETE FROM context_edges
            WHERE source_node_id = ANY($1::uuid[]) OR target_node_id = ANY($1::uuid[])
        """, all_node_ids)

        # Delete the nodes themselves
        await conn.execute("""
            DELETE FROM context_nodes WHERE id = ANY($1::uuid[])
        """, all_node_ids)

        # Prune concept nodes now orphaned (no remaining is_type edges)
        await conn.execute("""
            DELETE FROM context_nodes
            WHERE org_id=$1 AND node_type='concept'
            AND id NOT IN (SELECT target_node_id FROM context_edges WHERE edge_type='is_type')
        """, org_id)

        # Clear context_index for this org (will be rebuilt by graph/build)
        await conn.execute("DELETE FROM context_index WHERE org_id=$1", org_id)

    log.info("graph.deleted", doc_id=document_id, nodes=len(all_node_ids))
    return {"deleted": True, "nodes_removed": len(all_node_ids)}


# ─── Document Intelligence ───────────────────────────────────────────────────

@app.get("/documents/{document_id}/intelligence")
async def get_document_intelligence(document_id: str, org_id: str = Query(...)):
    """Aggregate document metadata, classification, chunk stats, tables, images, and graph summary."""
    async with db_pool.acquire() as conn:
        # Document metadata
        doc = await conn.fetchrow("""
            SELECT id, name, file_name, document_type, status,
                   file_size_bytes, sha256_hash, version, source_type,
                   created_at, updated_at, metadata, error_message
            FROM documents WHERE id=$1 AND org_id=$2
        """, uuid.UUID(document_id), uuid.UUID(org_id))

        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")

        # Classification reasoning (only exists for low-confidence auto-detect)
        classification = await conn.fetchrow("""
            SELECT suggested_type_codes, confidence_scores, llm_analysis,
                   metadata_extracted, auto_detected_hints, status
            FROM pending_classifications
            WHERE document_id=$1 ORDER BY created_at DESC LIMIT 1
        """, uuid.UUID(document_id))

        # Chunk type distribution + size stats
        chunk_stats = await conn.fetchrow("""
            SELECT
              COUNT(*)                                                                      AS total,
              COUNT(*) FILTER (WHERE metadata->>'content_type' = 'text')                  AS text_chunks,
              COUNT(*) FILTER (WHERE metadata->>'content_type' = 'table')                 AS tables,
              COUNT(*) FILTER (WHERE metadata->>'content_type' = 'figure')                AS figures,
              COUNT(*) FILTER (WHERE metadata->>'content_type' = 'table_row')             AS table_rows,
              COUNT(*) FILTER (WHERE embedding IS NOT NULL)                               AS embedded,
              MAX(page_number)                                                             AS max_page,
              ROUND(AVG(CHAR_LENGTH(content)))                                            AS avg_chars,
              ROUND(AVG(CHAR_LENGTH(content)) FILTER (WHERE metadata->>'content_type' = 'text'))      AS avg_chars_text,
              ROUND(AVG(CHAR_LENGTH(content)) FILTER (WHERE metadata->>'content_type' = 'table'))     AS avg_chars_table,
              ROUND(AVG(CHAR_LENGTH(content)) FILTER (WHERE metadata->>'content_type' = 'figure'))    AS avg_chars_figure,
              ROUND(AVG(CHAR_LENGTH(content)) FILTER (WHERE metadata->>'content_type' = 'table_row')) AS avg_chars_table_row,
              COUNT(*) FILTER (WHERE section IS NOT NULL AND section != '')               AS section_count
            FROM document_chunks WHERE document_id=$1
        """, uuid.UUID(document_id))

        # Infer chunking strategy from section coverage
        _total = int(chunk_stats["total"] or 0)
        _section_count = int(chunk_stats["section_count"] or 0)
        _section_frac = _section_count / max(1, _total)
        if doc["document_type"] in ("sdtm_dataset", "adam_dataset"):
            chunk_strategy = "xpt_tabular"
        elif _section_frac >= 0.8:
            chunk_strategy = "toc_driven"
        elif _section_frac < 0.2:
            chunk_strategy = "page_based"
        else:
            chunk_strategy = "hybrid"

        # Table chunks (limited 200)
        table_chunks = await conn.fetch("""
            SELECT chunk_index, page_number, section, content,
                   metadata->>'columns'   AS columns,
                   metadata->>'row_count' AS row_count
            FROM document_chunks
            WHERE document_id=$1 AND metadata->>'content_type'='table'
            ORDER BY chunk_index LIMIT 200
        """, uuid.UUID(document_id))

        # Image chunks
        image_chunks = await conn.fetch("""
            SELECT chunk_index, page_number, section, content,
                   metadata->>'image_url' AS image_url
            FROM document_chunks
            WHERE document_id=$1 AND metadata->>'image_url' IS NOT NULL
            ORDER BY chunk_index
        """, uuid.UUID(document_id))

        # Graph entity + edge breakdown + index stats
        doc_node = await conn.fetchrow("""
            SELECT id FROM context_nodes
            WHERE external_id=$1 AND node_type='document' AND org_id=$2
        """, document_id, org_id)

        entity_breakdown = []
        edge_breakdown = []
        total_concepts = 0
        index_entries = 0
        index_quality = None
        index_health = "no_data"

        if doc_node:
            doc_node_id = doc_node["id"]

            # extracted_from edges point from entity → document node directly
            entity_rows = await conn.fetch("""
                SELECT cn.node_type, COUNT(*) as cnt
                FROM context_nodes cn
                JOIN context_edges ce ON ce.source_node_id = cn.id AND ce.edge_type = 'extracted_from'
                WHERE ce.target_node_id = $1
                GROUP BY cn.node_type ORDER BY cnt DESC
            """, doc_node_id)
            entity_breakdown = [{"type": r["node_type"], "count": int(r["cnt"])} for r in entity_rows]

            # edge breakdown scoped to doc node + its chunk nodes
            edge_rows = await conn.fetch("""
                SELECT ce.edge_type, COUNT(*) as cnt
                FROM context_edges ce
                JOIN context_nodes src ON src.id = ce.source_node_id
                WHERE src.org_id = $1
                  AND (ce.source_node_id = $2 OR ce.target_node_id = $2
                       OR src.id IN (
                           SELECT target_node_id FROM context_edges
                           WHERE source_node_id = $2 AND edge_type = 'contains'
                       ))
                GROUP BY ce.edge_type ORDER BY cnt DESC
            """, org_id, doc_node_id)
            edge_breakdown = [{"type": r["edge_type"], "count": int(r["cnt"])} for r in edge_rows]

            # concept count: unique concept nodes reachable from this doc's entities
            total_concepts = await conn.fetchval("""
                SELECT COUNT(DISTINCT cn.id)
                FROM context_nodes cn
                JOIN context_edges ce ON ce.target_node_id = cn.id AND ce.edge_type = 'is_type'
                WHERE ce.source_node_id IN (
                    SELECT source_node_id FROM context_edges
                    WHERE target_node_id = $1 AND edge_type = 'extracted_from'
                )
            """, doc_node_id) or 0

            # index stats scoped to org
            index_entries = await conn.fetchval(
                "SELECT COUNT(*) FROM context_index WHERE org_id=$1", org_id) or 0
            index_quality = await conn.fetchval(
                "SELECT AVG(quality_score) FROM context_index WHERE org_id=$1", org_id)
            indexed_nodes = await conn.fetchval(
                "SELECT COUNT(*) FROM context_nodes WHERE org_id=$1 AND embedding IS NOT NULL", org_id) or 0
            index_health = "ready" if indexed_nodes > 100 else "insufficient_data"

        # embedding dimension from DB (or settings fallback)
        actual_dim = None
        if doc_node:
            actual_dim = await conn.fetchval("""
                SELECT vector_dims(embedding) FROM context_nodes
                WHERE org_id=$1 AND embedding IS NOT NULL LIMIT 1
            """, org_id)

        # Processing logs
        proc_logs = await conn.fetch("""
            SELECT id, step, event, message, metadata, created_at
            FROM processing_logs WHERE document_id=$1 ORDER BY created_at ASC
        """, uuid.UUID(document_id))

    # Build classification section
    def _parse_json(val):
        if val is None:
            return None
        if isinstance(val, str):
            try:
                return json.loads(val)
            except Exception:
                return val
        return val

    if classification:
        cls_status = classification["status"]
        if cls_status == "pending":
            method = "llm_pending_review"
        else:
            method = "auto_classified"
        suggested = list(_parse_json(classification["suggested_type_codes"]) or [])
        conf_scores = dict(_parse_json(classification["confidence_scores"]) or {})
        llm_analysis = classification["llm_analysis"]
        meta_extracted = dict(_parse_json(classification["metadata_extracted"]) or {})
        key_phrases = list(meta_extracted.get("key_phrases", []))
        structure_desc = meta_extracted.get("structure_description", "")
    else:
        method = "manually_set"
        suggested = [doc["document_type"]] if doc["document_type"] else []
        conf_scores = {}
        llm_analysis = None
        key_phrases = []
        structure_desc = ""

    # Build tables list
    tables_list = []
    for t in table_chunks:
        cols_raw = t["columns"]
        try:
            cols = json.loads(cols_raw) if cols_raw else []
        except Exception:
            cols = [cols_raw] if cols_raw else []
        tables_list.append({
            "chunk_index": t["chunk_index"],
            "page_number": t["page_number"],
            "section": t["section"] or "",
            "content": t["content"] or "",
            "columns": cols,
            "row_count": int(t["row_count"] or 0),
        })

    # Build images list — rewrite internal MinIO URL for browser access
    images_list = []
    for img in image_chunks:
        url = img["image_url"] or ""
        url = url.replace("http://minio:9000", "http://localhost:9000")
        images_list.append({
            "chunk_index": img["chunk_index"],
            "page_number": img["page_number"],
            "section": img["section"] or "",
            "caption": img["content"] or "",
            "image_url": url,
        })

    return {
        "document": {
            "id":              str(doc["id"]),
            "name":            doc["name"],
            "file_name":       doc["file_name"],
            "document_type":   doc["document_type"],
            "status":          doc["status"],
            "file_size_bytes": doc["file_size_bytes"],
            "sha256_hash":     doc["sha256_hash"],
            "version":         doc["version"],
            "source_type":     doc["source_type"],
            "created_at":      doc["created_at"].isoformat() if doc["created_at"] else None,
            "updated_at":      doc["updated_at"].isoformat() if doc["updated_at"] else None,
            "error_message":   doc["error_message"],
        },
        "classification": {
            "method":               method,
            "suggested_types":      suggested,
            "confidence_scores":    conf_scores,
            "llm_analysis":         llm_analysis,
            "key_phrases":          key_phrases,
            "structure_description": structure_desc,
        },
        "chunk_stats": {
            "total":               int(chunk_stats["total"] or 0),
            "text_chunks":         int(chunk_stats["text_chunks"] or 0),
            "tables":              int(chunk_stats["tables"] or 0),
            "figures":             int(chunk_stats["figures"] or 0),
            "table_rows":          int(chunk_stats["table_rows"] or 0),
            "embedded":            int(chunk_stats["embedded"] or 0),
            "max_page":            int(chunk_stats["max_page"] or 0),
            "avg_chars":           int(chunk_stats["avg_chars"] or 0),
            "avg_chars_text":      int(chunk_stats["avg_chars_text"] or 0),
            "avg_chars_table":     int(chunk_stats["avg_chars_table"] or 0),
            "avg_chars_figure":    int(chunk_stats["avg_chars_figure"] or 0),
            "avg_chars_table_row": int(chunk_stats["avg_chars_table_row"] or 0),
            "section_count":       int(chunk_stats["section_count"] or 0),
            "chunk_strategy":      chunk_strategy,
        },
        "tables":  tables_list,
        "images":  images_list,
        "graph_summary": {
            "entity_breakdown":  entity_breakdown,
            "edge_breakdown":    edge_breakdown,
            "total_concepts":    int(total_concepts),
            "index_entries":     int(index_entries),
            "index_quality":     round(float(index_quality), 3) if index_quality else None,
            "index_health":      index_health,
            "embedding_dim":     int(actual_dim) if actual_dim else settings.embedding_dim,
            "embedding_model":   settings.embedding_model,
        } if doc_node else None,
        "processing_logs": [
            {"id": str(r["id"]), "step": r["step"], "event": r["event"],
             "message": r["message"] or "",
             "metadata": json.loads(r["metadata"]) if isinstance(r["metadata"], str)
                         else dict(r["metadata"] or {}),
             "created_at": r["created_at"].isoformat()}
            for r in proc_logs
        ],
    }


# ─── Processing Logs ──────────────────────────────────────────────────────────

@app.get("/documents/{document_id}/processing-logs")
async def get_processing_logs(document_id: str, org_id: str = Query(...)):
    async with db_pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT id, step, event, message, metadata, created_at
            FROM processing_logs
            WHERE document_id=$1 AND org_id=$2
            ORDER BY created_at ASC
        """, uuid.UUID(document_id), uuid.UUID(org_id))
    return {"logs": [
        {"id": str(r["id"]), "step": r["step"], "event": r["event"],
         "message": r["message"] or "",
         "metadata": json.loads(r["metadata"]) if isinstance(r["metadata"], str) else dict(r["metadata"] or {}),
         "created_at": r["created_at"].isoformat()}
        for r in rows
    ]}


# ─── Standard Context Graphs ──────────────────────────────────────────────────

@app.get("/standard-graphs")
async def list_standard_graphs(org_id: Optional[str] = None):
    """List standard context graphs.

    Returns platform graphs (org_id IS NULL, is_published=TRUE) plus
    tenant-scoped graphs for the given org_id.
    """
    async with db_pool.acquire() as conn:
        if org_id and org_id != settings.platform_org_id:
            rows = await conn.fetch(
                "SELECT id, name, description, document_ids, is_published, org_id, "
                "published_at, created_at, updated_at "
                "FROM standard_context_graphs "
                "WHERE (org_id IS NULL AND is_published=TRUE) OR org_id=$1 "
                "ORDER BY created_at DESC",
                uuid.UUID(org_id))
        else:
            # Platform admin sees all graphs
            rows = await conn.fetch(
                "SELECT id, name, description, document_ids, is_published, org_id, "
                "published_at, created_at, updated_at "
                "FROM standard_context_graphs ORDER BY created_at DESC")
    return {"graphs": [dict(r) for r in rows]}


@app.post("/standard-graphs", status_code=201)
async def create_standard_graph(body: dict):
    """Create a new standard context graph (unpublished by default).

    Pass org_id to create a tenant-scoped graph (visible only to that tenant).
    Omit org_id (or pass null) to create a platform-level graph.
    """
    org_id_val = body.get("org_id")
    org_uuid = uuid.UUID(org_id_val) if org_id_val else None
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO standard_context_graphs (name, description, document_ids, org_id) "
            "VALUES ($1,$2,$3,$4) RETURNING *",
            body["name"],
            body.get("description"),
            [uuid.UUID(d) for d in body.get("document_ids", [])],
            org_uuid)
    return dict(row)


@app.patch("/standard-graphs/{graph_id}")
async def update_standard_graph(graph_id: str, body: dict):
    """Update or publish a standard context graph."""
    async with db_pool.acquire() as conn:
        if body.get("is_published") is True:
            await conn.execute(
                "UPDATE standard_context_graphs "
                "SET is_published=TRUE, published_at=NOW(), updated_at=NOW() "
                "WHERE id=$1", uuid.UUID(graph_id))
        elif body.get("is_published") is False:
            await conn.execute(
                "UPDATE standard_context_graphs "
                "SET is_published=FALSE, published_at=NULL, updated_at=NOW() "
                "WHERE id=$1", uuid.UUID(graph_id))
        if "document_ids" in body:
            await conn.execute(
                "UPDATE standard_context_graphs SET document_ids=$1, updated_at=NOW() "
                "WHERE id=$2",
                [uuid.UUID(d) for d in body["document_ids"]], uuid.UUID(graph_id))
        if "name" in body or "description" in body:
            await conn.execute(
                "UPDATE standard_context_graphs "
                "SET name=COALESCE($1,name), description=COALESCE($2,description), "
                "updated_at=NOW() WHERE id=$3",
                body.get("name"), body.get("description"), uuid.UUID(graph_id))
    return {"ok": True}


@app.delete("/standard-graphs/{graph_id}", status_code=204)
async def delete_standard_graph(graph_id: str):
    """Delete a standard context graph."""
    async with db_pool.acquire() as conn:
        await conn.execute(
            "DELETE FROM standard_context_graphs WHERE id=$1", uuid.UUID(graph_id))


# ─── Health ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "context-graph"}
