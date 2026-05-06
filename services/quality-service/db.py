"""Database pool and table initialization for the Quality Service."""
from __future__ import annotations
import asyncpg

_pool: asyncpg.Pool | None = None


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("DB pool not initialized")
    return _pool


async def init_pool(dsn: str) -> asyncpg.Pool:
    global _pool
    _pool = await asyncpg.create_pool(dsn, min_size=3, max_size=15)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


CREATE_QUALITY_REPORTS = """
CREATE TABLE IF NOT EXISTS quality_reports (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversion_id   UUID,
    run_id          UUID,
    checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Provenance summary
    spans_verified          INTEGER NOT NULL DEFAULT 0,
    hallucinations_detected INTEGER NOT NULL DEFAULT 0,
    provenance_coverage     FLOAT   NOT NULL DEFAULT 0,

    -- Validation results (JSONB for flexibility)
    ich_m11_result   JSONB NOT NULL DEFAULT '{}',
    cdisc_ct_result  JSONB NOT NULL DEFAULT '{}',
    schema_result    JSONB NOT NULL DEFAULT '{}',

    -- Full field quality map and composite score
    field_quality    JSONB NOT NULL DEFAULT '{}',
    overall_score    FLOAT NOT NULL DEFAULT 0,
    overall_passed   BOOLEAN NOT NULL DEFAULT FALSE
);
"""

CREATE_FIELD_QUALITY_ENTRIES = """
CREATE TABLE IF NOT EXISTS field_quality_entries (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    report_id           UUID NOT NULL REFERENCES quality_reports(id) ON DELETE CASCADE,
    field_path          TEXT NOT NULL,
    quality_state       TEXT NOT NULL CHECK (quality_state IN ('verified','hallucinated','unverified')),
    source_span         TEXT,
    chunk_id            TEXT,
    hallucination_reason TEXT,
    section_id          TEXT,
    checked_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

CREATE_INDEXES = """
CREATE INDEX IF NOT EXISTS idx_quality_reports_conversion
    ON quality_reports (conversion_id);

CREATE INDEX IF NOT EXISTS idx_quality_reports_run
    ON quality_reports (run_id);

CREATE INDEX IF NOT EXISTS idx_quality_reports_checked_at
    ON quality_reports (checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_field_quality_report
    ON field_quality_entries (report_id);

CREATE INDEX IF NOT EXISTS idx_field_quality_state
    ON field_quality_entries (quality_state);
"""


async def init_db() -> None:
    pool = get_pool()
    async with pool.acquire() as conn:
        await conn.execute("CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\"")
        await conn.execute(CREATE_QUALITY_REPORTS)
        await conn.execute(CREATE_FIELD_QUALITY_ENTRIES)
        await conn.execute(CREATE_INDEXES)
