"""Quality Service — standalone microservice for USDM quality validation.

Exposes REST endpoints for:
  - Hallucination detection (source-span verification against retrieved chunks)
  - ICH M11 completeness checking
  - CDISC Controlled Terminology code validation
  - Schema / structural integrity checks
  - Composite quality run (all checks in one call)
  - Quality report storage and retrieval

Swagger UI: http://localhost:8016/docs
ReDoc:       http://localhost:8016/redoc
OpenAPI JSON: http://localhost:8016/openapi.json
"""
from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic_settings import BaseSettings

import db as database
from models import (
    FieldQualityEntry,
    HallucinationCheckRequest,
    HallucinationCheckResponse,
    QualityReportListResponse,
    QualityReportSummary,
    QualityRunRequest,
    QualityRunResponse,
    StructuralValidationRequest,
    StructuralValidationResponse,
    ValidationResult,
)
from validators.hallucination import (
    check_scalar_quality,
    collect_field_quality,
    verify_source_spans,
)
from validators.structural import (
    validate_cdisc_ct,
    validate_ich_m11,
    validate_schema_fields,
)

log = structlog.get_logger()


# ── Settings ──────────────────────────────────────────────────────────────────

class Settings(BaseSettings):
    database_url: str = "postgresql://quality:quality_dev@quality-postgres:5432/quality_db"
    service_port: int = 8016
    log_level: str = "INFO"

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()


# ── App lifecycle ─────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    await database.init_pool(settings.database_url)
    await database.init_db()
    log.info("quality_service.startup", port=settings.service_port)
    yield
    await database.close_pool()
    log.info("quality_service.shutdown")


app = FastAPI(
    title="Trialo Quality Service",
    description=(
        "Standalone quality validation microservice for USDM clinical trial data.\n\n"
        "Provides hallucination detection, ICH M11 completeness checks, CDISC CT "
        "code validation, and schema integrity checks. Quality reports are stored "
        "in an independent database and accessible to any downstream agent or service."
    ),
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    contact={"name": "Trialo Platform", "email": "platform@trialo.io"},
    license_info={"name": "Proprietary"},
    openapi_tags=[
        {
            "name": "quality",
            "description": "Full quality run: hallucination + structural + schema checks combined",
        },
        {
            "name": "hallucination",
            "description": "Source-span verification against retrieved document chunks",
        },
        {
            "name": "structural",
            "description": "ICH M11 completeness, CDISC CT codes, and USDM schema validation",
        },
        {
            "name": "reports",
            "description": "Retrieve and list stored quality reports",
        },
        {
            "name": "health",
            "description": "Service health and readiness",
        },
    ],
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _compute_overall_score(
    ich: dict, cdisc: dict, schema: dict, provenance_coverage: float
) -> float:
    return round(
        0.35 * ich["score"]
        + 0.25 * cdisc["score"]
        + 0.20 * schema["score"]
        + 0.20 * provenance_coverage,
        3,
    )


async def _save_report(
    pool,
    conversion_id: str | None,
    run_id: str | None,
    spans_verified: int,
    hallucinations_detected: int,
    provenance_coverage: float,
    field_quality: dict[str, str],
    ich_result: dict,
    cdisc_result: dict,
    schema_result: dict,
    overall_score: float,
    overall_passed: bool,
) -> str:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO quality_reports (
                conversion_id, run_id,
                spans_verified, hallucinations_detected, provenance_coverage,
                ich_m11_result, cdisc_ct_result, schema_result,
                field_quality, overall_score, overall_passed
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            RETURNING id
            """,
            conversion_id, run_id,
            spans_verified, hallucinations_detected, provenance_coverage,
            json.dumps(ich_result), json.dumps(cdisc_result), json.dumps(schema_result),
            json.dumps(field_quality), overall_score, overall_passed,
        )
        report_id = str(row["id"])

        # Persist individual field entries for fine-grained querying
        if field_quality:
            await conn.executemany(
                """
                INSERT INTO field_quality_entries
                    (report_id, field_path, quality_state)
                VALUES ($1, $2, $3)
                """,
                [(report_id, path, state) for path, state in field_quality.items()],
            )
        return report_id


# ── Health ────────────────────────────────────────────────────────────────────

@app.get(
    "/health",
    tags=["health"],
    summary="Service health check",
    response_description="Returns service status and DB connectivity",
)
async def health():
    pool = database.get_pool()
    async with pool.acquire() as conn:
        await conn.execute("SELECT 1")
    return {"status": "ok", "service": "quality-service", "version": "1.0.0"}


# ── Hallucination endpoints ───────────────────────────────────────────────────

@app.post(
    "/hallucination/check",
    tags=["hallucination"],
    response_model=HallucinationCheckResponse,
    summary="Verify extracted fields against source chunks",
    response_description=(
        "Returns annotated section_data with hallucination/verified flags, "
        "plus a flat field_quality map."
    ),
)
async def hallucination_check(body: HallucinationCheckRequest):
    """
    For every field in **section_data** that carries a `source_span`, verify
    whether that span literally appears in the supplied document **chunks**.

    - `verified` → span found verbatim in chunks
    - `hallucinated` → span not found (model invented it)
    - `unverified` → span present but verification was not run

    The annotated `section_data` (with added `hallucination_detected` / `verified`
    / `source_chunk_id` keys) is returned alongside a flat `field_quality` map
    suitable for storage in `provenance.field_quality`.
    """
    chunks_raw = [c.model_dump() for c in body.chunks]
    annotated, verified, hallucinated = verify_source_spans(
        body.section_data.copy(), chunks_raw
    )
    total = verified + hallucinated
    coverage = round(verified / total, 3) if total else 0.0
    field_quality = collect_field_quality(annotated)

    return HallucinationCheckResponse(
        spans_verified=verified,
        hallucinations_detected=hallucinated,
        provenance_coverage=coverage,
        field_quality=field_quality,
        annotated_data=annotated,
    )


# ── Structural validation endpoints ──────────────────────────────────────────

@app.post(
    "/structural/validate",
    tags=["structural"],
    response_model=StructuralValidationResponse,
    summary="Run ICH M11, CDISC CT, and schema checks on assembled USDM JSON",
    response_description="Per-check results with score (0-1) and gap list",
)
async def structural_validate(body: StructuralValidationRequest):
    """
    Runs three independent validators against the provided USDM v4 JSON:

    1. **ICH M11 completeness** — checks that all required protocol sections
       (identifiers, objectives, arms, epochs, population, indications) are
       present and non-empty.

    2. **CDISC CT codes** — spot-checks study arm type, epoch type, and study
       phase codes against the CDISC Controlled Terminology code lists.

    3. **Schema integrity** — detects non-USDM root-level fields, missing
       required structural keys (`versions`, `titles`, `versionIdentifier`).

    Each check returns `passed` (bool), `score` (0–1), and a `gaps` list
    describing each individual failure.
    """
    ich = validate_ich_m11(body.usdm_json)
    cdisc = validate_cdisc_ct(body.usdm_json)
    schema = validate_schema_fields(body.usdm_json)
    overall = _compute_overall_score(ich, cdisc, schema, 1.0)

    return StructuralValidationResponse(
        ich_m11=ValidationResult(**ich),
        cdisc_ct=ValidationResult(**cdisc),
        schema_check=ValidationResult(**schema),
        overall_score=overall,
        overall_passed=ich["passed"] and cdisc["passed"] and schema["passed"],
    )


# ── Full quality run ──────────────────────────────────────────────────────────

@app.post(
    "/quality/run",
    tags=["quality"],
    response_model=QualityRunResponse,
    summary="Run all quality checks and persist a quality report",
    response_description=(
        "Composite quality report with hallucination stats, structural validation, "
        "per-field quality map, and an overall 0–1 score."
    ),
    status_code=201,
)
async def quality_run(body: QualityRunRequest):
    """
    Execute the full quality pipeline on a USDM conversion:

    **Step 1 — Hallucination detection** (only when `section_results` + `chunks_by_section`
    are provided). Walks every extracted field's `source_span` and marks it as
    `verified`, `hallucinated`, or `unverified`.

    **Step 2 — Structural checks**. Runs ICH M11 completeness, CDISC CT code
    validation, and USDM schema integrity checks against the assembled `usdm_json`.

    **Step 3 — Composite score**. Weights: ICH M11 35 % · CDISC CT 25 % ·
    Schema 20 % · Provenance coverage 20 %.

    **Step 4 — Persist**. Saves a `quality_reports` row and individual
    `field_quality_entries` rows to the quality service database.

    Returns the `report_id` so agents can reference this report later via
    `GET /quality/reports/{report_id}`.
    """
    pool = database.get_pool()
    spans_verified = 0
    hallucinations_detected = 0
    field_quality: dict[str, str] = {}

    # Step 1: hallucination check (optional — requires raw section results + chunks)
    if body.section_results and body.chunks_by_section:
        for section_id, section_data in body.section_results.items():
            if not isinstance(section_data, (dict, list)):
                continue
            section_chunks_raw = [
                c.model_dump() for c in (body.chunks_by_section.get(section_id) or [])
            ]
            if not section_chunks_raw:
                continue
            annotated, v, h = verify_source_spans(section_data, section_chunks_raw)
            spans_verified += v
            hallucinations_detected += h
            section_fq = collect_field_quality(annotated, path_prefix=f".{section_id}")
            field_quality.update(section_fq)

    total = spans_verified + hallucinations_detected
    provenance_coverage = round(spans_verified / total, 3) if total else 0.0

    # Also collect quality from usdm_json.provenance.field_quality if already present
    existing_fq = body.usdm_json.get("provenance", {}).get("field_quality") or {}
    if existing_fq and not field_quality:
        field_quality = {str(k): str(v) for k, v in existing_fq.items()}
        # Re-derive counts from existing map
        for state in field_quality.values():
            if state == "verified":
                spans_verified += 1
            elif state == "hallucinated":
                hallucinations_detected += 1

    # Step 2: structural checks
    ich = validate_ich_m11(body.usdm_json)
    cdisc = validate_cdisc_ct(body.usdm_json)
    schema = validate_schema_fields(body.usdm_json)

    # Step 3: composite score
    overall_score = _compute_overall_score(ich, cdisc, schema, provenance_coverage)
    overall_passed = (
        ich["passed"]
        and cdisc["passed"]
        and schema["passed"]
        and hallucinations_detected == 0
    )

    # Step 4: persist
    now = datetime.now(timezone.utc)
    report_id = await _save_report(
        pool,
        conversion_id=body.conversion_id,
        run_id=body.run_id,
        spans_verified=spans_verified,
        hallucinations_detected=hallucinations_detected,
        provenance_coverage=provenance_coverage,
        field_quality=field_quality,
        ich_result=ich,
        cdisc_result=cdisc,
        schema_result=schema,
        overall_score=overall_score,
        overall_passed=overall_passed,
    )

    log.info(
        "quality_run.complete",
        report_id=report_id,
        conversion_id=body.conversion_id,
        overall_score=overall_score,
        hallucinations=hallucinations_detected,
        spans_verified=spans_verified,
    )

    return QualityRunResponse(
        report_id=report_id,
        conversion_id=body.conversion_id,
        run_id=body.run_id,
        checked_at=now,
        summary={
            "spans_verified": spans_verified,
            "hallucinations_detected": hallucinations_detected,
            "provenance_coverage": provenance_coverage,
        },
        field_quality=field_quality,
        structural=StructuralValidationResponse(
            ich_m11=ValidationResult(**ich),
            cdisc_ct=ValidationResult(**cdisc),
            schema_check=ValidationResult(**schema),
            overall_score=_compute_overall_score(ich, cdisc, schema, 1.0),
            overall_passed=ich["passed"] and cdisc["passed"] and schema["passed"],
        ),
        overall_score=overall_score,
        overall_passed=overall_passed,
    )


# ── Report retrieval ──────────────────────────────────────────────────────────

@app.get(
    "/quality/reports",
    tags=["reports"],
    response_model=QualityReportListResponse,
    summary="List quality reports with pagination",
)
async def list_reports(
    conversion_id: str | None = Query(None, description="Filter by conversion UUID"),
    run_id: str | None = Query(None, description="Filter by agent run UUID"),
    limit: int = Query(20, ge=1, le=100, description="Max results to return"),
    offset: int = Query(0, ge=0, description="Pagination offset"),
):
    """List stored quality reports. Optionally filter by `conversion_id` or `run_id`."""
    pool = database.get_pool()
    where_clauses: list[str] = []
    params: list[Any] = []
    i = 1

    if conversion_id:
        where_clauses.append(f"conversion_id = ${i}::uuid")
        params.append(conversion_id)
        i += 1
    if run_id:
        where_clauses.append(f"run_id = ${i}::uuid")
        params.append(run_id)
        i += 1

    where = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
    count_params = params[:]

    params.extend([limit, offset])

    async with pool.acquire() as conn:
        total_row = await conn.fetchrow(f"SELECT COUNT(*) FROM quality_reports {where}", *count_params)
        total = total_row["count"]
        rows = await conn.fetch(
            f"""
            SELECT id, conversion_id, run_id, checked_at,
                   overall_score, overall_passed,
                   spans_verified, hallucinations_detected,
                   ich_m11_result->'score' AS ich_m11_score,
                   cdisc_ct_result->'score' AS cdisc_ct_score
            FROM quality_reports {where}
            ORDER BY checked_at DESC
            LIMIT ${i} OFFSET ${i+1}
            """,
            *params,
        )

    reports = [
        QualityReportSummary(
            report_id=str(r["id"]),
            conversion_id=str(r["conversion_id"]) if r["conversion_id"] else None,
            run_id=str(r["run_id"]) if r["run_id"] else None,
            checked_at=r["checked_at"],
            overall_score=float(r["overall_score"]),
            overall_passed=bool(r["overall_passed"]),
            spans_verified=int(r["spans_verified"]),
            hallucinations_detected=int(r["hallucinations_detected"]),
            ich_m11_score=float(r["ich_m11_score"] or 0),
            cdisc_ct_score=float(r["cdisc_ct_score"] or 0),
        )
        for r in rows
    ]
    return QualityReportListResponse(total=total, reports=reports)


@app.get(
    "/quality/reports/{report_id}",
    tags=["reports"],
    response_model=QualityRunResponse,
    summary="Get a specific quality report by ID",
)
async def get_report(report_id: str):
    """Retrieve a stored quality report by its UUID."""
    pool = database.get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, conversion_id, run_id, checked_at,
                   spans_verified, hallucinations_detected, provenance_coverage,
                   ich_m11_result, cdisc_ct_result, schema_result,
                   field_quality, overall_score, overall_passed
            FROM quality_reports WHERE id = $1::uuid
            """,
            report_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail=f"Report {report_id!r} not found")

    ich = json.loads(row["ich_m11_result"])
    cdisc = json.loads(row["cdisc_ct_result"])
    schema = json.loads(row["schema_result"])
    fq_raw = json.loads(row["field_quality"])

    return QualityRunResponse(
        report_id=str(row["id"]),
        conversion_id=str(row["conversion_id"]) if row["conversion_id"] else None,
        run_id=str(row["run_id"]) if row["run_id"] else None,
        checked_at=row["checked_at"],
        summary={
            "spans_verified": row["spans_verified"],
            "hallucinations_detected": row["hallucinations_detected"],
            "provenance_coverage": float(row["provenance_coverage"]),
        },
        field_quality=fq_raw,
        structural=StructuralValidationResponse(
            ich_m11=ValidationResult(**ich),
            cdisc_ct=ValidationResult(**cdisc),
            schema_check=ValidationResult(**schema),
            overall_score=_compute_overall_score(ich, cdisc, schema, 1.0),
            overall_passed=ich.get("passed", False)
            and cdisc.get("passed", False)
            and schema.get("passed", False),
        ),
        overall_score=float(row["overall_score"]),
        overall_passed=bool(row["overall_passed"]),
    )


@app.get(
    "/quality/conversions/{conversion_id}/report",
    tags=["reports"],
    response_model=QualityRunResponse,
    summary="Get the most recent quality report for a conversion",
)
async def get_conversion_report(conversion_id: str):
    """Retrieve the latest quality report for a given `conversion_id`."""
    pool = database.get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id FROM quality_reports
            WHERE conversion_id = $1::uuid
            ORDER BY checked_at DESC LIMIT 1
            """,
            conversion_id,
        )
    if not row:
        raise HTTPException(
            status_code=404,
            detail=f"No quality report found for conversion {conversion_id!r}",
        )
    return await get_report(str(row["id"]))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=settings.service_port, reload=False)
