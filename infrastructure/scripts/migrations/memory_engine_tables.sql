-- Memory Engine Tables Migration
-- Creates tables needed by services/memory-engine/main.py

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS episodic_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    agent_definition_id UUID NOT NULL,
    study_id UUID,
    run_id UUID,
    episode_type TEXT NOT NULL DEFAULT 'run',
    context_summary TEXT NOT NULL DEFAULT '',
    outcome_summary TEXT NOT NULL DEFAULT '',
    key_decisions JSONB NOT NULL DEFAULT '[]',
    evidence_used JSONB NOT NULL DEFAULT '[]',
    importance FLOAT NOT NULL DEFAULT 0.5,
    embedding VECTOR(768),
    access_count INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_accessed TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS semantic_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    scope TEXT NOT NULL DEFAULT 'org',
    scope_id TEXT,
    fact_type TEXT NOT NULL DEFAULT 'fact',
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    confidence FLOAT NOT NULL DEFAULT 1.0,
    support_count INT NOT NULL DEFAULT 1,
    source_episode_ids UUID[] NOT NULL DEFAULT '{}',
    embedding VECTOR(768),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS procedural_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    task_type TEXT NOT NULL,
    procedure_name TEXT NOT NULL,
    steps JSONB NOT NULL DEFAULT '[]',
    preconditions JSONB NOT NULL DEFAULT '{}',
    expected_outcome TEXT,
    success_rate FLOAT,
    run_count INT NOT NULL DEFAULT 0,
    embedding VECTOR(768),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, task_type, procedure_name)
);

CREATE TABLE IF NOT EXISTS agent_learnings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    scope TEXT NOT NULL DEFAULT 'agent',
    agent_definition_id UUID,
    task_type TEXT,
    learning_type TEXT NOT NULL,
    description TEXT NOT NULL,
    evidence JSONB NOT NULL DEFAULT '{}',
    confidence FLOAT NOT NULL DEFAULT 0.8,
    embedding VECTOR(768),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    study_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS decision_trees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    tree_name TEXT NOT NULL,
    description TEXT,
    nodes JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS performance_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    agent_definition_id UUID NOT NULL,
    task_type TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    metric_value FLOAT NOT NULL,
    context JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_semantic_org ON semantic_memories(org_id);
CREATE INDEX IF NOT EXISTS idx_semantic_fact_type ON semantic_memories(fact_type);
CREATE INDEX IF NOT EXISTS idx_semantic_subject ON semantic_memories(subject);
CREATE INDEX IF NOT EXISTS idx_episodic_org_agent ON episodic_memories(org_id, agent_definition_id);
CREATE INDEX IF NOT EXISTS idx_learnings_org_type ON agent_learnings(org_id, learning_type);
CREATE INDEX IF NOT EXISTS idx_procedural_org_task ON procedural_memories(org_id, task_type);
