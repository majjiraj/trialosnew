# TrialOS — Clinical Trial AI Platform

> **Branch `update6may`** — snapshot of all workbench, PDF viewer, sidebar, and quality-tab improvements built through 6 May 2026.

A production-grade platform for AI-assisted clinical trial protocol authoring, USDM conversion, SDTM mapping, and regulatory document management.

![Status](https://img.shields.io/badge/status-active-brightgreen)
![Version](https://img.shields.io/badge/version-2.1.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## What's in this branch

| Area | Changes |
|------|---------|
| **USDM Reviewer Workbench** | 3-pane layout; PDF viewer with byte-range streaming + auto-fit; collapsible right pane; Full JSON modal with copy; insight-tab shortcuts in header |
| **Quality Tab** | Fixed 10 false-positive validation gaps — USDM v4 field paths aligned (`titles[]`, `studyPhase.standardCode`, `scopeId`, `documentVersionIds`, `populationSummary`, `analysisPopulationId`, `variableOfInterestId`, `design.population`, leaf-activity check) |
| **PDF performance** | HTTP byte-range support, ETag/Cache-Control caching, non-blocking S3 I/O — eliminates full-download wait before first render |
| **Navigation** | Sidebar stripped to core items: Documents, Standards, Clinical Intelligence |
| **Data fix** | USDM JSON for B7981041 corrected — wrong AA estimands replaced with Vitiligo (SALT/VASI) estimands; TA corrected to Dermatology/Vitiligo |

---

## Architecture

```
Browser
  └─ Next.js 14 (App Router)          :3000
       ├─ GraphQL API (Node/Apollo)    :4000
       ├─ Auth Service (FastAPI)       :8001
       ├─ Audit Service (FastAPI)      :8002
       ├─ Ingestion Service (FastAPI)  :8003   ← PDF serve + chunking
       ├─ Agent Runtime (FastAPI)      :8004   ← USDM conversion, agent runs
       ├─ Marketplace (FastAPI)        :8005
       ├─ Notifications (FastAPI)      :8006
       ├─ Data Platform (FastAPI)      :8007
       └─ Context Graph (FastAPI)      :8008

Infrastructure
  ├─ PostgreSQL 15  :5432   (main relational store + pgvector)
  ├─ MongoDB 7      :27017  (document metadata, lineage)
  ├─ Neo4j 5        :7687   (agent decision graph)
  ├─ MinIO          :9000   (object storage — documents, datasets)
  ├─ Kafka          :9092   (event bus)
  └─ OPA            :8181   (policy engine)
```

---

## Quick start

```bash
git clone https://github.com/majjiraj/trialosnew.git trialo
cd trialo
git checkout update6may

# 1. Copy environment file
cp .env.dev .env

# 2. Add your Anthropic key (required for USDM conversion)
#    Edit .env and set ANTHROPIC_API_KEY=sk-ant-...

# 3. Start all services (~60 s first boot)
docker compose -f docker-compose.dev.yml up -d

# 4. Restore sample data
bash data-backup/restore.sh

# 5. Open the app
open http://localhost:3000   # macOS
# or navigate to http://localhost:3000 in your browser
```

Default login: **admin@trialo.ai** / **admin123**

See **[INSTALL.md](INSTALL.md)** for the full step-by-step guide including Ollama, troubleshooting, and production deployment.

---

## Key workflows

### USDM Conversion Workbench
`/usdm` → click **Review** on a completed conversion

- **Left pane** — USDM section JSON, required-field validation, "Why this value?", self-correction history
- **Centre pane** — Protocol source chunks or inline PDF viewer (byte-range streamed, auto-fit width). Toggle with **Chunks / PDF** buttons; numbered chunk tabs show page numbers.
- **Right pane** — Extraction details, source highlight, similar past cases, audit trail. Collapse with `›` button to give the PDF viewer full width.
- **Header icons** — Six small icons (Evaluation, Quality, Decision Traces, Validation, Learnings, Audit Log) jump directly to the relevant Agent Insights tab below the workbench.

### Documents
`/documents` — upload protocol PDFs, SDTM datasets, ICH guidelines; automatically chunked and vector-embedded.

### Protocol Hub
`/protocols` — browse protocol versions and lineage.

### Conversions
`/usdm` — trigger a USDM v4 conversion from an uploaded protocol PDF.

---

## Services reference

| URL | Service |
|-----|---------|
| http://localhost:3000 | Frontend (Next.js) |
| http://localhost:4000/graphql | GraphQL Playground |
| http://localhost:8003/docs | Ingestion Service API |
| http://localhost:8004/docs | Agent Runtime API |
| http://localhost:9001 | MinIO Console (`trialo` / `trialo_dev_secret`) |

---

## Data backup & restore

All backup files live in `data-backup/`:

```bash
# Restore everything (PostgreSQL + MongoDB + MinIO CSVs)
bash data-backup/restore.sh

# Individual stores
bash data-backup/restore.sh --postgres-only
bash data-backup/restore.sh --mongodb-only
bash data-backup/restore.sh --minio-only
```

See [`data-backup/README.md`](data-backup/README.md) for a full inventory of what each backup contains.

> **Large PDFs** (protocol documents, SDTM-IG, USDM-IG) are not committed to git.
> After restore, re-upload them via Documents or directly via the MinIO console at http://localhost:9001.

---

## Development — rebuild a single service

```bash
docker compose -f docker-compose.dev.yml build <service>
docker compose -f docker-compose.dev.yml up -d --no-deps <service>

# Service names:
#   frontend  ingestion-service  agent-runtime  graphql-api
#   auth-service  audit  context-graph  data-platform
#   marketplace  notifications
```

---

## Stopping

```bash
# Stop containers (data volumes persist)
docker compose -f docker-compose.dev.yml down

# Full reset (deletes all data)
docker compose -f docker-compose.dev.yml down -v
```
