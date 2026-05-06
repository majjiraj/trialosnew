"""
TrialOS Ingestion Service — Coordinator
Manages EDC connector schedules, document ingestion, ingestion manifests,
Bronze layer writes, and Kafka event emission.
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks, Request
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
        extra = 'ignore'

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
    "protocol", "sap", "crf", "csr", "sdtm_ig", "adam_ig", "usdm_ig",
    "lab_manual", "lab_report", "study_budget", "dmp", "icf", "other",
    "ich_guideline", "controlled_terminology",
    "auto",  # new: trigger LLM-based type detection
}

# Common SDTM dataset filenames uploaded as CSV exports (e.g., AE.csv, DM.csv).
SDTM_DATASET_NAMES = {
    "AE", "CM", "DM", "DS", "EX", "LB", "MH", "QS", "SE", "SV", "TA", "TE", "TI", "TS", "TU", "TV", "VS",
    "SUPPAE", "SUPPCM", "SUPPDM", "SUPPDS", "SUPPEX", "SUPPLB", "SUPPMH", "SUPPQS", "SUPPVS",
}

@app.get("/health")
async def health():
    return {"status": "ok", "service": "ingestion"}

def extract_document_date(content: bytes, filename: str) -> Optional[str]:
    """Extract the protocol/document date from the file content (first 3 pages)."""
    text = ""
    try:
        fname = filename.lower()
        if fname.endswith('.pdf'):
            import fitz
            doc = fitz.open(stream=content, filetype="pdf")
            for page in doc[:3]:
                text += page.get_text() + "\n"
            doc.close()
        elif fname.endswith(('.docx', '.doc')):
            try:
                import docx
                d = docx.Document(io.BytesIO(content))
                text = "\n".join(p.text for p in d.paragraphs[:80])
            except Exception:
                pass
    except Exception:
        return None

    date_patterns = [
        # Labelled dates: "Protocol Date: 15 Jan 2024" / "Effective Date: 2024-01-15"
        r'(?:Protocol\s+Date|Effective\s+Date|Date\s+of\s+(?:Issue|Amendment)|Amendment\s+Date|Version\s+Date|Issue\s+Date|Approval\s+Date)[:\s]+(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})',
        r'(?:Protocol\s+Date|Effective\s+Date|Date\s+of\s+(?:Issue|Amendment)|Amendment\s+Date|Version\s+Date|Issue\s+Date|Approval\s+Date)[:\s]+(\d{4}-\d{2}-\d{2})',
        r'(?:Protocol\s+Date|Effective\s+Date|Date\s+of\s+(?:Issue|Amendment)|Amendment\s+Date|Version\s+Date|Issue\s+Date|Approval\s+Date)[:\s]+([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})',
        r'(?:Protocol\s+Date|Effective\s+Date|Date\s+of\s+(?:Issue|Amendment)|Amendment\s+Date|Version\s+Date|Issue\s+Date|Approval\s+Date)[:\s]+(\d{1,2}\s+[A-Z][a-z]+\.?\s+\d{4})',
        # Generic "Date: ..." near the top (first 500 chars only)
        r'Date[:\s]+(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})',
        r'Date[:\s]+(\d{1,2}\s+[A-Z][a-z]+\.?\s+\d{4})',
    ]
    date_formats = [
        '%d/%m/%Y','%m/%d/%Y','%d-%m-%Y','%m-%d-%Y','%d.%m.%Y','%m.%d.%Y',
        '%Y-%m-%d','%d/%m/%y','%m/%d/%y',
        '%B %d, %Y','%B %d %Y','%d %B %Y','%b %d, %Y','%b %d %Y','%d %b %Y',
        '%B. %d, %Y','%b. %d, %Y',
    ]
    import re
    from datetime import datetime as _dt
    for pattern in date_patterns:
        m = re.search(pattern, text[:2000], re.IGNORECASE)
        if m:
            raw = m.group(1).strip().rstrip('.')
            for fmt in date_formats:
                try:
                    return _dt.strptime(raw, fmt).strftime('%Y-%m-%d')
                except Exception:
                    pass
    return None


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
    2. Dedup: same file in same study → 409; new protocol version → auto-version + chain
    3. Extract document date from content
    4. Store raw file in S3 (bronze documents bucket)
    5. Write ingestion manifest
    6. Queue background processing (parse/chunk/embed/graph)
    7. Emit Kafka event
    """
    from fastapi.responses import JSONResponse
    import io

    if document_type not in SUPPORTED_DOC_TYPES:
        raise HTTPException(400, f"Unsupported document_type. Must be one of: {SUPPORTED_DOC_TYPES}")

    content = await file.read()
    sha256_hash = compute_sha256(content)
    file_size = len(content)

    # Use 'other' as the placeholder type when auto-detecting
    effective_type = "other" if document_type == "auto" else document_type

    # ── Deduplication & versioning ──────────────────────────────────────────────
    version_number = 1
    parent_document_id = None

    async with db_pool.acquire() as conn:
        if study_id:
            # 1. Exact duplicate within same study → reject
            same_file = await conn.fetchrow(
                "SELECT id, name, document_type, status FROM documents "
                "WHERE org_id=$1::uuid AND study_id=$2 AND sha256_hash=$3 LIMIT 1",
                org_id, study_id, sha256_hash
            )
            if same_file:
                return JSONResponse(status_code=409, content={
                    "duplicate": True,
                    "scope": "study",
                    "existing_document_id": str(same_file["id"]),
                    "existing_document_name": same_file["name"],
                    "existing_document_type": same_file["document_type"],
                    "existing_status": same_file["status"],
                    "message": f"This exact file has already been uploaded to this study: '{same_file['name']}'",
                })

            # 2. Protocol new-version detection: previous protocol exists for this study
            if effective_type == "protocol":
                prev = await conn.fetchrow(
                    "SELECT id, name, version, version_number FROM documents "
                    "WHERE org_id=$1::uuid AND study_id=$2 AND document_type='protocol' "
                    "ORDER BY version_number DESC LIMIT 1",
                    org_id, study_id
                )
                if prev:
                    version_number = prev["version_number"] + 1
                    version = f"{version_number}.0"
                    parent_document_id = str(prev["id"])
        else:
            # No study context — org-wide duplicate check (original behaviour)
            existing = await conn.fetchrow(
                "SELECT id, name, document_type, status, bronze_s3_key FROM documents "
                "WHERE org_id=$1 AND sha256_hash=$2 LIMIT 1",
                org_id, sha256_hash
            )
            if existing:
                return JSONResponse(status_code=409, content={
                    "duplicate": True,
                    "scope": "org",
                    "existing_document_id": str(existing["id"]),
                    "existing_document_name": existing["name"],
                    "existing_document_type": existing["document_type"],
                    "existing_status": existing["status"],
                    "s3_key": existing["bronze_s3_key"],
                    "message": f"A document with identical content already exists: '{existing['name']}'",
                })

    # ── Extract date from document content ────────────────────────────────────
    document_date = extract_document_date(content, file.filename)

    doc_id = str(uuid.uuid4())

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
    try:
        async with db_pool.acquire() as conn:
            await conn.execute("""
                INSERT INTO documents (id, org_id, study_id, document_type, name, file_name,
                    file_size_bytes, sha256_hash, version, version_number, parent_document_id,
                    document_date, source_type, bronze_s3_key, status, uploaded_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'upload',$13,'pending',$14)
            """, doc_id, org_id, study_id, effective_type, file.filename, file.filename,
                file_size, sha256_hash, version, version_number, parent_document_id,
                document_date, s3_key, uploaded_by)

            # For lab reports: create lab_report_ingestion record
            if effective_type == "lab_report" and lab_type:
                await conn.execute("""
                    INSERT INTO lab_report_ingestions (document_id, lab_type, site_id, report_date)
                    VALUES ($1,$2,$3,$4)
                """, doc_id, lab_type, site_id, report_date)
    except asyncpg.CheckViolationError as e:
        raise HTTPException(status_code=400, detail=f"Invalid document_type '{effective_type}'") from e
    except asyncpg.UniqueViolationError:
        # Race-condition: another upload of same file to same study won the race
        return JSONResponse(status_code=409, content={
            "duplicate": True,
            "scope": "study",
            "message": "This file has already been uploaded to this study.",
        })

    # Write ingestion manifest to S3
    manifest = {
        "manifest_version": "1.0",
        "document_id": doc_id,
        "org_id": org_id,
        "study_id": study_id,
        "document_type": effective_type,
        "requested_type": document_type,
        "file_name": file.filename,
        "file_size_bytes": file_size,
        "sha256_hash": sha256_hash,
        "version": version,
        "version_number": version_number,
        "parent_document_id": parent_document_id,
        "document_date": document_date,
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
    lineage_event = "new_version" if parent_document_id else "initial_upload"
    try:
        await mongo_db.document_lineage.insert_one({
            "document_id": doc_id,
            "parent_document_id": parent_document_id,
            "study_id": study_id,
            "tenant_id": org_id,
            "version": version,
            "version_number": version_number,
            "document_date": document_date,
            "file_name": file.filename,
            "sha256_hash": sha256_hash,
            "file_size_bytes": file_size,
            "uploaded_by_id": uploaded_by,
            "uploaded_by_name": uploaded_by_name or "",
            "uploaded_at": datetime.utcnow(),
            "event": lineage_event,
            "notes": f"Supersedes v{prev['version']}" if parent_document_id and 'prev' in dir() else "",
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
             version=version, version_number=version_number,
             auto_detect=document_type == "auto", org_id=org_id)
    return {
        "document_id": doc_id,
        "sha256_hash": sha256_hash,
        "s3_key": s3_key,
        "status": "pending",
        "version": version,
        "version_number": version_number,
        "is_new_version": parent_document_id is not None,
        "parent_document_id": parent_document_id,
        "document_date": document_date,
        "auto_detect": document_type == "auto",
        "message": (
            f"Protocol v{version} uploaded — supersedes previous version"
            if parent_document_id else
            "Document queued for processing"
            + (" — type will be auto-detected" if document_type == "auto" else "")
        ),
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
        lower_filename = (filename or "").lower().strip()
        file_base = lower_filename.rsplit("/", 1)[-1]
        file_stem = file_base.rsplit(".", 1)[0].upper() if "." in file_base else file_base.upper()

        # Fast path for SDTM domain CSV exports that are commonly named by domain.
        if auto_detect and file_base.endswith(".csv") and file_stem in SDTM_DATASET_NAMES:
            document_type = "sdtm_dataset"
            async with db_pool.acquire() as conn:
                await conn.execute("UPDATE documents SET document_type=$1 WHERE id=$2",
                                   document_type, doc_id)
            log.info("document.csv_domain_detected", doc_id=doc_id,
                     filename=filename, detected_type=document_type)
            auto_detect = False

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
        text_doc_types = {"protocol","sap","crf","csr","sdtm_ig","adam_ig","usdm_ig",
                          "lab_manual","dmp","icf","sdtm_dataset","adam_dataset","other",
                          "ich_guideline","controlled_terminology"}
        if document_type in text_doc_types:
            await process_text_document(doc_id, content, document_type, org_id, study_id, filename=filename)
        elif document_type == "lab_report":
            await process_lab_report(doc_id, content, lab_type, org_id, study_id)
        elif document_type == "study_budget":
            await process_budget(doc_id, content, org_id, study_id)
            # Budget parsing populates transactional tables but does not create
            # document chunks. For CSV-like uploads, also build chunk/index data
            # so the UI can show Stats/Details/Graph/Intelligence.
            if file_base.endswith((".csv", ".tsv", ".txt")):
                await process_text_document(doc_id, content, "other", org_id, study_id, filename=filename)

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
        # Distinguish whether section hierarchy came from embedded ToC or heading detection
        has_sections = any(c.get("section") and "/" in (c.get("section") or "") for c in chunks[:20])
        chunk_strategy = "section_based" if has_sections else "toc_driven"
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


@app.delete("/documents/{doc_id}", status_code=204)
async def delete_document(doc_id: str, org_id: str):
    """
    Permanently delete a document and ALL associated data:
    chunks, embeddings, pending classifications, lab report ingestions,
    site budgets, processing logs, folder assignments (MongoDB), and
    the context-graph nodes/edges.  Also removes the raw file from S3.
    """
    async with db_pool.acquire() as conn:
        doc = await conn.fetchrow(
            "SELECT id, org_id, bronze_s3_key FROM documents WHERE id=$1 AND org_id=$2",
            doc_id, org_id,
        )
    if not doc:
        raise HTTPException(404, "Document not found")

    # 1. Wipe graph nodes, edges and vector index entries
    try:
        await call_context_graph(
            f"/graph/document/{doc_id}", method="DELETE", params={"org_id": org_id}
        )
    except Exception as e:
        log.warning("delete_doc.graph_wipe_failed", doc_id=doc_id, error=str(e))

    # 2. Remove all relational data referencing this document
    async with db_pool.acquire() as conn:
        await conn.execute("DELETE FROM document_chunks WHERE document_id=$1", doc_id)
        await conn.execute("DELETE FROM pending_classifications WHERE document_id=$1", doc_id)
        await conn.execute("DELETE FROM lab_report_ingestions WHERE document_id=$1", doc_id)
        await conn.execute("DELETE FROM site_budgets WHERE source_document_id=$1", doc_id)
        await conn.execute("DELETE FROM processing_logs WHERE document_id=$1", doc_id)
        await conn.execute("DELETE FROM documents WHERE id=$1", doc_id)

    # 3. Remove folder assignment from MongoDB
    await mongo_db.folder_files.delete_one({"tenant_id": org_id, "document_id": doc_id})

    # 4. Delete raw file from S3 (best-effort)
    if doc["bronze_s3_key"]:
        try:
            s3 = get_s3_client()
            s3.delete_object(Bucket=settings.s3_bucket_docs, Key=doc["bronze_s3_key"])
        except Exception as e:
            log.warning("delete_doc.s3_delete_failed", doc_id=doc_id, error=str(e))

    log.info("document.deleted", doc_id=doc_id, org_id=org_id)


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
            f"SELECT id, name, document_type, version, status, sha256_hash, file_size_bytes, created_at, uploaded_by, is_foundational, metadata FROM documents WHERE {' AND '.join(conditions)} ORDER BY created_at DESC",
            *params
        )
        import json as _json
        docs_out = []
        for r in rows:
            d = dict(r)
            if isinstance(d.get("metadata"), str):
                try:
                    d["metadata"] = _json.loads(d["metadata"])
                except Exception:
                    d["metadata"] = {}
            docs_out.append(d)
        return {"documents": docs_out}


FOUNDATIONAL_CATEGORIES = {"standard", "codelist", "regulation"}

@app.patch("/documents/{doc_id}/foundational")
async def toggle_foundational(
    doc_id: str,
    org_id: str,
    is_foundational: bool,
    category: Optional[str] = None,
):
    """Mark or unmark a document as foundational (contributes to Foundation Graph).
    
    category: one of 'standard', 'codelist', 'regulation' (required when is_foundational=True).
    Maps to L1.E4 Standards, L1.E3 Controlled Terminology, L1.E2 Regulatory Requirements.
    """
    if is_foundational and category and category not in FOUNDATIONAL_CATEGORIES:
        raise HTTPException(400, f"category must be one of: {FOUNDATIONAL_CATEGORIES}")
    async with db_pool.acquire() as conn:
        doc = await conn.fetchrow(
            "SELECT id, metadata FROM documents WHERE id=$1 AND org_id=$2",
            doc_id, org_id,
        )
        if not doc:
            raise HTTPException(404, "Document not found")
        # Merge foundational_category into existing metadata
        existing_meta = {}
        if doc["metadata"]:
            try:
                existing_meta = json.loads(doc["metadata"]) if isinstance(doc["metadata"], str) else dict(doc["metadata"])
            except Exception:
                pass
        if is_foundational and category:
            existing_meta["foundational_category"] = category
        elif not is_foundational:
            existing_meta.pop("foundational_category", None)
        await conn.execute(
            "UPDATE documents SET is_foundational=$1, metadata=$2::jsonb, updated_at=NOW() WHERE id=$3",
            is_foundational, json.dumps(existing_meta), doc_id,
        )
    return {"ok": True, "is_foundational": is_foundational, "category": category if is_foundational else None}


@app.patch("/documents/{doc_id}/study")
async def assign_document_to_study(doc_id: str, org_id: str, study_id: str):
    """Assign (or reassign) a document to a study."""
    async with db_pool.acquire() as conn:
        doc = await conn.fetchrow(
            "SELECT id FROM documents WHERE id=$1 AND org_id=$2",
            doc_id, org_id,
        )
        if not doc:
            raise HTTPException(404, "Document not found")
        await conn.execute(
            "UPDATE documents SET study_id=$1, updated_at=NOW() WHERE id=$2",
            study_id, doc_id,
        )
    return {"ok": True, "document_id": doc_id, "study_id": study_id}

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


@app.get("/documents/{doc_id}/chunks/{chunk_id}")
async def get_chunk(doc_id: str, chunk_id: str):
    """Return full content for a single chunk by its UUID (for workbench full-text display)."""
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, chunk_index, page_number, section, content, metadata "
            "FROM document_chunks WHERE document_id=$1 AND id=$2",
            doc_id, chunk_id,
        )
    if not row:
        raise HTTPException(404, "Chunk not found")
    r = dict(row)
    r["id"] = str(r["id"])
    if isinstance(r.get("metadata"), str):
        try:
            r["metadata"] = json.loads(r["metadata"])
        except Exception:
            r["metadata"] = {}
    return r


@app.get("/documents/{doc_id}/serve")
async def serve_document(doc_id: str, request: Request):
    """Serve document with HTTP Range support, ETag caching, and non-blocking S3 I/O.

    Range requests let the browser's PDF viewer fetch only the pages it needs,
    eliminating the wait-for-full-download bottleneck.
    """
    import asyncio
    from fastapi.responses import Response, StreamingResponse

    async with db_pool.acquire() as conn:
        doc = await conn.fetchrow(
            "SELECT file_name, bronze_s3_key FROM documents WHERE id=$1", doc_id
        )
    if not doc or not doc["bronze_s3_key"]:
        raise HTTPException(404, "Document not found")

    fname    = doc["file_name"] or "document"
    s3_key   = doc["bronze_s3_key"]
    is_pdf   = fname.lower().endswith(".pdf")
    ctype    = "application/pdf" if is_pdf else "application/octet-stream"
    loop     = asyncio.get_event_loop()
    s3       = get_s3_client()

    # HEAD first — tiny call, gives us Content-Length + ETag without fetching data
    try:
        head = await loop.run_in_executor(
            None, lambda: s3.head_object(Bucket=settings.s3_bucket_docs, Key=s3_key)
        )
    except Exception as e:
        raise HTTPException(500, f"S3 head failed: {e}")

    total = head["ContentLength"]
    etag  = head.get("ETag", "").strip('"')

    base_headers = {
        "Content-Disposition": f'inline; filename="{fname}"',
        "Accept-Ranges":       "bytes",
        "Cache-Control":       "public, max-age=3600",
        "ETag":                f'"{etag}"',
    }

    # Honour If-None-Match — return 304 if browser already has this version cached
    if request.headers.get("If-None-Match", "").strip('"') == etag:
        return Response(status_code=304, headers=base_headers)

    # ── Byte-range request (PDF.js page-level fetches) ──────────────────────
    range_header = request.headers.get("Range", "")
    if range_header.startswith("bytes="):
        try:
            spec       = range_header[6:]
            start_s, end_s = spec.split("-", 1)
            start = int(start_s) if start_s else 0
            end   = int(end_s)   if end_s   else total - 1
            end   = min(end, total - 1)
        except Exception:
            raise HTTPException(416, "Range Not Satisfiable")

        data = await loop.run_in_executor(
            None,
            lambda: s3.get_object(
                Bucket=settings.s3_bucket_docs,
                Key=s3_key,
                Range=f"bytes={start}-{end}",
            )["Body"].read()
        )
        return Response(
            content=data,
            status_code=206,
            media_type=ctype,
            headers={
                **base_headers,
                "Content-Range":  f"bytes {start}-{end}/{total}",
                "Content-Length": str(end - start + 1),
            },
        )

    # ── Full file — stream in 64 KB chunks so the first bytes arrive quickly ─
    async def _stream():
        obj  = await loop.run_in_executor(
            None, lambda: s3.get_object(Bucket=settings.s3_bucket_docs, Key=s3_key)
        )
        body = obj["Body"]
        while True:
            chunk = await loop.run_in_executor(None, lambda: body.read(65536))
            if not chunk:
                break
            yield chunk

    return StreamingResponse(
        _stream(),
        status_code=200,
        media_type=ctype,
        headers={**base_headers, "Content-Length": str(total)},
    )


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


@app.get("/studies/{study_id}/protocol-lineage")
async def get_study_protocol_lineage(study_id: str, org_id: str):
    """Return the ordered version chain of protocols for a study (oldest → newest)."""
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT d.id, d.name, d.file_name, d.version, d.version_number,
                      d.document_date, d.parent_document_id, d.status,
                      d.sha256_hash, d.file_size_bytes, d.created_at,
                      d.metadata, u.name AS uploaded_by_name
               FROM documents d
               LEFT JOIN users u ON u.id::text = d.uploaded_by
               WHERE d.org_id=$1::uuid AND d.study_id=$2 AND d.document_type='protocol'
               ORDER BY d.version_number ASC""",
            org_id, study_id
        )
    return {
        "study_id": study_id,
        "protocols": [
            {
                "id": str(r["id"]),
                "name": r["name"],
                "file_name": r["file_name"],
                "version": r["version"],
                "version_number": r["version_number"],
                "document_date": r["document_date"].isoformat() if r["document_date"] else None,
                "parent_document_id": str(r["parent_document_id"]) if r["parent_document_id"] else None,
                "status": r["status"],
                "sha256_hash": r["sha256_hash"],
                "file_size_bytes": r["file_size_bytes"],
                "uploaded_at": r["created_at"].isoformat(),
                "uploaded_by_name": r["uploaded_by_name"] or "",
            }
            for r in rows
        ]
    }


@app.get("/studies")
async def list_studies(org_id: str):
    """Return studies for an org (used by lineage filter)."""
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, sponsor_protocol_id, title, phase, status "
            "FROM studies WHERE org_id=$1 ORDER BY created_at DESC",
            org_id
        )
    return {
        "studies": [
            {
                "id": str(r["id"]),
                "sponsor_protocol_id": r["sponsor_protocol_id"] or "",
                "title": r["title"] or "",
                "phase": r["phase"] or "",
                "status": r["status"] or "",
            }
            for r in rows
        ]
    }


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
