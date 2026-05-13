# TrialOS — Complete Installation Guide

This guide takes a fresh machine from zero to a fully running TrialOS stack with all sample data loaded. Estimated time: **15–25 minutes** (excluding Docker image pulls).

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Clone the Repository](#2-clone-the-repository)
3. [Configure Environment](#3-configure-environment)
4. [Install Ollama & Models](#4-install-ollama--models)
5. [Start the Stack](#5-start-the-stack)
6. [Restore Sample Data](#6-restore-sample-data)
7. [Verify the Installation](#7-verify-the-installation)
8. [Service URLs Reference](#8-service-urls-reference)
9. [Stopping & Restarting](#9-stopping--restarting)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Prerequisites

### Required Software

| Tool | Minimum Version | Install |
|------|----------------|---------|
| Docker Desktop | 24.0+ | https://docs.docker.com/get-docker/ |
| Docker Compose | v2 (plugin) | Included with Docker Desktop |
| Git | any | https://git-scm.com/ |
| Node.js | 20+ | https://nodejs.org/ (only for local dev) |

### System Resources

Docker Desktop needs at least:
- **CPU:** 4 cores allocated
- **RAM:** 8 GB allocated (12 GB recommended)
- **Disk:** 20 GB free

> **macOS:** Open Docker Desktop → Settings → Resources and set Memory ≥ 8 GB.

### API Keys (minimum one LLM)

The platform needs at least one LLM provider. Easiest is **Ollama** (free, runs locally — set up in step 4). Alternatively provide one of:
- `ANTHROPIC_API_KEY` — required for the `protocol-usdm-v3` USDM generation service
- `OPENAI_API_KEY` — optional, used by agents when configured

---

## 2. Clone the Repository

```bash
git clone https://github.com/majjiraj/trialosnew.git trialo
cd trialo
git checkout update6may
```

---

## 3. Configure Environment

Copy the dev template and fill in your API keys:

```bash
cp .env.dev .env
```

Open `.env` in your editor. The only values you **must** fill in are LLM API keys. Everything else (database passwords, MinIO credentials, internal URLs) is pre-configured for the local dev stack.

### Minimum required changes

```bash
# Option A — Use Ollama (free, local, no key needed — see step 4)
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://host.docker.internal:11434

# Option B — Use Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Option C — Use OpenAI
OPENAI_API_KEY=sk-...
```

The `protocol-usdm-v3` service (USDM document generation) requires `ANTHROPIC_API_KEY`. If you don't have one, that service will start but fail when invoked; all other features work without it.

### Infrastructure credentials (pre-set, do not change for local dev)

These are already baked into `docker-compose.dev.yml` and `.env.dev`:

| Service | Credential |
|---------|-----------|
| PostgreSQL | `trialo` / `trialo_dev` |
| MongoDB | `trialo` / `trialopass` |
| Neo4j | `neo4j` / `trialo_dev` |
| MinIO | `trialo` / `trialo_dev_secret` |
| JWT Secret | `dev-jwt-secret-change-in-production` |

---

## 4. Install Ollama & Models

Ollama runs natively on the host (not in Docker) so the containers reach it via `host.docker.internal:11434`.

### Install Ollama

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh

# Windows — download installer from https://ollama.com/download
```

### Pull required models

```bash
# Embedding model (required — used by context-graph, ingestion, standards-registry)
ollama pull nomic-embed-text

# Default generation model for agents
ollama pull gemma:latest

# Marketplace/smaller tasks
ollama pull llama3.2:3b

# Start Ollama service (macOS/Linux — leave this running)
ollama serve
```

> **Skip Ollama entirely** if you're using OpenAI or Anthropic exclusively. Set `EMBEDDING_PROVIDER=openai` and `EMBEDDING_MODEL=text-embedding-3-large` in `.env`.

---

## 5. Start the Stack

```bash
# Start all services (pulls images on first run — takes 5–10 min)
docker compose -f docker-compose.dev.yml up -d
```

### Monitor startup

```bash
# Watch all service logs
docker compose -f docker-compose.dev.yml logs -f

# Check that core services are healthy
docker compose -f docker-compose.dev.yml ps
```

Expected healthy output after ~2 minutes:

```
NAME                           STATUS
trialo-postgres-1              Up
trialo-neo4j-1                 Up (healthy)
trialo-mongodb-1               Up
trialo-redis-1                 Up
trialo-minio-1                 Up
trialo-kafka-1                 Up
trialo-opa-1                   Up
trialo-auth-service-1          Up
trialo-audit-service-1         Up
trialo-ingestion-service-1     Up
trialo-agent-runtime-1         Up
trialo-context-graph-1         Up
trialo-standards-registry-1    Up
trialo-marketplace-1           Up
trialo-graphql-api-1           Up
trialo-frontend-1              Up
trialo-protocol-usdm-v3-1      Up
trialo-study-graph-1           Up
trialo-memory-engine-1         Up
trialo-super-agent-1           Up
```

> Some services (zeebe, elasticsearch, operate, langfuse) may show as exited if their Docker image pulls failed or if you have limited RAM. Core functionality does not require them.

---

## 6. Restore Sample Data

The `data-backup/` directory contains a complete snapshot of the live database. This includes:

- **PostgreSQL** — 197k context edges, 58k context nodes, 5.4k document chunks, 2 active studies, 28 agent runs, evaluator definitions, USDM conversions
- **MongoDB** — document folders, lineage records, folder files
- **MinIO** — clinical protocol PDFs, SDTM datasets, ICH M11 template, study documents (~20 MB)
- **Neo4j** — 100 DecisionTrace nodes, 88 AgentRun nodes (rebuilt automatically by services)

### Run the restore script

Wait until all Docker services are running (step 5), then:

```bash
bash data-backup/restore.sh
```

The script restores each database in sequence and prints progress. The PostgreSQL restore is the longest step (~1–2 minutes due to the vector embedding data).

#### Restore individual databases only

```bash
bash data-backup/restore.sh --postgres-only
bash data-backup/restore.sh --mongodb-only
bash data-backup/restore.sh --minio-only
```

---

## 7. Verify the Installation

### Frontend

Open **http://localhost:3000** — you should see the TrialOS dashboard.

### GraphQL API

Open **http://localhost:4000/graphql** — Apollo Sandbox loads. Run:

```graphql
{
  agentRuns(limit: 5) {
    id
    status
    createdAt
  }
}
```

Should return the 27 existing agent runs from the backup.

### Agent Runtime health

```bash
curl http://localhost:8004/health
# {"status":"ok","service":"agent-runtime","version":"2.0.0"}
```

### PostgreSQL

```bash
docker exec trialo-postgres-1 sh -c \
  "PGPASSWORD=trialo_dev psql -U trialo -d trialo -c \
   'SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE n_live_tup > 0 ORDER BY n_live_tup DESC LIMIT 10;'"
```

### MinIO Console

Open **http://localhost:9001** → login `trialo` / `trialo_dev_secret` → browse `trialo-documents` bucket.

### Neo4j Browser

Open **http://localhost:7474** → login `neo4j` / `trialo_dev` → run:

```cypher
MATCH (n) RETURN labels(n)[0] as type, count(n) ORDER BY count(n) DESC
```

---

## 8. Service URLs Reference

| Service | URL | Notes |
|---------|-----|-------|
| **Frontend** | http://localhost:3000 | Next.js app |
| **GraphQL API** | http://localhost:4000/graphql | Apollo Sandbox in dev |
| **Auth Service** | http://localhost:8001 | JWT auth |
| **Audit Service** | http://localhost:8002 | Audit log REST API |
| **Ingestion Service** | http://localhost:8003 | Document ingestion |
| **Agent Runtime** | http://localhost:8004 | Agent execution + SDTM mapper |
| **Marketplace** | http://localhost:8005 | Agent marketplace |
| **Notification Service** | http://localhost:8006 | WebSocket notifications |
| **Data Platform** | http://localhost:8007 | Data pipeline |
| **Context Graph** | http://localhost:8008 | Neo4j-backed knowledge graph |
| **App Composer** | http://localhost:8009 | ACP app builder |
| **Form Engine** | http://localhost:8010 | Dynamic forms |
| **Workflow Bridge** | http://localhost:8011 | Zeebe workflow connector |
| **Standards Registry** | http://localhost:8012 | CDISC standards |
| **Study Graph** | http://localhost:8013 | Study knowledge graph |
| **Memory Engine** | http://localhost:8014 | Agent memory |
| **Super Agent** | http://localhost:8015 | Orchestration agent |
| **Quality Service** | http://localhost:8016 | Data quality |
| **Protocol USDM v3** | http://localhost:8020 | USDM generation |
| **MinIO Console** | http://localhost:9001 | Object storage UI |
| **Neo4j Browser** | http://localhost:7474 | Graph database UI |
| **Langfuse** | http://localhost:3100 | LLM observability |
| **OPA** | http://localhost:8181 | Policy engine |
| **Kafka** | localhost:9092 | Event streaming |
| **PostgreSQL** | localhost:5432 | DB: `trialo`, user: `trialo`, pwd: `trialo_dev` |
| **MongoDB** | localhost:27017 | user: `trialo`, pwd: `trialopass` |
| **Redis** | localhost:6379 | |

---

## 9. Stopping & Restarting

```bash
# Stop all containers (preserves data volumes)
docker compose -f docker-compose.dev.yml down

# Restart everything
docker compose -f docker-compose.dev.yml up -d

# Stop and DELETE all data volumes (full reset)
docker compose -f docker-compose.dev.yml down -v
# Then re-run: bash data-backup/restore.sh
```

---

## 10. Troubleshooting

### "Cannot connect to the Docker daemon"
Docker Desktop is not running. Start it from your Applications folder.

### Services keep restarting

```bash
# Check logs for the failing service
docker compose -f docker-compose.dev.yml logs --tail=50 <service-name>
```

Common causes:
- **agent-runtime / context-graph**: Ollama not running or `nomic-embed-text` not pulled. Run `ollama serve` and `ollama pull nomic-embed-text`.
- **protocol-usdm-v3**: `ANTHROPIC_API_KEY` not set in `.env`. The service will fail on startup without it. Comment it out of `docker-compose.dev.yml` if you don't need USDM generation.
- **quality-service**: Expects `quality_db` database. Run: `docker exec trialo-postgres-1 sh -c "PGPASSWORD=trialo_dev psql -U trialo -c 'CREATE DATABASE quality_db;'"`.

### Frontend shows blank page or API errors

Wait 30–60 seconds after `docker compose up` — Next.js needs to compile on first start. Check:
```bash
docker compose -f docker-compose.dev.yml logs frontend
```

### PostgreSQL restore errors "relation already exists"

The dump uses `--clean --if-exists` so this is safe to ignore. Re-run restore if data seems incomplete.

### Ollama models not found by services

```bash
# Verify Ollama is running and models are present
ollama list
# Should show: nomic-embed-text, gemma:latest, llama3.2:3b

# If Ollama is not running
ollama serve
```

On Linux, `host.docker.internal` may not resolve inside containers. Add to `docker-compose.dev.yml` under the relevant service:
```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

### Port conflicts

If another service is using a port (e.g., 5432, 27017, 9092), stop it or change the host-side port in `docker-compose.dev.yml`:
```yaml
ports:
  - "15432:5432"  # map host port 15432 → container 5432
```

### Neo4j fails health check

Neo4j takes up to 60 seconds to initialize. Services that depend on it will retry. Check:
```bash
docker compose -f docker-compose.dev.yml logs neo4j
```

### "disk full" errors in Docker

```bash
# Remove unused images and volumes
docker system prune -f
docker volume prune -f
```

---

## Appendix: Manual Database Setup (without restore script)

If you prefer a fresh empty database instead of restoring the backup:

```bash
# PostgreSQL — run init + all migrations
docker exec trialo-postgres-1 sh -c \
  "PGPASSWORD=trialo_dev psql -U trialo -d trialo" \
  < infrastructure/scripts/init-db.sql

# Run numbered migrations
for f in infrastructure/scripts/migrations/*.sql; do
  docker exec -i trialo-postgres-1 sh -c \
    "PGPASSWORD=trialo_dev psql -U trialo -d trialo" < "$f"
done

# MinIO — create buckets
bash infrastructure/scripts/seed-minio-buckets.sh

# MongoDB — create collections
docker exec trialo-mongodb-1 mongosh \
  --username trialo --password trialopass \
  --authenticationDatabase admin \
  trialo infrastructure/scripts/seed-mongodb.js
```

---

*Last updated: 2026-05-06 — TrialOS v2.1.0 (branch: update6may)*
