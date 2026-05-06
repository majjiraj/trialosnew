# Quality Service

Standalone microservice for USDM clinical trial data quality validation.

**Port:** `8016`  
**Swagger UI:** `http://localhost:8016/docs`  
**ReDoc:** `http://localhost:8016/redoc`  
**OpenAPI JSON:** `http://localhost:8016/openapi.json`

---

## What it does

The Quality Service provides three categories of validation against assembled USDM v4 JSON:

| Check | Description |
|---|---|
| **Hallucination detection** | Verifies each extracted `source_span` literally appears in the original document chunks. Marks fields as `verified`, `hallucinated`, or `unverified`. |
| **ICH M11 completeness** | Checks that all six required protocol sections are present: identifiers, objectives/endpoints, study arms, epochs, population (I/E criteria), and indications. |
| **CDISC CT code validation** | Validates study arm type, epoch type, and study phase codes against CDISC Controlled Terminology code lists. |
| **Schema integrity** | Detects non-USDM root-level fields, missing `versions` array, missing `titles`, missing `versionIdentifier`. |

Reports are persisted in an independent PostgreSQL database and retrievable by `report_id` or `conversion_id`.

---

## Prerequisites

| Dependency | Minimum version |
|---|---|
| Docker | 24.x |
| Docker Compose | 2.x (`docker-compose` or `docker compose`) |
| curl | any (used by health check scripts) |

No Python installation required on the host — everything runs inside containers.

---

## Quick Start (standalone)

The service runs completely independently. No other platform services are needed.

```bash
# 1. Navigate to the service directory
cd services/quality-service

# 2. Install (copies .env, builds image)
make install

# 3. Start (spins up postgres + service, waits until healthy)
make start

# 4. Verify
curl http://localhost:8016/health
# → {"status":"ok","service":"quality-service","version":"1.0.0"}

# 5. Open the Swagger UI
open http://localhost:8016/docs
```

### Alternative — without Make

```bash
cp .env.example .env
docker-compose up --build -d
./scripts/healthcheck.sh
```

---

## Common commands

```bash
make start      # start in background (waits until healthy)
make stop       # stop containers (data preserved)
make restart    # stop + start
make logs       # tail service logs
make health     # quick /health poll
make test-smoke # run all endpoints with sample payloads
make clean      # remove containers, volumes, and image
```

---

## Configuration

Copy `.env.example` to `.env` and edit as needed.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://quality:quality_dev@quality-postgres:5432/quality_db` | Postgres DSN. Change host/credentials for production. |
| `SERVICE_PORT` | `8016` | Port uvicorn listens on inside the container. |
| `LOG_LEVEL` | `INFO` | Logging level (`DEBUG`, `INFO`, `WARNING`, `ERROR`). |

### Standalone vs platform-integrated DB

- **Standalone** (default in `.env.example`): the `quality-postgres` container defined in `docker-compose.yml`. Credentials: `quality/quality_dev`, database: `quality_db`.
- **Platform-integrated**: set `DATABASE_URL` to point at the shared Trialo postgres instance (`DATABASE_URL=postgresql://trialo:trialo_dev@postgres:5432/quality_db`). The service creates its own schema (`quality_db`) on the shared instance.

---

## API Reference

Interactive docs with request/response schemas and try-it-out are at `http://localhost:8016/docs`.

---

### `GET /health`

Returns service status and confirms DB connectivity.

```bash
curl http://localhost:8016/health
```

```json
{"status": "ok", "service": "quality-service", "version": "1.0.0"}
```

---

### `POST /hallucination/check`

Verify extracted fields against original document chunks. Every field in `section_data` that carries a `source_span` is checked for literal presence in the supplied chunks.

```bash
curl -X POST http://localhost:8016/hallucination/check \
  -H "Content-Type: application/json" \
  -d '{
    "section_data": {
      "objectiveDescription": {
        "value": "To evaluate efficacy of drug X",
        "source_span": "To evaluate efficacy of drug X in adult patients"
      }
    },
    "chunks": [
      {
        "chunk_id": "abc-123",
        "chunk_index": 5,
        "content": "To evaluate efficacy of drug X in adult patients with ...",
        "section": "Objectives",
        "page_number": 8
      }
    ]
  }'
```

**Response**

```json
{
  "spans_verified": 1,
  "hallucinations_detected": 0,
  "provenance_coverage": 1.0,
  "field_quality": {
    ".objectiveDescription": "verified"
  },
  "annotated_data": {
    "objectiveDescription": {
      "value": "To evaluate efficacy of drug X",
      "source_span": "To evaluate efficacy of drug X in adult patients",
      "verified": true,
      "source_chunk_id": "abc-123",
      "source_chunk_index": 5
    }
  }
}
```

---

### `POST /structural/validate`

Run ICH M11, CDISC CT, and schema checks. Does **not** persist to the database.

```bash
curl -X POST http://localhost:8016/structural/validate \
  -H "Content-Type: application/json" \
  -d '{
    "usdm_json": {
      "study": {
        "id": "STUDY-001",
        "versions": [
          {
            "id": "VERSION-001",
            "versionIdentifier": "1.0",
            "titles": [{"id": "T-001", "text": "A Phase 2 Study of Drug X"}],
            "studyDesigns": [
              {
                "id": "DESIGN-001",
                "objectives": [{"id": "O-001"}],
                "studyArms": [{"id": "A-001"}],
                "studyEpochs": [{"id": "E-001"}],
                "studyPopulations": [{"id": "P-001"}],
                "studyIndications": [{"id": "I-001"}],
                "studyIdentifiers": [{"id": "ID-001"}]
              }
            ]
          }
        ]
      }
    }
  }'
```

**Response**

```json
{
  "ich_m11": {"passed": true, "score": 1.0, "gaps": []},
  "cdisc_ct": {"passed": true, "score": 1.0, "gaps": []},
  "schema_check": {"passed": true, "score": 1.0, "gaps": []},
  "overall_score": 1.0,
  "overall_passed": true
}
```

**Gap format:** `"ich_m11_missing:study_arms:Study arms"` — `check:key:human_label`

---

### `POST /quality/run`  → `201 Created`

Full pipeline: hallucination detection + structural checks + persist report.

```bash
curl -X POST http://localhost:8016/quality/run \
  -H "Content-Type: application/json" \
  -d '{
    "usdm_json": { "study": { "id": "STUDY-001", "versions": [...] } },
    "conversion_id": "16a7158c-5250-4bd8-a7fe-b1ea5339fd5a",
    "run_id": "abc-def-123",
    "section_results": null,
    "chunks_by_section": null
  }'
```

Pass `section_results` and `chunks_by_section` to enable hallucination detection. If omitted, only structural checks run and provenance fields from `usdm_json.provenance.field_quality` are used if present.

**Response**

```json
{
  "report_id": "7d2f4c1a-...",
  "conversion_id": "16a7158c-...",
  "run_id": "abc-def-123",
  "checked_at": "2026-04-30T14:00:00Z",
  "summary": {
    "spans_verified": 0,
    "hallucinations_detected": 0,
    "provenance_coverage": 0.0
  },
  "field_quality": {},
  "structural": {
    "ich_m11": {"passed": true, "score": 1.0, "gaps": []},
    "cdisc_ct": {"passed": true, "score": 1.0, "gaps": []},
    "schema_check": {"passed": true, "score": 1.0, "gaps": []},
    "overall_score": 1.0,
    "overall_passed": true
  },
  "overall_score": 0.8,
  "overall_passed": false
}
```

---

### `GET /quality/reports`

List stored reports. Supports pagination and filtering.

```bash
# All reports (newest first)
curl "http://localhost:8016/quality/reports"

# Filter by conversion
curl "http://localhost:8016/quality/reports?conversion_id=16a7158c-5250-4bd8-a7fe-b1ea5339fd5a"

# Paginate
curl "http://localhost:8016/quality/reports?limit=10&offset=20"
```

| Query param | Type | Default | Description |
|---|---|---|---|
| `conversion_id` | UUID string | — | Filter to a specific conversion |
| `run_id` | UUID string | — | Filter to a specific agent run |
| `limit` | int (1–100) | 20 | Results per page |
| `offset` | int ≥ 0 | 0 | Pagination offset |

---

### `GET /quality/reports/{report_id}`

Retrieve a specific report by its UUID.

```bash
curl http://localhost:8016/quality/reports/7d2f4c1a-...
```

---

### `GET /quality/conversions/{conversion_id}/report`

Get the **most recent** quality report for a conversion.

```bash
curl http://localhost:8016/quality/conversions/16a7158c-5250-4bd8-a7fe-b1ea5339fd5a/report
```

---

## Scoring methodology

Overall score is a weighted composite:

| Component | Weight | Description |
|---|---|---|
| ICH M11 completeness | 35 % | Fraction of required sections present |
| CDISC CT codes | 25 % | Fraction of code checks that passed |
| Schema integrity | 20 % | 1 − (gap_count / 10), floored at 0 |
| Provenance coverage | 20 % | verified / (verified + hallucinated) |

`overall_passed` is `true` only when **all four** components pass and zero hallucinations are detected.

---

## Quality states

| State | Meaning |
|---|---|
| `verified` | Source span found verbatim in retrieved document chunks |
| `hallucinated` | Source span not found in any retrieved chunk |
| `unverified` | Field carries a source span but verification was not run |

---

## Calling the service from an agent

The service is consumed over plain HTTP. Example Python snippet for an agent using `httpx`:

```python
import httpx

QUALITY_URL = os.environ["QUALITY_SERVICE_URL"]  # http://quality-service:8016

async def run_quality_check(usdm_json: dict, conversion_id: str) -> dict:
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{QUALITY_URL}/quality/run",
            json={
                "usdm_json": usdm_json,
                "conversion_id": conversion_id,
            },
        )
        resp.raise_for_status()
        return resp.json()

async def get_structural_score(usdm_json: dict) -> dict:
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            f"{QUALITY_URL}/structural/validate",
            json={"usdm_json": usdm_json},
        )
        resp.raise_for_status()
        return resp.json()
```

The environment variable `QUALITY_SERVICE_URL` is already injected into the `agent-runtime` container via `docker-compose.dev.yml`.

---

## Database schema

Two tables are created automatically on service startup.

**`quality_reports`** — one row per quality run

| Column | Type | Description |
|---|---|---|
| `id` | UUID PK | Report identifier |
| `conversion_id` | UUID | USDM conversion this report covers |
| `run_id` | UUID | Agent run that produced the USDM |
| `checked_at` | TIMESTAMPTZ | When the report was created |
| `spans_verified` | INTEGER | Count of source spans confirmed in chunks |
| `hallucinations_detected` | INTEGER | Count of spans not found in chunks |
| `provenance_coverage` | FLOAT | `verified / (verified + hallucinated)` |
| `ich_m11_result` | JSONB | `{passed, score, gaps}` |
| `cdisc_ct_result` | JSONB | `{passed, score, gaps}` |
| `schema_result` | JSONB | `{passed, score, gaps}` |
| `field_quality` | JSONB | Flat `{path: state}` map |
| `overall_score` | FLOAT | Weighted composite 0–1 |
| `overall_passed` | BOOLEAN | All checks passed and zero hallucinations |

**`field_quality_entries`** — one row per field per run (enables fine-grained SQL queries)

| Column | Type | Description |
|---|---|---|
| `id` | UUID PK | |
| `report_id` | UUID FK | Parent report |
| `field_path` | TEXT | Dot-notation path, e.g. `.study.studyTitle` |
| `quality_state` | TEXT | `verified` / `hallucinated` / `unverified` |
| `source_span` | TEXT | The cited text (if available) |
| `chunk_id` | TEXT | Source chunk where span was found |
| `hallucination_reason` | TEXT | Explanation when state is `hallucinated` |

---

## Platform integration (Trialo docker-compose)

When running the full Trialo platform, the service is included automatically:

```bash
# From the repository root
docker-compose -f docker-compose.dev.yml up quality-service
```

In this mode the service uses the shared `postgres` container but writes to its own `quality_db` database. The `agent-runtime` service already has `QUALITY_SERVICE_URL=http://quality-service:8016` injected.

---

## Development — running without Docker

```bash
cd services/quality-service

# Create a local postgres database named quality_db first, then:
pip install -r requirements.txt

DATABASE_URL="postgresql://quality:quality_dev@localhost:5432/quality_db" \
SERVICE_PORT=8016 \
uvicorn main:app --host 0.0.0.0 --port 8016 --reload
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERROR: role "quality" does not exist` | Postgres started before init-db.sql ran | `make clean && make start` |
| `RuntimeError: DB pool not initialized` | Service started before postgres was ready | Check `depends_on` healthcheck; the compose file handles this automatically |
| `404 No quality report found` | No run has been submitted for that conversion | Call `POST /quality/run` first |
| Port 8016 already in use | Another service occupies the port | Change `SERVICE_PORT` in `.env` and update `docker-compose.yml` port mapping |
| Slow first start | Docker pulling `postgres:16-alpine` | Normal on first run; subsequent starts are fast |
