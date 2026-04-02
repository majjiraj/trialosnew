"""
TrialOS Ingestion Service — Coordinator
Manages EDC connector schedules, document ingestion, ingestion manifests,
Bronze layer writes, and Kafka event emission.
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from pydantic import BaseModel
from pydantic_settings import BaseSettings
import structlog
import asyncpg
import boto3
import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Optional, Literal
import httpx
import time as _time
from motor.motor_asyncio import AsyncIOMotorClient
from bson import ObjectId

log = structlog.get_logger()

class Settings(BaseSettings):
    database_url: str
    kafka_brokers: str = "localhost:9092"
    s3_endpoint: str = "http://localhost:9000"
    s3_access_key: str = "trialo"
    s3_secret_key: str = ""
    s3_bucket_bronze: str = "trialo-bronze"
    s3_bucket_docs: str = "trialo-documents"
    audit_service_url: str = "http://localhost:8002"
    notification_service_url: str = "http://localhost:8006"
    context_graph_url: str = "http://localhost:8008"  # context graph service
    ollama_base_url: str = "http://localhost:11434"
    embedding_model: str = "nomic-embed-text"
    mongo_url: str = "mongodb://trialo:trialopass@mongodb:27017/trialo?authSource=admin"
    mongo_db_name: str = "trialo"

    class Config:
        env_file = ".env"

settings = Settings()
db_pool: asyncpg.Pool = None
mongo_client: AsyncIOMotorClient = None
mongo_db = None


async def emit_processing_log(doc_id: str, org_id: str, step: str, event: str,
                               message: str, metadata: dict = None):
    try:
        async with db_pool.acquire() as conn:
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
    global db_pool, mongo_client, mongo_db
    db_pool = await asyncpg.create_pool(settings.database_url, min_size=5, max_size=20)
    mongo_client = AsyncIOMotorClient(settings.mongo_url)
    mongo_db = mongo_client[settings.mongo_db_name]
    await mongo_db.folder_files.create_index(
        [("tenant_id", 1), ("document_id", 1)], unique=True)
    log.info("ingestion_service.startup")
    yield
    await db_pool.close()
    mongo_client.close()

app = FastAPI(title="TrialOS Ingestion Service", version="1.0.0", lifespan=lifespan)

from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_s3_client():
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
    )

def compute_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

async def emit_kafka_event(topic: str, event: dict):
    """Emit event to Kafka. Simple HTTP bridge for now; replace with kafka-python in production."""
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"http://kafka-bridge:8090/emit",
                json={"topic": topic, "event": event},
                timeout=5.0
            )
    except Exception as e:
        log.warning("kafka.emit.failed", topic=topic, error=str(e))

async def write_audit(action: str, resource_type: str, resource_id: str, org_id: str,
                      study_id: Optional[str] = None, after_state: dict = None):
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{settings.audit_service_url}/events",
                json={
                    "org_id": org_id,
                    "study_id": study_id,
                    "actor_type": "system",
                    "actor_id": "ingestion-service",
                    "action": action,
                    "resource_type": resource_type,
                    "resource_id": resource_id,
                    "after_state": after_state
                }
            )
    except Exception as e:
        log.warning("audit.write.failed", error=str(e))

async def call_context_graph(path: str, body: dict = None, method: str = "POST", params: dict = None) -> dict:
    """Call the context-graph service. Non-fatal on error."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            url = f"{settings.context_graph_url}{path}"
            if method == "DELETE":
                resp = await client.delete(url, params=params)
            else:
                resp = await client.post(url, json=body, params=params)
            resp.raise_for_status()
            return resp.json()
    except Exception as e:
        log.warning("context_graph.call.failed", path=path, error=str(e))
        return {}

# ============================================================
# DOCUMENT UPLOAD ENDPOINT
# ============================================================

SUPPORTED_DOC_TYPES = {
    "protocol", "sap", "crf", "csr", "sdtm_ig", "adam_ig",
    "lab_manual", "lab_report", "study_budget", "dmp", "icf", "other",
    "auto",  # new: trigger LLM-based type detection
}

@app.get("/health")
async def health():
    return {"status": "ok", "service": "ingestion"}

@app.post("/documents/upload")
async def upload_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    org_id: str = Form(...),
    study_id: Optional[str] = Form(None),
    document_type: str = Form("auto"),      # default to auto-detection
    version: str = Form("1.0"),
    uploaded_by: str = Form(...),
    uploaded_by_name: Optional[str] = Form(None),
    folder_id: Optional[str] = Form(None),  # optional folder assignment on upload
    lab_type: Optional[str] = Form(None),   # 'central' or 'site' for lab reports
    site_id: Optional[str] = Form(None),
    report_date: Optional[str] = Form(None),
):
    """
    Accept document uploads: protocol, SAP, CRF, CSR, lab reports, budgets, etc.
    document_type='auto'  → LLM auto-detects type; may create pending_classification.
    1. Compute SHA-256
    2. Store raw file in S3 (bronze documents bucket)
    3. Write ingestion manifest
    4. Queue background processing (parse/chunk/embed/graph)
    5. Emit Kafka event
    """
    if document_type not in SUPPORTED_DOC_TYPES:
        raise HTTPException(400, f"Unsupported document_type. Must be one of: {SUPPORTED_DOC_TYPES}")

    content = await file.read()
    sha256_hash = compute_sha256(content)
    file_size = len(content)

    # Duplicate detection: same file content (SHA-256) already exists for this org
    async with db_pool.acquire() as conn:
        existing = await conn.fetchrow(
            "SELECT id, name, document_type, status, bronze_s3_key, created_at FROM documents "
            "WHERE org_id=$1 AND sha256_hash=$2 LIMIT 1",
            org_id, sha256_hash
        )
    if existing:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=409, content={
            "duplicate": True,
            "existing_document_id": str(existing["id"]),
            "existing_document_name": existing["name"],
            "existing_document_type": existing["document_type"],
            "existing_status": existing["status"],
            "s3_key": existing["bronze_s3_key"],
            "message": f"A document with identical content already exists: '{existing['name']}'",
        })

    doc_id = str(uuid.uuid4())

    # Use 'other' as the placeholder type when auto-detecting
    effective_type = "other" if document_type == "auto" else document_type

    # S3 key: org_id/study_id/document_type/doc_id/filename
    s3_key = f"{org_id}/{study_id or 'org-level'}/{effective_type}/{doc_id}/{file.filename}"

    # Upload to S3
    s3 = get_s3_client()
    s3.put_object(
        Bucket=settings.s3_bucket_docs,
        Key=s3_key,
        Body=content,
        ContentType=file.content_type or "application/octet-stream",
        Metadata={
            "sha256": sha256_hash,
            "org_id": org_id,
            "study_id": study_id or "",
            "document_type": effective_type,
            "version": version,
            "uploaded_by": uploaded_by
        }
    )

    # Write to DB
    async with db_pool.acquire() as conn:
        await conn.execute("""
            INSERT INTO documents (id, org_id, study_id, document_type, name, file_name,
                file_size_bytes, sha256_hash, version, source_type, bronze_s3_key, status, uploaded_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'upload',$10,'pending',$11)
        """, doc_id, org_id, study_id, effective_type, file.filename, file.filename,
            file_size, sha256_hash, version, s3_key, uploaded_by)

        # For lab reports: create lab_report_ingestion record
        if effective_type == "lab_report" and lab_type:
            await conn.execute("""
                INSERT INTO lab_report_ingestions (document_id, lab_type, site_id, report_date)
                VALUES ($1,$2,$3,$4)
            """, doc_id, lab_type, site_id, report_date)

    # Write ingestion manifest to S3
    manifest = {
        "manifest_version": "1.0",
        "document_id": doc_id,
        "org_id": org_id,
        "study_id": study_id,
        "document_type": effective_type,
        "requested_type": document_type,   # 'auto' if user requested auto-detection
        "file_name": file.filename,
        "file_size_bytes": file_size,
        "sha256_hash": sha256_hash,
        "version": version,
        "ingested_at": datetime.now(timezone.utc).isoformat(),
        "ingested_by": uploaded_by,
        "source": "file_upload",
        "s3_key": s3_key
    }
    s3.put_object(
        Bucket=settings.s3_bucket_docs,
        Key=f"{s3_key}.manifest.json",
        Body=json.dumps(manifest, indent=2),
        ContentType="application/json"
    )

    # Write lineage record to MongoDB
    try:
        await mongo_db.document_lineage.insert_one({
            "document_id": doc_id,
            "tenant_id": org_id,
            "version": version,
            "file_name": file.filename,
            "sha256_hash": sha256_hash,
            "file_size_bytes": file_size,
            "uploaded_by_id": uploaded_by,
            "uploaded_by_name": uploaded_by_name or "",
            "uploaded_at": datetime.utcnow(),
            "event": "initial_upload",
            "notes": ""
        })
    except Exception as e:
        log.warning("lineage.write_failed", doc_id=doc_id, error=str(e))

    # Assign to folder in MongoDB if folder_id provided
    if folder_id:
        try:
            await mongo_db.folder_files.insert_one({
                "tenant_id": org_id,
                "folder_id": folder_id,
                "document_id": doc_id,
                "added_by_id": uploaded_by,
                "added_by_name": uploaded_by_name or "",
                "added_at": datetime.utcnow()
            })
        except Exception as e:
            log.warning("folder_assign.failed", doc_id=doc_id, folder_id=folder_id, error=str(e))

    # Audit
    await write_audit(
        "document.uploaded", "document", doc_id, org_id, study_id,
        after_state={"document_type": effective_type, "sha256": sha256_hash, "size_bytes": file_size,
                     "auto_detect": document_type == "auto"}
    )

    # Queue background processing
    background_tasks.add_task(
        process_document, doc_id, effective_type, s3_key, content,
        org_id, study_id, lab_type,
        auto_detect=(document_type == "auto"), filename=file.filename
    )

    log.info("document.uploaded", doc_id=doc_id, doc_type=effective_type,
             auto_detect=document_type == "auto", org_id=org_id)
    return {
        "document_id": doc_id,
        "sha256_hash": sha256_hash,
        "s3_key": s3_key,
        "status": "pending",
        "auto_detect": document_type == "auto",
        "message": "Document queued for processing"
        + (" — type will be auto-detected" if document_type == "auto" else ""),
    }


async def process_document(doc_id: str, document_type: str, s3_key: str,
                            content: bytes, org_id: str, study_id: Optional[str],
                            lab_type: Optional[str], auto_detect: bool = False,
                            filename: str = ""):
    """Background: auto-detect type (if requested), parse, chunk, embed, build graph."""
    try:
        async with db_pool.acquire() as conn:
            await conn.execute("UPDATE documents SET status='processing' WHERE id=$1", doc_id)

        # ── Step 1: Auto-detect document type ────────────────────────────────
        # XPT files are binary SAS transport — auto-detect would produce garbage; skip it
        if auto_detect and content[:8] == b'HEADER R':
            document_type = "sdtm_dataset"
            async with db_pool.acquire() as conn:
                await conn.execute("UPDATE documents SET document_type=$1 WHERE id=$2",
                                   document_type, doc_id)
            log.info("document.xpt_detected", doc_id=doc_id, detected_type=document_type)
            auto_detect = False

        if auto_detect:
            from document_processor import extract_text
            text_sample = await extract_text(content, "other")
            classify_result = await call_context_graph("/classify", {
                "document_id": doc_id,
                "text_excerpt": text_sample[:3000],
                "filename": filename or doc_id,
                "org_id": org_id,
                "study_id": study_id,
            })
            if classify_result.get("status") == "classified":
                document_type = classify_result["document_type"]
                async with db_pool.acquire() as conn:
                    await conn.execute(
                        "UPDATE documents SET document_type=$1 WHERE id=$2",
                        document_type, doc_id
                    )
                log.info("document.auto_classified", doc_id=doc_id,
                         detected_type=document_type,
                         confidence=classify_result.get("confidence"))
            else:
                # Pending classification — continue processing as 'other'
                log.info("document.pending_classification", doc_id=doc_id)

        # ── Step 2: Route to type-specific processor ──────────────────────────
        text_doc_types = {"protocol","sap","crf","csr","sdtm_ig","adam_ig",
                          "lab_manual","dmp","icf","sdtm_dataset","adam_dataset","other"}
        if document_type in text_doc_types:
            await process_text_document(doc_id, content, document_type, org_id, study_id, filename=filename)
        elif document_type == "lab_report":
            await process_lab_report(doc_id, content, lab_type, org_id, study_id)
        elif document_type == "study_budget":
            await process_budget(doc_id, content, org_id, study_id)

        async with db_pool.acquire() as conn:
            await conn.execute("UPDATE documents SET status='indexed', updated_at=NOW() WHERE id=$1", doc_id)

        # ── Step 3: Build context graph ───────────────────────────────────────
        await call_context_graph("/graph/build", {
            "document_id": str(doc_id),
            "org_id": str(org_id),
            "study_id": str(study_id) if study_id else None,
        })

        # ── Step 3b: Ensure chunk nodes are synced (idempotent, non-fatal) ────
        try:
            await call_context_graph("/graph/sync-chunks", {
                "document_id": str(doc_id),
                "org_id": str(org_id),
                "study_id": str(study_id) if study_id else None,
            })
        except Exception as _sync_exc:
            log.warning("graph.sync_chunks_failed", doc_id=str(doc_id), error=str(_sync_exc))

        # ── Step 4: Emit Kafka event ──────────────────────────────────────────
        await emit_kafka_event("trialo.events.data", {
            "type": "document.processed",
            "source": "ingestion-service",
            "document_id": doc_id,
            "document_type": document_type,
            "org_id": org_id,
            "study_id": study_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

        log.info("document.processed", doc_id=doc_id)
    except Exception as e:
        async with db_pool.acquire() as conn:
            await conn.execute(
                "UPDATE documents SET status='error', error_message=$1, updated_at=NOW() WHERE id=$2",
                str(e), doc_id
            )
        log.error("document.processing_failed", doc_id=doc_id, error=str(e))


async def process_text_document(doc_id: str, content: bytes, doc_type: str,
                                 org_id: str, study_id: Optional[str],
                                 filename: str = ""):
    """
    Extract, chunk, insert, and embed a document — content-type aware.

    PDFs for structured types (sdtm_ig, protocol, …) use ToC-driven section
    extraction so prose is accumulated per section (preserving cross-page
    context) and tables are extracted atomically with column metadata.

    Embedding uses prepare_embedding_text() which prepends a structured
    preamble for tables so the 768-dim vector captures column semantics.
    Sequential batches of 8 keep Ollama pressure low.
    """
    import asyncio as _asyncio
    from document_processor import extract_and_chunk_pdf, prepare_embedding_text, extract_text, chunk_text, chunk_xpt

    t0 = _time.monotonic()
    await emit_processing_log(doc_id, org_id, "ingestion", "started",
        f"Parsing {doc_type}: {filename or doc_id}",
        {"doc_type": doc_type, "filename": filename})

    # 1. Extract + chunk
    if content[:4] == b'%PDF':
        chunks = await extract_and_chunk_pdf(content, doc_type=doc_type)
    elif content[:8] == b'HEADER R':  # SAS XPT transport file magic
        chunks = chunk_xpt(content, filename=filename, doc_type=doc_type)
    else:
        text   = await extract_text(content, doc_type)
        chunks = chunk_text(text, doc_type)

    # 1b. Upload any image bytes to MinIO; strip transient keys before DB insert
    s3 = get_s3_client()
    for i, chunk in enumerate(chunks):
        image_bytes = chunk.pop("image_bytes", None)
        image_ext   = chunk.pop("image_ext", "png")
        if image_bytes:
            page = chunk.get("page", 0)
            key  = f"documents/{doc_id}/images/page_{page}_chunk_{i}.{image_ext}"
            try:
                await _asyncio.to_thread(
                    s3.put_object,
                    Bucket=settings.s3_bucket_docs,
                    Key=key,
                    Body=image_bytes,
                    ContentType=f"image/{image_ext}",
                )
                chunk["metadata"]["image_url"] = (
                    f"{settings.s3_endpoint}/{settings.s3_bucket_docs}/{key}"
                )
            except Exception as exc:
                log.warning("image_upload.failed", error=str(exc), chunk_index=i)

    # Count by content type for logging
    by_type: dict[str, int] = {}
    for c in chunks:
        ct = (c.get("metadata") or {}).get("content_type", "text")
        by_type[ct] = by_type.get(ct, 0) + 1

    # 2. Insert all chunks with metadata (without embeddings yet)
    async with db_pool.acquire() as conn:
        await conn.executemany(
            "INSERT INTO document_chunks "
            "(document_id, org_id, study_id, chunk_index, page_number, section, content, metadata) "
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
            [
                (doc_id, org_id, study_id, i,
                 chunk.get("page"), chunk.get("section"), chunk["text"],
                 json.dumps(chunk.get("metadata") or {}))
                for i, chunk in enumerate(chunks)
            ]
        )
    log.info("text_document.chunked", doc_id=doc_id, chunk_count=len(chunks), by_type=by_type)

    t1 = _time.monotonic()
    _total_c = len(chunks)
    _tc = by_type.get("table_row", 0)
    if doc_type in ("sdtm_dataset", "adam_dataset"):
        chunk_strategy = "xpt_tabular"
    elif _total_c > 0 and by_type.get("text", 0) / max(1, _total_c) >= 0.8:
        chunk_strategy = "toc_driven"
    else:
        chunk_strategy = "hybrid"
    await emit_processing_log(doc_id, org_id, "ingestion", "completed",
        f"Created {len(chunks)} chunks — strategy: {chunk_strategy}",
        {"chunks": len(chunks), "by_type": by_type, "strategy": chunk_strategy,
         "duration_ms": int((t1 - t0) * 1000)})

    # 3. Embed — use per-content-type text preparation so table vectors carry
    #    column semantics and section context is encoded for text chunks.
    from embedding_client import EmbeddingClient
    embedder    = EmbeddingClient()
    EMBED_BATCH = 8
    embedded    = 0
    t_emb = _time.monotonic()
    await emit_processing_log(doc_id, org_id, "embedding", "started",
        f"Embedding {len(chunks)} chunks with {embedder.model}",
        {"model": embedder.model, "model_version": "latest",
         "total": len(chunks), "dim": 768})
    try:
        for batch_start in range(0, len(chunks), EMBED_BATCH):
            batch  = chunks[batch_start:batch_start + EMBED_BATCH]
            # prepare_embedding_text adds structural preamble for tables/figures
            texts  = [prepare_embedding_text(c) for c in batch]
            vectors = await embedder.embed(texts)
            vec_rows = [
                ("[" + ",".join(str(x) for x in v) + "]", doc_id, batch_start + i)
                for i, v in enumerate(vectors)
            ]
            async with db_pool.acquire() as conn:
                await conn.executemany(
                    "UPDATE document_chunks SET embedding=$1::vector "
                    "WHERE document_id=$2 AND chunk_index=$3",
                    vec_rows,
                )
            embedded += len(batch)
            if embedded % 24 == 0 or embedded >= len(chunks):
                await emit_processing_log(doc_id, org_id, "embedding", "progress",
                    f"Embedded {embedded}/{len(chunks)} chunks",
                    {"done": embedded, "total": len(chunks)})
        t_emb_done = _time.monotonic()
        await emit_processing_log(doc_id, org_id, "embedding", "completed",
            f"All {embedded} chunks vectorised · {embedder.model} · 768 dims",
            {"model": embedder.model, "model_version": "latest",
             "total": embedded, "dim": 768,
             "duration_ms": int((t_emb_done - t_emb) * 1000)})
        log.info("embedding.complete", doc_id=doc_id, chunks=embedded,
                 model=embedder.model, by_type=by_type)
    except Exception as e:
        log.warning("embedding.failed", doc_id=doc_id, embedded_so_far=embedded, error=str(e))


async def process_lab_report(doc_id: str, content: bytes, lab_type: Optional[str],
                              org_id: str, study_id: Optional[str]):
    """Parse lab report: central=structured, site=OCR."""
    from lab_processor import process_central_lab, process_site_lab_ocr

    if lab_type == "central":
        records = await process_central_lab(content)
    else:
        records = await process_site_lab_ocr(content)

    log.info("lab_report.processed", doc_id=doc_id, records=len(records), lab_type=lab_type)


async def process_budget(doc_id: str, content: bytes, org_id: str, study_id: Optional[str]):
    """Parse Excel/CSV budget into site_budgets rows."""
    from budget_processor import parse_budget_file
    rows = await parse_budget_file(content)
    log.info("budget.processed", doc_id=doc_id, rows=len(rows))


@app.get("/documents/{doc_id}/status")
async def get_document_status(doc_id: str):
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, document_type, status, error_message, created_at, updated_at FROM documents WHERE id=$1",
            doc_id
        )
        if not row:
            raise HTTPException(404, "Document not found")
        return dict(row)


@app.post("/documents/{doc_id}/reembed")
async def reembed_document(doc_id: str):
    """Backfill embeddings for chunks that were stored without a vector (e.g. when Ollama was unreachable)."""
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT chunk_index, content FROM document_chunks WHERE document_id=$1 AND embedding IS NULL ORDER BY chunk_index",
            doc_id,
        )
    if not rows:
        return {"status": "nothing_to_embed", "doc_id": doc_id}

    ollama_url = settings.ollama_base_url.rstrip("/")
    embed_model = settings.embedding_model
    texts = [r["content"] for r in rows]
    indices = [r["chunk_index"] for r in rows]
    # Send one embedding request at a time (sequential) so we don't overwhelm Ollama
    # while it may be concurrently running LLM inference.
    all_vecs: list[list[float]] = []
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            for text in texts:
                resp = await client.post(
                    f"{ollama_url}/api/embeddings",
                    json={"model": embed_model, "prompt": text[:4000]},
                )
                resp.raise_for_status()
                all_vecs.append(resp.json()["embedding"])
        vec_rows = [("[" + ",".join(str(x) for x in v) + "]", doc_id, idx) for idx, v in zip(indices, all_vecs)]
        async with db_pool.acquire() as conn:
            await conn.executemany(
                "UPDATE document_chunks SET embedding=$1::vector WHERE document_id=$2 AND chunk_index=$3",
                vec_rows,
            )
        log.info("reembed.complete", doc_id=doc_id, chunks=len(rows))
        return {"status": "ok", "doc_id": doc_id, "chunks_embedded": len(rows)}
    except Exception as e:
        log.warning("reembed.failed", doc_id=doc_id, error=str(e))
        raise HTTPException(500, f"Embedding failed: {e}")


@app.post("/documents/{doc_id}/reprocess")
async def reprocess_document(doc_id: str, background_tasks: BackgroundTasks):
    """
    Re-extract, re-chunk, re-embed, and rebuild the context graph for an existing document.
    Use after updating the extraction logic (e.g. table support) to refresh stored chunks.
    """
    async with db_pool.acquire() as conn:
        doc = await conn.fetchrow(
            "SELECT id, document_type, bronze_s3_key, org_id, study_id, file_name FROM documents WHERE id=$1",
            doc_id
        )
    if not doc:
        raise HTTPException(404, "Document not found")

    s3 = get_s3_client()
    try:
        obj = s3.get_object(Bucket=settings.s3_bucket_docs, Key=doc["bronze_s3_key"])
        content = obj["Body"].read()
    except Exception as e:
        raise HTTPException(500, f"Failed to download document from S3: {e}")

    background_tasks.add_task(_reprocess_document_bg, doc_id, dict(doc), content)
    return {"status": "reprocessing", "doc_id": doc_id, "document_type": doc["document_type"]}


async def _reprocess_document_bg(doc_id: str, doc: dict, content: bytes):
    """Background: delete old chunks/graph data, re-extract, re-embed, rebuild graph."""
    try:
        async with db_pool.acquire() as conn:
            await conn.execute("UPDATE documents SET status='processing', error_message=NULL WHERE id=$1", doc_id)
            await conn.execute("DELETE FROM document_chunks WHERE document_id=$1", doc_id)
            await conn.execute("DELETE FROM pending_classifications WHERE document_id=$1", doc_id)
            await conn.execute("DELETE FROM processing_logs WHERE document_id=$1", doc_id)

        # Wipe graph nodes, edges and index entries for this document
        try:
            await call_context_graph(f"/graph/document/{doc_id}", method="DELETE",
                                     params={"org_id": doc["org_id"]})
        except Exception as e:
            log.warning("reprocess.graph_wipe_failed", doc_id=doc_id, error=str(e))

        await process_text_document(
            doc_id, content, doc["document_type"],
            doc["org_id"], doc["study_id"],
            filename=doc.get("file_name", ""),
        )

        async with db_pool.acquire() as conn:
            await conn.execute("UPDATE documents SET status='indexed', updated_at=NOW() WHERE id=$1", doc_id)

        await call_context_graph("/graph/build", {
            "document_id": str(doc_id),
            "org_id": str(doc["org_id"]),
            "study_id": str(doc["study_id"]) if doc["study_id"] else None,
        })
        try:
            await call_context_graph("/graph/sync-chunks", {
                "document_id": str(doc_id),
                "org_id": str(doc["org_id"]),
                "study_id": str(doc["study_id"]) if doc["study_id"] else None,
            })
        except Exception:
            pass

        log.info("document.reprocessed", doc_id=doc_id)
    except Exception as e:
        async with db_pool.acquire() as conn:
            await conn.execute(
                "UPDATE documents SET status='error', error_message=$1, updated_at=NOW() WHERE id=$2",
                str(e), doc_id
            )
        log.error("document.reprocess_failed", doc_id=doc_id, error=str(e))


@app.get("/documents")
async def list_documents(org_id: str, study_id: Optional[str] = None, document_type: Optional[str] = None):
    async with db_pool.acquire() as conn:
        conditions = ["org_id=$1"]
        params = [org_id]
        i = 2
        if study_id:
            conditions.append(f"study_id=${i}"); params.append(study_id); i += 1
        if document_type:
            conditions.append(f"document_type=${i}"); params.append(document_type); i += 1
        rows = await conn.fetch(
            f"SELECT id, name, document_type, version, status, sha256_hash, file_size_bytes, created_at, uploaded_by FROM documents WHERE {' AND '.join(conditions)} ORDER BY created_at DESC",
            *params
        )
        return {"documents": [dict(r) for r in rows]}


# ============================================================
# FOLDER ENDPOINTS
# ============================================================

def _oid(v) -> ObjectId:
    """Convert string to ObjectId, raise 400 on invalid format."""
    try:
        return ObjectId(v)
    except Exception:
        raise HTTPException(400, f"Invalid folder id: {v}")


def _ser(doc: dict) -> dict:
    """Serialize MongoDB document to JSON-safe dict."""
    doc = dict(doc)
    if "_id" in doc:
        doc["id"] = str(doc.pop("_id"))
    if "folder_id" in doc and isinstance(doc["folder_id"], ObjectId):
        doc["folder_id"] = str(doc["folder_id"])
    for k, v in doc.items():
        if isinstance(v, ObjectId):
            doc[k] = str(v)
        elif isinstance(v, datetime):
            doc[k] = v.isoformat()
    return doc


def _build_tree(folders: list[dict], counts: dict[str, int]) -> list[dict]:
    """Recursively build nested folder tree."""
    by_parent: dict = {}
    for f in folders:
        pid = f.get("parent_id")
        key = str(pid) if pid else "root"
        by_parent.setdefault(key, []).append(f)

    def nest(parent_key: str) -> list[dict]:
        children = by_parent.get(parent_key, [])
        result = []
        for c in sorted(children, key=lambda x: x.get("name", "")):
            node = dict(c)
            node["document_count"] = counts.get(node["id"], 0)
            node["children"] = nest(node["id"])
            result.append(node)
        return result

    return nest("root")


@app.get("/folders/tree")
async def get_folder_tree(org_id: str):
    """Return nested folder tree for a tenant with document counts per folder."""
    cursor = mongo_db.document_folders.find({"tenant_id": org_id})
    raw_folders = await cursor.to_list(length=None)
    folders = [_ser(f) for f in raw_folders]

    # Count docs per folder
    pipeline = [
        {"$match": {"tenant_id": org_id}},
        {"$group": {"_id": "$folder_id", "count": {"$sum": 1}}}
    ]
    count_cursor = mongo_db.folder_files.aggregate(pipeline)
    counts_raw = await count_cursor.to_list(length=None)
    counts = {str(c["_id"]): c["count"] for c in counts_raw if c["_id"]}

    # Unassigned doc count (not in any folder)
    total_assigned = await mongo_db.folder_files.count_documents({"tenant_id": org_id, "folder_id": {"$ne": None}})
    async with db_pool.acquire() as conn:
        total_docs = await conn.fetchval("SELECT COUNT(*) FROM documents WHERE org_id=$1", org_id)
    root_count = int(total_docs or 0) - total_assigned

    tree = _build_tree(folders, counts)
    return {"tree": tree, "root_document_count": max(0, root_count)}


@app.post("/folders", status_code=201)
async def create_folder(body: dict):
    """Create a new folder for a tenant."""
    org_id = body.get("org_id")
    name = body.get("name", "").strip()
    if not org_id or not name:
        raise HTTPException(400, "org_id and name are required")
    parent_id = body.get("parent_id")
    doc = {
        "tenant_id": org_id,
        "name": name,
        "parent_id": parent_id,
        "created_by_id": body.get("user_id", ""),
        "created_by_name": body.get("user_name", ""),
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow(),
    }
    result = await mongo_db.document_folders.insert_one(doc)
    doc["_id"] = result.inserted_id
    return _ser(doc)


@app.patch("/folders/{folder_id}")
async def update_folder(folder_id: str, body: dict):
    """Rename or reparent a folder."""
    updates: dict = {"updated_at": datetime.utcnow()}
    if "name" in body:
        updates["name"] = body["name"].strip()
    if "parent_id" in body:
        updates["parent_id"] = body["parent_id"]
    await mongo_db.document_folders.update_one(
        {"_id": _oid(folder_id)}, {"$set": updates})
    return {"ok": True}


@app.delete("/folders/{folder_id}", status_code=204)
async def delete_folder(folder_id: str, org_id: str):
    """Delete a folder. Documents in it are moved to the parent folder (or root)."""
    folder = await mongo_db.document_folders.find_one({"_id": _oid(folder_id), "tenant_id": org_id})
    if not folder:
        raise HTTPException(404, "Folder not found")
    parent_id = folder.get("parent_id")

    # Move children folders to this folder's parent
    await mongo_db.document_folders.update_many(
        {"parent_id": folder_id, "tenant_id": org_id},
        {"$set": {"parent_id": parent_id, "updated_at": datetime.utcnow()}}
    )
    # Move folder's files to parent folder (or root)
    await mongo_db.folder_files.update_many(
        {"folder_id": folder_id, "tenant_id": org_id},
        {"$set": {"folder_id": parent_id}}
    )
    await mongo_db.document_folders.delete_one({"_id": _oid(folder_id)})


@app.post("/folders/{folder_id}/documents", status_code=201)
async def add_document_to_folder(folder_id: str, body: dict):
    """Assign a document to a folder (upsert — moves from any previous folder)."""
    org_id = body.get("org_id")
    doc_id = body.get("document_id")
    if not org_id or not doc_id:
        raise HTTPException(400, "org_id and document_id are required")

    # Use replace to handle unique index (tenant_id, document_id)
    await mongo_db.folder_files.replace_one(
        {"tenant_id": org_id, "document_id": doc_id},
        {
            "tenant_id": org_id,
            "folder_id": folder_id,
            "document_id": doc_id,
            "added_by_id": body.get("user_id", ""),
            "added_by_name": body.get("user_name", ""),
            "added_at": datetime.utcnow(),
        },
        upsert=True
    )
    return {"ok": True}


@app.delete("/folders/{folder_id}/documents/{doc_id}", status_code=204)
async def remove_document_from_folder(folder_id: str, doc_id: str, org_id: str):
    """Remove a document from a folder (back to root / unassigned)."""
    await mongo_db.folder_files.delete_one(
        {"tenant_id": org_id, "document_id": doc_id, "folder_id": folder_id})


@app.patch("/documents/{doc_id}/folder")
async def move_document_to_folder(doc_id: str, body: dict):
    """Move a document to a different folder (or null = root)."""
    org_id = body.get("org_id")
    if not org_id:
        raise HTTPException(400, "org_id is required")
    folder_id = body.get("folder_id")  # None = root
    if folder_id:
        await mongo_db.folder_files.replace_one(
            {"tenant_id": org_id, "document_id": doc_id},
            {
                "tenant_id": org_id,
                "folder_id": folder_id,
                "document_id": doc_id,
                "added_by_id": body.get("user_id", ""),
                "added_by_name": body.get("user_name", ""),
                "added_at": datetime.utcnow(),
            },
            upsert=True
        )
    else:
        await mongo_db.folder_files.delete_one({"tenant_id": org_id, "document_id": doc_id})
    return {"ok": True}


@app.get("/folder-files")
async def get_all_folder_files(org_id: str):
    """Return all folder assignments for a tenant as a flat list (one call instead of N)."""
    cursor = mongo_db.folder_files.find(
        {"tenant_id": org_id},
        {"document_id": 1, "folder_id": 1, "_id": 0}
    )
    entries = await cursor.to_list(length=None)
    return {"files": [{"document_id": e["document_id"], "folder_id": e.get("folder_id")} for e in entries]}


@app.get("/documents/{doc_id}/folder")
async def get_document_folder(doc_id: str, org_id: str):
    """Get the folder assignment for a document."""
    entry = await mongo_db.folder_files.find_one({"tenant_id": org_id, "document_id": doc_id})
    if not entry:
        return {"folder_id": None}
    return {"folder_id": entry.get("folder_id")}


@app.get("/documents/{doc_id}/lineage")
async def get_document_lineage(doc_id: str, org_id: str):
    """Return version/lineage history for a document (newest first)."""
    cursor = mongo_db.document_lineage.find(
        {"document_id": doc_id, "tenant_id": org_id},
        sort=[("uploaded_at", -1)]
    )
    entries = await cursor.to_list(length=None)
    return {"lineage": [_ser(e) for e in entries]}


@app.get("/documents/{doc_id}/xpt-analysis")
async def analyze_xpt_file(doc_id: str, org_id: str):
    """Analyze an XPT file and return record count and column statistics."""
    import boto3
    import pyreadstat
    import tempfile
    import os

    try:
        # Get document metadata
        async with db_pool.acquire() as conn:
            doc = await conn.fetchrow(
                "SELECT * FROM documents WHERE id = $1 AND org_id = $2",
                doc_id, org_id
            )
            if not doc:
                return {"error": "Document not found"}, 404
            if not doc["bronze_s3_key"]:
                return {"error": "Document not yet processed"}, 400

        # Get file from MinIO
        s3_client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
            region_name="us-east-1"
        )

        response = s3_client.get_object(Bucket="trialo-documents", Key=doc["bronze_s3_key"])
        file_content = response["Body"].read()

        # Analyze XPT file
        with tempfile.NamedTemporaryFile(suffix=".xpt", delete=False) as tmp:
            tmp.write(file_content)
            tmp_path = tmp.name

        try:
            df, meta = pyreadstat.read_xport(tmp_path)

            # Collect statistics
            stats = {
                "record_count": len(df),
                "column_count": len(df.columns),
                "columns": list(df.columns),
                "column_stats": {}
            }

            # Add frequency stats for key columns
            for col in df.columns[:10]:  # Limit to first 10 columns
                unique_count = df[col].nunique()
                if unique_count <= 20:  # Only show frequencies for low-cardinality columns
                    stats["column_stats"][col] = {
                        "unique_count": unique_count,
                        "top_values": df[col].value_counts().head(5).to_dict()
                    }

            return stats
        finally:
            os.remove(tmp_path)

    except Exception as e:
        logger.error(f"Error analyzing XPT file: {e}")
        return {"error": str(e)}, 500
