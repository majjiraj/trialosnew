"""
TrialOS Data Platform API
Exposes endpoints for triggering and monitoring Bronze→Silver→Gold pipelines.
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel
from pydantic_settings import BaseSettings
import structlog
import asyncpg
from sdtm_pipeline import BronzeToSilverPipeline, SilverToGoldPipeline, SDTMConformanceChecker
from datetime import datetime, timezone
import uuid

log = structlog.get_logger()

class Settings(BaseSettings):
    database_url: str
    s3_endpoint: str = "http://localhost:9000"

    class Config:
        env_file = ".env"

settings = Settings()
db_pool: asyncpg.Pool = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global db_pool
    db_pool = await asyncpg.create_pool(settings.database_url)
    log.info("data_platform.startup")
    yield
    await db_pool.close()

app = FastAPI(title="TrialOS Data Platform", version="1.0.0", lifespan=lifespan)

class PipelineRunRequest(BaseModel):
    study_id: str
    org_id: str
    domains: list[str] = ["DM","AE","LB","VS","CM"]
    source_records: dict[str, list[dict]]  # domain -> records

class ConformanceCheckRequest(BaseModel):
    study_id: str
    org_id: str
    domain_data: dict[str, list[dict]]

@app.get("/health")
async def health():
    return {"status": "ok", "service": "data-platform"}

@app.post("/pipeline/bronze-to-silver")
async def run_bronze_to_silver(req: PipelineRunRequest, background_tasks: BackgroundTasks):
    run_id = str(uuid.uuid4())
    background_tasks.add_task(_run_pipeline, run_id, req)
    return {"run_id": run_id, "status": "queued"}

async def _run_pipeline(run_id: str, req: PipelineRunRequest):
    pipeline = BronzeToSilverPipeline(db_pool)
    async with db_pool.acquire() as conn:
        study = await conn.fetchrow("SELECT * FROM studies WHERE id=$1", req.study_id)

    study_info = dict(study) if study else {}

    results = {}
    for domain in req.domains:
        if domain in req.source_records:
            result = await pipeline.transform_domain(
                req.study_id, req.org_id, domain,
                req.source_records[domain], study_info
            )
            results[domain] = result

    log.info("pipeline.bronze_to_silver.complete", run_id=run_id, domains=list(results.keys()))

@app.post("/conformance/check")
async def run_conformance_check(req: ConformanceCheckRequest):
    checker = SDTMConformanceChecker()
    result = checker.check_all_domains(req.domain_data)
    return result

@app.get("/lineage/{study_id}")
async def get_lineage(study_id: str, org_id: str, source_record_id: str = None):
    async with db_pool.acquire() as conn:
        if source_record_id:
            rows = await conn.fetch(
                "SELECT * FROM lineage_records WHERE study_id=$1 AND org_id=$2 AND source_record_id=$3",
                study_id, org_id, source_record_id
            )
        else:
            rows = await conn.fetch(
                "SELECT * FROM lineage_records WHERE study_id=$1 AND org_id=$2 ORDER BY transformed_at DESC LIMIT 100",
                study_id, org_id
            )
    return {"lineage": [dict(r) for r in rows]}
