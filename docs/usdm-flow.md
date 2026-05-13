# USDM Conversion Flow — Technical Reference

**Scope:** End-to-end data flow for `http://localhost:3000/usdm`  
**Last updated:** 2026-05-13

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Services & Ports](#2-services--ports)
3. [Database Schema](#3-database-schema)
4. [Status State Machine](#4-status-state-machine)
5. [Page-by-Page Flow](#5-page-by-page-flow)
6. [USDM Conversion Pipeline](#6-usdm-conversion-pipeline)
7. [Human-in-the-Loop (HITL) Approval](#7-human-in-the-loop-hitl-approval)
8. [Quality Evaluation](#8-quality-evaluation)
9. [Artifact Storage](#9-artifact-storage)
10. [GraphQL API Reference](#10-graphql-api-reference)
11. [REST API Reference](#11-rest-api-reference)
12. [End-to-End Data Flow Diagram](#12-end-to-end-data-flow-diagram)

---

## 1. Architecture Overview

The USDM flow converts a clinical trial protocol PDF into a structured USDM v4 JSON model. It spans five backend microservices, a PostgreSQL relational database, MinIO object storage, and a Next.js frontend.

```
Browser (Next.js)
    │
    ├─ GraphQL (:4000) ──────────────────────── graphql-api/index.js
    │       │
    │       ├─ Agent Runtime (:8004) ─────────── agent-runtime/main.py
    │       │       │
    │       │       ├─ Protocol-USDM-V3 (:8020)  (Claude Opus 4.7 sidecar)
    │       │       ├─ Quality Service (:8016)
    │       │       └─ Context Graph (:8008)
    │       │
    │       └─ Ingestion (:8003) ─────────────── ingestion/main.py
    │
    └─ Study Graph (:8013)
```

**Storage:**

| Store | Purpose |
|-------|---------|
| PostgreSQL (:5432) | `usdm_conversions`, `documents`, `agent_runs`, `approval_requests` |
| MinIO / S3 (:9000) | Protocol PDFs, USDM v4 JSON artifacts |
| Redis (:6379) | Embedding cache, standards cache |
| Neo4j (:7687) | Context graph (section provenance, knowledge graph) |

---

## 2. Services & Ports

| Service | Port | Role in USDM Flow |
|---------|------|-------------------|
| `graphql-api` | 4000 | Unified GraphQL gateway; all browser mutations/queries |
| `agent-runtime` | 8004 | USDM pipeline execution, HITL resumption, download |
| `ingestion-service` | 8003 | Protocol PDF upload, chunking, embedding |
| `protocol-usdm-v3` | 8020 | Claude Opus 4.7 USDM generation with self-healing |
| `quality-service` | 8016 | ICH M11, CDISC CT, structural validation |
| `context-graph` | 8008 | Section provenance & knowledge graph |
| `study-graph` | 8013 | Study metadata (name, phase, therapeutic area) |
| `standards-registry` | 8012 | CDISC CT codes, USDM IG section definitions |

**Frontend env vars:**

```
NEXT_PUBLIC_GRAPHQL_URL       = http://localhost:4000/graphql
NEXT_PUBLIC_AGENT_RUNTIME_URL = http://localhost:8004
NEXT_PUBLIC_INGESTION_URL     = http://localhost:8003
NEXT_PUBLIC_STUDY_GRAPH_URL   = http://localhost:8013
NEXT_PUBLIC_ORG_ID            = 00000000-0000-0000-0000-000000000000
```

---

## 3. Database Schema

### 3.1 `usdm_conversions` (primary table)

Migration: `infrastructure/scripts/migrations/018_usdm.sql`  
Later amended by: `019_usdm_draft.sql`, `031_cognitive_usdm_agent.sql`, `037_usdm_plan_id.sql`

```sql
CREATE TABLE usdm_conversions (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID        NOT NULL REFERENCES organizations(id),
    study_id            TEXT,

    -- Source protocol document
    protocol_doc_id     TEXT,                       -- NULL while in selecting_document state
    protocol_filename   TEXT        NOT NULL DEFAULT '',
    protocol_s3_key     TEXT        NOT NULL DEFAULT '',

    -- Output
    name                TEXT        NOT NULL,       -- user-entered label from "New Conversion" modal
    status              TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN (
                                'selecting_document', 'pending', 'running',
                                'waiting_approval', 'waiting_cro_approval',
                                'approved', 'rejected', 'completed', 'failed'
                            )),
    usdm_json           JSONB       DEFAULT '{}',

    -- Orchestration links
    run_id              TEXT,       -- → agent_runs.id
    approval_id         UUID,       -- → approval_requests.id (current pending review)
    plan_id             TEXT,       -- → super-agent plan id

    -- Quality scores (populated after AI generation, before HITL)
    confidence          FLOAT,      -- overall DDF score
    eval_accuracy       FLOAT,      -- protocol digitization accuracy
    eval_completeness   FLOAT,      -- populated USDM sections / 10
    eval_standards      FLOAT,      -- ICH M11 + USDM IG conformance
    eval_hallucination  FLOAT,      -- 1.0 − hallucination_rate
    eval_readability    FLOAT,      -- absence of placeholder text
    eval_consistency    FLOAT,      -- technical feasibility score
    eval_cost_usd       FLOAT,      -- LLM inference cost

    -- Meta
    created_by          TEXT,
    error_message       TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX usdm_conversions_org_idx    ON usdm_conversions(org_id);
CREATE INDEX usdm_conversions_status_idx ON usdm_conversions(status);
CREATE INDEX usdm_conversions_study_idx  ON usdm_conversions(study_id);
CREATE INDEX usdm_conversions_plan_idx   ON usdm_conversions(plan_id);
```

### 3.2 `name` field

`usdm_conversions.name` is the **free-text label the user types** in the "New Conversion" modal. It is:
- Written once at INSERT time (`status = 'selecting_document'`)
- Never overwritten by the pipeline
- Shown in the UI "Title" column, falling back to `study.name` if a study is linked

### 3.3 `agent_runs`

Tracks pipeline execution. Each USDM conversion has exactly one `agent_runs` row.

```sql
CREATE TABLE agent_runs (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id UUID        NOT NULL REFERENCES agent_installations(id),
    study_id        UUID        NOT NULL REFERENCES studies(id),
    status          TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (status IN (
                            'pending', 'running', 'waiting_approval',
                            'completed', 'failed', 'cancelled'
                        )),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    input_context   JSONB       DEFAULT '{}',   -- conversion_id, protocol_doc_id, s3_key, etc.
    step_traces     JSONB       DEFAULT '[]',   -- one entry per pipeline step
    artifacts       JSONB       DEFAULT '[]',   -- S3 artifact references post-approval
    metadata        JSONB       DEFAULT '{}',   -- ddf_scores, section_provenance, loop history
    checkpoint_data JSONB       DEFAULT '{}',   -- resume state across HITL pause
    output_summary  TEXT,
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**`agent_runs.metadata` structure (written after generation):**

```json
{
  "ddf_scores": {
    "overall_score": 0.87,
    "protocol_digitization_accuracy": 0.91,
    "automated_output_quality": 0.84,
    "interoperability_standards": 0.88,
    "hallucination_risk": 0.05,
    "technical_feasibility": 0.90,
    "standards_score_breakdown": { "studyIdentifiers_schema": 1.0, "...": "..." },
    "passed": true
  },
  "section_provenance": {
    "arms":    [{ "chunk_id": "...", "page_number": 12, "excerpt": "..." }],
    "epochs":  [...],
    "objectives": [...]
  },
  "generation_loop_history": [ { "attempt": 1, "score": 0.72 }, { "attempt": 2, "score": 0.87 } ],
  "generation_loop_summary": {
    "attempts_executed": 2,
    "best_attempt": 2,
    "llm_model": "claude-opus-4-7-...",
    "sections_extracted": ["meta", "identifiers", "arms", "epochs"]
  }
}
```

### 3.4 `approval_requests`

One row per HITL review event. A conversion with CRO review gets two rows (sponsor → CRO).

```sql
CREATE TABLE approval_requests (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id              UUID        NOT NULL REFERENCES agent_runs(id),
    org_id              UUID        NOT NULL REFERENCES organizations(id),
    study_id            UUID        REFERENCES studies(id),
    assignee_id         TEXT        NOT NULL,        -- user ID of reviewer
    title               TEXT        NOT NULL,        -- "Review USDM v4 Mapping — {study}"
    description         TEXT,
    proposed_action     JSONB       NOT NULL,         -- usdm_json at review time
    status              TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'approved', 'rejected', 'modified')),
    decision_by         TEXT,
    decision_at         TIMESTAMPTZ,
    decision_note       TEXT,
    modified_action     JSONB,                        -- edits made by reviewer
    reviewer_role       TEXT        NOT NULL DEFAULT 'sponsor',  -- 'sponsor' | 'cro'
    parent_approval_id  UUID        REFERENCES approval_requests(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 3.5 `documents` (protocol source)

```sql
CREATE TABLE documents (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID        NOT NULL,
    study_id        TEXT,
    document_type   TEXT        NOT NULL,   -- 'protocol' | 'sap' | 'crf' | 'sdtm_dataset' | ...
    file_name       TEXT        NOT NULL,
    bronze_s3_key   TEXT,                   -- s3://trialo-documents/{doc_id}/document.pdf
    sha256_hash     TEXT,                   -- prevents duplicate uploads
    status          TEXT        DEFAULT 'pending',   -- pending | indexed | error
    is_foundational BOOLEAN     DEFAULT false,
    version         TEXT,
    document_date   DATE,
    uploaded_by     UUID,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

### 3.6 `document_chunks`

```sql
CREATE TABLE document_chunks (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID        NOT NULL REFERENCES documents(id),
    chunk_index     INT         NOT NULL,
    page_number     INT,
    section         TEXT,       -- protocol section label
    content         TEXT,       -- raw extracted text
    embedding       VECTOR(768),-- nomic-embed-text, used for semantic search
    metadata        JSONB       DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 4. Status State Machine

```
[New] ──► selecting_document ──► pending ──► running ──► waiting_approval
                                                │              │
                                             failed        approved ──► waiting_cro_approval
                                                                │              │
                                                           rejected        approved
                                                                               │
                                                                           approved ──► completed
```

| Status | Set When | `agent_runs.status` |
|--------|----------|---------------------|
| `selecting_document` | Draft created, no protocol yet | — (no run yet) |
| `pending` | Protocol attached; run queued | `pending` |
| `running` | Pipeline executing | `running` |
| `waiting_approval` | USDM generated; sponsor review required | `waiting_approval` |
| `waiting_cro_approval` | Sponsor approved; CRO review required | `waiting_approval` |
| `approved` | All reviewers approved | `completed` |
| `completed` | Artifact uploaded to S3 | `completed` |
| `rejected` | Reviewer rejected, no restart | `cancelled` |
| `failed` | Unrecoverable pipeline error | `failed` |

**Conversion ID & Duration (list page columns):**

| Column | Source | Logic |
|--------|--------|-------|
| Conversion ID | `usdm_conversions.id` | First 8 chars of UUID, uppercased. Hidden when queued. |
| Duration | `usdm_conversions.created_at` / `updated_at` | `updated_at − created_at` when finished; `now() − created_at` while running. Hidden when queued. |

---

## 5. Page-by-Page Flow

### 5.1 List Page — `/usdm`

On load, two parallel REST calls:

```
GET :8013/studies?org_id={orgId}       → study list
GET :8004/usdm?org_id={orgId}          → SELECT * FROM usdm_conversions ORDER BY created_at DESC
```

**Create new conversion:**

```graphql
mutation($orgId: String!, $name: String!, $createdBy: String) {
  createUsdmDraft(orgId: $orgId, name: $name, createdBy: $createdBy) { id }
}
```

Inserts `usdm_conversions` row with `status = 'selecting_document'` and the user-entered `name`.

### 5.2 Detail Page — `/usdm/[id]`

GraphQL query on mount, polls every 4 s while `status ∈ {running, pending}`:

```graphql
query($id: ID!) {
  usdmConversion(id: $id) {
    id name status protocolFilename protocolDocId runId approvalId studyId
    usdmJson errorMessage createdAt updatedAt
    confidence evalAccuracy evalCompleteness evalStandards evalHallucination evalReadability
  }
}
```

**Select / upload protocol → start conversion:**

```
POST :8003/documents/upload  { file, org_id, document_type: "protocol" }
→ { document_id, s3_key }

mutation beginUsdmConversion($id, $protocolDocId, $protocolFilename, $protocolS3Key, ...)
→ POST :8004/usdm/{id}/start  →  pipeline starts in background
```

**Approve/reject:**

```graphql
mutation resumeAgentRun(
  $runId, $approvalId, $decision,   # 'approved' | 'rejected' | 'modified'
  $modifiedSpec, $decidedBy, $note, $restart
)
→ POST :8004/runs/{runId}/resume
```

### 5.3 Workbench — `/usdm/[id]/workbench`

Three-panel layout: USDM section tree + JSON editor | Protocol chunks | PDF viewer.

**USDM sections:**

| Key | USDM Path |
|-----|-----------|
| `meta` | study root |
| `studyIdentifiers` | study.studyIdentifiers |
| `studyProtocols` | study.studyProtocolVersions |
| `therapeuticAreas` | study.businessTherapeuticAreas |
| `objectives` | study.studyDesigns[0].objectives |
| `estimands` | study.studyDesigns[0].estimands |
| `populations` | study.studyDesigns[0].studyPopulations |
| `arms` | study.studyDesigns[0].studyArms |
| `epochs` | study.studyDesigns[0].studyEpochs |
| `activities` | study.studyDesigns[0].activities |

Section change auto-refreshes chunks panel and PDF (React `key`-based iframe remount).

---

## 6. USDM Conversion Pipeline

### 6.1 Trigger

`beginUsdmConversion` GraphQL mutation → `POST :8004/usdm/{id}/start` → background task enqueued.

### 6.2 Six-Step Pipeline

`execute_usdm_converter_run()` — `agent-runtime/main.py:22523`

```
Step 1 ─ Document Resolution
    Fetch protocol PDF from MinIO; validate title grounding
    UPDATE agent_runs SET status='running'

Step 2 ─ Chunk Retrieval
    SELECT content, section, page_number FROM document_chunks
    WHERE document_id = protocol_doc_id ORDER BY chunk_index

Step 3 ─ Few-Shot Context
    _fetch_past_usdm_examples()  →  past approved conversions as reference
    Fetch USDM IG + ICH M11 sections from knowledge graph

Step 4 ─ USDM Generation (two paths)
    PRIMARY: protocol-usdm-v3 sidecar (:8020)
        POST /v1/extract  →  poll /v1/jobs/{id}  →  GET /v1/jobs/{id}/usdm
    FALLBACK: _generate_and_verify_usdm_with_retries()
        10 parallel section sub-agents (self-healing, up to 5 iterations)

Step 5 ─ Quality Evaluation & Grounding Guards
    _evaluate_usdm_ddf()
    _validate_ich_m11_completeness(), _validate_cdisc_ct()
    _validate_hallucinations(), _validate_structural_integrity()
    _apply_title_grounding_guard()    ← title must appear in source text
    Write eval_* scores → usdm_conversions

Step 6 ─ HITL Pause
    INSERT approval_requests (proposed_action = usdm_json)
    UPDATE usdm_conversions SET status='waiting_approval', approval_id=...
    UPDATE agent_runs SET status='waiting_approval'
```

### 6.3 Section Sub-Agents (fallback path)

10 agents run in parallel, each targeting one USDM JSON path:

| Agent | USDM Path | ICH M11 |
|-------|-----------|---------|
| `study_meta` | `study.versions[0]` | §1 Title Page |
| `study_identifiers` | `study.versions[0].studyIdentifiers` | §1 Title Page |
| `therapeutic_areas` | `study.businessTherapeuticAreas` | §2 Background |
| `objectives_endpoints` | `study.versions[0].studyDesigns[0].objectives` | §3 Objectives |
| `estimands` | `study.versions[0].studyDesigns[0].estimands` | §3 ICH E9 R1 |
| `study_design` | `study.versions[0].studyDesigns[0]` | §4 Design |
| `study_arms` | `study.versions[0].studyDesigns[0].studyArms` | §4 Arms |
| `study_epochs` | `study.versions[0].studyDesigns[0].studyEpochs` | §4 Periods |
| `population` | `study.versions[0].studyDesigns[0].studyPopulations` | §5 Population |
| `activities` | `study.versions[0].studyDesigns[0].activities` | §9 Activities |

### 6.4 Self-Healing Validation Loop

Up to 5 generation attempts; best score wins. 8 validation dimensions:
USDM schema · ICH M11 completeness · CDISC CT codes · biomedical concept grounding · past org feedback · hallucination detection · downstream SDTM/CRF readiness · structural integrity.

---

## 7. Human-in-the-Loop (HITL) Approval

### 7.1 Two-Tier Review

```
AI generates USDM
    ↓
approval_requests row 1: reviewer_role='sponsor'
    ↓
Sponsor reviews in workbench → approve
    ↓ (if cro_reviewer_id set)
approval_requests row 2: reviewer_role='cro', parent_approval_id = row 1
usdm_conversions.status = 'waiting_cro_approval'
    ↓
CRO approves → continue_usdm_converter_run()
    ↓
Upload to S3 · status = 'approved'
```

### 7.2 Resume Payload

`POST :8004/runs/{run_id}/resume` — `agent-runtime/main.py:13869`

```python
decision: str      # 'approved' | 'rejected' | 'modified'
modified_spec: dict  # reviewer edits (if any)
decided_by: str
reviewer_role: str   # 'sponsor' | 'cro'
note: str
restart: bool        # rejected + True = re-run pipeline; False = cancel
```

### 7.3 Continuation — `continue_usdm_converter_run()` (`main.py:23462`)

```
1. Mark step 5 completed in step_traces
2. Upload USDM JSON to S3:
       s3://trialo-artifacts/{org_id}/{study_id}/artifacts/{run_id}/usdm_v4.json
3. Append to agent_runs.artifacts[]
4. UPDATE agent_runs SET status='completed'
5. UPDATE usdm_conversions SET status='approved', usdm_json=final_json
6. INSERT decision_trace record
7. Store gold pattern for future few-shot examples
8. Emit audit events
```

---

## 8. Quality Evaluation

Scores computed in Step 5, written to `usdm_conversions` before the HITL pause.

| Column | Measures |
|--------|----------|
| `confidence` | DDF overall score (avg of all dimensions) |
| `eval_accuracy` | Protocol digitization accuracy |
| `eval_completeness` | Populated sections / 10 |
| `eval_standards` | ICH M11 + USDM IG conformance |
| `eval_hallucination` | `1.0 − hallucination_rate` |
| `eval_readability` | Absence of placeholder/template text |

Quality Service (`services/quality-service/main.py`) provides three independent validators:
`validate_ich_m11()` · `validate_cdisc_ct()` · `validate_schema_fields()`

---

## 9. Artifact Storage

| Object | S3 Key | Written When |
|--------|--------|-------------|
| Protocol PDF | `documents/{doc_id}/document.pdf` | On ingestion upload |
| USDM v4 JSON | `{org_id}/{study_id}/artifacts/{run_id}/usdm_v4.json` | After approval |

---

## 10. GraphQL API Reference

### Queries

```graphql
usdmConversions(orgId: String!, studyId: String): [UsdmConversion!]!
usdmConversion(id: ID!): UsdmConversion
validateProtocolDoc(s3Key: String!, filename: String!): ProtocolValidation
```

### Mutations

```graphql
createUsdmDraft(orgId, studyId, name, createdBy): UsdmConversion!
beginUsdmConversion(id, protocolDocId, protocolFilename, protocolS3Key, createdBy, croReviewerId): UsdmConversion!
startUsdmConversion(orgId, studyId, protocolDocId, protocolFilename, protocolS3Key, name, createdBy, croReviewerId): UsdmConversion!
updateUsdmConversion(id, usdmJson, corrections): UsdmConversion!
resumeAgentRun(runId, approvalId, decision, modifiedSpec, decidedBy, reviewerRole, note, restart): JSON!
```

### UsdmConversion type

```graphql
type UsdmConversion {
  id: ID!
  orgId: String!
  studyId: String
  protocolDocId: String
  protocolFilename: String
  name: String!          # user-entered label, written once at draft creation
  status: String!
  usdmJson: JSON
  runId: String
  approvalId: String
  planId: String
  createdBy: String
  errorMessage: String
  confidence: Float
  evalAccuracy: Float
  evalCompleteness: Float
  evalStandards: Float
  evalHallucination: Float
  evalReadability: Float
  createdAt: String
  updatedAt: String
}
```

---

## 11. REST API Reference

### Ingestion (:8003)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/documents/upload` | Upload protocol PDF |
| `GET` | `/documents` | List documents (`?org_id&study_id`) |
| `GET` | `/documents/{docId}/chunks/{chunkId}` | Fetch single chunk text |
| `GET` | `/documents/{docId}/serve` | Serve PDF for iframe viewer |

### Agent Runtime (:8004)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/usdm` | List conversions (`?org_id&study_id`) |
| `POST` | `/usdm/draft` | Create draft (no protocol) |
| `POST` | `/usdm/{id}/start` | Attach protocol and start pipeline |
| `POST` | `/usdm` | Create and start in one call |
| `PATCH` | `/usdm/{id}` | Update USDM JSON during HITL |
| `GET` | `/usdm/{id}/download` | Download final USDM v4 JSON |
| `GET` | `/runs/{runId}/provenance-manifest` | Section-to-chunk citation map |
| `POST` | `/runs/{runId}/resume` | Submit HITL decision |
| `POST` | `/evaluate-usdm-ddf` | Re-run DDF quality evaluation |

### Study Graph (:8013)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/studies` | List studies (`?org_id`) |

---

## 12. End-to-End Data Flow Diagram

```
USER                   BROWSER              GRAPHQL(:4000)       AGENT-RUNTIME(:8004)
 │                        │                      │                       │
 │── clicks "New" ───────►│                      │                       │
 │                        │── createUsdmDraft ──►│                       │
 │                        │                      │── POST /usdm/draft ──►│
 │                        │                      │                       │── INSERT usdm_conversions
 │                        │                      │                       │   status='selecting_document'
 │                        │                      │                       │   name = user-entered string
 │◄── redirect /usdm/{id}─│◄─────────────────────│◄──────────────────────│
 │                        │                      │                       │
 │── uploads PDF ────────►│                      │                       │
 │                        │── POST :8003/documents/upload ──────────────────────────► INGESTION(:8003)
 │                        │                                                               │── INSERT documents
 │                        │                                                               │── Upload PDF → S3
 │                        │                                                               │── Chunk + embed
 │◄── { document_id } ────│◄──────────────────────────────────────────────────────────────│
 │                        │                      │                       │
 │── clicks "Start" ─────►│                      │                       │
 │                        │── beginUsdmConversion►│                       │
 │                        │                      │── POST /usdm/{id}/start►│
 │                        │                      │                       │── UPDATE usdm_conversions
 │                        │                      │                       │   status='pending'
 │                        │                      │                       │── INSERT agent_runs
 │                        │                      │                       │── [background task]
 │                        │                      │                       │
 │                        │                      │     execute_usdm_converter_run()
 │                        │                      │                       │── Fetch PDF from S3
 │                        │                      │                       │── Query document_chunks
 │                        │                      │                       │── Fetch past examples
 │                        │                      │                       │
 │                        │                      │    PROTOCOL-USDM-V3(:8020)
 │                        │                      │                       │── POST /v1/extract
 │                        │                      │                       │── Poll /v1/jobs/{id}
 │                        │                      │                       │── GET /v1/jobs/{id}/usdm
 │                        │                      │                       │── GET quality report
 │                        │                      │                       │
 │                        │                      │                       │── Evaluate quality
 │                        │                      │                       │── INSERT approval_requests
 │                        │                      │                       │── UPDATE usdm_conversions
 │                        │                      │                       │   status='waiting_approval'
 │                        │                      │                       │   usdm_json=..., eval_*=...
 │                        │                      │                       │
 │── polls (4s) ─────────►│── usdmConversion ───►│── SELECT usdm_conversions
 │◄─ status=waiting_approval◄───────────────────────────────────────────│
 │                        │                      │                       │
 │── reviews workbench ──►│                      │                       │
 │── edits sections ─────►│── updateUsdmConversion►│── PATCH /usdm/{id}─►│── UPDATE usdm_conversions.usdm_json
 │                        │                      │                       │
 │── clicks "Approve" ───►│── resumeAgentRun ───►│                       │
 │                        │                      │── POST /runs/{id}/resume►│
 │                        │                      │                       │── UPDATE approval_requests
 │                        │                      │                       │── [background task]
 │                        │                      │  continue_usdm_converter_run()
 │                        │                      │                       │── Upload USDM → S3
 │                        │                      │                       │── UPDATE usdm_conversions
 │                        │                      │                       │   status='approved'
 │                        │                      │                       │── UPDATE agent_runs
 │                        │                      │                       │   status='completed'
 │                        │                      │                       │── Emit audit events
 │                        │                      │                       │
 │── clicks "Download" ──►│── GET :8004/usdm/{id}/download ─────────────►│── S3 presigned URL
 │◄─ USDM v4 JSON ────────│◄──────────────────────────────────────────────│
```

---

## Key Source Files

| Component | File |
|-----------|------|
| GraphQL schema + resolvers | `services/graphql-api/index.js` |
| Main pipeline function | `services/agent-runtime/main.py:22523` |
| Section sub-agents | `services/agent-runtime/main.py:20440` |
| HITL resume handler | `services/agent-runtime/main.py:13869` |
| Post-approval continuation | `services/agent-runtime/main.py:23462` |
| Quality check builder | `services/agent-runtime/main.py:12493` |
| Quality service validators | `services/quality-service/main.py` |
| Protocol-USDM-V3 sidecar | `services/protocol-usdm-v3/` |
| Ingestion upload + chunking | `services/ingestion/main.py` |
| Database schema (USDM) | `infrastructure/scripts/migrations/018_usdm.sql` |
| Draft status addition | `infrastructure/scripts/migrations/019_usdm_draft.sql` |
| Quality columns | `infrastructure/scripts/migrations/031_cognitive_usdm_agent.sql` |
| Plan ID addition | `infrastructure/scripts/migrations/037_usdm_plan_id.sql` |
| USDM list page | `frontend/src/app/(dashboard)/usdm/page.tsx` |
| USDM detail page | `frontend/src/app/(dashboard)/usdm/[id]/page.tsx` |
| USDM workbench | `frontend/src/app/(dashboard)/usdm/[id]/workbench/page.tsx` |
