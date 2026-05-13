"""
TrialOS Study Graph Service  (port 8013)
=========================================
Layer 2 — Client-Specific Knowledge Graphs.

Manages rich Neo4j-backed graphs for:
  • Study Design (arms, endpoints, eligibility, visits, activities)
  • Data Operations (EDC, Labs, ePRO, RTSM sources + flows)
  • Process/SOP (roles, SOPs, approval workflows)
  • Decision Memory (known overrides, exceptions, regulatory shifts)
  • Issue/Risk Registry
  • Portfolio Intelligence (cross-study analytics)
  • Vendor Ecosystem
  • Submission Graph

PostgreSQL tables mirror key nodes for SQL reporting and vector similarity search.
Neo4j is the primary graph store; PostgreSQL is the analytics mirror.
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
import hashlib
import asyncio
import httpx
from datetime import datetime, timezone
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
    neo4j_url: str              = "bolt://localhost:7687"
    neo4j_username: str         = "neo4j"
    neo4j_password: str         = "trialo_dev"
    redis_url: str              = "redis://localhost:6379"
    ollama_base_url: str        = "http://localhost:11434"
    embedding_model: str        = "nomic-embed-text"
    embedding_dim: int          = 768
    kafka_brokers: str          = "localhost:9092"
    context_graph_url: str      = "http://localhost:8008"
    standards_registry_url: str = "http://localhost:8012"

    class Config:
        env_file = ".env"
        extra = 'ignore'


settings      = Settings()
db_pool:      asyncpg.Pool = None
redis_client: Any          = None
_neo4j_driver: Any         = None


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


async def _neo4j_run(cypher: str, params: dict = None) -> list:
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
    # USDM v4.0 class labels + platform operational labels
    labels = [
        # USDM v4.0 core design classes
        "StudyDesign", "StudyArm", "StudyEpoch", "StudyCell", "StudyElement",
        "Activity", "Encounter", "ScheduleTimeline", "ScheduledActivityInstance",
        "BiomedicalConcept", "Procedure",
        "EligibilityCriterion", "StudyDesignPopulation", "StudyCohort",
        "Indication", "Estimand", "IntercurrentEvent",
        "Objective", "StudyEndpoint",
        # Platform operational labels
        "DataSource", "SOP", "Role", "Issue", "DecisionMemory", "Vendor", "Submission",
    ]
    for label in labels:
        await _neo4j_run(
            f"CREATE CONSTRAINT IF NOT EXISTS FOR (n:{label}) REQUIRE n.id IS UNIQUE"
        )


# ─── Lifespan ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global db_pool, redis_client, _neo4j_driver

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
            log.info("study_graph.redis_connected")
        except Exception as exc:
            log.warning("study_graph.redis_unavailable", error=str(exc))
            redis_client = None

    try:
        from neo4j import AsyncGraphDatabase
        _neo4j_driver = AsyncGraphDatabase.driver(
            settings.neo4j_url,
            auth=(settings.neo4j_username, settings.neo4j_password),
        )
        await _neo4j_run("RETURN 1")
        await _neo4j_init_constraints()
        log.info("study_graph.neo4j_connected")
    except Exception as exc:
        log.warning("study_graph.neo4j_unavailable", error=str(exc))
        _neo4j_driver = None

    log.info("study_graph.startup", port=8013)
    yield
    await db_pool.close()
    if redis_client:
        await redis_client.aclose()
    if _neo4j_driver:
        await _neo4j_driver.close()


app = FastAPI(title="TrialOS Study Graph", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ─── Pydantic Models ──────────────────────────────────────────────────────────

class DesignExtractRequest(BaseModel):
    usdm_data:   Optional[dict] = None
    source_text: Optional[str]  = None
    source:      str = "usdm"

class DecisionMemoryCreate(BaseModel):
    category:       str
    context_text:   str
    rationale:      str
    impact_domains: list[str] = []
    approved_by:    Optional[str] = None
    expires_at:     Optional[str] = None
    metadata:       dict = {}

class DecisionMemoryQuery(BaseModel):
    context_query: str
    top_k:         int = 5
    org_id:        Optional[str] = None
    category:      Optional[str] = None

class IssueCreate(BaseModel):
    issue_type:    str
    title:         str
    description:   Optional[str] = None
    severity:      str = "medium"
    related_domain: Optional[str] = None
    assigned_to:   Optional[str] = None
    metadata:      dict = {}
    org_id:        Optional[str] = None

class StudyCreate(BaseModel):
    org_id:           str
    name:             str
    protocol_number:  str
    phase:            Optional[str] = None
    therapeutic_area: Optional[str] = None
    indication:       Optional[str] = None
    sponsor_name:     Optional[str] = None
    status:           str = "planning"
    is_blinded:       bool = False


# ─── Health ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "study-graph", "port": 8013,
            "neo4j": _neo4j_driver is not None}


# ─── Study Design Graph ───────────────────────────────────────────────────────

@app.post("/study/{study_id}/design/extract")
async def extract_study_design(study_id: str, body: DesignExtractRequest, org_id: str = Query(...)):
    """
    Extract study design elements from USDM v4.0 data into Neo4j + PostgreSQL.

    Handles USDM v4.0 nested structure:
      study.versions[].studyDesigns[] → arms, epochs, studyCells, elements,
      activities (with procedures + BCs), encounters, scheduleTimelines,
      objectives (with endpoints), estimands, indications,
      population (criteria with IETESTCD/IECAT, cohorts, plannedEnrollment).
    """
    usdm = body.usdm_data or {}
    elements_created = []

    # ── Navigate USDM v4.0 nested path ────────────────────────────────────────
    # Standard path: study.versions[0].studyDesigns[0]
    # Fallback: top-level dict (pre-v4 or flattened exports)
    design = _usdm_design(usdm)

    # Anchor the top-level StudyDesign node in Neo4j
    design_name = design.get("name", design.get("label", study_id))
    await _neo4j_run(
        "MERGE (sd:StudyDesign {id: $id}) SET sd.study_id = $sid, sd.name = $name, sd.updated_at = datetime()",
        {"id": study_id, "sid": study_id, "name": design_name},
    )

    # ── Arms (StudyArm) ───────────────────────────────────────────────────────
    for arm in design.get("arms", design.get("studyArms", [])):
        arm_type = _code_value(arm.get("type"))
        elem = {
            "element_type": "arm",
            "label": arm.get("name", arm.get("label", "Unnamed Arm")),
            "metadata": {**arm, "arm_type": arm_type},
        }
        eid = await _upsert_design_element(study_id, org_id, elem, body.source)
        elements_created.append({"type": "arm", "id": eid, "label": elem["label"]})
        await _neo4j_run(
            "MERGE (a:StudyArm {id: $id}) SET a.name = $name, a.type = $type, a.study_id = $sid "
            "WITH a MATCH (sd:StudyDesign {id: $sid}) MERGE (sd)-[:HAS_ARM]->(a)",
            {"id": eid, "name": elem["label"], "type": arm_type, "sid": study_id},
        )

    # ── Epochs (StudyEpoch) ────────────────────────────────────────────────────
    epoch_ids: dict[str, str] = {}
    for epoch in design.get("epochs", design.get("studyEpochs", [])):
        epoch_type = _code_value(epoch.get("type"))
        label = epoch.get("name", epoch.get("label", "Unnamed Epoch"))
        elem = {
            "element_type": "epoch",
            "label": label,
            "metadata": {**epoch, "epoch_type": epoch_type},
        }
        eid = await _upsert_design_element(study_id, org_id, elem, body.source)
        epoch_ids[epoch.get("id", eid)] = eid
        elements_created.append({"type": "epoch", "id": eid, "label": label, "epoch_type": epoch_type})
        await _neo4j_run(
            "MERGE (e:StudyEpoch {id: $id}) SET e.name = $name, e.type = $type, e.study_id = $sid "
            "WITH e MATCH (sd:StudyDesign {id: $sid}) MERGE (sd)-[:HAS_EPOCH]->(e)",
            {"id": eid, "name": label, "type": epoch_type, "sid": study_id},
        )

    # ── Study Elements (StudyElement) ─────────────────────────────────────────
    for element in design.get("elements", design.get("studyElements", [])):
        label = element.get("name", element.get("label", "Unnamed Element"))
        trans_start = element.get("transitionStartRule", {}).get("description", "")
        trans_end   = element.get("transitionEndRule",   {}).get("description", "")
        elem = {
            "element_type": "element",
            "label": label,
            "metadata": {**element, "transition_start": trans_start, "transition_end": trans_end},
        }
        eid = await _upsert_design_element(study_id, org_id, elem, body.source)
        elements_created.append({"type": "element", "id": eid, "label": label})
        await _neo4j_run(
            "MERGE (se:StudyElement {id: $id}) SET se.name = $name, se.study_id = $sid",
            {"id": eid, "name": label, "sid": study_id},
        )

    # ── Study Cells (StudyCell — arm×epoch cross product) ─────────────────────
    for cell in design.get("studyCells", []):
        arm_ref   = cell.get("arm",   {}).get("id", "")
        epoch_ref = cell.get("epoch", {}).get("id", "")
        label = f"Cell({arm_ref[:8]}×{epoch_ref[:8]})"
        elem = {"element_type": "cell", "label": label, "metadata": cell}
        eid = await _upsert_design_element(study_id, org_id, elem, body.source)
        elements_created.append({"type": "cell", "id": eid})
        if arm_ref and epoch_ref:
            await _neo4j_run(
                "MATCH (a:StudyArm {id: $aid}), (e:StudyEpoch {id: $eid}) MERGE (a)-[:IN_EPOCH]->(e)",
                {"aid": epoch_ids.get(arm_ref, arm_ref), "eid": epoch_ids.get(epoch_ref, epoch_ref)},
            )

    # ── Activities (Activity with Procedures + BiomedicalConcepts) ────────────
    for activity in design.get("activities", []):
        procs = [p.get("name", p.get("label", "")) for p in activity.get("definedProcedures", [])]
        bcs   = [bc.get("name", bc.get("label", "")) for bc in activity.get("biomedicalConcepts", [])]
        label = activity.get("name", activity.get("label", "Unnamed Activity"))
        elem = {
            "element_type": "activity",
            "label": label,
            "metadata": {**{k: v for k, v in activity.items() if k not in ("definedProcedures", "biomedicalConcepts", "children", "next", "previous")},
                         "procedures": procs, "biomedical_concepts": bcs},
        }
        eid = await _upsert_design_element(study_id, org_id, elem, body.source)
        elements_created.append({"type": "activity", "id": eid, "label": label,
                                  "procedures": len(procs), "bcs": len(bcs)})
        await _neo4j_run(
            "MERGE (a:Activity {id: $id}) SET a.name = $name, a.study_id = $sid "
            "WITH a MATCH (sd:StudyDesign {id: $sid}) MERGE (sd)-[:HAS_ACTIVITY]->(a)",
            {"id": eid, "name": label, "sid": study_id},
        )

    # ── Encounters (Encounter / Visit) ─────────────────────────────────────────
    for encounter in design.get("encounters", []):
        label = encounter.get("name", encounter.get("label", "Unnamed Encounter"))
        elem = {"element_type": "encounter", "label": label, "metadata": encounter}
        eid = await _upsert_design_element(study_id, org_id, elem, body.source)
        elements_created.append({"type": "encounter", "id": eid, "label": label})
        await _neo4j_run(
            "MERGE (en:Encounter {id: $id}) SET en.name = $name, en.study_id = $sid",
            {"id": eid, "name": label, "sid": study_id},
        )

    # ── Schedule Timelines (ScheduleTimeline) ─────────────────────────────────
    for timeline in design.get("scheduleTimelines", []):
        label = timeline.get("name", timeline.get("label", "Unnamed Timeline"))
        elem = {"element_type": "schedule_timeline", "label": label, "metadata": timeline}
        eid = await _upsert_design_element(study_id, org_id, elem, body.source)
        elements_created.append({"type": "schedule_timeline", "id": eid, "label": label})
        await _neo4j_run(
            "MERGE (st:ScheduleTimeline {id: $id}) SET st.name = $name, st.study_id = $sid",
            {"id": eid, "name": label, "sid": study_id},
        )

    # ── Objectives → Endpoints (Objective / StudyEndpoint) ───────────────────
    for obj in design.get("objectives", []):
        obj_label = obj.get("description", obj.get("name", obj.get("label", "Unnamed Objective")))
        obj_elem = {
            "element_type": "endpoint",
            "label": obj_label[:500],
            "metadata": {**{k: v for k, v in obj.items() if k != "endpoints"},
                         "endpoint_type": "primary_objective"},
        }
        await _upsert_design_element(study_id, org_id, obj_elem, body.source)
        for ep in obj.get("endpoints", []):
            ep_label = ep.get("description", ep.get("name", ep.get("label", "Unnamed Endpoint")))
            ep_type  = _classify_endpoint_type(ep)
            elem = {"element_type": "endpoint", "label": ep_label[:500],
                    "metadata": {**ep, "endpoint_type": ep_type}}
            eid = await _upsert_design_element(study_id, org_id, elem, body.source)
            elements_created.append({"type": "endpoint", "id": eid, "label": ep_label, "endpoint_type": ep_type})
            await _neo4j_run(
                "MERGE (se:StudyEndpoint {id: $id}) SET se.name = $name, se.type = $type, se.study_id = $sid",
                {"id": eid, "name": ep_label[:200], "type": ep_type, "sid": study_id},
            )

    # ── Estimands (Estimand) ──────────────────────────────────────────────────
    for estimand in design.get("estimands", []):
        label = estimand.get("name", estimand.get("label", "Unnamed Estimand"))
        elem = {"element_type": "estimand", "label": label, "metadata": estimand}
        eid = await _upsert_design_element(study_id, org_id, elem, body.source)
        elements_created.append({"type": "estimand", "id": eid, "label": label})
        await _neo4j_run(
            "MERGE (es:Estimand {id: $id}) SET es.name = $name, es.study_id = $sid",
            {"id": eid, "name": label, "sid": study_id},
        )

    # ── Indications (Indication) ──────────────────────────────────────────────
    for indication in design.get("indications", []):
        label = indication.get("name", indication.get("label", "Unnamed Indication"))
        is_rare = indication.get("isRareDisease", False)
        elem = {"element_type": "indication", "label": label,
                "metadata": {**indication, "is_rare_disease": is_rare}}
        eid = await _upsert_design_element(study_id, org_id, elem, body.source)
        elements_created.append({"type": "indication", "id": eid, "label": label, "is_rare": is_rare})
        await _neo4j_run(
            "MERGE (ind:Indication {id: $id}) SET ind.name = $name, ind.isRareDisease = $rare, ind.study_id = $sid",
            {"id": eid, "name": label, "rare": is_rare, "sid": study_id},
        )

    # ── Population + Eligibility Criteria (USDM v4.0 TI domain mapping) ──────
    population = design.get("population", {})
    if population:
        pop_label = population.get("name", population.get("label", "Study Population"))
        pop_elem = {
            "element_type": "population",
            "label": pop_label,
            "metadata": {
                "planned_sex":    _code_value(population.get("plannedSex")),
                "planned_age":    population.get("plannedAge"),
                "includes_healthy_subjects": population.get("includesHealthySubjects", False),
                "planned_enrollment_range": population.get("plannedEnrollmentNumberRange"),
                "planned_enrollment_quantity": population.get("plannedEnrollmentNumberQuantity"),
            },
        }
        await _upsert_design_element(study_id, org_id, pop_elem, body.source)

        # Eligibility criteria — USDM v4.0 maps to SDTM TI domain:
        # criterion.identifier → IETESTCD, criterion.category.code → IECAT (INCL/EXCL)
        criteria_sources = population.get("criteria", []) + design.get("eligibilityCriteria", [])
        for criterion in criteria_sources:
            ietestcd = criterion.get("identifier", "")
            iecat_code = _code_value(criterion.get("category"))
            iecat = "INCL" if (iecat_code or "").upper() in ("INCLUSION", "INCL", "I") else "EXCL"
            text = criterion.get("text", criterion.get("description", criterion.get("name", "")))
            if isinstance(text, dict):
                text = text.get("value", text.get("text", json.dumps(text)))
            label = f"[{ietestcd}] {str(text)[:450]}" if ietestcd else str(text)[:500]
            elem = {
                "element_type": "eligibility",
                "label": label,
                "metadata": {**{k: v for k, v in criterion.items() if k != "text"},
                             "ietestcd": ietestcd, "iecat": iecat,
                             "criterion_type": "inclusion" if iecat == "INCL" else "exclusion"},
            }
            eid = await _upsert_design_element(study_id, org_id, elem, body.source)
            elements_created.append({"type": "eligibility", "id": eid,
                                     "ietestcd": ietestcd, "iecat": iecat})
            await _neo4j_run(
                "MERGE (ec:EligibilityCriterion {id: $id}) "
                "SET ec.ietestcd = $tc, ec.iecat = $cat, ec.study_id = $sid "
                "WITH ec MATCH (sd:StudyDesign {id: $sid}) MERGE (sd)-[:HAS_CRITERION]->(ec)",
                {"id": eid, "tc": ietestcd, "cat": iecat, "sid": study_id},
            )

        # Cohorts (StudyCohort)
        for cohort in population.get("cohorts", []):
            cohort_label = cohort.get("name", cohort.get("label", "Unnamed Cohort"))
            elem = {"element_type": "cohort", "label": cohort_label, "metadata": cohort}
            eid = await _upsert_design_element(study_id, org_id, elem, body.source)
            elements_created.append({"type": "cohort", "id": eid, "label": cohort_label})
            await _neo4j_run(
                "MERGE (co:StudyCohort {id: $id}) SET co.name = $name, co.study_id = $sid",
                {"id": eid, "name": cohort_label, "sid": study_id},
            )

    # Also handle top-level eligibility criteria (USDM v4.0 version-level criteria)
    for criterion in usdm.get("study", {}).get("versions", [{}])[0].get("eligibilityCriteria", []):
        ietestcd = criterion.get("identifier", "")
        iecat_code = _code_value(criterion.get("category"))
        iecat = "INCL" if (iecat_code or "").upper() in ("INCLUSION", "INCL", "I") else "EXCL"
        text = criterion.get("text", criterion.get("description", ""))
        if isinstance(text, dict):
            text = text.get("value", json.dumps(text))
        label = f"[{ietestcd}] {str(text)[:450]}" if ietestcd else str(text)[:500]
        elem = {
            "element_type": "eligibility",
            "label": label,
            "metadata": {"ietestcd": ietestcd, "iecat": iecat,
                         "criterion_type": "inclusion" if iecat == "INCL" else "exclusion"},
        }
        eid = await _upsert_design_element(study_id, org_id, elem, body.source)
        elements_created.append({"type": "eligibility", "id": eid, "ietestcd": ietestcd, "iecat": iecat})

    log.info("study_graph.design_extracted", study_id=study_id, elements=len(elements_created))
    return {
        "study_id": study_id,
        "elements_created": len(elements_created),
        "elements": elements_created,
        "usdm_version": "4.0",
    }


def _usdm_design(usdm: dict) -> dict:
    """Navigate USDM v4.0 nested path: study.versions[0].studyDesigns[0].
    Falls back to top-level dict for flat/legacy USDM exports."""
    study = usdm.get("study", usdm)
    versions = study.get("versions", [])
    if versions:
        designs = versions[0].get("studyDesigns", [])
        if designs:
            return designs[0]
    # Flat fallback
    for key in ("studyDesign", "design"):
        if key in study:
            return study[key]
    return study


def _code_value(code_obj) -> str:
    """Extract string value from a USDM AliasCode/Code object or plain string."""
    if not code_obj:
        return ""
    if isinstance(code_obj, str):
        return code_obj
    if isinstance(code_obj, dict):
        # AliasCode: {standardCode: {code: "..."}, ...} or {code: "..."} or {decode: "..."}
        std = code_obj.get("standardCode") or code_obj
        return std.get("code", std.get("decode", std.get("id", "")))
    return str(code_obj)


def _classify_endpoint_type(obj: dict) -> str:
    level = (obj.get("level") or obj.get("type") or obj.get("endpointLevel") or "").lower()
    if "primary" in level:
        return "primary"
    if "secondary" in level:
        return "secondary"
    return "exploratory"


async def _upsert_design_element(study_id: str, org_id: str, elem: dict, source: str) -> str:
    elem_id = str(uuid.uuid4())
    label = elem.get("label", "")
    embedding = await _embed(label + " " + json.dumps(elem.get("metadata", {}))[:200])
    vec = _vec_str(embedding) if embedding else None

    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO study_design_elements
               (id, study_id, org_id, element_type, label, metadata, source, embedding)
               VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::vector)
               ON CONFLICT DO NOTHING
               RETURNING id""",
            elem_id, uuid.UUID(study_id), uuid.UUID(org_id),
            elem["element_type"], label, json.dumps(elem.get("metadata", {})),
            source, vec,
        ) if vec else await conn.fetchrow(
            """INSERT INTO study_design_elements
               (id, study_id, org_id, element_type, label, metadata, source)
               VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
               ON CONFLICT DO NOTHING
               RETURNING id""",
            elem_id, uuid.UUID(study_id), uuid.UUID(org_id),
            elem["element_type"], label, json.dumps(elem.get("metadata", {})), source,
        )
    return str(row["id"]) if row else elem_id


@app.get("/study/{study_id}/design")
async def get_study_design(study_id: str):
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id,element_type,label,metadata,source,created_at "
            "FROM study_design_elements WHERE study_id=$1 ORDER BY element_type,label",
            uuid.UUID(study_id),
        )
    grouped: dict[str, list] = {}
    for r in rows:
        t = r["element_type"]
        grouped.setdefault(t, []).append(dict(r))

    # Also fetch Neo4j graph summary
    neo4j_summary = await _neo4j_run(
        "MATCH (n) WHERE n.study_id = $sid RETURN labels(n)[0] as label, count(n) as cnt",
        {"sid": study_id},
    )
    return {"study_id": study_id, "elements": grouped, "neo4j_summary": neo4j_summary}


@app.get("/study/{study_id}/arms")
async def get_study_arms(study_id: str):
    return await _get_elements_by_type(study_id, "arm")


@app.get("/study/{study_id}/endpoints")
async def get_study_endpoints(study_id: str):
    return await _get_elements_by_type(study_id, "endpoint")


@app.get("/study/{study_id}/eligibility")
async def get_study_eligibility(study_id: str):
    return await _get_elements_by_type(study_id, "eligibility")


@app.get("/study/{study_id}/visit-schedule")
async def get_visit_schedule(study_id: str):
    # USDM v4.0: encounters are the canonical visit objects
    enc = await _get_elements_by_type(study_id, "encounter")
    # also include legacy 'visit' type for backwards compatibility
    legacy = await _get_elements_by_type(study_id, "visit")
    combined = enc["elements"] + legacy["elements"]
    return {"study_id": study_id, "element_type": "encounter", "elements": combined}


@app.get("/study/{study_id}/epochs")
async def get_study_epochs(study_id: str):
    return await _get_elements_by_type(study_id, "epoch")


@app.get("/study/{study_id}/schedule-timelines")
async def get_schedule_timelines(study_id: str):
    return await _get_elements_by_type(study_id, "schedule_timeline")


@app.get("/study/{study_id}/estimands")
async def get_study_estimands(study_id: str):
    return await _get_elements_by_type(study_id, "estimand")


@app.get("/study/{study_id}/indications")
async def get_study_indications(study_id: str):
    return await _get_elements_by_type(study_id, "indication")


@app.get("/study/{study_id}/cohorts")
async def get_study_cohorts(study_id: str):
    return await _get_elements_by_type(study_id, "cohort")


@app.get("/study/{study_id}/data-ops")
async def get_data_ops(study_id: str):
    return await _get_elements_by_type(study_id, "data_source")


async def _get_elements_by_type(study_id: str, element_type: str) -> dict:
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id,element_type,label,metadata,source,created_at "
            "FROM study_design_elements WHERE study_id=$1 AND element_type=$2 ORDER BY label",
            uuid.UUID(study_id), element_type,
        )
    return {"study_id": study_id, "element_type": element_type,
            "elements": [dict(r) for r in rows]}


@app.post("/study/{study_id}/data-ops")
async def upsert_data_ops(study_id: str, body: dict, org_id: str = Query(...)):
    """Register a data source (EDC, Labs, ePRO, RTSM, etc.) for the study."""
    elem = {
        "element_type": "data_source",
        "label": body.get("system_name", body.get("source_type", "Unknown Data Source")),
        "metadata": body,
    }
    eid = await _upsert_design_element(study_id, org_id, elem, "manual")

    # Neo4j
    await _neo4j_run(
        "MERGE (ds:DataSource {id: $id}) SET ds.type = $type, ds.system = $sys, ds.study_id = $sid",
        {"id": eid, "type": body.get("source_type", ""), "sys": body.get("system_name", ""), "sid": study_id},
    )
    await _neo4j_run(
        "MATCH (sd:StudyDesign {id: $sid}), (ds:DataSource {id: $did}) MERGE (sd)-[:USES_DATA_SOURCE]->(ds)",
        {"sid": study_id, "did": eid},
    )
    return {"id": eid}


# ─── Decision Memory ──────────────────────────────────────────────────────────

@app.post("/study/{study_id}/decision-memory")
async def add_or_query_decision_memory(study_id: str, body: DecisionMemoryCreate | DecisionMemoryQuery, org_id: str = Query(...)):
    if isinstance(body, DecisionMemoryQuery):
        return await _search_decision_memory(study_id, org_id, body)

    # Create new decision memory entry
    ctx_hash = hashlib.sha256(body.context_text.strip().lower().encode()).hexdigest()
    embedding = await _embed(body.context_text)
    vec = _vec_str(embedding) if embedding else None

    expires = None
    if body.expires_at:
        from datetime import datetime
        expires = datetime.fromisoformat(body.expires_at)

    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO decision_memory
               (org_id, study_id, category, context_hash, context_text,
                rationale, impact_domains, approved_by, expires_at, embedding)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector)
               ON CONFLICT (org_id, context_hash) DO UPDATE
               SET rationale=EXCLUDED.rationale, updated_at=NOW()
               RETURNING id""",
            uuid.UUID(org_id), uuid.UUID(study_id) if study_id else None,
            body.category, ctx_hash, body.context_text,
            body.rationale, body.impact_domains, body.approved_by, expires, vec,
        ) if vec else await conn.fetchrow(
            """INSERT INTO decision_memory
               (org_id, study_id, category, context_hash, context_text,
                rationale, impact_domains, approved_by, expires_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               ON CONFLICT (org_id, context_hash) DO UPDATE
               SET rationale=EXCLUDED.rationale
               RETURNING id""",
            uuid.UUID(org_id), uuid.UUID(study_id) if study_id else None,
            body.category, ctx_hash, body.context_text,
            body.rationale, body.impact_domains, body.approved_by, expires,
        )
    return {"id": str(row["id"])}


@app.get("/study/{study_id}/decision-memory")
async def get_decision_memory(
    study_id: str,
    org_id: str = Query(...),
    category: Optional[str] = None,
    q: Optional[str] = None,
    top_k: int = 10,
):
    return await _search_decision_memory(
        study_id, org_id,
        DecisionMemoryQuery(context_query=q or "", top_k=top_k, category=category, org_id=org_id),
    )


async def _search_decision_memory(study_id: str, org_id: str, query: DecisionMemoryQuery) -> dict:
    conditions = ["org_id = $1", "(study_id = $2 OR study_id IS NULL)"]
    params: list = [uuid.UUID(org_id), uuid.UUID(study_id) if study_id else None]
    n = 3
    if query.category:
        conditions.append(f"category = ${n}"); params.append(query.category); n += 1

    where = " AND ".join(conditions)

    if query.context_query:
        embedding = await _embed(query.context_query)
        if embedding:
            vec = _vec_str(embedding)
            async with db_pool.acquire() as conn:
                rows = await conn.fetch(
                    f"SELECT id,category,context_text,rationale,impact_domains,"
                    f"approved_by,created_at,"
                    f"1 - (embedding <=> '{vec}'::vector) AS similarity "
                    f"FROM decision_memory WHERE {where} AND embedding IS NOT NULL "
                    f"ORDER BY embedding <=> '{vec}'::vector LIMIT ${n}",
                    *params, query.top_k,
                )
            return {"memories": [dict(r) for r in rows], "query": query.context_query}

    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT id,category,context_text,rationale,impact_domains,approved_by,created_at "
            f"FROM decision_memory WHERE {where} ORDER BY created_at DESC LIMIT ${n}",
            *params, query.top_k,
        )
    return {"memories": [dict(r) for r in rows]}


# ─── Issues & Risks ───────────────────────────────────────────────────────────

@app.post("/study/{study_id}/issues", status_code=201)
async def create_issue(study_id: str, body: IssueCreate):
    org = body.org_id or ""
    if not org:
        raise HTTPException(400, "org_id is required")
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO study_issues
               (study_id, org_id, issue_type, title, description,
                severity, related_domain, assigned_to, metadata)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
               RETURNING id""",
            uuid.UUID(study_id), uuid.UUID(org), body.issue_type, body.title,
            body.description, body.severity, body.related_domain,
            body.assigned_to, json.dumps(body.metadata),
        )

    # Neo4j
    issue_id = str(row["id"])
    await _neo4j_run(
        "MERGE (i:Issue {id: $id}) SET i.type = $type, i.severity = $sev, i.study_id = $sid",
        {"id": issue_id, "type": body.issue_type, "sev": body.severity, "sid": study_id},
    )
    await _neo4j_run(
        "MATCH (sd:StudyDesign {id: $sid}), (i:Issue {id: $iid}) MERGE (sd)-[:HAS_ISSUE]->(i)",
        {"sid": study_id, "iid": issue_id},
    )
    return {"id": issue_id}


@app.get("/study/{study_id}/issues")
async def get_issues(
    study_id: str,
    status: Optional[str] = None,
    severity: Optional[str] = None,
    issue_type: Optional[str] = None,
):
    conditions = ["study_id = $1"]
    params: list = [uuid.UUID(study_id)]
    n = 2
    if status:
        conditions.append(f"status = ${n}"); params.append(status); n += 1
    if severity:
        conditions.append(f"severity = ${n}"); params.append(severity); n += 1
    if issue_type:
        conditions.append(f"issue_type = ${n}"); params.append(issue_type); n += 1

    where = " AND ".join(conditions)
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT id,issue_type,title,description,severity,status,"
            f"related_domain,assigned_to,created_at "
            f"FROM study_issues WHERE {where} ORDER BY severity,created_at DESC",
            *params,
        )
    return {"study_id": study_id, "issues": [dict(r) for r in rows]}


@app.patch("/study/{study_id}/issues/{issue_id}")
async def update_issue(study_id: str, issue_id: str, body: dict):
    allowed = {"status", "assigned_to", "description", "severity"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(400, "No valid fields to update")
    sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(updates))
    params = [uuid.UUID(issue_id)] + list(updates.values())
    params.append(uuid.UUID(study_id))
    async with db_pool.acquire() as conn:
        await conn.execute(
            f"UPDATE study_issues SET {sets}, updated_at=NOW() "
            f"WHERE id = $1 AND study_id = ${len(params)}",
            *params,
        )
    return {"updated": True}


# ─── Studies CRUD ─────────────────────────────────────────────────────────────

@app.get("/studies")
async def list_studies(org_id: str = Query(...)):
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, org_id, name, protocol_number, phase, therapeutic_area,
                   indication, sponsor_name, status, is_blinded, created_at, updated_at
            FROM studies
            WHERE org_id = $1
            ORDER BY created_at DESC
            """,
            uuid.UUID(org_id),
        )
    return {"studies": [dict(r) for r in rows]}


@app.post("/studies", status_code=201)
async def create_study(body: StudyCreate):
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO studies (org_id, name, protocol_number, phase, therapeutic_area,
                                 indication, sponsor_name, status, is_blinded)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id, org_id, name, protocol_number, phase, therapeutic_area,
                      indication, sponsor_name, status, is_blinded, created_at, updated_at
            """,
            uuid.UUID(body.org_id),
            body.name,
            body.protocol_number,
            body.phase,
            body.therapeutic_area,
            body.indication,
            body.sponsor_name,
            body.status,
            body.is_blinded,
        )
    return dict(row)


# ─── Portfolio Intelligence ───────────────────────────────────────────────────

@app.get("/portfolio/analytics")
async def portfolio_analytics(org_id: str = Query(...)):
    async with db_pool.acquire() as conn:
        study_count = await conn.fetchval(
            "SELECT COUNT(*) FROM studies WHERE org_id = $1", uuid.UUID(org_id)
        )
        issue_counts = await conn.fetch(
            "SELECT severity, COUNT(*) as cnt FROM study_issues "
            "WHERE org_id=$1 AND status='open' GROUP BY severity ORDER BY severity",
            uuid.UUID(org_id),
        )
        element_counts = await conn.fetch(
            "SELECT element_type, COUNT(*) as cnt FROM study_design_elements "
            "WHERE org_id=$1 GROUP BY element_type ORDER BY element_type",
            uuid.UUID(org_id),
        )
    return {
        "org_id": org_id,
        "study_count": study_count,
        "open_issues_by_severity": {r["severity"]: r["cnt"] for r in issue_counts},
        "design_elements_by_type": {r["element_type"]: r["cnt"] for r in element_counts},
    }


@app.get("/portfolio/risks")
async def portfolio_risks(org_id: str = Query(...)):
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT si.study_id, s.name as study_name, si.issue_type, si.title, "
            "si.severity, si.status, si.created_at "
            "FROM study_issues si "
            "LEFT JOIN studies s ON s.id = si.study_id "
            "WHERE si.org_id=$1 AND si.severity IN ('critical','high') "
            "AND si.status NOT IN ('resolved','closed') "
            "ORDER BY si.severity, si.created_at DESC",
            uuid.UUID(org_id),
        )
    return {"org_id": org_id, "critical_risks": [dict(r) for r in rows]}
