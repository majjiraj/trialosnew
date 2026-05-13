-- Migration 025: Memory Engine (Layer 3 — Memory + Learnings + Decision Trees)
-- Episodic, semantic, procedural, performance memories;
-- agent learnings, decision trees, memory contradictions.

CREATE TABLE IF NOT EXISTS episodic_memories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id),
    study_id        UUID REFERENCES studies(id),
    run_id          UUID REFERENCES agent_runs(id),
    episode_type    TEXT NOT NULL CHECK (episode_type IN (
        'success','failure','partial','hitl_correction','novel_situation'
    )),
    context_summary TEXT NOT NULL,
    outcome_summary TEXT NOT NULL,
    key_decisions   JSONB NOT NULL DEFAULT '[]',
    evidence_used   JSONB NOT NULL DEFAULT '[]',
    embedding       VECTOR(768),
    importance      FLOAT NOT NULL DEFAULT 1.0,
    access_count    INT NOT NULL DEFAULT 0,
    last_accessed   TIMESTAMPTZ,
    decay_factor    FLOAT NOT NULL DEFAULT 1.0,
    expires_at      TIMESTAMPTZ,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ep_mem_agent ON episodic_memories(agent_definition_id, study_id);
CREATE INDEX IF NOT EXISTS idx_ep_mem_org ON episodic_memories(org_id, is_active);
CREATE INDEX IF NOT EXISTS idx_ep_mem_embedding ON episodic_memories
    USING ivfflat (embedding vector_cosine_ops) WITH (lists=50)
    WHERE embedding IS NOT NULL AND is_active = TRUE;

CREATE TABLE IF NOT EXISTS semantic_memories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    scope           TEXT NOT NULL CHECK (scope IN ('global','org','study','domain')),
    scope_id        TEXT,
    fact_type       TEXT NOT NULL CHECK (fact_type IN (
        'rule','pattern','preference','constraint','relationship','calibration'
    )),
    subject         TEXT NOT NULL,
    predicate       TEXT NOT NULL,
    object          TEXT NOT NULL,
    confidence      FLOAT NOT NULL DEFAULT 1.0,
    support_count   INT NOT NULL DEFAULT 1,
    contradiction_count INT NOT NULL DEFAULT 0,
    embedding       VECTOR(768),
    source_episode_ids UUID[] NOT NULL DEFAULT '{}',
    decay_factor    FLOAT NOT NULL DEFAULT 1.0,
    expires_at      TIMESTAMPTZ,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sem_mem_org ON semantic_memories(org_id, scope, fact_type, is_active);
CREATE INDEX IF NOT EXISTS idx_sem_mem_embedding ON semantic_memories
    USING ivfflat (embedding vector_cosine_ops) WITH (lists=50)
    WHERE embedding IS NOT NULL AND is_active = TRUE;

CREATE TABLE IF NOT EXISTS procedural_memories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    task_type       TEXT NOT NULL,
    procedure_name  TEXT NOT NULL,
    steps           JSONB NOT NULL DEFAULT '[]',
    preconditions   JSONB NOT NULL DEFAULT '{}',
    expected_outcome TEXT,
    success_rate    FLOAT NOT NULL DEFAULT 0.0,
    run_count       INT NOT NULL DEFAULT 0,
    embedding       VECTOR(768),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, task_type, procedure_name)
);

CREATE INDEX IF NOT EXISTS idx_proc_mem_org ON procedural_memories(org_id, task_type, is_active);

CREATE TABLE IF NOT EXISTS performance_memories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id),
    study_id        UUID REFERENCES studies(id),
    period_start    DATE NOT NULL,
    period_end      DATE NOT NULL,
    run_count       INT NOT NULL DEFAULT 0,
    success_count   INT NOT NULL DEFAULT 0,
    hitl_count      INT NOT NULL DEFAULT 0,
    avg_confidence  FLOAT,
    avg_duration_secs FLOAT,
    avg_cost_usd    FLOAT DEFAULT 0,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, agent_definition_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_perf_mem_agent ON performance_memories(agent_definition_id, period_start DESC);

CREATE TABLE IF NOT EXISTS agent_learnings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    scope           TEXT NOT NULL CHECK (scope IN ('agent','task','client','platform')),
    agent_definition_id UUID REFERENCES agent_definitions(id),
    task_type       TEXT,
    learning_type   TEXT NOT NULL CHECK (learning_type IN (
        'gold_pattern','anti_pattern','calibration','edge_case','preference'
    )),
    description     TEXT NOT NULL,
    evidence        JSONB NOT NULL DEFAULT '{}',
    confidence      FLOAT NOT NULL DEFAULT 0.8,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    human_verified  BOOLEAN NOT NULL DEFAULT FALSE,
    embedding       VECTOR(768),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_learnings_org ON agent_learnings(org_id, scope, learning_type, active);
CREATE INDEX IF NOT EXISTS idx_learnings_embedding ON agent_learnings
    USING ivfflat (embedding vector_cosine_ops) WITH (lists=50)
    WHERE embedding IS NOT NULL AND active = TRUE;

CREATE TABLE IF NOT EXISTS decision_trees (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    tree_name       TEXT NOT NULL,
    task_type       TEXT NOT NULL,
    tree_definition JSONB NOT NULL DEFAULT '{}',
    version         INT NOT NULL DEFAULT 1,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, tree_name, version)
);

CREATE INDEX IF NOT EXISTS idx_dt_org ON decision_trees(org_id, task_type, is_active);

CREATE TABLE IF NOT EXISTS memory_contradictions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    memory_a_id     UUID NOT NULL,
    memory_a_type   TEXT NOT NULL,
    memory_b_id     UUID NOT NULL,
    memory_b_type   TEXT NOT NULL,
    contradiction_description TEXT NOT NULL,
    resolution      TEXT,
    resolved_by     TEXT,
    resolved_at     TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending','resolved','dismissed')
    ),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contradictions_org ON memory_contradictions(org_id, status);
