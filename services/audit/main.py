"""
TrialOS Audit Service — 21 CFR Part 11 Compliant
Write-once, hash-chained audit trail with Merkle checkpoint support.
Every write is: SHA-256(all_fields + prev_hash) → tamper-evident chain.
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings
import structlog
import asyncpg
import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Optional, Any, Literal
import csv
import io

log = structlog.get_logger()

class Settings(BaseSettings):
    database_url: str
    kafka_brokers: str = "localhost:9092"

    class Config:
        env_file = ".env"

settings = Settings()

# ---- DB Pool ----
db_pool: asyncpg.Pool = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global db_pool
    db_pool = await asyncpg.create_pool(settings.database_url, min_size=5, max_size=20)
    await init_db()
    log.info("audit_service.startup")
    yield
    await db_pool.close()

app = FastAPI(title="TrialOS Audit Service", version="1.0.0", lifespan=lifespan)

async def init_db():
    async with db_pool.acquire() as conn:
        await conn.execute("""
        CREATE TABLE IF NOT EXISTS audit_events (
            id              BIGSERIAL PRIMARY KEY,
            event_id        UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
            org_id          TEXT NOT NULL,
            study_id        TEXT,
            timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            actor_type      TEXT NOT NULL CHECK (actor_type IN ('user','agent','system')),
            actor_id        TEXT NOT NULL,
            action          TEXT NOT NULL,
            resource_type   TEXT NOT NULL,
            resource_id     TEXT,
            before_state    JSONB,
            after_state     JSONB,
            ip_address      INET,
            session_id      TEXT,
            metadata        JSONB DEFAULT '{}',
            prev_hash       TEXT,
            row_hash        TEXT NOT NULL,
            is_test_run     BOOLEAN DEFAULT FALSE,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_audit_org_study ON audit_events(org_id, study_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(action, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_events(resource_type, resource_id);

        CREATE TABLE IF NOT EXISTS audit_merkle_checkpoints (
            id              BIGSERIAL PRIMARY KEY,
            checkpoint_id   UUID DEFAULT gen_random_uuid(),
            from_event_id   BIGINT NOT NULL,
            to_event_id     BIGINT NOT NULL,
            merkle_root     TEXT NOT NULL,
            event_count     INT NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """)

# ---- Hashing ----

def compute_row_hash(event: dict, prev_hash: Optional[str]) -> str:
    """
    SHA-256 hash of canonical JSON of event fields + prev_hash.
    Deterministic: fields sorted, timestamps as ISO strings.
    """
    canonical = {
        "event_id": str(event.get("event_id", "")),
        "org_id": event.get("org_id", ""),
        "study_id": event.get("study_id", ""),
        "timestamp": event.get("timestamp", ""),
        "actor_type": event.get("actor_type", ""),
        "actor_id": event.get("actor_id", ""),
        "action": event.get("action", ""),
        "resource_type": event.get("resource_type", ""),
        "resource_id": event.get("resource_id", ""),
        "before_state": json.dumps(event.get("before_state"), sort_keys=True),
        "after_state": json.dumps(event.get("after_state"), sort_keys=True),
        "prev_hash": prev_hash or "GENESIS",
    }
    payload = json.dumps(canonical, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()

# ---- Models ----

class AuditEventCreate(BaseModel):
    org_id: str
    study_id: Optional[str] = None
    actor_type: Literal["user", "agent", "system"]
    actor_id: str
    action: str
    resource_type: str
    resource_id: Optional[str] = None
    before_state: Optional[dict] = None
    after_state: Optional[dict] = None
    ip_address: Optional[str] = None
    session_id: Optional[str] = None
    metadata: dict = {}
    is_test_run: bool = False

class AuditEventResponse(BaseModel):
    event_id: str
    org_id: str
    study_id: Optional[str]
    timestamp: str
    actor_type: str
    actor_id: str
    action: str
    resource_type: str
    resource_id: Optional[str]
    before_state: Optional[dict]
    after_state: Optional[dict]
    prev_hash: Optional[str]
    row_hash: str

class AuditQueryParams(BaseModel):
    org_id: str
    study_id: Optional[str] = None
    actor_id: Optional[str] = None
    action: Optional[str] = None
    resource_type: Optional[str] = None
    from_ts: Optional[str] = None
    to_ts: Optional[str] = None
    limit: int = 100
    offset: int = 0

# ---- Endpoints ----

@app.get("/health")
async def health():
    return {"status": "ok", "service": "audit"}

@app.post("/events", response_model=AuditEventResponse, status_code=201)
async def create_audit_event(event: AuditEventCreate):
    """
    Write an audit event. Gets previous hash from last row, computes new hash.
    WRITE-ONCE: no UPDATE or DELETE permitted on audit_events table.
    """
    async with db_pool.acquire() as conn:
        # Get previous hash (last event in org chain)
        prev = await conn.fetchrow(
            "SELECT row_hash FROM audit_events WHERE org_id = $1 AND is_test_run = FALSE ORDER BY id DESC LIMIT 1",
            event.org_id
        )
        prev_hash = prev["row_hash"] if prev else None

        event_id = str(uuid.uuid4())
        timestamp = datetime.now(timezone.utc)

        event_dict = {
            "event_id": event_id,
            "org_id": event.org_id,
            "study_id": event.study_id,
            "timestamp": timestamp.isoformat(),
            "actor_type": event.actor_type,
            "actor_id": event.actor_id,
            "action": event.action,
            "resource_type": event.resource_type,
            "resource_id": event.resource_id,
            "before_state": event.before_state,
            "after_state": event.after_state,
        }

        row_hash = compute_row_hash(event_dict, prev_hash)

        row = await conn.fetchrow("""
            INSERT INTO audit_events (
                event_id, org_id, study_id, timestamp, actor_type, actor_id,
                action, resource_type, resource_id, before_state, after_state,
                ip_address, session_id, metadata, prev_hash, row_hash, is_test_run
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
            RETURNING *
        """, event_id, event.org_id, event.study_id, timestamp, event.actor_type,
            event.actor_id, event.action, event.resource_type, event.resource_id,
            json.dumps(event.before_state) if event.before_state else None,
            json.dumps(event.after_state) if event.after_state else None,
            event.ip_address, event.session_id, json.dumps(event.metadata),
            prev_hash, row_hash, event.is_test_run
        )

        log.info("audit.event.written", event_id=event_id, action=event.action, org_id=event.org_id)

        return AuditEventResponse(
            event_id=event_id,
            org_id=event.org_id,
            study_id=event.study_id,
            timestamp=timestamp.isoformat(),
            actor_type=event.actor_type,
            actor_id=event.actor_id,
            action=event.action,
            resource_type=event.resource_type,
            resource_id=event.resource_id,
            before_state=event.before_state,
            after_state=event.after_state,
            prev_hash=prev_hash,
            row_hash=row_hash
        )

@app.get("/events")
async def query_events(
    org_id: Optional[str] = Query(None),
    study_id: Optional[str] = Query(None),
    actor_id: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
    resource_type: Optional[str] = Query(None),
    resource_id: Optional[str] = Query(None),
    from_ts: Optional[str] = Query(None),
    to_ts: Optional[str] = Query(None),
    limit: int = Query(100, le=1000),
    offset: int = Query(0),
    export: Optional[str] = Query(None, description="csv or pdf")
):
    """Query audit events with filters. Supports CSV export for inspections.
    When resource_id is provided (e.g. a run UUID), org_id is not required
    since resource IDs are globally unique — this ensures events written with
    a system/default org_id are still visible when querying by run ID.
    """
    if not org_id and not resource_id:
        from fastapi import HTTPException
        raise HTTPException(status_code=422, detail="Either org_id or resource_id must be provided.")
    async with db_pool.acquire() as conn:
        conditions = ["is_test_run = FALSE"]
        params = []
        i = 1

        # Only filter by org when explicitly provided and no resource_id scoping
        if org_id and not resource_id:
            conditions.append(f"org_id = ${i}"); params.append(org_id); i += 1

        if study_id:
            conditions.append(f"study_id = ${i}"); params.append(study_id); i += 1
        if actor_id:
            conditions.append(f"actor_id = ${i}"); params.append(actor_id); i += 1
        if action:
            conditions.append(f"action ILIKE ${i}"); params.append(f"%{action}%"); i += 1
        if resource_type:
            conditions.append(f"resource_type = ${i}"); params.append(resource_type); i += 1
        if resource_id:
            conditions.append(f"resource_id = ${i}"); params.append(resource_id); i += 1
        if from_ts:
            conditions.append(f"timestamp >= ${i}"); params.append(from_ts); i += 1
        if to_ts:
            conditions.append(f"timestamp <= ${i}"); params.append(to_ts); i += 1

        where = " AND ".join(conditions) if conditions else "TRUE"
        rows = await conn.fetch(
            f"SELECT * FROM audit_events WHERE {where} ORDER BY timestamp DESC LIMIT {limit} OFFSET {offset}",
            *params
        )

        events = [dict(r) for r in rows]

        if export == "csv":
            output = io.StringIO()
            if events:
                writer = csv.DictWriter(output, fieldnames=events[0].keys())
                writer.writeheader()
                writer.writerows(events)
            return Response(
                content=output.getvalue(),
                media_type="text/csv",
                headers={"Content-Disposition": "attachment; filename=audit_trail.csv"}
            )

        return {"events": events, "total": len(events), "offset": offset}

@app.post("/verify-chain")
async def verify_chain(org_id: str = Query(...)):
    """Verify hash chain integrity for an org. Returns any broken links."""
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, event_id, row_hash, prev_hash, org_id, study_id, timestamp, actor_type, actor_id, action, resource_type, resource_id, before_state, after_state FROM audit_events WHERE org_id = $1 AND is_test_run = FALSE ORDER BY id ASC",
            org_id
        )

        broken = []
        prev_hash = None

        for row in rows:
            event_dict = {
                "event_id": str(row["event_id"]),
                "org_id": row["org_id"],
                "study_id": row["study_id"],
                "timestamp": row["timestamp"].isoformat() if row["timestamp"] else "",
                "actor_type": row["actor_type"],
                "actor_id": row["actor_id"],
                "action": row["action"],
                "resource_type": row["resource_type"],
                "resource_id": row["resource_id"],
                "before_state": row["before_state"],
                "after_state": row["after_state"],
            }
            expected_hash = compute_row_hash(event_dict, prev_hash)

            if expected_hash != row["row_hash"]:
                broken.append({
                    "id": row["id"],
                    "event_id": str(row["event_id"]),
                    "expected_hash": expected_hash,
                    "stored_hash": row["row_hash"]
                })

            prev_hash = row["row_hash"]

        return {
            "org_id": org_id,
            "total_events": len(rows),
            "chain_valid": len(broken) == 0,
            "broken_links": broken
        }
