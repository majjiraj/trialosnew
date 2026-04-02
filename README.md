# Trialo — Clinical Trial AI Platform

A comprehensive, production-grade platform for clinical trial data management and AI-driven CDISC compliance. **Trialo** automates SDTM mapping, generates synthetic test data, and provides intelligent decision traces with built-in self-correction loops.

![Status](https://img.shields.io/badge/status-active-brightgreen) ![Version](https://img.shields.io/badge/version-2.0.0-blue) ![License](https://img.shields.io/badge/license-MIT-green)

---

## 🎯 Features

### 🔬 SDTM Raw Data Mapper
- **Multi-sheet Excel support** — handle AE, DM, CM domains in separate sheets
- **Domain-isolated mapping** — ensures column names don't cross domains
- **Synonym-based mapping** — 70+ EDC→SDTM column synonyms pre-mapped
- **LLM-assisted mapping** — GPT/Ollama/Azure/Anthropic for semantic matching
- **Self-validation** — auto-fix phantom columns, missing required vars, duplicates
- **HITL approval** — human-in-the-loop review before data export
- **Audit trail** — full decision traces with reasoning, evidence, confidence scores

### 📊 Test Data Generator
- **Multiple formats** — CSV, Excel, XPT (SAS), PDF
- **Data types** — SDTM, ADaM, Protocol, TLF, CRF, Raw EDC
- **Full domain coverage** — SDTM (21 domains), ADaM (10), CRF (12)
- **Therapeutic areas** — Oncology, Cardiology, Neurology, Immunology, etc.
- **Realistic EDC naming** — randomized column names (Gender/Sex/Patient_Sex)
- **Data anomalies** — inject realistic quality issues (missing values, duplicates, outliers)

### 🤖 Agent Self-Correction Engine
- **Step verification** — check every LLM output for quality (empty, refusal, truncation)
- **Retry loop** — up to 2 auto-corrected attempts before human escalation
- **SDTM auto-fix** — correct validation errors (phantom columns, missing required vars)
- **Decision traces** — log each attempt, corrections, and final validation score

### 📈 Multi-Agent Orchestration
- **LangChain flow builder** — visual workflow with 12+ node types
- **Context graph** — Neo4j-backed knowledge retrieval with decision traces
- **Async execution** — topologically-sorted DAG execution with span tracing
- **Tool ecosystem** — 50+ built-in tools (data access, calculations, document generation)

### 🔐 Audit & Compliance
- **Decision traces** — 10-layer auto-enriched reasoning traces
- **Audit provenance** — all actions logged with user, timestamp, before/after state
- **GraphQL API** — query traces, runs, decisions, audit events
- **GDPR/21 CFR Part 11** — phi detection, masking, compliance logging

---

## 📋 Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Frontend (Next.js)                           │
│         Data Generator | SDTM Mapper | Agent Flows | Audit         │
└────────────────────────────┬────────────────────────────────────────┘
                             │ GraphQL
                             ↓
┌─────────────────────────────────────────────────────────────────────┐
│                       GraphQL API (Apollo)                          │
│    Queries: runs, traces, decisions | Mutations: approve, feedback │
└────────┬──────────────────────────────────────────────────────────┬─┘
         │ gRPC                                                      │ REST
         ↓                                                            ↓
    ┌────────────┐                                            ┌──────────────┐
    │   Agent    │  SDTM Mapper  Data Generator  Self-Correct  │ Auth Service │
    │   Runtime  │  Self-Validation  Tool Executor  Utilities  └──────────────┘
    └─────┬──────┘
          │
    ┌─────┴──────────────┬──────────────────┬──────────┐
    ↓                    ↓                  ↓          ↓
┌────────┐          ┌──────────┐      ┌────────┐  ┌────────┐
│   DB   │          │ Context  │      │ Kafka  │  │  OPA   │
│ Postgres│          │  Graph   │      │        │  │ Policy │
└────────┘          │  Neo4j   │      └────────┘  └────────┘
                    └──────────┘
```

---

## 🚀 Quick Start

### Prerequisites
- **Docker & Docker Compose** (v20.10+)
- **Python** 3.11+ (for local dev)
- **Node.js** 18+ (for frontend dev)
- **Git**

### 1. Clone the Repository

```bash
git clone https://github.com/majjiraj/trialos.git
cd trialos
```

### 2. Configure Environment

Create `.env` file in the root with required variables:

```bash
# Database
DATABASE_URL=postgresql://trialo:trialo@postgres:5432/trialo
NEO4J_URI=neo4j://neo4j:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=trialo123

# Services
AGENT_RUNTIME_PORT=8004
GRAPHQL_API_PORT=4000
FRONTEND_PORT=3000

# LLM (optional — defaults to Ollama)
OLLAMA_BASE_URL=http://ollama:11434
OPENAI_API_KEY=sk-...  # Optional
AZURE_OPENAI_ENDPOINT=https://...  # Optional

# Auth (default: demo mode, no auth required)
AUTH_ENABLED=false
JWT_SECRET=demo-secret-key

# Features
ENABLE_SELF_CORRECTION=true
MAX_RETRIES=2
```

### 3. Start Docker Compose

**Full stack** (all services):
```bash
docker-compose -f docker-compose.dev.yml up -d
```

**Individual services** (if needed):
```bash
# Just the databases
docker-compose -f docker-compose.dev.yml up -d postgres neo4j

# Add agent runtime
docker-compose -f docker-compose.dev.yml up -d postgres neo4j context-graph agent-runtime

# Add frontend & API
docker-compose -f docker-compose.dev.yml up -d
```

**Check status:**
```bash
docker-compose -f docker-compose.dev.yml ps
```

Expected output:
```
NAME                          STATUS
trialo-postgres-1             Up 2 minutes
trialo-neo4j-1                Up 2 minutes
trialo-context-graph-1        Up 2 minutes
trialo-agent-runtime-1        Up 1 minute (port 8004)
trialo-graphql-api-1          Up 1 minute (port 4000)
trialo-frontend-1             Up 1 minute (port 3000)
```

### 4. Access the Platform

- **Frontend:** http://localhost:3000
- **GraphQL Playground:** http://localhost:4000/graphql
- **Agent Runtime Health:** http://localhost:8004/health
- **Neo4j Browser:** http://localhost:7474 (user: neo4j, pwd: trialo123)

---

## 📖 Usage Guide

### Generate Test Data

**Via Frontend:**
1. Go to http://localhost:3000 → **Data Generator**
2. Select **Data Type** (SDTM, ADaM, CRF, RawEDC)
3. Choose **Sub-types** (domains)
4. Set **Output Format** (CSV, XLS, XPT, PDF)
5. Specify **Row Count** (up to 1 crore)
6. Optionally check **"Add Anomalies"** and choose **Therapeutic Area** (for RawEDC)
7. Click **Generate** → Download

**Via API:**
```bash
curl -X POST http://localhost:8004/generate-test-data \
  -H "Content-Type: application/json" \
  -d '{
    "data_type": "RawEDC",
    "sub_domains": ["DM", "AE", "CM"],
    "output_format": "CSV",
    "num_rows": 100,
    "add_anomalies": false,
    "study_id": "STUDY-001",
    "therapeutic_area": "Oncology"
  }' \
  -o test_data.zip
```

**Via Python:**
```python
from services.agent_runtime import data_generator as dg

file_bytes, filename, mime_type = dg.generate(
    data_type="RawEDC",
    sub_domains=["DM", "AE", "CM"],
    output_format="CSV",
    num_rows=100,
    add_anomalies=False,
    study_id="STUDY-001",
    therapeutic_area="Oncology"
)

with open(filename, "wb") as f:
    f.write(file_bytes)
```

### Upload EDC Data & Map to SDTM

**Via Frontend:**
1. Navigate to **SDTM Mapper**
2. Upload EDC files (Excel with sheets or CSV)
3. Select **target domains** (AE, DM, CM, etc.)
4. Click **Start Mapping**
5. Review auto-mapped columns (green = high confidence, yellow = manual review needed)
6. **System auto-corrects** validation errors (phantom columns, missing vars)
7. Approve mappings → download mapping spec + transformed SDTM data

**Via API:**
```bash
# Submit files
curl -X POST http://localhost:8004/sdtm-mapper/submit \
  -F "files=@data/AE.csv" \
  -F "files=@data/DM.csv" \
  -F "files=@data/CM.csv" \
  -F "target_domains=AE,DM,CM" \
  -F "study_id=STUDY-001"

# Returns run_id, poll status:
RUN_ID="abc123..."

# Poll for mapping results
curl http://localhost:8004/sdtm-mapper/runs/$RUN_ID/status

# Approve mappings
curl -X POST http://localhost:8004/sdtm-mapper/runs/$RUN_ID/approve

# Download SDTM output
curl http://localhost:8004/sdtm-mapper/runs/$RUN_ID/download \
  -o sdtm_output.zip
```

---

## 🧪 Testing

### Unit Tests

**Agent Runtime:**
```bash
cd services/agent-runtime
python -m pytest tests/ -v
```

**Frontend:**
```bash
cd frontend
npm test
```

### Integration Tests

**SDTM Mapper:**
```bash
# Generate test EDC data
python services/agent-runtime/data_generator.py --type RawEDC --count 50

# Run mapper
curl -X POST http://localhost:8004/sdtm-mapper/submit -F "files=@test_edc.csv"

# Verify mapping output
unzip sdtm_output.zip && cat SDTM_mapping_spec.json
```

**Self-Correction Engine:**
```bash
# Create a flow with intentionally low-quality LLM prompt
# - Verification will fail (output too short, refusal pattern, etc.)
# - Agent will auto-retry with correction prompt
# - Check step traces for verification metadata

curl http://localhost:4000/graphql -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query { agentRuns(limit: 1) { id stepTraces { status verification { passed score issues } } } }"
  }'
```

### Load Testing

**1000 rows, 3 domains, Oncology TA:**
```bash
for i in {1..5}; do
  echo "Run $i..."
  curl -X POST http://localhost:8004/generate-test-data \
    -H "Content-Type: application/json" \
    -d '{
      "data_type":"RawEDC",
      "sub_domains":["DM","AE","CM"],
      "output_format":"CSV",
      "num_rows":1000,
      "therapeutic_area":"Oncology"
    }' \
    -o test_$i.zip
done
```

---

## 🛠 Development

### Local Setup (No Docker)

**Install dependencies:**
```bash
# Backend
cd services/agent-runtime
pip install -r requirements.txt

# Frontend
cd ../../frontend
npm install
```

**Start services:**
```bash
# Terminal 1: Agent Runtime (port 8004)
cd services/agent-runtime
python main.py

# Terminal 2: GraphQL API (port 4000)
cd services/graphql-api
npm start

# Terminal 3: Frontend (port 3000)
cd frontend
npm run dev
```

### Project Structure

```
trialos/
├── frontend/                      # Next.js app
│   ├── src/app/(dashboard)/
│   │   ├── data-generator/        # Test data generation UI
│   │   ├── sdtm-mapper/           # SDTM mapper UI
│   │   └── agent-builder/         # Flow builder
│   └── package.json
│
├── services/
│   ├── agent-runtime/             # Python FastAPI backend
│   │   ├── main.py                # Core API + agent orchestration
│   │   ├── data_generator.py      # Test data generator
│   │   └── requirements.txt
│   │
│   ├── graphql-api/               # Node.js GraphQL
│   │   ├── schema/                # GraphQL types
│   │   └── resolvers/
│   │
│   └── context-graph/             # Neo4j decision traces
│
├── packages/                       # Shared utilities
├── infrastructure/                 # Terraform, K8s configs
├── docker-compose.dev.yml          # Full stack
└── README.md
```

### Code Guidelines

- **Python:** PEP 8, type hints, docstrings
- **TypeScript/React:** ESLint + Prettier
- **Git commits:** Include Co-authored-by trailer

```bash
git commit -m "Feature: Add SDTM validator

Validates mapping spec for required vars and phantom columns.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## 🔑 Key Concepts

### Decision Traces

Every agent decision is recorded with 10 auto-enriched layers:
1. **Input Context** — raw query, intent
2. **Evidence Confidence** — evidence count vs. confidence
3. **Evidence Assembly** — sources cited, quality scored
4. **Retrieval Reasoning** — strategy, keywords
5. **Alternatives** — rejected options + why
6. **Confidence Decomposition** — retrieval, evidence, tool, formulation scores
7. **Validation** — methods applied (schema check, required vars)
8. **Learning Recommendation** — improve future runs
9. **Feedback Validation** — human corrections applied
10. **Step Linkage** — dependencies, downstream effects

**Query example:**
```graphql
query {
  agentRuns(limit: 5) {
    id
    status
    stepTraces {
      step
      name
      status
      verification {
        passed
        score
        issues
        corrections_applied
      }
    }
    decisionTraces {
      traceType
      confidence
      reasoning_steps { step thought action }
      sources_cited { doc_name chunk_id score }
    }
  }
}
```

### Self-Correction Loop

For LLM nodes in agent flows:

1. **Execute** → call LLM
2. **Verify** → check output for:
   - Empty response
   - Refusal patterns ("I cannot", "insufficient data")
   - Truncation
   - Format compliance (JSON, bullet list, etc.)
3. **Score** → 0–1.0 confidence
4. **If failed** → build correction prompt with issues + retry (up to 2 times)
5. **Log** → all attempts in step trace + decision trace

Enable via node config:
```json
{
  "type": "llm",
  "prompt": "Analyze the data...",
  "self_correction": {
    "enabled": true,
    "max_retries": 2
  }
}
```

### SDTM Mapper Pipeline

1. **Parse EDC files** → detect sheets, columns
2. **Retrieve CDISC IG** → vector search for 3 query types per domain
3. **Pre-map** → exact name match + 70+ synonyms + file-domain isolation
4. **LLM map** → semantic matching for unmapped columns
5. **Validate** → check for required vars, phantom columns, duplicates
6. **Auto-correct** → fix errors (phantom removal, required var injection)
7. **HITL approval** → human review + optional modifications
8. **Output** → mapping spec + transformed SDTM files (XPT, CSV)

---

## 🐳 Docker Reference

### Service Port Map

| Service | Port | URL |
|---------|------|-----|
| Frontend | 3000 | http://localhost:3000 |
| GraphQL API | 4000 | http://localhost:4000/graphql |
| Agent Runtime | 8004 | http://localhost:8004 |
| PostgreSQL | 5432 | localhost:5432 |
| Neo4j | 7474 | http://localhost:7474 |
| Neo4j Bolt | 7687 | bolt://localhost:7687 |

### Rebuild Containers

```bash
# Agent runtime only
docker-compose -f docker-compose.dev.yml build agent-runtime

# All services
docker-compose -f docker-compose.dev.yml build

# No cache (clean rebuild)
docker-compose -f docker-compose.dev.yml build --no-cache
```

### View Logs

```bash
# All services
docker-compose -f docker-compose.dev.yml logs -f

# Specific service
docker-compose -f docker-compose.dev.yml logs -f agent-runtime

# Last 100 lines, specific service
docker-compose -f docker-compose.dev.yml logs --tail=100 agent-runtime
```

### Clean Up

```bash
# Stop all containers
docker-compose -f docker-compose.dev.yml down

# Remove volumes (DELETES DATA!)
docker-compose -f docker-compose.dev.yml down -v

# Restart from scratch
docker-compose -f docker-compose.dev.yml down -v && docker-compose -f docker-compose.dev.yml up -d
```

---

## 📊 Sample Queries

### GraphQL: Query Recent Agent Runs

```graphql
{
  agentRuns(limit: 10, orderBy: CREATED_AT_DESC) {
    id
    status
    agentType
    createdAt
    completedAt
    stepCount
    errorCount
    outputPreview
  }
}
```

### GraphQL: Query Decision Traces with Low Confidence

```graphql
{
  decisionTraces(
    where: { confidence_lt: 0.75 }
    limit: 20
  ) {
    id
    traceType
    confidence
    input_ctx { message }
    reasoning_steps {
      step
      thought
      action
      tool_used
    }
    sources_cited {
      doc_name
      score
    }
  }
}
```

### REST: Check Agent Health

```bash
curl http://localhost:8004/health
# Response: {"status":"ok","service":"agent-runtime","version":"2.0.0"}
```

### REST: List Available Domains for Data Generation

```bash
curl http://localhost:8004/generate-test-data/domains | jq '.'
```

---

## 🐛 Troubleshooting

### Frontend shows "Agent Runtime Unreachable"

**Check if backend is running:**
```bash
docker-compose -f docker-compose.dev.yml ps agent-runtime

# If not running, start it:
docker-compose -f docker-compose.dev.yml up -d agent-runtime

# View logs:
docker-compose -f docker-compose.dev.yml logs agent-runtime
```

### SDTM Mapper: "No CDISC IG data found"

The context graph (Neo4j) needs CDISC SDTM IG documents loaded. This happens automatically on first run. If missing:

```bash
# Rebuild context-graph service
docker-compose -f docker-compose.dev.yml build context-graph
docker-compose -f docker-compose.dev.yml up -d context-graph

# Monitor ingestion:
docker-compose -f docker-compose.dev.yml logs context-graph
```

### Data Generation: "No rows generated"

- Ensure **Row Count** ≥ 1
- Check that at least one **Sub-type/Domain** is selected
- For RawEDC, ensure at least one of: AE, DM, CM, LB, VS, EX, etc. is selected

### Agent Run Stuck "Running"

- Check agent-runtime logs: `docker-compose logs agent-runtime | grep -i error`
- If flow has HITL step, it may be waiting for human approval
- Approve via API: `curl -X POST http://localhost:8004/runs/{run_id}/resume-from-hitl`

### Neo4j Connection Error

- Verify Neo4j is running: `docker-compose ps neo4j`
- Check credentials in `.env` match `docker-compose.dev.yml`
- Try accessing browser: http://localhost:7474 (default user: neo4j, pwd: trialo123)

---

## 📚 Documentation

- **Agent Architecture** → See `docs/agent-architecture.md`
- **SDTM Mapper Guide** → See `docs/sdtm-mapper.md`
- **GraphQL Schema** → Available at `/graphql-api/schema/`
- **LLM Providers** → See `docs/llm-setup.md` (Ollama, OpenAI, Azure, Anthropic)

---

## 🤝 Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/my-feature`
3. Commit with co-author trailer: `git commit -m "..."`
4. Push: `git push origin feature/my-feature`
5. Open pull request

---

## 📄 License

MIT License — see LICENSE file

---

## 📧 Support

- **Issues:** https://github.com/majjiraj/trialos/issues
- **Discussions:** https://github.com/majjiraj/trialos/discussions
- **Email:** majjiraj@gmail.com

---

## 🎉 Acknowledgments

Built with:
- **FastAPI** — Python backend
- **Next.js** — Frontend
- **LangChain** — Agent orchestration
- **Neo4j** — Knowledge graph
- **PostgreSQL** — Relational data
- **Docker** — Containerization
- **CDISC SDTM IG v3.4** — Regulatory standards

---

**Last Updated:** April 2, 2026 | **Version:** 2.0.0
