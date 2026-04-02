"""
TrialOS Marketplace Service
Agent Registry: discovery, install, consent, versioning.
Supports: trialo-native, verified-third-party, org-custom-sdk, org-created (UI-built).
Creation modes: wizard (config-driven / prompt-agent) and flowchart (langchain-flow).
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pydantic_settings import BaseSettings
import structlog
import asyncpg
import json
import uuid
import semver
import re as _re_mp
from datetime import datetime, timezone
from typing import Optional, Literal
import openai as _openai_mp

log = structlog.get_logger()

class Settings(BaseSettings):
    database_url: str
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "gemma:latest"
    context_graph_url: str = "http://localhost:8008"
    class Config:
        env_file = ".env"

settings = Settings()
db_pool: asyncpg.Pool = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global db_pool
    db_pool = await asyncpg.create_pool(settings.database_url, ssl="disable")
    await seed_initial_agents()
    log.info("marketplace.startup")
    yield
    await db_pool.close()

app = FastAPI(title="TrialOS Marketplace", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Ensure CORS headers are present even on unhandled 500 errors
@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    from fastapi.responses import JSONResponse
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc)},
        headers={"Access-Control-Allow-Origin": "*"},
    )

# ============================================================
# CONSTANTS
# ============================================================

VALID_DATA_SOURCES = [
    "sdtm",        # SDTM domains (DM, AE, LB, VS, CM, ...)
    "adam",        # ADaM datasets (ADSL, ADAE, ADLB, ...)
    "raw_edc",     # Raw EDC/CDASH data before SDTM mapping
    "ctms",        # Clinical Trial Management System data
    "budget",      # Study financials / site budgets
    "documents",   # Protocol, SAP, ICF, Lab Manual (RAG)
    "ig",          # CDISC Implementation Guides
    "crf",         # CRF specifications
    "sap",         # Statistical Analysis Plan
]

VALID_PURPOSES = Literal[
    "conversational",
    "chart_generation",
    "sdtm_mapping",
    "budget_analysis",
    "protocol_writing",
    "custom",
]

# Tool → permission scope mapping (covers all 17 tools in agent-runtime)
TOOL_REGISTRY_SCOPES = {
    # Core data read tools
    "read_sdtm_domain":           "study:data:read",
    "read_adam_dataset":          "study:data:read",
    "read_raw_edc_data":          "study:data:read",
    "read_ctms_data":             "study:data:read",
    "query_budget_data":          "study:data:read",
    "read_crf_specification":     "study:docs:read",
    # Document / RAG tools
    "search_documents":           "study:docs:read",
    "read_protocol_section":      "study:docs:read",
    "search_implementation_guides": "platform:guidelines:read",
    # Write / action tools
    "raise_data_query":           "study:queries:write",
    "close_data_query":           "study:queries:write",
    "generate_pdf_report":        "study:reports:write",
    "generate_chart":             "study:reports:write",
    "create_document":            "study:reports:write",
    "send_notification":          "platform:notify:write",
    "create_approval_request":    "platform:approvals:write",
    # Validation tools
    "check_cdisc_conformance":    "study:validation:read",
    "run_sdtm_mapping":           "study:reports:write",
    "validate_sdtm_mapping":      "study:validation:read",
}

# Default tools per purpose (mirrors PURPOSE_DEFAULT_TOOLS in agent-runtime)
PURPOSE_DEFAULT_TOOLS: dict[str, list[str]] = {
    "conversational": [
        "read_sdtm_domain", "read_adam_dataset", "search_documents",
        "read_protocol_section", "raise_data_query",
    ],
    "chart_generation": [
        "read_sdtm_domain", "read_adam_dataset", "query_budget_data",
        "generate_chart", "generate_pdf_report",
    ],
    "sdtm_mapping": [
        "read_raw_edc_data", "read_crf_specification", "run_sdtm_mapping",
        "validate_sdtm_mapping", "search_implementation_guides", "search_documents",
    ],
    "budget_analysis": [
        "query_budget_data", "read_adam_dataset", "generate_chart",
        "generate_pdf_report", "send_notification",
    ],
    "protocol_writing": [
        "search_documents", "search_implementation_guides", "read_protocol_section",
        "read_sdtm_domain", "create_document",
    ],
    "custom": [
        "read_sdtm_domain", "search_documents", "generate_pdf_report",
    ],
}

# Default data sources per purpose
PURPOSE_DEFAULT_DATA_SOURCES: dict[str, list[str]] = {
    "conversational":   ["sdtm", "adam", "documents"],
    "chart_generation": ["sdtm", "adam", "budget"],
    "sdtm_mapping":     ["raw_edc", "crf", "ig"],
    "budget_analysis":  ["budget", "ctms", "sdtm"],
    "protocol_writing": ["documents", "ig", "sap", "crf"],
    "custom":           ["sdtm", "documents"],
}

# ============================================================
# SEED: 20 INITIAL AGENTS
# ============================================================

INITIAL_AGENTS = [
    # DATA MANAGEMENT
    {
        "name": "SDTM Conformance Checker",
        "slug": "sdtm-conformance-checker",
        "version": "1.0.0",
        "category": "data_management",
        "agent_purpose": "sdtm_mapping",
        "description": "Runs CDISC SDTM conformance checks across all study domains. Generates findings report with severity levels (ERROR/WARNING). Equivalent to Pinnacle 21 Community checks.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-sdtm-conformance-checker:1.0.0",
        "required_permissions": ["study:data:read", "study:validation:read", "study:reports:write"],
        "declared_tools": ["read_sdtm_domain", "check_cdisc_conformance", "generate_pdf_report", "send_notification"],
        "data_sources": ["sdtm"],
    },
    {
        "name": "Query Rate Monitor",
        "slug": "query-rate-monitor",
        "version": "1.0.0",
        "category": "data_management",
        "agent_purpose": "conversational",
        "description": "Tracks open query rates per site and domain. Alerts when query response rate drops below configurable SLA threshold (default 90%). Generates weekly site compliance report.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-query-rate-monitor:1.0.0",
        "required_permissions": ["study:data:read", "study:reports:write", "platform:notify:write"],
        "declared_tools": ["read_sdtm_domain", "generate_pdf_report", "send_notification"],
        "data_sources": ["sdtm", "ctms"],
    },
    {
        "name": "Missing Data Sweeper",
        "slug": "missing-data-sweeper",
        "version": "1.0.0",
        "category": "data_management",
        "agent_purpose": "custom",
        "description": "Identifies and prioritizes missing required data points across all SDTM domains. Raises targeted data queries for missing critical fields. Generates missing data heat map by site.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-missing-data-sweeper:1.0.0",
        "required_permissions": ["study:data:read", "study:queries:write", "study:reports:write", "platform:notify:write"],
        "declared_tools": ["read_sdtm_domain", "raise_data_query", "generate_pdf_report", "send_notification"],
        "data_sources": ["sdtm"],
    },
    {
        "name": "Duplicate Subject Detector",
        "slug": "duplicate-subject-detector",
        "version": "1.0.0",
        "category": "data_management",
        "agent_purpose": "custom",
        "description": "Identifies potential duplicate subject enrollments using fuzzy matching on demographics (DOB, sex, initials, site) and creates approval request for DM review.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-duplicate-subject-detector:1.0.0",
        "required_permissions": ["study:data:read", "platform:approvals:write", "platform:notify:write"],
        "declared_tools": ["read_sdtm_domain", "create_approval_request", "send_notification"],
        "data_sources": ["sdtm"],
    },
    {
        "name": "Protocol Deviation Detector",
        "slug": "protocol-deviation-detector",
        "version": "1.0.0",
        "category": "data_management",
        "agent_purpose": "conversational",
        "description": "Cross-references study data against protocol eligibility criteria and visit windows. Flags potential protocol deviations and categorizes by severity. Uses RAG to pull relevant protocol sections.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-protocol-deviation-detector:1.0.0",
        "required_permissions": ["study:data:read", "study:docs:read", "study:reports:write", "platform:notify:write"],
        "declared_tools": ["read_sdtm_domain", "search_documents", "generate_pdf_report", "send_notification"],
        "data_sources": ["sdtm", "documents"],
    },
    # SAFETY
    {
        "name": "SAE Detector",
        "slug": "sae-detector",
        "version": "1.0.0",
        "category": "safety",
        "agent_purpose": "custom",
        "description": "Monitors adverse event data for serious adverse events (SAE). Triggers safety workflow on detection: medical monitor review → narrative writing → regulatory reporting. 24/7 monitoring.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-sae-detector:1.0.0",
        "required_permissions": ["study:data:read", "study:reports:write", "platform:notify:write", "platform:approvals:write"],
        "declared_tools": ["read_sdtm_domain", "send_notification", "create_approval_request", "generate_pdf_report"],
        "data_sources": ["sdtm"],
    },
    {
        "name": "AE Severity Grader",
        "slug": "ae-severity-grader",
        "version": "1.0.0",
        "category": "safety",
        "agent_purpose": "custom",
        "description": "Automatically applies CTCAE v5.0 grading to adverse events based on event term and description. Flags discrepancies between entered severity and CTCAE grade for DM review.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-ae-severity-grader:1.0.0",
        "required_permissions": ["study:data:read", "study:queries:write", "platform:notify:write"],
        "declared_tools": ["read_sdtm_domain", "raise_data_query", "send_notification"],
        "data_sources": ["sdtm"],
    },
    {
        "name": "Concomitant Med Conflict Checker",
        "slug": "concomitant-med-conflict-checker",
        "version": "1.0.0",
        "category": "safety",
        "agent_purpose": "conversational",
        "description": "Flags prohibited concomitant medication use per protocol exclusion criteria. Uses RAG to retrieve relevant protocol sections. Raises queries for protocol-prohibited medications found in CM domain.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-concomitant-med-conflict-checker:1.0.0",
        "required_permissions": ["study:data:read", "study:docs:read", "study:queries:write", "platform:notify:write"],
        "declared_tools": ["read_sdtm_domain", "search_documents", "raise_data_query", "send_notification"],
        "data_sources": ["sdtm", "documents"],
    },
    # SITE MONITORING
    {
        "name": "Site Performance Reporter",
        "slug": "site-performance-reporter",
        "version": "1.0.0",
        "category": "site_monitoring",
        "agent_purpose": "chart_generation",
        "description": "Generates weekly site performance reports: enrollment rate, query rate, SDV completion %, protocol deviations, missing data %. Benchmarks each site against study average.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-site-performance-reporter:1.0.0",
        "required_permissions": ["study:data:read", "study:reports:write", "platform:notify:write"],
        "declared_tools": ["read_sdtm_domain", "generate_chart", "generate_pdf_report", "send_notification"],
        "data_sources": ["sdtm", "ctms"],
    },
    {
        "name": "Enrollment Forecaster",
        "slug": "enrollment-forecaster",
        "version": "1.0.0",
        "category": "site_monitoring",
        "agent_purpose": "chart_generation",
        "description": "Predicts enrollment completion date with 80% confidence interval using historical enrollment velocity per site. Alerts when projected completion date exceeds target.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-enrollment-forecaster:1.0.0",
        "required_permissions": ["study:data:read", "study:reports:write", "platform:notify:write"],
        "declared_tools": ["read_sdtm_domain", "generate_chart", "generate_pdf_report", "send_notification"],
        "data_sources": ["sdtm", "ctms"],
    },
    # ANALYTICS
    {
        "name": "Data Lock Readiness Checker",
        "slug": "data-lock-readiness-checker",
        "version": "1.0.0",
        "category": "analytics",
        "agent_purpose": "custom",
        "description": "Runs comprehensive pre-lock checklist: open queries, missing data, conformance errors, unresolved deviations, outstanding approval requests. Generates readiness score and action list.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-data-lock-readiness-checker:1.0.0",
        "required_permissions": ["study:data:read", "study:validation:read", "study:reports:write"],
        "declared_tools": ["read_sdtm_domain", "check_cdisc_conformance", "generate_pdf_report"],
        "data_sources": ["sdtm", "adam"],
    },
    {
        "name": "Adverse Event Summary Reporter",
        "slug": "adverse-event-summary-reporter",
        "version": "1.0.0",
        "category": "analytics",
        "agent_purpose": "chart_generation",
        "description": "Generates AE summary tables organized by MedDRA System Organ Class (SOC) and Preferred Term (PT). Calculates incidence rates per treatment arm. Standard CSR table format.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-ae-summary-reporter:1.0.0",
        "required_permissions": ["study:data:read", "study:reports:write"],
        "declared_tools": ["read_sdtm_domain", "read_adam_dataset", "generate_chart", "generate_pdf_report"],
        "data_sources": ["sdtm", "adam"],
    },
    # REGULATORY
    {
        "name": "SDTM Annotation Generator",
        "slug": "sdtm-annotation-generator",
        "version": "1.0.0",
        "category": "regulatory",
        "agent_purpose": "sdtm_mapping",
        "description": "Auto-generates SDTM annotations on CRF pages, mapping CRF fields to SDTM variables. Uses protocol and CRF documents via RAG. Outputs annotated CRF PDF.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-sdtm-annotation-generator:1.0.0",
        "required_permissions": ["study:data:read", "study:docs:read", "study:reports:write"],
        "declared_tools": ["read_crf_specification", "search_implementation_guides", "search_documents", "generate_pdf_report"],
        "data_sources": ["crf", "ig", "documents"],
    },
    {
        "name": "21 CFR Part 11 Auditor",
        "slug": "21cfr-part11-auditor",
        "version": "1.0.0",
        "category": "regulatory",
        "agent_purpose": "custom",
        "description": "Generates audit trail report for FDA inspection readiness. Verifies hash chain integrity, checks MFA compliance, session timeouts, e-signature records. Exportable PDF/CSV.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-21cfr-part11-auditor:1.0.0",
        "required_permissions": ["study:data:read", "study:reports:write"],
        "declared_tools": ["generate_pdf_report"],
        "data_sources": ["sdtm"],
    },
    # MEDICAL WRITING
    {
        "name": "Clinical Narrative Writer",
        "slug": "clinical-narrative-writer",
        "version": "1.0.0",
        "category": "medical_writing",
        "agent_purpose": "protocol_writing",
        "description": "Generates draft SAE narratives in standard MedWatch/CIOMS format using subject-level AE, CM, MH, LB, and DM data. Includes relevant protocol context via RAG. Draft requires medical monitor review.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-clinical-narrative-writer:1.0.0",
        "required_permissions": ["study:data:read", "study:docs:read", "study:reports:write", "platform:approvals:write"],
        "declared_tools": ["read_sdtm_domain", "search_documents", "create_document", "create_approval_request"],
        "data_sources": ["sdtm", "documents"],
    },
    # OPERATIONS
    {
        "name": "Budget Variance Monitor",
        "slug": "budget-variance-monitor",
        "version": "1.0.0",
        "category": "operations",
        "agent_purpose": "budget_analysis",
        "description": "Monitors site budget vs actuals weekly. Flags categories exceeding 10% variance. Provides consolidated cross-site view for sponsors. Alerts finance team on threshold breach.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-budget-variance-monitor:1.0.0",
        "required_permissions": ["study:data:read", "study:reports:write", "platform:notify:write"],
        "declared_tools": ["query_budget_data", "generate_chart", "generate_pdf_report", "send_notification"],
        "data_sources": ["budget", "ctms"],
    },
    {
        "name": "Milestone Payment Tracker",
        "slug": "milestone-payment-tracker",
        "version": "1.0.0",
        "category": "operations",
        "agent_purpose": "budget_analysis",
        "description": "Tracks per-visit and per-procedure payment milestones across all sites. Flags overdue payments, generates site payment status report, notifies finance on aging milestones.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-milestone-payment-tracker:1.0.0",
        "required_permissions": ["study:data:read", "study:reports:write", "platform:notify:write"],
        "declared_tools": ["query_budget_data", "generate_chart", "generate_pdf_report", "send_notification"],
        "data_sources": ["budget", "ctms"],
    },
    {
        "name": "Budget Forecaster",
        "slug": "budget-forecaster",
        "version": "1.0.0",
        "category": "operations",
        "agent_purpose": "budget_analysis",
        "description": "Projects end-of-study spend using enrollment trajectory × per-subject cost model. Calculates burn rate, estimated completion cost, and budget headroom. Alerts when forecast exceeds budget.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-budget-forecaster:1.0.0",
        "required_permissions": ["study:data:read", "study:reports:write", "platform:notify:write"],
        "declared_tools": ["query_budget_data", "read_sdtm_domain", "generate_chart", "generate_pdf_report", "send_notification"],
        "data_sources": ["budget", "sdtm", "ctms"],
    },
    {
        "name": "Lab Value Outlier Detector",
        "slug": "lab-value-outlier-detector",
        "version": "1.0.0",
        "category": "safety",
        "agent_purpose": "custom",
        "description": "Detects lab value outliers using reference ranges from the Lab Manual and SDTM LB domain. Flags extreme values (>3x ULN for liver enzymes, etc.) for urgent medical review.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-lab-value-outlier-detector:1.0.0",
        "required_permissions": ["study:data:read", "study:docs:read", "platform:notify:write", "platform:approvals:write"],
        "declared_tools": ["read_sdtm_domain", "search_documents", "send_notification", "create_approval_request"],
        "data_sources": ["sdtm", "documents"],
    },
    {
        "name": "Supply Chain Monitor",
        "slug": "supply-chain-monitor",
        "version": "1.0.0",
        "category": "operations",
        "agent_purpose": "custom",
        "description": "Tracks study drug inventory levels across sites. Alerts on low stock based on enrollment velocity. Forecasts resupply needs using projected visit schedule.",
        "publisher_type": "trialo-native",
        "agent_type": "docker",
        "docker_image": "trialo/agent-supply-chain-monitor:1.0.0",
        "required_permissions": ["study:data:read", "study:reports:write", "platform:notify:write"],
        "declared_tools": ["read_sdtm_domain", "generate_chart", "generate_pdf_report", "send_notification"],
        "data_sources": ["sdtm", "ctms"],
    },
    # DATA MANAGEMENT — SDTM MAPPER (Human-in-the-Loop)
    {
        "name": "SDTM Raw Data Mapper",
        "slug": "sdtm-raw-data-mapper",
        "version": "1.0.0",
        "category": "data_management",
        "agent_purpose": "sdtm_mapping",
        "description": "Maps raw EDC data (CSV/XLS/XPT) to SDTM domains. AI-assisted column mapping with Human-in-the-Loop review. Generates Python transformation script and Excel mapping spec. Full 21 CFR Part 11 audit trail.",
        "publisher_type": "trialo-native",
        "agent_type": "sdtm_mapper",
        "docker_image": None,
        "required_permissions": [
            "study:data:read", "study:data:write", "study:validation:read",
            "study:reports:write", "platform:approvals:write", "platform:notify:write",
        ],
        "declared_tools": [
            "read_raw_edc_data", "search_implementation_guides",
            "read_crf_specification", "create_approval_request", "send_notification",
        ],
        "data_sources": ["raw_edc", "crf", "ig"],
        "flow_definition": {
            "nodes": [
                {"id": "n1", "type": "data_source", "label": "Raw EDC Files",
                 "config": {"tool": "read_raw_edc_data", "sourceType": "raw_edc", "params": {"formats": "CSV, XLS, XPT"}}},
                {"id": "n2", "type": "data_source", "label": "CRF Specification",
                 "config": {"tool": "read_crf_specification", "sourceType": "crf"}},
                {"id": "n3", "type": "data_source", "label": "CDISC SDTM IG v3.4",
                 "config": {"tool": "search_implementation_guides", "sourceType": "ig"}},
                {"id": "n4", "type": "llm", "label": "Generate Mapping Spec",
                 "config": {"model": "llama3.1:8b", "prompt": "Map raw EDC columns to SDTM variables with derivation rules and confidence scores."}},
                {"id": "n5", "type": "hitl", "label": "Human Review",
                 "config": {"checkpoint": "mapping_review", "title": "Review & Correct SDTM Mapping",
                            "description": "Validate AI mappings, correct errors, then approve."}},
                {"id": "n6", "type": "code", "label": "Generate Outputs",
                 "config": {"language": "python", "description": "Python script + Excel mapping spec"}},
                {"id": "n7", "type": "output", "label": "Mapping Artifacts",
                 "config": {"outputFormat": "xpt", "title": "SDTM Mapping Package"}},
            ],
            "edges": [
                {"source": "n1", "target": "n4"}, {"source": "n2", "target": "n4"},
                {"source": "n3", "target": "n4"}, {"source": "n4", "target": "n5"},
                {"source": "n5", "target": "n6"}, {"source": "n6", "target": "n7"},
            ],
        },
    },
    {
        "name": "SDTM Explorer",
        "slug": "sdtm-explorer",
        "version": "1.0.0",
        "category": "data_management",
        "agent_purpose": "conversational",
        "description": "Answers natural-language questions about SDTM XPT datasets. Uses RAG over ingested study documents to return subject counts, variable summaries, and domain-level statistics. Supports queries like 'Show AE records for subject 101' or 'What are the unique values in AESEV?'.",
        "publisher_type": "trialo-native",
        "agent_type": "langchain-flow",
        "docker_image": None,
        "required_permissions": ["study:docs:read", "study:data:read"],
        "declared_tools": ["search_documents"],
        "data_sources": ["documents", "sdtm"],
        "flow_definition": {
            "nodes": [
                {
                    "id": "n1", "type": "input", "label": "User Question",
                    "config": {"inputKey": "query", "description": "Natural-language question about the SDTM data"}
                },
                {
                    "id": "n2", "type": "tool_call", "label": "Search SDTM Documents",
                    "config": {
                        "tool": "search_documents",
                        "params": {"query": "{{query}}", "top_k": 8}
                    }
                },
                {
                    "id": "n3", "type": "llm", "label": "Answer Question",
                    "config": {
                        "model": "llama3.2:3b",
                        "systemPrompt": "You are an expert clinical data analyst. You have access to SDTM study data chunks. Answer the user's question accurately and concisely based on the retrieved context. If data is insufficient, say so clearly.",
                        "prompt": "Context from study documents:\n{{n2.result}}\n\nQuestion: {{query}}\n\nAnswer:"
                    }
                },
                {
                    "id": "n4", "type": "output", "label": "Response",
                    "config": {"outputFormat": "text", "title": "SDTM Analysis Result"}
                }
            ],
            "edges": [
                {"source": "n1", "target": "n2"},
                {"source": "n2", "target": "n3"},
                {"source": "n3", "target": "n4"}
            ]
        },
    },
]


async def seed_initial_agents():
    """Seed the initial TrialOS agents into the registry if not already present."""
    async with db_pool.acquire() as conn:
        for agent in INITIAL_AGENTS:
            flow_def = agent.get("flow_definition")
            await conn.execute("""
                INSERT INTO agent_definitions (
                    name, slug, version, category, description, publisher_type,
                    agent_type, docker_image, required_permissions, declared_tools,
                    agent_purpose, data_sources, flow_definition, is_published, is_verified
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,TRUE,TRUE)
                ON CONFLICT (slug) DO UPDATE SET
                    flow_definition = EXCLUDED.flow_definition,
                    agent_type = EXCLUDED.agent_type
            """,
                agent["name"], agent["slug"], agent["version"], agent["category"],
                agent["description"], agent["publisher_type"], agent["agent_type"],
                agent.get("docker_image"), agent["required_permissions"], agent["declared_tools"],
                agent.get("agent_purpose", "custom"), agent.get("data_sources", []),
                json.dumps(flow_def) if flow_def else None,
            )
    log.info("marketplace.seeded", agent_count=len(INITIAL_AGENTS))


# ============================================================
# AGENT TEMPLATES — one per purpose (for the wizard pre-fill)
# ============================================================

AGENT_TEMPLATES = {
    "conversational": {
        "purpose": "conversational",
        "label": "Conversational Data Analyst",
        "description": "Chat with your clinical trial data. Ask questions about subjects, adverse events, lab values, or protocol compliance using natural language.",
        "icon": "message-circle",
        "default_tools": PURPOSE_DEFAULT_TOOLS["conversational"],
        "default_data_sources": PURPOSE_DEFAULT_DATA_SOURCES["conversational"],
        "suggested_agent_type": "prompt-agent",
        "output_format": "narrative",
        "example_objective": "Answer questions about study data using SDTM domains and protocol documents. Provide concise, accurate answers with data citations.",
        "example_flow": {
            "nodes": [
                {"id": "n1", "type": "data_source", "label": "SDTM / ADaM", "config": {"sources": ["sdtm", "adam"]}},
                {"id": "n2", "type": "data_source", "label": "Protocol Docs", "config": {"sources": ["documents"]}},
                {"id": "n3", "type": "llm",         "label": "LLM Analysis",  "config": {"prompt": "Answer the user's question using the provided data."}},
                {"id": "n4", "type": "output",      "label": "Response",       "config": {"format": "narrative"}},
            ],
            "edges": [
                {"source": "n1", "target": "n3"},
                {"source": "n2", "target": "n3"},
                {"source": "n3", "target": "n4"},
            ],
        },
    },
    "chart_generation": {
        "purpose": "chart_generation",
        "label": "Chart & Visualization Agent",
        "description": "Generate interactive charts and dashboards from SDTM, ADaM, or budget data. Supports bar, line, scatter, box plots and more via Vega-Lite.",
        "icon": "bar-chart-2",
        "default_tools": PURPOSE_DEFAULT_TOOLS["chart_generation"],
        "default_data_sources": PURPOSE_DEFAULT_DATA_SOURCES["chart_generation"],
        "suggested_agent_type": "prompt-agent",
        "output_format": "json",
        "example_objective": "Visualize adverse event incidence rates by system organ class and treatment arm. Return a Vega-Lite chart specification.",
        "example_flow": {
            "nodes": [
                {"id": "n1", "type": "data_source", "label": "SDTM / ADaM",  "config": {"sources": ["sdtm", "adam"]}},
                {"id": "n2", "type": "llm",         "label": "LLM Analysis", "config": {"prompt": "Analyze the data and determine the best chart type."}},
                {"id": "n3", "type": "chart",       "label": "Chart Builder", "config": {"chart_type": "bar"}},
                {"id": "n4", "type": "output",      "label": "Chart Output",  "config": {"format": "vega-lite"}},
            ],
            "edges": [
                {"source": "n1", "target": "n2"},
                {"source": "n2", "target": "n3"},
                {"source": "n3", "target": "n4"},
            ],
        },
    },
    "sdtm_mapping": {
        "purpose": "sdtm_mapping",
        "label": "SDTM Mapping Agent",
        "description": "Transform raw EDC / CDASH data into CDISC SDTM domains. Uses CRF specifications and CDISC Implementation Guides to generate mapping logic and validate output.",
        "icon": "git-merge",
        "default_tools": PURPOSE_DEFAULT_TOOLS["sdtm_mapping"],
        "default_data_sources": PURPOSE_DEFAULT_DATA_SOURCES["sdtm_mapping"],
        "suggested_agent_type": "langchain-flow",
        "output_format": "json",
        "example_objective": "Map raw EDC data to SDTM AE domain following CDASH-to-SDTM conventions. Validate output against CDISC conformance rules.",
        "example_flow": {
            "nodes": [
                {"id": "n1", "type": "data_source", "label": "Raw EDC Data",     "config": {"sources": ["raw_edc"]}},
                {"id": "n2", "type": "data_source", "label": "CRF Spec + IGs",   "config": {"sources": ["crf", "ig"]}},
                {"id": "n3", "type": "llm",         "label": "Mapping LLM",      "config": {"prompt": "Generate SDTM mapping for each raw field using the CRF spec and CDISC IG."}},
                {"id": "n4", "type": "data_source", "label": "Run SDTM Mapping", "config": {"sources": [], "tool": "run_sdtm_mapping"}},
                {"id": "n5", "type": "data_source", "label": "Validate",         "config": {"sources": [], "tool": "validate_sdtm_mapping"}},
                {"id": "n6", "type": "output",      "label": "Mapping Report",   "config": {"format": "json"}},
            ],
            "edges": [
                {"source": "n1", "target": "n3"},
                {"source": "n2", "target": "n3"},
                {"source": "n3", "target": "n4"},
                {"source": "n4", "target": "n5"},
                {"source": "n5", "target": "n6"},
            ],
        },
    },
    "budget_analysis": {
        "purpose": "budget_analysis",
        "label": "Budget Analysis Agent",
        "description": "Analyse study financials: budget vs actuals, site-level variance, milestone payments, and end-of-study burn-rate forecasting.",
        "icon": "dollar-sign",
        "default_tools": PURPOSE_DEFAULT_TOOLS["budget_analysis"],
        "default_data_sources": PURPOSE_DEFAULT_DATA_SOURCES["budget_analysis"],
        "suggested_agent_type": "prompt-agent",
        "output_format": "table",
        "example_objective": "Compare budget vs actual spend across all sites. Flag sites with >10% variance. Generate a bar chart of variance by site and a summary PDF.",
        "example_flow": {
            "nodes": [
                {"id": "n1", "type": "data_source", "label": "Budget Data",   "config": {"sources": ["budget", "ctms"]}},
                {"id": "n2", "type": "llm",         "label": "LLM Analysis",  "config": {"prompt": "Identify budget variances and anomalies."}},
                {"id": "n3", "type": "chart",       "label": "Variance Chart", "config": {"chart_type": "bar"}},
                {"id": "n4", "type": "document",    "label": "PDF Report",     "config": {"format": "pdf"}},
                {"id": "n5", "type": "output",      "label": "Output",         "config": {"format": "table"}},
            ],
            "edges": [
                {"source": "n1", "target": "n2"},
                {"source": "n2", "target": "n3"},
                {"source": "n2", "target": "n4"},
                {"source": "n3", "target": "n5"},
                {"source": "n4", "target": "n5"},
            ],
        },
    },
    "protocol_writing": {
        "purpose": "protocol_writing",
        "label": "Protocol & Document Writing Agent",
        "description": "Draft and review clinical study documents: protocol sections, SAE narratives, CSR sections, and regulatory submission text using study data and guidelines.",
        "icon": "file-text",
        "default_tools": PURPOSE_DEFAULT_TOOLS["protocol_writing"],
        "default_data_sources": PURPOSE_DEFAULT_DATA_SOURCES["protocol_writing"],
        "suggested_agent_type": "langchain-flow",
        "output_format": "narrative",
        "example_objective": "Draft the Adverse Events section of the Clinical Study Report using SDTM AE data and protocol inclusion/exclusion criteria.",
        "example_flow": {
            "nodes": [
                {"id": "n1", "type": "data_source", "label": "Protocol + SAP",    "config": {"sources": ["documents", "sap"]}},
                {"id": "n2", "type": "data_source", "label": "CDISC IGs",         "config": {"sources": ["ig"]}},
                {"id": "n3", "type": "data_source", "label": "Study Data",        "config": {"sources": ["sdtm"]}},
                {"id": "n4", "type": "llm",         "label": "Drafting LLM",      "config": {"prompt": "Draft the document section using the protocol, guidelines, and study data."}},
                {"id": "n5", "type": "document",    "label": "Create Document",   "config": {"format": "docx"}},
                {"id": "n6", "type": "output",      "label": "Draft Document",    "config": {"format": "narrative"}},
            ],
            "edges": [
                {"source": "n1", "target": "n4"},
                {"source": "n2", "target": "n4"},
                {"source": "n3", "target": "n4"},
                {"source": "n4", "target": "n5"},
                {"source": "n5", "target": "n6"},
            ],
        },
    },
    "custom": {
        "purpose": "custom",
        "label": "Custom Agent",
        "description": "Build a fully custom agent from scratch. Choose any combination of data sources and tools.",
        "icon": "settings",
        "default_tools": PURPOSE_DEFAULT_TOOLS["custom"],
        "default_data_sources": PURPOSE_DEFAULT_DATA_SOURCES["custom"],
        "suggested_agent_type": "config-driven",
        "output_format": "narrative",
        "example_objective": "Describe what this agent should do...",
        "example_flow": {
            "nodes": [
                {"id": "n1", "type": "data_source", "label": "Data",    "config": {"sources": ["sdtm"]}},
                {"id": "n2", "type": "llm",         "label": "LLM",     "config": {"prompt": ""}},
                {"id": "n3", "type": "output",      "label": "Output",  "config": {"format": "narrative"}},
            ],
            "edges": [
                {"source": "n1", "target": "n2"},
                {"source": "n2", "target": "n3"},
            ],
        },
    },
}


# ============================================================
# API ENDPOINTS
# ============================================================

class AgentInstallRequest(BaseModel):
    org_id: str
    agent_id: str
    installed_by: str
    consented_permissions: list[str]
    auto_update_patch: bool = True


class UIAgentCreateRequest(BaseModel):
    """Create an agent via the UI Wizard (config-driven or prompt-agent)."""
    org_id: str
    created_by: str
    name: str
    description: str
    category: str
    agent_type: Literal["config-driven", "prompt-agent"] = "config-driven"
    agent_purpose: Literal[
        "conversational", "chart_generation", "sdtm_mapping",
        "budget_analysis", "protocol_writing", "custom"
    ] = "custom"
    data_sources: list[str] = []          # e.g. ["sdtm", "adam", "documents"]
    # Wizard config fields
    trigger_type: str = "manual"
    trigger_config: dict = {}
    declared_tools: list[str] = []
    system_prompt: str = ""
    objective: str = ""
    output_format: str = "narrative"      # narrative | table | json | pdf
    actions: dict = {}                    # {on_findings: [...], notification_recipients: [...], requires_approval: bool}


class FlowAgentCreateRequest(BaseModel):
    """
    Create an agent via the Flowchart Builder (Flowise-style, LangGraph execution).
    flow_definition follows the LangChain-flow node/edge format understood by
    run_langchain_flow_agent() in agent-runtime.
    """
    org_id: str
    created_by: str
    name: str
    description: str
    category: str
    agent_purpose: Literal[
        "conversational", "chart_generation", "sdtm_mapping",
        "budget_analysis", "protocol_writing", "custom",
        "adverse_event_review", "data_quality_check", "lab_review",
        "protocol_deviation", "csr_generation", "statistical_analysis",
    ] = "custom"
    data_sources: list[str] = []
    flow_definition: dict                 # {"nodes": [...], "edges": [...]}
    output_format: str = "narrative"
    agent_mode: str = "standard"          # standard | deep


class AgentTriggerCreate(BaseModel):
    installation_id: str
    study_id: str
    trigger_type: Literal["event", "schedule", "data_condition", "manual"]
    trigger_config: dict
    created_by: str


class AgentEditRequest(BaseModel):
    org_id: str
    updated_by: str
    change_type: Literal["major", "minor"]
    change_reason: str
    name: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    flow_definition: Optional[dict] = None
    agent_config: Optional[dict] = None
    declared_tools: Optional[list[str]] = None
    agent_mode: Optional[str] = None


class AgentActivateRequest(BaseModel):
    org_id: str
    version: str
    activated_by: str


class AgentPublishToggleRequest(BaseModel):
    org_id: str
    is_platform_admin: bool = False


@app.get("/health")
async def health():
    return {"status": "ok", "service": "marketplace"}


@app.get("/agents")
async def list_agents(
    category: Optional[str] = None,
    publisher_type: Optional[str] = None,
    agent_purpose: Optional[str] = None,
    search: Optional[str] = None,
    org_id: Optional[str] = None,
):
    """Browse marketplace. Returns trialo-native + verified-third-party + org's own agents."""
    async with db_pool.acquire() as conn:
        conditions = ["is_published=TRUE"]
        params = []
        i = 1

        if category:
            conditions.append(f"category=${i}"); params.append(category); i += 1
        if publisher_type:
            conditions.append(f"publisher_type=${i}"); params.append(publisher_type); i += 1
        if agent_purpose:
            conditions.append(f"agent_purpose=${i}"); params.append(agent_purpose); i += 1
        if search:
            conditions.append(f"(name ILIKE ${i} OR description ILIKE ${i})"); params.append(f"%{search}%"); i += 1
        if org_id:
            # Include org's own agents even if they match a search condition
            conditions.append(f"(is_published=TRUE OR publisher_org_id=${i})"); params.append(org_id); i += 1

        rows = await conn.fetch(
            f"""
            SELECT id, name, slug, version, category, description, publisher_type,
                   agent_type, agent_purpose, data_sources,
                   required_permissions, declared_tools, is_verified, flow_definition
            FROM agent_definitions
            WHERE {' AND '.join(conditions)}
            ORDER BY publisher_type, name
            """,
            *params,
        )
        agents = []
        for r in rows:
            d = dict(r)
            if d.get("flow_definition") and isinstance(d["flow_definition"], str):
                d["flow_definition"] = json.loads(d["flow_definition"])
            agents.append(d)
        return {"agents": agents, "total": len(agents)}


@app.get("/agents/templates")
async def list_templates(
    purpose: Optional[str] = None,
):
    """
    Return pre-built agent templates.
    If ?purpose= is specified, return only that template.
    Used by both wizard and flowchart builder to pre-populate the UI.
    """
    if purpose:
        if purpose not in AGENT_TEMPLATES:
            raise HTTPException(400, f"Unknown purpose '{purpose}'. Valid values: {list(AGENT_TEMPLATES.keys())}")
        return AGENT_TEMPLATES[purpose]
    return {"templates": list(AGENT_TEMPLATES.values())}


@app.get("/agents/by-id/{agent_id}")
async def get_agent_by_id(agent_id: str, org_id: Optional[str] = None):
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM agent_definitions WHERE id=$1", agent_id)
        if not row:
            raise HTTPException(404, "Agent not found")
        d = dict(row)
        if org_id:
            if not d.get("is_published") and str(d.get("publisher_org_id")) != org_id:
                raise HTTPException(403, "Not authorized")
        for field in ("flow_definition", "agent_config", "expertise_scaffold"):
            if d.get(field) and isinstance(d[field], str):
                try:
                    d[field] = json.loads(d[field])
                except Exception:
                    pass
        return d


@app.put("/agents/{agent_id}")
async def edit_agent(agent_id: str, req: AgentEditRequest):
    async with db_pool.acquire() as conn:
        current = await conn.fetchrow(
            "SELECT * FROM agent_definitions WHERE id=$1", agent_id
        )
        if not current:
            raise HTTPException(404, "Agent not found")
        if str(current["publisher_org_id"]) != req.org_id:
            raise HTTPException(403, "Not authorized to edit this agent")

        cur_version = current["version"] or "1.0.0"
        v = semver.VersionInfo.parse(cur_version)
        next_version = str(v.bump_major() if req.change_type == "major" else v.bump_minor())

        # Merge fields: req fields override current
        new_name        = req.name        or current["name"]
        new_description = req.description or current["description"]
        new_category    = req.category    or current["category"]
        new_agent_mode  = req.agent_mode  or current.get("agent_mode") or "standard"

        cur_fd = current.get("flow_definition")
        if cur_fd and isinstance(cur_fd, str):
            try:
                cur_fd = json.loads(cur_fd)
            except Exception:
                cur_fd = {}
        new_flow_definition = req.flow_definition if req.flow_definition is not None else cur_fd

        cur_ac = current.get("agent_config")
        if cur_ac and isinstance(cur_ac, str):
            try:
                cur_ac = json.loads(cur_ac)
            except Exception:
                cur_ac = {}
        new_agent_config = req.agent_config if req.agent_config is not None else cur_ac

        cur_tools = list(current.get("declared_tools") or [])
        new_declared_tools = req.declared_tools if req.declared_tools is not None else cur_tools
        new_required_permissions = list({
            TOOL_REGISTRY_SCOPES.get(t, "study:data:read") for t in new_declared_tools
        })

        await conn.execute("""
            UPDATE agent_definitions
            SET name=$1, description=$2, category=$3,
                flow_definition=$4, agent_config=$5,
                declared_tools=$6, required_permissions=$7,
                agent_mode=$8, version=$9,
                updated_at=NOW(), updated_by=$10
            WHERE id=$11
        """,
            new_name, new_description, new_category,
            json.dumps(new_flow_definition) if new_flow_definition else None,
            json.dumps(new_agent_config) if new_agent_config else None,
            new_declared_tools, new_required_permissions,
            new_agent_mode, next_version,
            req.updated_by, agent_id,
        )

        version_id = str(uuid.uuid4())
        await conn.execute("""
            INSERT INTO agent_versions (
                id, agent_id, version, status, change_type, change_reason, changed_by,
                name, description, agent_config, flow_definition,
                declared_tools, required_permissions, agent_mode
            ) VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        """,
            version_id, agent_id, next_version,
            req.change_type, req.change_reason, req.updated_by,
            new_name, new_description,
            json.dumps(new_agent_config) if new_agent_config else None,
            json.dumps(new_flow_definition) if new_flow_definition else None,
            new_declared_tools, new_required_permissions, new_agent_mode,
        )

    return {
        "agent_id": agent_id,
        "version_id": version_id,
        "version": next_version,
        "status": "draft",
        "change_type": req.change_type,
    }


@app.post("/agents/{agent_id}/activate")
async def activate_agent_version(agent_id: str, req: AgentActivateRequest):
    async with db_pool.acquire() as conn:
        async with conn.transaction():
            defn = await conn.fetchrow(
                "SELECT publisher_org_id FROM agent_definitions WHERE id=$1", agent_id
            )
            if not defn:
                raise HTTPException(404, "Agent not found")
            if str(defn["publisher_org_id"]) != req.org_id:
                raise HTTPException(403, "Not authorized")

            ver_row = await conn.fetchrow(
                "SELECT id FROM agent_versions WHERE agent_id=$1 AND version=$2",
                agent_id, req.version,
            )
            if not ver_row:
                raise HTTPException(404, f"Version {req.version} not found")

            await conn.execute(
                "UPDATE agent_versions SET status='archived' WHERE agent_id=$1 AND status='active'",
                agent_id,
            )
            await conn.execute(
                "UPDATE agent_versions SET status='active' WHERE agent_id=$1 AND version=$2",
                agent_id, req.version,
            )
            await conn.execute(
                "UPDATE agent_definitions SET version=$1, updated_at=NOW(), updated_by=$2 WHERE id=$3",
                req.version, req.activated_by, agent_id,
            )
            await conn.execute(
                "UPDATE agent_installations SET installed_version=$1 WHERE agent_id=$2 AND org_id=$3",
                req.version, agent_id, req.org_id,
            )

    return {"agent_id": agent_id, "version": req.version, "status": "active"}


@app.patch("/agents/{agent_id}/publish")
async def publish_agent(agent_id: str, req: AgentPublishToggleRequest):
    async with db_pool.acquire() as conn:
        defn = await conn.fetchrow(
            "SELECT publisher_org_id, is_published FROM agent_definitions WHERE id=$1", agent_id
        )
        if not defn:
            raise HTTPException(404, "Agent not found")
        if not req.is_platform_admin and str(defn["publisher_org_id"]) != req.org_id:
            raise HTTPException(403, "Not authorized")
        if defn["is_published"]:
            return {"agent_id": agent_id, "is_published": True, "status": "already_published"}
        await conn.execute(
            "UPDATE agent_definitions SET is_published=TRUE, updated_at=NOW() WHERE id=$1", agent_id
        )
    return {"agent_id": agent_id, "is_published": True, "status": "published"}


@app.patch("/agents/{agent_id}/unpublish")
async def unpublish_agent(agent_id: str, req: AgentPublishToggleRequest):
    async with db_pool.acquire() as conn:
        defn = await conn.fetchrow(
            "SELECT publisher_org_id, is_published FROM agent_definitions WHERE id=$1", agent_id
        )
        if not defn:
            raise HTTPException(404, "Agent not found")
        if not req.is_platform_admin and str(defn["publisher_org_id"]) != req.org_id:
            raise HTTPException(403, "Not authorized")
        if not defn["is_published"]:
            return {"agent_id": agent_id, "is_published": False, "status": "already_unpublished"}
        await conn.execute(
            "UPDATE agent_definitions SET is_published=FALSE, updated_at=NOW() WHERE id=$1", agent_id
        )
    return {"agent_id": agent_id, "is_published": False, "status": "unpublished"}


@app.get("/agents/{agent_id}/versions/compare")
async def compare_agent_versions(agent_id: str, v1: str = Query(...), v2: str = Query(...)):
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT * FROM agent_versions
            WHERE agent_id=$1 AND version = ANY($2::text[])
            ORDER BY created_at ASC
            """,
            agent_id, [v1, v2],
        )
        if len(rows) < 2:
            raise HTTPException(404, "One or both versions not found")
        snapshots = {}
        for r in rows:
            d = dict(r)
            for field in ("flow_definition", "agent_config", "expertise_scaffold"):
                if d.get(field) and isinstance(d[field], str):
                    try:
                        d[field] = json.loads(d[field])
                    except Exception:
                        pass
            snapshots[d["version"]] = d
        return {"agent_id": agent_id, "v1": snapshots.get(v1), "v2": snapshots.get(v2)}


@app.get("/agents/{agent_id}/versions/{version}")
async def get_agent_version(agent_id: str, version: str):
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM agent_versions WHERE agent_id=$1 AND version=$2",
            agent_id, version,
        )
        if not row:
            raise HTTPException(404, "Version not found")
        d = dict(row)
        for field in ("flow_definition", "agent_config", "expertise_scaffold"):
            if d.get(field) and isinstance(d[field], str):
                try:
                    d[field] = json.loads(d[field])
                except Exception:
                    pass
        return d


@app.get("/agents/{agent_id}/versions")
async def list_agent_versions(agent_id: str):
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT av.id, av.agent_id, av.version, av.status, av.change_type,
                   av.change_reason, av.changed_by, av.created_at, av.name,
                   u.email as changed_by_email,
                   COALESCE(u.first_name || ' ' || u.last_name, u.email) as changed_by_name
            FROM agent_versions av
            LEFT JOIN users u ON u.id = av.changed_by
            WHERE av.agent_id=$1
            ORDER BY av.created_at DESC
            """,
            agent_id,
        )
        return {"agent_id": agent_id, "versions": [dict(r) for r in rows]}


@app.get("/agents/{slug}")
async def get_agent(slug: str):
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM agent_definitions WHERE slug=$1", slug)
        if not row:
            raise HTTPException(404, "Agent not found")
        return dict(row)


@app.post("/agents/install")
async def install_agent(req: AgentInstallRequest):
    """Install marketplace agent into an org with consent. OAuth-style consent flow."""
    async with db_pool.acquire() as conn:
        agent = await conn.fetchrow("SELECT * FROM agent_definitions WHERE id=$1", req.agent_id)
        if not agent:
            raise HTTPException(404, "Agent not found")
        if not agent["is_published"]:
            raise HTTPException(400, "Agent is not published")

        required = set(agent["required_permissions"])
        consented = set(req.consented_permissions)
        missing = required - consented
        if missing:
            raise HTTPException(400, f"Missing consent for required permissions: {missing}")

        existing = await conn.fetchval(
            "SELECT id FROM agent_installations WHERE org_id=$1 AND agent_id=$2",
            req.org_id, req.agent_id,
        )
        if existing:
            return {"installation_id": str(existing), "status": "already_installed"}

        install_id = str(uuid.uuid4())
        await conn.execute("""
            INSERT INTO agent_installations (id, org_id, agent_id, installed_version, installed_by, consented_permissions)
            VALUES ($1,$2,$3,$4,$5,$6)
        """, install_id, req.org_id, req.agent_id, agent["version"], req.installed_by,
            req.consented_permissions)

        log.info("agent.installed", agent=agent["slug"], org_id=req.org_id)
        return {"installation_id": install_id, "status": "installed", "version": agent["version"]}


@app.post("/agents/create-ui")
async def create_ui_agent(req: UIAgentCreateRequest):
    """
    Create a custom agent via the UI Wizard.
    Stores as 'org-created' with agent_type = config-driven | prompt-agent.
    """
    # Auto-fill tools from purpose defaults if none specified
    tools = req.declared_tools or PURPOSE_DEFAULT_TOOLS.get(req.agent_purpose, PURPOSE_DEFAULT_TOOLS["custom"])
    data_sources = req.data_sources or PURPOSE_DEFAULT_DATA_SOURCES.get(req.agent_purpose, [])

    agent_id = str(uuid.uuid4())
    slug = f"{req.org_id[:8]}-{req.name.lower().replace(' ', '-')[:30]}-{agent_id[:8]}"

    agent_config = {
        "system_prompt": req.system_prompt,
        "objective": req.objective,
        "output_format": req.output_format,
        "data_scope": {"data_sources": data_sources},
        "actions": req.actions,
        "trigger_type": req.trigger_type,
        "trigger_config": req.trigger_config,
    }

    required_permissions = list({TOOL_REGISTRY_SCOPES.get(t, "study:data:read") for t in tools})

    async with db_pool.acquire() as conn:
        await conn.execute("""
            INSERT INTO agent_definitions (
                id, name, slug, version, category, description, publisher_type,
                publisher_org_id, agent_type, agent_config, declared_tools,
                required_permissions, agent_purpose, data_sources, is_published, is_verified
            ) VALUES ($1,$2,$3,'1.0.0',$4,$5,'org-created',$6,$7,$8,$9,$10,$11,$12,TRUE,FALSE)
        """,
            agent_id, req.name, slug, req.category, req.description,
            req.org_id, req.agent_type, json.dumps(agent_config), tools,
            required_permissions, req.agent_purpose, data_sources,
        )

    log.info("ui_agent.created", agent_id=agent_id, org_id=req.org_id,
             name=req.name, purpose=req.agent_purpose)
    return {
        "agent_id": agent_id,
        "slug": slug,
        "status": "created",
        "agent_type": req.agent_type,
        "agent_purpose": req.agent_purpose,
        "data_sources": data_sources,
        "declared_tools": tools,
    }


@app.post("/agents/create-flow")
async def create_flow_agent(req: FlowAgentCreateRequest):
    """
    Create a custom agent via the Flowchart Builder (Flowise-style).
    Stores as 'org-created' with agent_type='langchain-flow' and flow_definition in agent_config.
    agent-runtime will execute this using run_langchain_flow_agent().
    """
    # Infer tools from flow nodes so permissions are correctly derived
    node_tool_map = {
        "data_source": [],
        "llm": [],
        "chart": ["generate_chart"],
        "document": ["create_document"],
    }
    tools: set[str] = set()
    for node in req.flow_definition.get("nodes", []):
        node_type = node.get("type", "")
        tools.update(node_tool_map.get(node_type, []))
        # Explicit tool override in node config
        if node.get("config", {}).get("tool"):
            tools.add(node["config"]["tool"])
        # Data sources → map to read tools
        for src in node.get("config", {}).get("sources", []):
            if src in ("sdtm",):
                tools.add("read_sdtm_domain")
            elif src == "adam":
                tools.add("read_adam_dataset")
            elif src == "raw_edc":
                tools.add("read_raw_edc_data")
            elif src == "ctms":
                tools.add("read_ctms_data")
            elif src == "budget":
                tools.add("query_budget_data")
            elif src in ("documents", "sap"):
                tools.add("search_documents")
            elif src == "ig":
                tools.add("search_implementation_guides")
            elif src == "crf":
                tools.add("read_crf_specification")

    declared_tools = list(tools)
    data_sources = req.data_sources or PURPOSE_DEFAULT_DATA_SOURCES.get(req.agent_purpose, [])

    agent_id = str(uuid.uuid4())
    slug = f"{req.org_id[:8]}-{req.name.lower().replace(' ', '-')[:30]}-{agent_id[:8]}"

    agent_config = {
        "org_id": req.org_id,
        "created_by": req.created_by,
        "output_format": req.output_format,
        "flow_definition": req.flow_definition,
        "data_scope": {"data_sources": data_sources},
    }

    required_permissions = list({TOOL_REGISTRY_SCOPES.get(t, "study:data:read") for t in declared_tools})

    async with db_pool.acquire() as conn:
        await conn.execute("""
            INSERT INTO agent_definitions (
                id, name, slug, version, category, description, publisher_type,
                publisher_org_id, agent_type, agent_config, declared_tools,
                required_permissions, agent_purpose, data_sources,
                flow_definition, is_published, is_verified, agent_mode
            ) VALUES ($1,$2,$3,'1.0.0',$4,$5,'org-created',$6,'langchain-flow',$7,$8,$9,$10,$11,$12,TRUE,FALSE,$13)
        """,
            agent_id, req.name, slug, req.category, req.description,
            req.org_id, json.dumps(agent_config), declared_tools,
            required_permissions, req.agent_purpose, data_sources,
            json.dumps(req.flow_definition), req.agent_mode,
        )

        install_id = str(uuid.uuid4())
        await conn.execute("""
            INSERT INTO agent_installations
                (id, org_id, agent_id, installed_version, installed_by, consented_permissions, is_active)
            VALUES ($1,$2,$3,'1.0.0',$4,$5,TRUE)
        """, install_id, req.org_id, agent_id, req.created_by, required_permissions)

    log.info("flow_agent.created", agent_id=agent_id, org_id=req.org_id,
             name=req.name, purpose=req.agent_purpose,
             nodes=len(req.flow_definition.get("nodes", [])))
    return {
        "agent_id": agent_id,
        "installation_id": install_id,
        "slug": slug,
        "status": "created",
        "agent_type": "langchain-flow",
        "agent_purpose": req.agent_purpose,
        "data_sources": data_sources,
        "declared_tools": declared_tools,
        "node_count": len(req.flow_definition.get("nodes", [])),
        "edge_count": len(req.flow_definition.get("edges", [])),
    }


@app.post("/triggers")
async def create_trigger(req: AgentTriggerCreate):
    trigger_id = str(uuid.uuid4())
    async with db_pool.acquire() as conn:
        await conn.execute("""
            INSERT INTO agent_triggers (id, installation_id, study_id, trigger_type, trigger_config, created_by)
            VALUES ($1,$2,$3,$4,$5,$6)
        """, trigger_id, req.installation_id, req.study_id, req.trigger_type,
            json.dumps(req.trigger_config), req.created_by)
    return {"trigger_id": trigger_id, "status": "active"}


@app.get("/installations/{org_id}")
async def list_installations(org_id: str):
    async with db_pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT ai.id, ai.agent_id, ai.org_id, ai.installed_version, ai.is_active, ai.installed_at,
                   ad.id as ad_id, ad.name, ad.slug, ad.category, ad.publisher_type,
                   ad.agent_type, ad.agent_purpose, ad.data_sources, ad.required_permissions,
                   ad.declared_tools, ad.publisher_org_id
            FROM agent_installations ai
            JOIN agent_definitions ad ON ad.id = ai.agent_id
            WHERE ai.org_id=$1 AND ai.is_active=TRUE
            ORDER BY ai.installed_at DESC
        """, org_id)
        return {"installations": [dict(r) for r in rows]}


@app.get("/categories")
async def list_categories():
    return {
        "categories": [
            {"id": "data_management", "label": "Data Management", "icon": "database"},
            {"id": "safety",          "label": "Safety",          "icon": "shield"},
            {"id": "site_monitoring", "label": "Site Monitoring", "icon": "map-pin"},
            {"id": "analytics",       "label": "Analytics",       "icon": "bar-chart"},
            {"id": "regulatory",      "label": "Regulatory",      "icon": "file-text"},
            {"id": "medical_writing", "label": "Medical Writing", "icon": "pen-tool"},
            {"id": "operations",      "label": "Operations",      "icon": "settings"},
        ]
    }


@app.get("/purposes")
async def list_purposes():
    """Return all valid agent purposes with labels, default tools, and data sources."""
    return {
        "purposes": [
            {
                "id": p,
                "label": AGENT_TEMPLATES[p]["label"],
                "description": AGENT_TEMPLATES[p]["description"],
                "icon": AGENT_TEMPLATES[p]["icon"],
                "default_tools": PURPOSE_DEFAULT_TOOLS[p],
                "default_data_sources": PURPOSE_DEFAULT_DATA_SOURCES[p],
                "suggested_agent_type": AGENT_TEMPLATES[p]["suggested_agent_type"],
            }
            for p in PURPOSE_DEFAULT_TOOLS
        ]
    }


@app.get("/data-sources")
async def list_data_sources():
    """Return all valid data source identifiers with labels."""
    return {
        "data_sources": [
            {"id": "sdtm",      "label": "SDTM Domains",           "description": "Standardised clinical trial data (DM, AE, LB, VS, CM, ...)"},
            {"id": "adam",      "label": "ADaM Datasets",           "description": "Analysis-ready datasets (ADSL, ADAE, ADLB, ADTTE, ...)"},
            {"id": "raw_edc",   "label": "Raw EDC / CDASH Data",    "description": "Pre-SDTM raw data from electronic data capture systems"},
            {"id": "ctms",      "label": "CTMS Data",               "description": "Clinical Trial Management System data (sites, visits, milestones)"},
            {"id": "budget",    "label": "Budget & Financials",     "description": "Study budget, site contracts, actuals, and payment milestones"},
            {"id": "documents", "label": "Study Documents (RAG)",   "description": "Protocol, ICF, Lab Manual, and other study documents"},
            {"id": "ig",        "label": "CDISC Implementation Guides", "description": "CDASH IG, SDTM IG, ADaM IG — for mapping and annotation"},
            {"id": "crf",       "label": "CRF Specifications",      "description": "Case Report Form field definitions and completion guidelines"},
            {"id": "sap",       "label": "Statistical Analysis Plan", "description": "SAP documents — for analysis agent context"},
        ]
    }


@app.get("/tools")
async def list_tools(purpose: Optional[str] = None):
    """
    Return all available tools with their permission scopes.
    If ?purpose= is specified, return only the default tools for that purpose.
    """
    if purpose:
        tool_ids = PURPOSE_DEFAULT_TOOLS.get(purpose, PURPOSE_DEFAULT_TOOLS["custom"])
    else:
        tool_ids = list(TOOL_REGISTRY_SCOPES.keys())

    return {
        "tools": [
            {"id": t, "permission_scope": TOOL_REGISTRY_SCOPES.get(t, "study:data:read")}
            for t in tool_ids
        ]
    }


# ============================================================
# SKILLS  — org-scoped reusable capabilities
# ============================================================

class SkillCreate(BaseModel):
    org_id: Optional[str] = None   # None = platform-level standard skill
    name: str
    description: str = ""
    skill_type: str = "function"   # function | prompt
    body: str
    input_schema: dict = {}
    tags: list[str] = []
    created_by: Optional[str] = None

class SkillUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    skill_type: Optional[str] = None
    body: Optional[str] = None
    input_schema: Optional[dict] = None
    tags: Optional[list[str]] = None

class SkillGenerateRequest(BaseModel):
    org_id: str
    description: str
    skill_type: str = "function"   # function | prompt
    context_graph_id: Optional[str] = None

class SkillFixRequest(BaseModel):
    org_id: str
    original_code: str
    original_prompt: str
    context_graph_id: Optional[str] = None


@app.get("/skills")
async def list_skills(org_id: str):
    """List all skills for an org."""
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, name, description, skill_type, tags, created_at
               FROM agent_skills WHERE org_id=$1 ORDER BY name""",
            org_id,
        )
    return {
        "skills": [
            {
                "id":          str(r["id"]),
                "name":        r["name"],
                "description": r["description"],
                "skill_type":  r["skill_type"],
                "tags":        list(r["tags"]) if r["tags"] else [],
                "created_at":  r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in rows
        ]
    }


@app.get("/skills/standard")
async def list_standard_skills(published_only: bool = False):
    """List platform-level standard skills. Admin sees all; pass published_only=true for tenant view."""
    async with db_pool.acquire() as conn:
        if published_only:
            rows = await conn.fetch(
                "SELECT id, name, description, skill_type, tags, is_published, published_at, created_at"
                " FROM agent_skills WHERE org_id IS NULL AND is_published=TRUE ORDER BY name"
            )
        else:
            rows = await conn.fetch(
                "SELECT id, name, description, skill_type, tags, is_published, published_at, created_at"
                " FROM agent_skills WHERE org_id IS NULL ORDER BY name"
            )
    return {
        "skills": [
            {
                "id":           str(r["id"]),
                "name":         r["name"],
                "description":  r["description"],
                "skill_type":   r["skill_type"],
                "tags":         list(r["tags"]) if r["tags"] else [],
                "is_published": r["is_published"],
                "published_at": r["published_at"].isoformat() if r["published_at"] else None,
                "created_at":   r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in rows
        ]
    }


@app.get("/skills/{skill_id}")
async def get_skill(skill_id: str, org_id: str):
    """Get full skill including body."""
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM agent_skills WHERE id=$1 AND org_id=$2", skill_id, org_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Skill not found")
    return {
        "id":           str(row["id"]),
        "org_id":       str(row["org_id"]) if row["org_id"] else None,
        "name":         row["name"],
        "description":  row["description"],
        "skill_type":   row["skill_type"],
        "body":         row["body"],
        "input_schema": json.loads(row["input_schema"]) if isinstance(row["input_schema"], str) else (row["input_schema"] or {}),
        "tags":         list(row["tags"]) if row["tags"] else [],
        "created_at":   row["created_at"].isoformat() if row["created_at"] else None,
    }


@app.post("/skills", status_code=201)
async def create_skill(req: SkillCreate):
    """Create a new skill."""
    skill_id = str(uuid.uuid4())
    async with db_pool.acquire() as conn:
        try:
            await conn.execute(
                """INSERT INTO agent_skills
                       (id, org_id, name, description, skill_type, body, input_schema, tags, created_by)
                   VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)""",
                skill_id, req.org_id, req.name, req.description, req.skill_type,
                req.body, json.dumps(req.input_schema), req.tags,
                req.created_by,
            )
        except asyncpg.UniqueViolationError:
            raise HTTPException(status_code=409, detail=f"Skill '{req.name}' already exists in this org")
    return {"id": skill_id, "name": req.name}


@app.put("/skills/{skill_id}")
async def update_skill(skill_id: str, req: SkillUpdate, org_id: Optional[str] = None):
    """Update an existing skill. Pass org_id=null for platform-level skills."""
    async with db_pool.acquire() as conn:
        if org_id is None:
            row = await conn.fetchrow(
                "SELECT id FROM agent_skills WHERE id=$1 AND org_id IS NULL", skill_id,
            )
        else:
            row = await conn.fetchrow(
                "SELECT id FROM agent_skills WHERE id=$1 AND org_id=$2", skill_id, org_id,
            )
        if not row:
            raise HTTPException(status_code=404, detail="Skill not found")
        updates = {}
        if req.name         is not None: updates["name"]         = req.name
        if req.description  is not None: updates["description"]  = req.description
        if req.skill_type   is not None: updates["skill_type"]   = req.skill_type
        if req.body         is not None: updates["body"]         = req.body
        if req.input_schema is not None: updates["input_schema"] = json.dumps(req.input_schema)
        if req.tags         is not None: updates["tags"]         = req.tags
        if not updates:
            return {"updated": False}
        updates["updated_at"] = datetime.now(timezone.utc)
        set_clause = ", ".join(f"{k}=${i+2}" for i, k in enumerate(updates))
        await conn.execute(
            f"UPDATE agent_skills SET {set_clause} WHERE id=$1",
            skill_id, *updates.values(),
        )
    return {"updated": True}


@app.delete("/skills/{skill_id}")
async def delete_skill(skill_id: str, org_id: Optional[str] = None):
    """Delete a skill. Pass org_id=null for platform-level skills."""
    async with db_pool.acquire() as conn:
        if org_id is None:
            result = await conn.execute(
                "DELETE FROM agent_skills WHERE id=$1 AND org_id IS NULL", skill_id,
            )
        else:
            result = await conn.execute(
                "DELETE FROM agent_skills WHERE id=$1 AND org_id=$2", skill_id, org_id,
            )
    deleted = int(result.split()[-1]) if result else 0
    if not deleted:
        raise HTTPException(status_code=404, detail="Skill not found")
    return {"deleted": True}


@app.patch("/skills/{skill_id}/publish")
async def toggle_publish_skill(skill_id: str, body: dict):
    """Publish or unpublish a platform-level standard skill."""
    publish = bool(body.get("is_published", False))
    async with db_pool.acquire() as conn:
        result = await conn.execute(
            "UPDATE agent_skills SET is_published=$1, published_at=$2, published_by=$3,"
            " updated_at=NOW() WHERE id=$4 AND org_id IS NULL",
            publish,
            datetime.now(timezone.utc) if publish else None,
            body.get("published_by"),
            skill_id,
        )
    updated = int(result.split()[-1]) if result else 0
    if not updated:
        raise HTTPException(status_code=404, detail="Standard skill not found")
    return {"ok": True}


@app.post("/skills/{skill_id}/clone", status_code=201)
async def clone_standard_skill(skill_id: str, body: dict):
    """Clone a published standard skill into a tenant org."""
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM agent_skills WHERE id=$1 AND org_id IS NULL AND is_published=TRUE",
            skill_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Standard skill not found or not published")
        new_id = str(uuid.uuid4())
        try:
            await conn.execute(
                "INSERT INTO agent_skills (id, org_id, name, description, skill_type, body, input_schema, tags, created_by)"
                " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                new_id, body["org_id"], row["name"], row["description"], row["skill_type"],
                row["body"], row["input_schema"], row["tags"], body.get("cloned_by"),
            )
        except asyncpg.UniqueViolationError:
            raise HTTPException(status_code=409, detail=f"Skill '{row['name']}' already exists in your library")
    return {"id": new_id, "name": row["name"]}


_SDTM_KEYWORDS = {
    "sdtm", "cdisc", "edc", "mapping", "implementation guide",
    "domain", "variable", "adverse event", "demographics", "laboratory",
    "lab result", "vital sign", "concomitant", "disposition", "exposure",
}

# ─── Incomplete-code markers — any of these in generated code is a defect ─────
_INCOMPLETE_MARKERS = [
    "...",
    "# TODO",
    "# FIXME",
    "# implement",
    "# add logic",
    "# your code here",
    "# fill in",
    "# placeholder",
    "raise NotImplementedError",
    "pass  #",
]


def _validate_function_code(code: str) -> list[str]:
    """Return list of completeness issues found in generated Python code."""
    issues = []
    for marker in _INCOMPLETE_MARKERS:
        if marker in code:
            issues.append(f'Incomplete marker found: "{marker.strip()}"')
    if "result =" not in code and "result=" not in code:
        issues.append("Missing required assignment: result = {...}")
    if len(code.splitlines()) < 8:
        issues.append("Code body is suspiciously short — likely incomplete")
    return issues


def _extract_json(text: str) -> str:
    import re as _re
    text = _re.sub(r'^```[a-zA-Z]*\n?', '', text.strip())
    text = _re.sub(r'\n?```$', '', text)
    start = text.find('{')
    end   = text.rfind('}')
    if start != -1 and end != -1:
        return text[start:end+1]
    return text


# ─── Deterministic SDTM function code template ────────────────────────────────
# Governed SDTM mapper: domain auto-detection, full output contract,
# per-field mapping traceability, derivations, validation, confidence score.
# Context graph (SDTM IG v3.4) is embedded directly — rule_source='context_graph'
# in every trace entry confirms provenance.
_SDTM_FUNCTION_CODE = '''
from datetime import datetime
import re


# ── Built-in SDTM fallback (used when no context_graph is injected) ──────────
# Contains SDTM IG v3.4 domain definitions for DM/AE/LB/VS so domain detection,
# CT lookups, and required-variable validation all work without an injected graph.
# cg_source is set to "sdtm_fallback" in every trace entry when this is active.
_SDTM_FALLBACK_GRAPH = {
    "name": "SDTM Implementation Guide v3.4 (built-in fallback)",
    "domains": {
        "DM": {
            "label": "Demographics",
            "required": ["STUDYID","DOMAIN","USUBJID","SUBJID","RFSTDTC",
                         "RFENDTC","SITEID","AGE","AGEU","SEX","RACE","ETHNIC","COUNTRY"],
            "signal_fields": ["sex","gender","race","ethnicity","dob","date_of_birth",
                               "age","country","site_id","enroll_date","rand_date"],
            "controlled_terms": {
                "SEX": {
                    "male":"M","m":"M","man":"M","1":"M",
                    "female":"F","f":"F","woman":"F","2":"F",
                    "unknown":"U","u":"U","0":"U","not reported":"U",
                },
                "RACE": {
                    "white":"WHITE","caucasian":"WHITE",
                    "black":"BLACK OR AFRICAN AMERICAN",
                    "african american":"BLACK OR AFRICAN AMERICAN",
                    "asian":"ASIAN",
                    "american indian":"AMERICAN INDIAN OR ALASKA NATIVE",
                    "alaska native":"AMERICAN INDIAN OR ALASKA NATIVE",
                    "other":"OTHER","unknown":"UNKNOWN","not reported":"NOT REPORTED",
                },
                "ETHNIC": {
                    "hispanic":"HISPANIC OR LATINO","latino":"HISPANIC OR LATINO",
                    "not hispanic":"NOT HISPANIC OR LATINO",
                    "not latino":"NOT HISPANIC OR LATINO",
                    "unknown":"NOT REPORTED","not reported":"NOT REPORTED",
                },
            },
        },
        "AE": {
            "label": "Adverse Events",
            "required": ["STUDYID","DOMAIN","USUBJID","AESEQ","AETERM","AESTDTC"],
            "signal_fields": ["adverse_event","ae_term","event_name","onset_date","ae_start",
                               "severity","ae_sev","ae_grade","serious","causality","outcome"],
            "controlled_terms": {
                "AESEV": {
                    "mild":"MILD","1":"MILD","grade 1":"MILD",
                    "moderate":"MODERATE","2":"MODERATE","grade 2":"MODERATE",
                    "severe":"SEVERE","3":"SEVERE","grade 3":"SEVERE",
                    "life-threatening":"SEVERE","4":"SEVERE","fatal":"SEVERE",
                },
                "AEREL": {
                    "not related":"NOT RELATED","unrelated":"NOT RELATED",
                    "unlikely":"POSSIBLY RELATED","possible":"POSSIBLY RELATED",
                    "possibly":"POSSIBLY RELATED","probable":"PROBABLY RELATED",
                    "probably":"PROBABLY RELATED",
                    "definite":"RELATED","related":"RELATED",
                },
                "AEOUT": {
                    "recovered":"RECOVERED/RESOLVED","resolved":"RECOVERED/RESOLVED",
                    "recovering":"RECOVERING/RESOLVING",
                    "not recovered":"NOT RECOVERED/NOT RESOLVED",
                    "ongoing":"NOT RECOVERED/NOT RESOLVED",
                    "sequelae":"RECOVERED/RESOLVED WITH SEQUELAE",
                    "fatal":"FATAL","death":"FATAL","unknown":"UNKNOWN",
                },
            },
        },
        "LB": {
            "label": "Laboratory Test Results",
            "required": ["STUDYID","DOMAIN","USUBJID","LBSEQ","LBTESTCD","LBTEST",
                         "LBORRES","LBDTC"],
            "signal_fields": ["lab_test","test_code","analyte","result","lborres","lbdtc",
                               "normal_flag","specimen_type","lab_date","collection_date"],
            "controlled_terms": {
                "LBNRIND": {
                    "low":"LOW","l":"LOW","<":"LOW","below normal":"LOW",
                    "normal":"NORMAL","n":"NORMAL","within normal":"NORMAL",
                    "high":"HIGH","h":"HIGH",">":"HIGH","above normal":"HIGH",
                    "abnormal":"ABNORMAL","a":"ABNORMAL",
                },
                "LBTESTCD": {
                    "hemoglobin":"HGB","hgb":"HGB","haemoglobin":"HGB",
                    "hematocrit":"HCT","hct":"HCT",
                    "white blood cell":"WBC","wbc":"WBC","leukocyte":"WBC",
                    "platelets":"PLAT","plt":"PLAT",
                    "creatinine":"CREAT","creat":"CREAT",
                    "sodium":"SODIUM","na":"SODIUM",
                    "potassium":"POTASSIUM","k":"POTASSIUM",
                    "alanine aminotransferase":"ALT","alt":"ALT","sgpt":"ALT",
                    "aspartate aminotransferase":"AST","ast":"AST","sgot":"AST",
                    "glucose":"GLUC","total bilirubin":"BILI","bilirubin":"BILI",
                    "alkaline phosphatase":"ALKPH","alp":"ALKPH",
                    "albumin":"ALB","urea":"UREA","bun":"UREA",
                },
                "LBTEST_FULL": {
                    "HGB":"Hemoglobin","HCT":"Hematocrit","WBC":"Leukocytes",
                    "PLAT":"Platelets","CREAT":"Creatinine","SODIUM":"Sodium",
                    "POTASSIUM":"Potassium","ALT":"Alanine Aminotransferase",
                    "AST":"Aspartate Aminotransferase","GLUC":"Glucose",
                    "BILI":"Bilirubin","ALKPH":"Alkaline Phosphatase",
                    "ALB":"Albumin","UREA":"Blood Urea Nitrogen",
                },
            },
        },
        "VS": {
            "label": "Vital Signs",
            "required": ["STUDYID","DOMAIN","USUBJID","VSSEQ","VSTESTCD","VSTEST",
                         "VSORRES","VSDTC"],
            "signal_fields": ["vs_test","vital_sign","blood_pressure","pulse",
                               "temperature","weight","height","bmi","sysbp","diabp",
                               "assessment_date","vs_date"],
            "controlled_terms": {
                "VSTESTCD": {
                    "systolic blood pressure":"SYSBP","sysbp":"SYSBP",
                    "diastolic blood pressure":"DIABP","diabp":"DIABP",
                    "pulse":"PULSE","heart rate":"PULSE",
                    "temperature":"TEMP","body temperature":"TEMP",
                    "weight":"WEIGHT","body weight":"WEIGHT",
                    "height":"HEIGHT","body height":"HEIGHT",
                    "bmi":"BMI","body mass index":"BMI",
                },
                "VSTEST_FULL": {
                    "SYSBP":"Systolic Blood Pressure","DIABP":"Diastolic Blood Pressure",
                    "PULSE":"Pulse Rate","TEMP":"Temperature",
                    "WEIGHT":"Weight","HEIGHT":"Height","BMI":"Body Mass Index",
                },
                "VSORRESU": {
                    "SYSBP":"mmHg","DIABP":"mmHg","PULSE":"beats/min",
                    "TEMP":"C","WEIGHT":"kg","HEIGHT":"cm","BMI":"kg/m2",
                },
            },
        },
    },
}


def execute(input_data: dict, context_graph: dict = None) -> dict:
    """
    Map raw EDC records to structured, domain-grouped datasets.

    All CT lookups, required-variable validation, and signal-field scoring
    are driven exclusively by the injected context_graph.
    Falls back to _SDTM_FALLBACK_GRAPH (built-in SDTM IG v3.4) when none is supplied.

    Args:
        input_data:    Must contain "raw_edc_data" (list of dicts).
                       May also contain "metadata" and/or "context_graph".
        context_graph: Explicit domain knowledge graph (takes precedence over
                       input_data["context_graph"] when both are supplied).

    Returns:
        Exactly {identified_domains, domain_mappings, transformed_data,
                 derivations, validation_rules_applied, issues, confidence_score}.
    """

    # ── 1. Resolve context graph ──────────────────────────────────────────────
    # Explicit param > input_data field > built-in SDTM fallback
    _cg_raw = context_graph or input_data.get("context_graph")
    cg = (_cg_raw
          if isinstance(_cg_raw, dict) and "domains" in _cg_raw
          else _SDTM_FALLBACK_GRAPH)
    cg_source = "injected" if cg is not _SDTM_FALLBACK_GRAPH else "sdtm_fallback"

    # ── 2. Parse inputs ───────────────────────────────────────────────────────
    raw_records = input_data.get("raw_edc_data", [])
    metadata    = input_data.get("metadata", {}) or {}
    study_id    = str(metadata.get("study_id",    "STUDY001")).strip()
    domain_hint = str(metadata.get("domain_hint", "")).upper().strip()
    rfstdtc_ref = str(metadata.get("rfstdtc",     "")).strip()

    if not isinstance(raw_records, list):
        raw_records = [raw_records] if raw_records else []

    # ── 3. Pure utility functions ─────────────────────────────────────────────
    def normalize_date(raw):
        if raw is None or str(raw).strip() in ("", "nan", "None", "NaT", "NA"):
            return ""
        s = str(raw).strip()
        for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%b-%Y", "%d-%B-%Y",
                    "%Y%m%d", "%d.%m.%Y", "%m-%d-%Y",
                    "%b %d, %Y", "%B %d, %Y", "%d %b %Y"):
            try:
                return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
            except ValueError:
                continue
        if re.match(r"^\d{4}$", s) or re.match(r"^\d{4}-\d{2}$", s):
            return s
        return s

    def get_first(rec, *keys, default=""):
        for key in keys:
            val = rec.get(key)
            if val is not None and str(val).strip() not in ("", "nan", "None", "NaT"):
                return str(val).strip()
        return default

    def map_ct(raw, lookup, default=""):
        if raw is None:
            return default
        key = str(raw).lower().strip()
        if key in lookup:
            return lookup[key]
        for k, v in lookup.items():
            if k in key or key in k:
                return v
        return str(raw).upper().strip() or default

    def yn_flag(raw):
        return "Y" if str(raw).upper().strip() in ("Y", "YES", "TRUE", "1", "SI", "OUI") else "N"

    def derive_age(dob_raw, ref_raw):
        d = normalize_date(dob_raw)
        r = normalize_date(ref_raw)
        if not d or not r or len(d) < 10 or len(r) < 10:
            return 0
        try:
            return max(0, (datetime.strptime(r[:10], "%Y-%m-%d") -
                           datetime.strptime(d[:10], "%Y-%m-%d")).days // 365)
        except ValueError:
            return 0

    def study_day(ref_s, event_s):
        if not ref_s or not event_s or len(ref_s) < 10 or len(event_s) < 10:
            return None
        try:
            delta = (datetime.strptime(event_s[:10], "%Y-%m-%d") -
                     datetime.strptime(ref_s[:10],   "%Y-%m-%d")).days
            return delta + 1 if delta >= 0 else delta
        except ValueError:
            return None

    # ── 4. Per-record domain detection (driven by cg.signal_fields) ───────────
    def detect_domain(rec, hint, cg):
        if hint and hint in cg["domains"]:
            return hint, "param_hint"
        keys_lower = {k.lower() for k in rec.keys()}
        scores = {
            dom: sum(1 for sf in ddef.get("signal_fields", []) if sf in keys_lower)
            for dom, ddef in cg["domains"].items()
        }
        if not scores or max(scores.values(), default=0) == 0:
            return "UNKNOWN", "default"
        return max(scores, key=lambda d: scores[d]), "context_graph"

    # ── 5. Field mapping (rich handlers for DM/AE/LB/VS; passthrough otherwise) ─
    def map_record(rec, domain, seq, cg):
        ddef   = cg["domains"].get(domain, {})
        ct     = ddef.get("controlled_terms", {})
        trace  = []
        derivs = []
        mapped = {}

        def _t(var, src, raw, val, method):
            trace.append({
                "sdtm_variable": var, "source_field": src,
                "raw_value":     str(raw), "mapped_value": str(val),
                "method":        method,   "rule_source":  cg_source,
            })

        subj = get_first(rec, "subject_id", "subj_id", "SUBJID",
                          "patient_id", "PatientID", "SubjectID", default=f"{seq:04d}")
        site = get_first(rec, "site_id", "SITEID", "center_id",
                          "site", "CenterID", default="SITE01")
        uid  = f"{study_id}-{subj}"

        mapped["STUDYID"] = study_id; _t("STUDYID", "param:study_id", study_id, study_id, "direct_assign")
        mapped["DOMAIN"]  = domain;   _t("DOMAIN",  "constant",       domain,   domain,   "constant")
        mapped["USUBJID"] = uid;      _t("USUBJID", "subject_id",     subj,     uid,      "concatenation")

        # ── DM ────────────────────────────────────────────────────────────────
        if domain == "DM":
            dob     = get_first(rec, "date_of_birth", "dob", "DOB", "BirthDate")
            rfs_raw = get_first(rec, "study_start", "enroll_date", "RFSTDTC",
                                 "EnrollmentDate", "first_dose_date", "rand_date")
            rfe_raw = get_first(rec, "study_end", "last_visit_date", "RFENDTC",
                                 "CompletionDate", "last_dose_date")
            rfs = normalize_date(rfs_raw)
            rfe = normalize_date(rfe_raw)
            age_raw = rec.get("age", rec.get("Age", rec.get("AGE")))
            if age_raw and str(age_raw).strip().lstrip("-").isdigit():
                age    = int(float(str(age_raw)))
                age_m  = "direct_copy"
            else:
                age    = derive_age(dob, rfs)
                age_m  = "derived:floor((RFSTDTC-DOB).days/365)"
                if age:
                    derivs.append({
                        "variable":    "AGE",
                        "formula":     "floor((RFSTDTC - DOB).days / 365)",
                        "inputs":      {"DOB": dob, "RFSTDTC": rfs},
                        "rule_source": cg_source,
                    })
            sex_r  = get_first(rec, "sex", "gender", "SEX", "Gender")
            race_r = get_first(rec, "race", "Race", "racial_group")
            eth_r  = get_first(rec, "ethnicity", "Ethnicity")
            cntry  = get_first(rec, "country", "Country", "nation", default="USA")[:3].upper()
            mapped.update({
                "SUBJID":  subj,  "RFSTDTC": rfs,   "RFENDTC": rfe,
                "SITEID":  site,  "AGE":     age,   "AGEU":    "YEARS",
                "SEX":     map_ct(sex_r,  ct.get("SEX",    {}), "U"),
                "RACE":    map_ct(race_r, ct.get("RACE",   {}), "UNKNOWN"),
                "ETHNIC":  map_ct(eth_r,  ct.get("ETHNIC", {}), "NOT REPORTED"),
                "COUNTRY": cntry,
                "ARM":     get_first(rec, "treatment_arm", "arm", "TreatmentArm", "ARM"),
                "ACTARM":  get_first(rec, "actual_arm", "actual_treatment", "ACTARM"),
            })
            _t("SEX",     "sex/gender",  sex_r,          mapped["SEX"],    "ct_lookup:SEX")
            _t("RACE",    "race",        race_r,          mapped["RACE"],   "ct_lookup:RACE")
            _t("ETHNIC",  "ethnicity",   eth_r,           mapped["ETHNIC"], "ct_lookup:ETHNIC")
            _t("AGE",     "age/dob",     age_raw or dob,  age,              age_m)
            _t("RFSTDTC", "study_start", rfs_raw,         rfs,              "date_normalize")
            _t("RFENDTC", "study_end",   rfe_raw,         rfe,              "date_normalize")
            _t("COUNTRY", "country",     cntry,           mapped["COUNTRY"],"truncate_iso3")

        # ── AE ────────────────────────────────────────────────────────────────
        elif domain == "AE":
            ae_r  = get_first(rec, "adverse_event", "ae_term", "AETERM",
                               "AdverseEvent", "event_name", default="UNKNOWN")
            std_r = get_first(rec, "onset_date", "start_date", "ae_start",
                               "AESTDTC", "EventStartDate")
            end_r = get_first(rec, "resolve_date", "end_date", "ae_end",
                               "AEENDTC", "EventEndDate")
            std   = normalize_date(std_r)
            end   = normalize_date(end_r)
            sev_r = get_first(rec, "severity", "ae_sev", "AESEV", "Severity",
                               "ae_grade", default="mild")
            rel_r = get_first(rec, "relationship", "causality", "ae_rel",
                               "AEREL", "Causality", default="not related")
            out_r = get_first(rec, "outcome", "ae_outcome", "AEOUT",
                               "Outcome", default="unknown")
            stdy  = study_day(rfstdtc_ref, std)
            mapped.update({
                "AESEQ":    seq,
                "AETERM":   ae_r.upper(),
                "AEDECOD":  get_first(rec, "meddra_pt", "ae_decoded", "AEDECOD",
                                       "MeddraPT", "preferred_term", default="").upper(),
                "AESTDTC":  std,
                "AEENDTC":  end,
                "AESEV":    map_ct(sev_r, ct.get("AESEV", {}), "MILD"),
                "AESER":    yn_flag(get_first(rec, "serious", "ae_ser", "AESER",
                                               "Serious", default="N")),
                "AEREL":    map_ct(rel_r, ct.get("AEREL", {}), "NOT RELATED"),
                "AEOUT":    map_ct(out_r, ct.get("AEOUT", {}), "UNKNOWN"),
                "AEBODSYS": get_first(rec, "body_system", "soc", "AEBODSYS",
                                       "SystemOrganClass", default="").upper(),
            })
            if stdy is not None:
                mapped["AESTDY"] = stdy
                derivs.append({
                    "variable":    "AESTDY",
                    "formula":     "1-based CDISC study day offset from RFSTDTC",
                    "inputs":      {"RFSTDTC": rfstdtc_ref, "AESTDTC": std},
                    "rule_source": cg_source,
                })
            _t("AESEQ",   "seq",           seq,   seq,             "sequence_number")
            _t("AETERM",  "adverse_event", ae_r,  mapped["AETERM"],"uppercase")
            _t("AESTDTC", "onset_date",    std_r, std,             "date_normalize")
            _t("AEENDTC", "resolve_date",  end_r, end,             "date_normalize")
            _t("AESEV",   "severity",      sev_r, mapped["AESEV"], "ct_lookup:AESEV")
            _t("AEREL",   "causality",     rel_r, mapped["AEREL"], "ct_lookup:AEREL")
            _t("AEOUT",   "outcome",       out_r, mapped["AEOUT"], "ct_lookup:AEOUT")

        # ── LB ────────────────────────────────────────────────────────────────
        elif domain == "LB":
            traw  = get_first(rec, "test_code", "lab_test", "lab_name",
                               "test_name", "LBTESTCD", "LabTest", "analyte")
            tcd   = ct.get("LBTESTCD", {}).get(traw.lower(), traw.upper()[:8])
            tname = ct.get("LBTEST_FULL", {}).get(tcd,
                        get_first(rec, "test_name", "lab_test_full",
                                  "analyte_name", default=tcd))
            res_r = get_first(rec, "result", "lb_result", "value", "LBORRES",
                               "LabResult", "ResultValue", default="")
            nstr  = re.sub(r"[^0-9.\-]", "", res_r)
            try:    stresn = float(nstr) if nstr else None
            except ValueError: stresn = None
            unit  = get_first(rec, "unit", "lb_unit", "units", "LBORRESU", "Unit", default="")
            dtc_r = get_first(rec, "collection_date", "lab_date", "sample_date",
                               "LBDTC", "SampleDate")
            dtc   = normalize_date(dtc_r)
            nri_r = get_first(rec, "normal_flag", "lb_flag", "LBNRIND",
                               "NormalFlag", default="normal")
            stdy  = study_day(rfstdtc_ref, dtc)
            mapped.update({
                "LBSEQ":    seq,    "LBTESTCD": tcd,   "LBTEST":  tname,
                "LBORRES":  res_r,  "LBORRESU": unit,
                "LBSTRESC": res_r,  "LBSTRESN": stresn,"LBSTRESU": unit,
                "LBNRIND":  map_ct(nri_r, ct.get("LBNRIND", {}), "NORMAL"),
                "LBDTC":    dtc,
                "VISIT":    get_first(rec, "visit", "Visit", "visit_name",
                                       "VisitName", default=""),
                "LBSPEC":   get_first(rec, "specimen_type", "sample_type",
                                       "LBSPEC", "SpecimenType", default="SERUM").upper(),
            })
            if stdy is not None:
                mapped["LBSTDY"] = stdy
                derivs.append({
                    "variable":    "LBSTDY",
                    "formula":     "1-based CDISC study day offset from RFSTDTC",
                    "inputs":      {"RFSTDTC": rfstdtc_ref, "LBDTC": dtc},
                    "rule_source": cg_source,
                })
            _t("LBSEQ",    "seq",             seq,   seq,               "sequence_number")
            _t("LBTESTCD", "test_code",       traw,  tcd,               "ct_lookup:LBTESTCD")
            _t("LBORRES",  "result",          res_r, res_r,             "direct_copy")
            _t("LBSTRESN", "result_numeric",  res_r, stresn,            "numeric_extract")
            _t("LBNRIND",  "normal_flag",     nri_r, mapped["LBNRIND"], "ct_lookup:LBNRIND")
            _t("LBDTC",    "collection_date", dtc_r, dtc,               "date_normalize")

        # ── VS ────────────────────────────────────────────────────────────────
        elif domain == "VS":
            traw  = get_first(rec, "vs_test", "vital_sign", "test_name",
                               "VSTESTCD", "VitalSign", "measurement")
            tcd   = ct.get("VSTESTCD",    {}).get(traw.lower(), traw.upper()[:8])
            tname = ct.get("VSTEST_FULL", {}).get(tcd, traw)
            dunit = ct.get("VSORRESU",    {}).get(tcd, "")
            res_r = get_first(rec, "result", "value", "VSORRES", "VitalValue",
                               "measurement_value", default="")
            unit  = get_first(rec, "unit", "units", "VSORRESU", "Unit", default=dunit)
            nstr  = re.sub(r"[^0-9.\-]", "", res_r)
            try:    stresn = float(nstr) if nstr else None
            except ValueError: stresn = None
            dtc_r = get_first(rec, "assessment_date", "vs_date", "VSDTC",
                               "AssessmentDate", "measurement_date")
            dtc   = normalize_date(dtc_r)
            stdy  = study_day(rfstdtc_ref, dtc)
            mapped.update({
                "VSSEQ":    seq,    "VSTESTCD": tcd,   "VSTEST":  tname,
                "VSORRES":  res_r,  "VSORRESU": unit,
                "VSSTRESC": res_r,  "VSSTRESN": stresn,"VSSTRESU": unit,
                "VSDTC":    dtc,
                "VISIT":    get_first(rec, "visit", "Visit", "visit_name", default=""),
                "VSPOS":    get_first(rec, "position", "posture", "VSPOS", default="").upper(),
            })
            if stdy is not None:
                mapped["VSSTDY"] = stdy
                derivs.append({
                    "variable":    "VSSTDY",
                    "formula":     "1-based CDISC study day offset from RFSTDTC",
                    "inputs":      {"RFSTDTC": rfstdtc_ref, "VSDTC": dtc},
                    "rule_source": cg_source,
                })
            _t("VSSEQ",    "seq",        seq,   seq,    "sequence_number")
            _t("VSTESTCD", "vs_test",    traw,  tcd,    "ct_lookup:VSTESTCD")
            _t("VSORRES",  "result",     res_r, res_r,  "direct_copy")
            _t("VSSTRESN", "result_num", res_r, stresn, "numeric_extract")
            _t("VSDTC",    "vs_date",    dtc_r, dtc,    "date_normalize")

        # ── Generic passthrough (domain not in DM/AE/LB/VS) ──────────────────
        else:
            for k, v in rec.items():
                kup = k.upper()
                if kup not in ("STUDYID", "DOMAIN", "USUBJID"):
                    mapped[kup] = v
                    _t(kup, k, v, v, "passthrough")

        return mapped, trace, derivs

    # ── 6. Per-record validation (driven by cg.required + cg.controlled_terms) ─
    def validate_record(mapped, domain, seq, cg):
        ddef     = cg["domains"].get(domain, {})
        required = ddef.get("required", [])
        ct       = ddef.get("controlled_terms", {})
        findings = []

        def _f(rule_id, severity, msg):
            findings.append({
                "seq":         seq,
                "domain":      domain,
                "rule_id":     rule_id,
                "severity":    severity,
                "message":     msg,
                "rule_source": cg_source,
            })

        # R1 — Required variables present
        for var in required:
            if not mapped.get(var) or str(mapped[var]).strip() == "":
                _f(f"{domain}-REQ-001", "ERROR",
                   f"Missing required variable {var} in {domain} record {seq}")

        # R2 — STUDYID consistency
        if mapped.get("STUDYID") and mapped["STUDYID"] != study_id:
            _f(f"{domain}-STUDYID-002", "ERROR",
               f"STUDYID '{mapped['STUDYID']}' != expected '{study_id}' in {domain} record {seq}")

        # R3 — USUBJID format (at least one hyphen segment)
        uid = mapped.get("USUBJID", "")
        if uid and not re.match(r"^[A-Z0-9]+(-[A-Z0-9]+)+$", uid, re.IGNORECASE):
            _f(f"{domain}-USUBJID-003", "WARNING",
               f"USUBJID '{uid}' does not match expected pattern in {domain} record {seq}")

        # R4 — ISO 8601 date variables
        for dv in [v for v in mapped if v.endswith("DTC")]:
            val = str(mapped.get(dv, "")).strip()
            if val and not re.match(r"^\d{4}(-\d{2}(-\d{2})?)?$", val):
                _f(f"{domain}-DATE-004", "WARNING",
                   f"{dv} value '{val}' in {domain} record {seq} is not valid ISO 8601")

        # R5 — CT spot-check (only vars that exist in both mapped output and ct table)
        for ct_var, ct_table in ct.items():
            if not isinstance(ct_table, dict) or not ct_table:
                continue
            val     = str(mapped.get(ct_var, "")).strip()
            allowed = set(ct_table.values())
            if val and allowed and val not in allowed:
                _f(f"{domain}-CT-005", "WARNING",
                   f"{ct_var} value '{val}' not in CT table for {domain} record {seq}")

        return findings

    # ── 7. Multi-domain grouping ──────────────────────────────────────────────
    domain_groups = {}
    for gseq, rec in enumerate(raw_records, start=1):
        dom, _ = detect_domain(rec, domain_hint, cg)
        domain_groups.setdefault(dom, []).append((gseq, rec))

    # ── 8. Process each domain group independently ────────────────────────────
    all_transformed      = []
    all_traces_by_domain = {}
    all_derivations      = []
    all_findings         = []
    missing_fields       = []
    inconsistencies      = []
    warnings_list        = []
    seen_derivs          = set()

    for domain, group in domain_groups.items():
        dom_records = []
        dom_traces  = []
        dseq        = 0

        for gseq, rec in group:
            dseq += 1
            try:
                mapped, trace, derivs = map_record(rec, domain, dseq, cg)
                findings              = validate_record(mapped, domain, dseq, cg)
                dom_records.append(mapped)
                dom_traces.extend(trace)
                all_findings.extend(findings)
                for d in derivs:
                    key = f"{domain}:{d['variable']}"
                    if key not in seen_derivs:
                        seen_derivs.add(key)
                        all_derivations.append(d)
                for f in findings:
                    if f["severity"] == "ERROR":
                        (missing_fields if "Missing required" in f["message"]
                         else inconsistencies).append(f["message"])
                    else:
                        warnings_list.append(f["message"])
            except Exception as exc:
                warnings_list.append(f"Record {gseq} ({domain}) skipped: {exc}")

        all_transformed.append({
            "domain":       domain,
            "records":      dom_records,
            "record_count": len(dom_records),
            "input_count":  len(group),
        })
        all_traces_by_domain[domain] = dom_traces

    # ── 9. Build domain_mappings (deduplicated per domain) ────────────────────
    domain_mappings = []
    for domain, traces in all_traces_by_domain.items():
        seen = {}
        for t in traces:
            key = (t["source_field"], t["sdtm_variable"])
            if key not in seen:
                seen[key] = {k: t[k] for k in
                             ("source_field", "sdtm_variable", "method", "rule_source")}
        domain_mappings.append({"domain": domain, "mappings": list(seen.values())})

    # ── 10. Confidence score ──────────────────────────────────────────────────
    req_total = sum(
        len(cg["domains"].get(d, {}).get("required", []))
        for d in domain_groups
    )
    n_recs = len(raw_records) or 1
    if req_total == 0:
        # No required-field definitions in context graph — cannot assess completeness.
        # Treat as fully complete rather than misleadingly scoring 0.
        completeness = 1.0
    else:
        filled = sum(
            1
            for dr in all_transformed
            for r  in dr["records"]
            for v  in cg["domains"].get(dr["domain"], {}).get("required", [])
            if r.get(v) and str(r[v]).strip()
        )
        completeness = filled / (req_total * n_recs)
    err_count        = len([f for f in all_findings if f["severity"] == "ERROR"])
    validation_rate  = max(0.0, 1.0 - err_count / max(len(all_findings), 1))
    confidence_score = round(completeness * 0.6 + validation_rate * 0.4, 3)

    # ── 11. Return exact output contract ─────────────────────────────────────
    return {
        "identified_domains":       sorted(domain_groups.keys()),
        "domain_mappings":          domain_mappings,
        "transformed_data":         all_transformed,
        "derivations":              all_derivations,
        "validation_rules_applied": all_findings[:200],
        "issues": {
            "missing_fields":   missing_fields[:50],
            "inconsistencies":  inconsistencies[:50],
            "warnings":         warnings_list[:50],
        },
        "confidence_score": confidence_score,
    }

'''

# ─── Generic function skill complete example (non-SDTM) ───────────────────────
_GENERIC_FUNCTION_EXAMPLE = '''
COMPLETE WORKING EXAMPLE (follow this style exactly — no placeholders):

from datetime import datetime

THRESHOLD  = float(params.get("threshold", 0.8))
FIELD_NAME = str(params.get("field", "score"))


def safe_float(val):
    try:
        return float(val)
    except (TypeError, ValueError):
        return 0.0


def classify(score, threshold):
    if score >= threshold:
        return "PASS"
    elif score >= threshold * 0.75:
        return "BORDERLINE"
    else:
        return "FAIL"


records  = state_data.get("records", [])
summary  = {"PASS": 0, "BORDERLINE": 0, "FAIL": 0}
detailed = []

for idx, rec in enumerate(records, start=1):
    score = safe_float(rec.get(FIELD_NAME, 0))
    label = classify(score, THRESHOLD)
    summary[label] += 1
    detailed.append({"id": rec.get("id", idx), "score": score, "label": label})

result = {
    "processed":  len(records),
    "summary":    summary,
    "records":    detailed,
    "threshold":  THRESHOLD,
    "pass_rate":  round(summary["PASS"] / max(len(records), 1) * 100, 1),
}

END OF EXAMPLE — write similarly complete code below.
'''

_SDTM_KNOWLEDGE_CONTEXT = """
CDISC SDTM IG v3.4 Domain Reference (source of truth):

DOMAIN | REQUIRED VARIABLES | KEY CONTROLLED TERMS
DM     | STUDYID, DOMAIN, USUBJID, SUBJID, RFSTDTC, RFENDTC, SITEID, AGE, AGEU, SEX, RACE, ETHNIC, COUNTRY | SEX: M/F/U; AGEU: YEARS/MONTHS/DAYS
AE     | STUDYID, DOMAIN, USUBJID, AESEQ, AETERM, AESTDTC | AESEV: MILD/MODERATE/SEVERE; AESER: Y/N; AEREL: NOT RELATED/POSSIBLY RELATED/PROBABLY RELATED/RELATED
LB     | STUDYID, DOMAIN, USUBJID, LBSEQ, LBTESTCD, LBTEST, LBORRES, LBDTC | LBNRIND: LOW/NORMAL/HIGH/ABNORMAL
VS     | STUDYID, DOMAIN, USUBJID, VSSEQ, VSTESTCD, VSTEST, VSORRES, VSDTC | VSTESTCD: SYSBP/DIABP/PULSE/TEMP/WEIGHT/HEIGHT/BMI
CM     | STUDYID, DOMAIN, USUBJID, CMSEQ, CMTRT, CMSTDTC
EX     | STUDYID, DOMAIN, USUBJID, EXSEQ, EXTRT, EXDOSE, EXDOSU, EXROUTE, EXSTDTC
MH     | STUDYID, DOMAIN, USUBJID, MHSEQ, MHTERM
DS     | STUDYID, DOMAIN, USUBJID, DSSEQ, DSTERM, DSDECOD, EPOCH, DSSTDTC
"""

_STRUCTURED_SKILL_PROMPT = """\
You are an expert AI systems architect and domain-aware skill compiler.
Convert a user's natural language request into a fully defined, production-grade AI skill.

Inputs:
1. USER_PROMPT: {user_prompt}
2. CONTEXT_GRAPH (domain knowledge — use to guide mappings, schemas, enforce domain correctness):
{context_graph}

Skill Types:
- "prompt": reasoning / summarisation / classification
- "function": structured processing / transformations / computation

OUTPUT — return ONLY valid JSON with this structure (no prose, no markdown fences):
{{
  "skill_name": "",
  "description": "",
  "skill_type": "",
  "tags": [],
  "input_schema": {{}},
  "output_schema": {{}},
  "system_prompt": "",
  "examples": [],
  "execution_logic": {{
    "type": "python_function",
    "code": ""
  }},
  "assumptions": [],
  "limitations": []
}}

Requirements:
1. skill_name: snake_case, max 60 chars
2. input_schema / output_schema: valid JSON Schema with "type" and "description" per property
3. For prompt skills: system_prompt = complete production-ready instructions enforcing JSON output
4. For function skills: system_prompt = one-sentence plain-English description; execution_logic.code = FULLY EXECUTABLE Python
   - ABSOLUTE RULES for code: no ... placeholders, no # TODO, no bare pass, no raise NotImplementedError
   - Every function body fully implemented; every branch fully implemented
   - Code MUST define: def execute(input_data: dict, context_graph: dict = None) -> dict:
   - Read all inputs from input_data; last statement inside execute() must be: result = {{ ... }}  (fully populated dict)
   - Import only Python stdlib (datetime, re, json, math, collections)
   - Do NOT use state_data, params, or messages — they do not exist at runtime
5. examples: at least one realistic {{input, output}} pair
6. If CONTEXT_GRAPH is provided, reflect its rules in schemas and code logic
7. Return ONLY the JSON — no explanations outside it\
"""

_SKILL_FIXER_META_PROMPT = """\
You are an expert AI systems architect. Fix and upgrade a skill to be fully compliant and production-ready.

ORIGINAL_SKILL_CODE:
{original_code}

ORIGINAL_USER_PROMPT:
{original_prompt}

CONTEXT_GRAPH:
{context_graph}

MANDATORY FIXES:
1. Enforce standard output contract — execution_logic.code MUST populate ALL fields:
   identified_domains, domain_mappings, transformed_data, derivations,
   validation_rules_applied, issues, confidence_score
2. input_schema: complete JSON Schema with type+description for every property
3. output_schema: must reflect the full output contract above
4. system_prompt: production-ready instructions enforcing strict JSON output and traceability
5. examples: at least one realistic {{input, output}} pair
6. assumptions: list of key assumptions the skill makes
7. limitations: known edge cases or unsupported scenarios

Return ONLY valid JSON — set execution_logic.code to empty string "" (code is generated in a separate pass):
{{
  "skill_name": "",
  "description": "",
  "skill_type": "function",
  "tags": [],
  "input_schema": {{}},
  "output_schema": {{}},
  "system_prompt": "",
  "examples": [],
  "execution_logic": {{"type": "python_function", "code": ""}},
  "assumptions": [],
  "limitations": []
}}\
"""

_SKILL_FIXER_CODE_PROMPT = """\
You are a Python code generator for AI agent skills.
Write COMPLETE, EXECUTABLE Python code to fix and upgrade the following skill.

SKILL NAME: {skill_name}
DESCRIPTION: {description}

INPUT SCHEMA:
{input_schema}

OUTPUT SCHEMA (the result dict MUST match this exactly):
{output_schema}

ORIGINAL CODE (keep working logic, fix broken patterns):
{original_code}

CONTEXT_GRAPH:
{context_graph}

ABSOLUTE RULES:
1. Code MUST define: def execute(input_data: dict, context_graph: dict = None) -> dict:
2. Read all inputs from input_data at top of execute():
     raw_data    = input_data.get("raw_edc_data", input_data.get("records", []))
     metadata    = input_data.get("metadata", {{}})
     study_id    = str(metadata.get("study_id", "STUDY001")).strip()
     domain_hint = str(metadata.get("domain_hint", "")).upper().strip()
3. Organise logic into these named functions (all fully implemented):
     detect_domain(records, domain_hint)   → str domain name
     map_fields(rec, domain, study_id)     → (mapped_dict, list[mapping_trace_dict], list[derivation_dict])
     validate_record(mapped, domain, seq)  → list[finding_str]
4. The final result assignment MUST include ALL fields:
     result = {{
         "identified_domains":      [...],
         "domain_mappings":         [...],   # list of {{source_field, target_field, domain, transformation_applied}}
         "transformed_data":        [...],   # list of {{domain, records: [mapped_dicts]}}
         "derivations":             [...],   # list of {{variable, logic_used}}
         "validation_rules_applied":[...],   # list of {{rule_name, description, status}}
         "issues":                  {{
             "missing_fields":  [...],
             "inconsistencies": [...],
             "warnings":        [],
         }},
         "confidence_score": 0.0,            # float 0-1
     }}
5. confidence_score = (mapped_count / max(total_required, 1)) * (passed_validations / max(total_validations, 1))
6. NEVER use ..., # TODO, bare pass, raise NotImplementedError
7. Every branch fully implemented
8. Import only Python stdlib: datetime, re, json, math, collections
Return ONLY Python code — no markdown fences, no explanations.\
"""

_SDTM_REQUIRED_VARS = {
    "AE": ["STUDYID","DOMAIN","USUBJID","AESEQ","AETERM","AESTDTC"],
    "DM": ["STUDYID","DOMAIN","USUBJID","SUBJID","RFSTDTC","RFENDTC","SITEID","AGE","AGEU","SEX","RACE","ETHNIC","COUNTRY"],
    "LB": ["STUDYID","DOMAIN","USUBJID","LBSEQ","LBTESTCD","LBTEST","LBORRES","LBDTC"],
    "VS": ["STUDYID","DOMAIN","USUBJID","VSSEQ","VSTESTCD","VSTEST","VSORRES","VSDTC"],
    "CM": ["STUDYID","DOMAIN","USUBJID","CMSEQ","CMTRT","CMSTDTC"],
    "EX": ["STUDYID","DOMAIN","USUBJID","EXSEQ","EXTRT","EXDOSE","EXDOSU","EXROUTE","EXSTDTC"],
    "MH": ["STUDYID","DOMAIN","USUBJID","MHSEQ","MHTERM"],
    "DS": ["STUDYID","DOMAIN","USUBJID","DSSEQ","DSTERM","DSDECOD","EPOCH","DSSTDTC"],
}


def _is_sdtm_related(description: str) -> bool:
    desc_lower = description.lower()
    return any(kw in desc_lower for kw in _SDTM_KEYWORDS)


@app.post("/skills/generate")
async def generate_skill(req: SkillGenerateRequest):
    """LLM-generate a skill body from a description. Does NOT write to DB — user reviews before saving."""
    import openai as _openai
    import re as _re
    import json as _json

    sdtm = _is_sdtm_related(req.description)

    # ── SDTM function: deterministic template, no LLM ─────────────────────────
    if req.skill_type == "function" and sdtm:
        words = _re.sub(r'[^a-zA-Z0-9\s]', '', req.description.lower()).split()
        suggested_name = '_'.join(w for w in words[:5] if len(w) > 2) or "sdtm_mapper"
        return {
            "suggested_name": suggested_name,
            "generated_body": _SDTM_FUNCTION_CODE,
            "skill_type": "function",
            "description": req.description[:200],
            "system_prompt": (
                "Maps raw EDC records to CDISC SDTM-compliant datasets. "
                "Performs per-record domain detection via signal-field scoring, "
                "field mapping with controlled-term lookups, derivation of computed "
                "variables (AGE, study day), and CDISC conformance validation. "
                "Returns structured output with full mapping traces and audit provenance."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "raw_edc_data":  {"type": "array",  "description": "List of raw EDC records (dicts with any field names)"},
                    "metadata":      {"type": "object", "description": "Optional: {study_id, domain_hint, rfstdtc}"},
                    "context_graph": {"type": "object", "description": "Optional: SDTM domain knowledge graph (overrides built-in fallback)"},
                },
                "required": ["raw_edc_data"],
            },
            "output_schema": {
                "type": "object",
                "properties": {
                    "identified_domains":       {"type": "array",  "description": "SDTM domains detected in input records"},
                    "domain_mappings":          {"type": "array",  "description": "Per-domain deduplicated field mapping traces"},
                    "transformed_data":         {"type": "array",  "description": "Per-domain mapped records with record count"},
                    "derivations":              {"type": "array",  "description": "Derived variable calculations (AGE, AESTDY, etc.)"},
                    "validation_rules_applied": {"type": "array",  "description": "CDISC conformance findings with domain-prefixed rule IDs"},
                    "issues":                   {"type": "object", "description": "{missing_fields, inconsistencies, warnings} — capped at 50 each"},
                    "confidence_score":         {"type": "number", "description": "0–1 composite score: completeness (60%) + validation pass rate (40%)"},
                },
                "required": ["identified_domains","domain_mappings","transformed_data",
                             "derivations","validation_rules_applied","issues","confidence_score"],
            },
            "tags": ["sdtm","cdisc","clinical-data","etl","data-mapping","IG-v3.4"],
            "examples": [
                {
                    "input": {
                        "raw_edc_data": [
                            {"subject_id": "001", "sex": "male", "age": 34,
                             "race": "white", "country": "USA",
                             "enroll_date": "2024-01-15", "site_id": "S01"},
                        ],
                        "metadata": {"study_id": "STUDY001"},
                    },
                    "output": {
                        "identified_domains": ["DM"],
                        "domain_mappings": [{"domain": "DM", "mappings": [
                            {"source_field": "sex/gender", "sdtm_variable": "SEX",
                             "method": "ct_lookup:SEX", "rule_source": "sdtm_fallback"},
                        ]}],
                        "transformed_data": [{"domain": "DM", "record_count": 1, "records": [
                            {"STUDYID": "STUDY001", "DOMAIN": "DM", "USUBJID": "STUDY001-001",
                             "SUBJID": "001", "SEX": "M", "AGE": 34, "AGEU": "YEARS",
                             "RACE": "WHITE", "COUNTRY": "USA", "SITEID": "S01",
                             "RFSTDTC": "2024-01-15"},
                        ]}],
                        "derivations": [],
                        "validation_rules_applied": [],
                        "issues": {"missing_fields": ["Missing required variable RFENDTC in DM record 1"],
                                   "inconsistencies": [], "warnings": []},
                        "confidence_score": 0.754,
                    },
                }
            ],
            "assumptions": [
                "Input records contain at least one recognisable signal field per domain",
                "study_id is provided in metadata or defaults to 'STUDY001'",
                "Dates are parseable ISO 8601, dd/mm/yyyy, mm/dd/yyyy, or d-Mon-YYYY",
                "When context_graph is injected, its domain definitions take precedence over the built-in fallback",
                "Multi-domain input is supported: each record is assigned to one domain independently",
            ],
            "limitations": [
                "Supports DM, AE, LB, VS with rich handlers; other domains receive passthrough treatment",
                "CT lookup is prefix/substring matching — exact CDISC CT may differ by study",
                "Age derivation requires a valid DOB and RFSTDTC; otherwise defaults to 0",
                "Confidence score reflects completeness of CDISC required variables, not data accuracy",
                "MedDRA coding (AEDECOD) is not performed — must be supplied in the source data",
            ],
        }

    # ── All other skills: single-pass structured prompt ────────────────────────
    def _llm_call(prompt: str, max_tokens: int = 3500) -> str:
        response = _openai.OpenAI(
            base_url=f"{settings.ollama_base_url}/v1",
            api_key="ollama",
        ).chat.completions.create(
            model=settings.ollama_model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
        )
        return (response.choices[0].message.content or "").strip()

    if sdtm:
        context_graph = _SDTM_KNOWLEDGE_CONTEXT
    elif req.context_graph_id:
        try:
            import httpx as _httpx
            _cg_res = _httpx.get(
                f"{settings.context_graph_url}/standard-graphs",
                params={"org_id": req.org_id},
                timeout=5,
            )
            _graphs = _cg_res.json().get("graphs", [])
            _graph  = next((g for g in _graphs if str(g.get("id")) == req.context_graph_id), None)
            if _graph:
                context_graph = (
                    f"Graph: {_graph.get('name', '')}\n"
                    f"Description: {_graph.get('description', 'No description provided.')}"
                )
            else:
                context_graph = "No context graph provided."
        except Exception:
            context_graph = "No context graph provided."
    else:
        context_graph = "No context graph provided."

    full_prompt = _STRUCTURED_SKILL_PROMPT.format(
        user_prompt=req.description,
        context_graph=context_graph,
    )
    raw = _llm_call(full_prompt, max_tokens=3500)

    # Parse JSON envelope
    try:
        parsed = _json.loads(_extract_json(raw))
    except Exception:
        parsed = {}

    skill_type_from_llm = parsed.get("skill_type", req.skill_type or "prompt")
    if skill_type_from_llm == "function":
        body = (parsed.get("execution_logic") or {}).get("code") or raw
    else:
        body = parsed.get("system_prompt") or raw

    # Completeness check + retry for function skills
    if skill_type_from_llm == "function":
        issues = _validate_function_code(body)
        if issues:
            retry_prompt = full_prompt + (
                "\n\nPrevious attempt had issues:\n"
                + "\n".join(f"  • {i}" for i in issues)
                + "\n\nFix ALL issues and return the corrected JSON."
            )
            raw2 = _llm_call(retry_prompt, max_tokens=3500)
            try:
                parsed2 = _json.loads(_extract_json(raw2))
                body = (parsed2.get("execution_logic") or {}).get("code") or body
                parsed = parsed2
            except Exception:
                pass
            remaining = _validate_function_code(body)
            if remaining:
                body = (
                    "# WARNING: review before deploying:\n"
                    + "".join(f"#   {i}\n" for i in remaining)
                    + "\n" + body
                )

    words = _re.sub(r'[^a-zA-Z0-9\s]', '', req.description.lower()).split()
    suggested_name = (
        parsed.get("skill_name")
        or '_'.join(w for w in words[:5] if len(w) > 2)
        or "generated_skill"
    )

    return {
        "suggested_name": suggested_name,
        "generated_body": body,
        "input_schema":   parsed.get("input_schema",  {}),
        "output_schema":  parsed.get("output_schema", {}),
        "tags":           parsed.get("tags",          []),
        "examples":       parsed.get("examples",      []),
        "assumptions":    parsed.get("assumptions",   []),
        "limitations":    parsed.get("limitations",   []),
        "description":    parsed.get("description",   req.description[:200]),
    }


@app.post("/skills/fix")
async def fix_skill(req: SkillFixRequest):
    """Two-pass LLM fix: Pass 1 generates metadata (schema/prompt/examples),
    Pass 2 generates code. Avoids token-cutoff on single-pass attempts."""
    import openai as _openai
    import re as _re
    import json as _json

    # ── Resolve context graph ──────────────────────────────────────────────────
    if req.context_graph_id:
        try:
            import httpx as _httpx
            _cg_res = _httpx.get(
                f"{settings.context_graph_url}/standard-graphs",
                params={"org_id": req.org_id},
                timeout=5,
            )
            _graphs = _cg_res.json().get("graphs", [])
            _graph  = next((g for g in _graphs if str(g.get("id")) == req.context_graph_id), None)
            context_graph = (
                f"Graph: {_graph.get('name', '')}\n"
                f"Description: {_graph.get('description', '')}"
            ) if _graph else "No context graph provided."
        except Exception:
            context_graph = "No context graph provided."
    else:
        context_graph = "No context graph provided."

    def _llm(prompt: str, max_tokens: int = 3000) -> str:
        response = _openai.OpenAI(
            base_url=f"{settings.ollama_base_url}/v1",
            api_key="ollama",
        ).chat.completions.create(
            model=settings.ollama_model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
        )
        return (response.choices[0].message.content or "").strip()

    # ── Pass 1: metadata (no code) ─────────────────────────────────────────────
    meta_prompt = _SKILL_FIXER_META_PROMPT.format(
        original_code=req.original_code[:3000],
        original_prompt=req.original_prompt[:1000],
        context_graph=context_graph,
    )
    meta_raw = _llm(meta_prompt, max_tokens=2500)
    try:
        meta = _json.loads(_extract_json(meta_raw))
    except Exception:
        meta = {}

    skill_name  = meta.get("skill_name", "fixed_skill")
    description = meta.get("description", req.original_prompt[:150])

    # ── Pass 2: code only ──────────────────────────────────────────────────────
    code_prompt = _SKILL_FIXER_CODE_PROMPT.format(
        skill_name=skill_name,
        description=description,
        input_schema=_json.dumps(meta.get("input_schema", {}), indent=2)[:800],
        output_schema=_json.dumps(meta.get("output_schema", {}), indent=2)[:800],
        original_code=req.original_code[:2500],
        context_graph=context_graph,
    )
    code_raw = _llm(code_prompt, max_tokens=3500)
    # Strip fences
    code_raw = _re.sub(r'^```[a-zA-Z]*\n?', '', code_raw.strip())
    code_raw = _re.sub(r'\n?```$', '', code_raw).strip()

    # ── Completeness check + retry ─────────────────────────────────────────────
    issues = _validate_function_code(code_raw)
    if issues:
        retry_prompt = code_prompt + (
            "\n\nPrevious attempt had issues:\n"
            + "\n".join(f"  • {i}" for i in issues)
            + "\n\nFix ALL issues and return the corrected complete Python code."
        )
        code_raw2 = _llm(retry_prompt, max_tokens=3500)
        code_raw2 = _re.sub(r'^```[a-zA-Z]*\n?', '', code_raw2.strip())
        code_raw2 = _re.sub(r'\n?```$', '', code_raw2).strip()
        remaining = _validate_function_code(code_raw2)
        if not remaining:
            code_raw = code_raw2
        else:
            code_raw = (
                "# WARNING: review before deploying:\n"
                + "".join(f"#   {i}\n" for i in remaining)
                + "\n" + code_raw2
            )

    return {
        "suggested_name": skill_name,
        "generated_body": code_raw,
        "input_schema":   meta.get("input_schema",  {}),
        "output_schema":  meta.get("output_schema", {}),
        "tags":           meta.get("tags",           []),
        "examples":       meta.get("examples",       []),
        "assumptions":    meta.get("assumptions",    []),
        "limitations":    meta.get("limitations",    []),
        "description":    description,
        "system_prompt":  meta.get("system_prompt",  ""),
    }


# ============================================================
# AGENT BUILDER — Step-by-step AI-powered agent creation
# ============================================================

class StepRequest(BaseModel):
    step: Literal["intent", "classify", "plan", "knowledge", "skills", "model",
                  "subagents", "architect", "validate"]
    description: Optional[str] = None   # only for step=intent
    org_id: str
    context: dict = {}                  # accumulated results from previous steps
    overrides: dict = {}                # user edits to override AI output

class StepResponse(BaseModel):
    step: str
    result: dict
    hitl_required: bool
    confidence: float
    message: str


def _build_llm_call(prompt: str, max_tokens: int = 3000) -> str:
    """Synchronous LLM call used by build step handlers."""
    response = _openai_mp.OpenAI(
        base_url=f"{settings.ollama_base_url}/v1",
        api_key="ollama",
    ).chat.completions.create(
        model=settings.ollama_model,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=max_tokens,
    )
    return (response.choices[0].message.content or "").strip()


def _extract_json_block(text: str) -> str:
    """Extract first JSON object/array from LLM response."""
    m = _re_mp.search(r'```(?:json)?\s*([\s\S]*?)```', text)
    if m:
        return m.group(1).strip()
    m = _re_mp.search(r'(\{[\s\S]*\}|\[[\s\S]*\])', text)
    if m:
        return m.group(1)
    return text


def _safe_parse(text: str) -> dict:
    try:
        return json.loads(_extract_json_block(text))
    except Exception:
        return {}


async def _step_intent(req: StepRequest, pool, s) -> tuple:
    desc = req.description or req.context.get("description", "")
    prompt = f"""Extract structured information from this agent description and return ONLY valid JSON.

Description: {desc}

Return JSON with these exact fields:
{{
  "objective": "one-sentence goal",
  "domain": "clinical data domain (e.g. SDTM, ADaM, Safety, Operations)",
  "inputs": ["list of input data types"],
  "outputs": ["list of output types"],
  "complexity": "simple|medium|complex",
  "constraints": ["list of constraints or []"]
}}"""
    raw = _build_llm_call(prompt, 1000)
    result = _safe_parse(raw)
    if not result.get("objective"):
        result = {
            "objective": desc[:200],
            "domain": "Clinical Data",
            "inputs": ["study data"],
            "outputs": ["analysis report"],
            "complexity": "medium",
            "constraints": [],
        }
    return result, False, 0.9, f"Extracted intent: {result.get('objective', '')[:80]}"


async def _step_classify(req: StepRequest, pool, s) -> tuple:
    if req.overrides.get("agent_type"):
        t = req.overrides["agent_type"]
        return {"agent_type": t, "justification": "User override"}, False, 1.0, f"Agent type set to {t} (user override)"

    intent = req.context.get("intent", {})
    complexity = intent.get("complexity", "medium")
    prompt = f"""Classify this agent as 'normal' or 'deep'.

Intent: {json.dumps(intent, indent=2)}

Rules:
- 'deep' if complexity=complex OR requires multi-step planning OR needs persistent memory OR orchestrates sub-agents
- 'normal' for single-purpose, straightforward analysis or reporting

Return ONLY valid JSON:
{{"agent_type": "normal|deep", "justification": "one sentence reason"}}"""
    raw = _build_llm_call(prompt, 300)
    result = _safe_parse(raw)
    agent_type = result.get("agent_type", "normal" if complexity != "complex" else "deep")
    result["agent_type"] = agent_type
    return result, True, 0.85, f"Classified as {agent_type}: {result.get('justification', '')[:60]}"


async def _step_plan(req: StepRequest, pool, s) -> tuple:
    intent = req.context.get("intent", {})
    agent_type = req.context.get("classify", {}).get("agent_type", "normal")
    prompt = f"""Create a detailed execution plan for this agent.

Intent: {json.dumps(intent, indent=2)}
Agent Type: {agent_type}

Return ONLY valid JSON:
{{
  "goal": "clear goal statement",
  "tasks": [{{"id": "t1", "name": "task name", "description": "what it does", "approval_required": false}}],
  "knowledge_sources": ["sdtm", "documents", etc],
  "risks": ["potential issues"],
  "confidence": 0.85
}}"""
    raw = _build_llm_call(prompt, 1500)
    result = _safe_parse(raw)
    if not result.get("goal"):
        result = {
            "goal": intent.get("objective", "Accomplish agent objective"),
            "tasks": [{"id": "t1", "name": "Analyze data", "description": "Core analysis", "approval_required": False}],
            "knowledge_sources": ["sdtm", "documents"],
            "risks": [],
            "confidence": 0.75,
        }
    confidence = float(result.get("confidence", 0.75))
    hitl = confidence < 0.8 or bool(result.get("risks"))
    return result, hitl, confidence, f"Plan: {len(result.get('tasks',[]))} tasks, {len(result.get('risks',[]))} risks"


async def _step_knowledge(req: StepRequest, pool, s) -> tuple:
    import uuid as _uuid
    knowledge_sources = req.context.get("plan", {}).get("knowledge_sources", [])
    try:
        org_uuid = _uuid.UUID(str(req.org_id))
    except Exception:
        org_uuid = req.org_id
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, name, description, document_ids, is_published, org_id
               FROM standard_context_graphs
               WHERE (org_id IS NULL AND is_published = TRUE) OR org_id = $1
               ORDER BY is_published DESC, created_at DESC
               LIMIT 20""",
            org_uuid,
        )
    available = [
        {
            "id": str(r["id"]),
            "name": r["name"],
            "description": r["description"] or "",
            "document_count": len(r["document_ids"]) if r["document_ids"] else 0,
            "is_published": r["is_published"],
            "is_platform": r["org_id"] is None,
        }
        for r in rows
    ]
    missing = [src for src in knowledge_sources if not any(src.lower() in a["name"].lower() for a in available)]
    sufficient = len(available) > 0
    intent = req.context.get("intent", {})
    suggested_graph = f"{intent.get('domain', 'Study')} Knowledge Graph"
    result = {
        "sufficient": sufficient,
        "available": available,
        "missing": missing,
        "suggested_graph_name": suggested_graph,
    }
    # Always pause so the user can pick/attach a graph
    hitl = True
    msg = f"{len(available)} knowledge graph(s) available — select one to attach" if available else "No knowledge graphs found — create one or skip"
    return result, hitl, 0.9 if sufficient else 0.6, msg


async def _step_skills(req: StepRequest, pool, s) -> tuple:
    tasks = req.context.get("plan", {}).get("tasks", [])
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, name, description, skill_type FROM agent_skills
               WHERE org_id=$1 OR (org_id IS NULL AND is_published=TRUE)
               ORDER BY name""",
            req.org_id,
        )
    available_skills = [{"id": str(r["id"]), "name": r["name"], "description": r["description"], "skill_type": r["skill_type"]} for r in rows]

    if not available_skills:
        result = {"reused": [], "new_needed": [{"name": t["name"], "description": t.get("description", ""), "type": "function"} for t in tasks[:3]]}
        return result, True, 0.7, f"No existing skills found; {len(result['new_needed'])} new skills needed"

    prompt = f"""Match agent tasks to available skills. Return ONLY valid JSON.

Tasks: {json.dumps(tasks, indent=2)}
Available skills: {json.dumps(available_skills[:20], indent=2)}

Return:
{{
  "reused": [{{"id": "skill_id", "name": "skill_name"}}],
  "new_needed": [{{"name": "skill_name", "description": "what it does", "type": "function|prompt"}}]
}}"""
    raw = _build_llm_call(prompt, 800)
    result = _safe_parse(raw)
    if not isinstance(result.get("reused"), list):
        result = {"reused": [], "new_needed": []}
    return result, True, 0.8, f"{len(result.get('reused',[]))} reused, {len(result.get('new_needed',[]))} new skills needed"


async def _step_model(req: StepRequest, pool, s) -> tuple:
    intent = req.context.get("intent", {})
    complexity = intent.get("complexity", "medium")
    agent_type = req.context.get("classify", {}).get("agent_type", "normal")
    model = s.ollama_model
    result = {
        "selected_model": model,
        "provider": "ollama",
        "justification": f"Default model for {complexity} complexity {agent_type} agent",
        "alternatives": [],
    }
    return result, False, 0.9, f"Model: {model}"


async def _step_subagents(req: StepRequest, pool, s) -> tuple:
    agent_type = req.context.get("classify", {}).get("agent_type", "normal")
    if agent_type != "deep":
        return {"sub_agents": [], "skipped": True}, False, 1.0, "Skipped (normal agent)"

    tasks = req.context.get("plan", {}).get("tasks", [])
    prompt = f"""Design sub-agents for a deep agent system. Return ONLY valid JSON.

Tasks: {json.dumps(tasks, indent=2)}

Return:
{{
  "sub_agents": [{{
    "name": "SubAgent name",
    "responsibility": "what it handles",
    "input_contract": {{"type": "what it receives"}},
    "output_contract": {{"type": "what it produces"}}
  }}]
}}"""
    raw = _build_llm_call(prompt, 1000)
    result = _safe_parse(raw)
    if not isinstance(result.get("sub_agents"), list):
        result = {"sub_agents": []}
    return result, True, 0.8, f"{len(result.get('sub_agents',[]))} sub-agents designed"


async def _step_architect(req: StepRequest, pool, s) -> tuple:
    ctx = req.context
    intent     = ctx.get("intent", {})
    plan       = ctx.get("plan", {})
    skills     = ctx.get("skills", {})
    model_cfg  = ctx.get("model", {})
    agent_type = ctx.get("classify", {}).get("agent_type", "normal")
    reused_skills = skills.get("reused", [])
    tasks = plan.get("tasks", [])
    sub_agents = ctx.get("subagents", {}).get("sub_agents", [])

    nodes = []
    edges = []
    node_idx = 1

    def nid():
        nonlocal node_idx
        nid_val = f"n{node_idx}"
        node_idx += 1
        return nid_val

    prev_id = None

    # Start node: planner for deep, dataSource for normal
    if agent_type == "deep":
        pid = nid()
        nodes.append({"id": pid, "type": "planner", "label": "Planner",
                       "config": {"objective": intent.get("objective", ""), "max_tasks": len(tasks) or 5}})
        prev_id = pid

        # Add subagent nodes for each designed sub-agent
        for sa in sub_agents[:4]:
            sa_id = nid()
            nodes.append({"id": sa_id, "type": "agent", "label": sa.get("name", "Sub-Agent"),
                           "config": {
                               "agentName": sa.get("name", "Sub-Agent"),
                               "inputPrompt": sa.get("responsibility", ""),
                               "agentMode": "standard",
                           }})
            edges.append({"source": prev_id, "target": sa_id})
            prev_id = sa_id
    else:
        knowledge_sources = plan.get("knowledge_sources", ["sdtm"])
        for src in knowledge_sources[:2]:
            sid = nid()
            nodes.append({"id": sid, "type": "dataSource", "label": src.upper(),
                           "config": {"tool": f"read_{src}_domain" if src == "sdtm" else f"search_{src}" if src == "documents" else f"read_{src}_data", "sources": [src]}})
            if prev_id:
                edges.append({"source": prev_id, "target": sid})
            prev_id = sid

    # Context graph node if knowledge step has an attached graph
    knowledge = ctx.get("knowledge", {})
    if knowledge.get("attached_graph"):
        graph_id = knowledge["attached_graph"].get("graph_id")
        if graph_id:
            cg_id = nid()
            nodes.append({"id": cg_id, "type": "context_graph", "label": "Knowledge Graph",
                           "config": {"graph_id": graph_id}})
            if prev_id:
                edges.append({"source": prev_id, "target": cg_id})
            prev_id = cg_id

    # LLM node
    llm_id = nid()
    nodes.append({"id": llm_id, "type": "llm", "label": "LLM Analysis",
                   "config": {"model": model_cfg.get("selected_model", s.ollama_model),
                               "provider": model_cfg.get("provider", "ollama"),
                               "prompt": f"Perform: {intent.get('objective', '')}"}})
    if prev_id:
        edges.append({"source": prev_id, "target": llm_id})
    prev_id = llm_id

    # Skill nodes (reused)
    for skill in reused_skills[:2]:
        sk_id = nid()
        nodes.append({"id": sk_id, "type": "skill", "label": skill["name"],
                       "config": {"skill_id": skill["id"]}})
        edges.append({"source": prev_id, "target": sk_id})
        prev_id = sk_id

    # HITL nodes where plan has approval_required
    for task in tasks:
        if task.get("approval_required"):
            h_id = nid()
            nodes.append({"id": h_id, "type": "hitl", "label": f"Review: {task['name'][:30]}",
                           "config": {"title": f"Review {task['name']}", "description": task.get("description", "")}})
            edges.append({"source": prev_id, "target": h_id})
            prev_id = h_id

    # Output node
    out_id = nid()
    nodes.append({"id": out_id, "type": "output", "label": "Output",
                   "config": {"format": "narrative"}})
    edges.append({"source": prev_id, "target": out_id})

    flow_definition = {
        "nodes": nodes,
        "edges": edges,
        "observability": {
            "provider": "langfuse",
            "trace_inputs": True,
            "trace_outputs": True,
            "trace_errors": True,
            "trace_latency": True,
            "trace_human_events": True,
        },
    }
    result = {"flow_definition": flow_definition, "node_count": len(nodes), "edge_count": len(edges)}
    return result, False, 0.9, f"Flow designed: {len(nodes)} nodes, {len(edges)} edges"


async def _step_validate(req: StepRequest, pool, s) -> tuple:
    flow_def = req.context.get("architect", {}).get("flow_definition", {})
    nodes = flow_def.get("nodes", [])
    edges = flow_def.get("edges", [])
    issues = []

    if not nodes:
        issues.append({"level": "error", "message": "No nodes in flow"})
    has_output = any(n.get("type") == "output" for n in nodes)
    if not has_output:
        issues.append({"level": "error", "message": "No output node"})
    connected = set()
    for e in edges:
        connected.add(e.get("source"))
        connected.add(e.get("target"))
    orphans = [n["id"] for n in nodes if n["id"] not in connected and len(nodes) > 1]
    if orphans:
        issues.append({"level": "warning", "message": f"Orphan nodes: {orphans}"})

    completeness = max(0, 100 - len(issues) * 20)
    confidence = 1.0 if not issues else (0.7 if any(i["level"] == "error" for i in issues) else 0.85)
    risk_level = "high" if any(i["level"] == "error" for i in issues) else ("medium" if issues else "low")
    result = {
        "issues": issues,
        "completeness": completeness,
        "confidence": confidence,
        "risk_level": risk_level,
        "optimizations": [],
    }
    hitl = risk_level == "high" or confidence < 0.75
    return result, hitl, confidence, f"Validation: {completeness}% complete, risk={risk_level}"


_STEP_HANDLERS = {
    "intent":    _step_intent,
    "classify":  _step_classify,
    "plan":      _step_plan,
    "knowledge": _step_knowledge,
    "skills":    _step_skills,
    "model":     _step_model,
    "subagents": _step_subagents,
    "architect": _step_architect,
    "validate":  _step_validate,
}


# ============================================================
# VIBE BUILDER — natural-language → complete artifact generation
# ============================================================

VALID_NODE_TYPES = {
    "data_source", "dataSource", "llm", "code", "condition", "hitl",
    "skill", "output", "agent", "context_graph", "memory", "reflect",
    "planner", "file_op", "chart", "document", "tool_call", "input",
}

HITL_KEYWORDS = {"review", "approve", "approval", "confirm", "validate",
                 "human", "qc", "quality check", "sign-off", "signoff",
                 "manual check", "human review"}


class VibeBuildRequest(BaseModel):
    org_id: str
    description: str
    target_type: str = "agent"   # "agent" | "skill"
    context: dict = {}


class VibeRefineRequest(BaseModel):
    org_id: str
    previous_artifacts: dict
    refinement: str
    section: Optional[str] = None   # e.g. "retrieval_recipe"


class VibeSaveRequest(BaseModel):
    org_id: str
    created_by: str
    target_type: str   # "agent" | "skill"
    artifacts: dict


def _vibe_llm_call(prompt: str, max_tokens: int = 4000) -> str:
    response = _openai_mp.OpenAI(
        base_url=f"{settings.ollama_base_url}/v1",
        api_key="ollama",
    ).chat.completions.create(
        model=settings.ollama_model,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=max_tokens,
        response_format={"type": "json_object"},
    )
    return (response.choices[0].message.content or "").strip()


def _repair_flow_edges(artifacts: dict) -> dict:
    """
    Post-process flow_definition after LLM generation:
    1. Strip edges referencing unknown node IDs.
    2. Wire any node missing an outgoing edge to the next node in declaration order.
    3. If the LLM produced ≤3 generic nodes, expand to a sensible skeleton using
       node types inferred from the agent description/prompt_contract.
    """
    flow = artifacts.get("flow_definition")
    if not flow or not isinstance(flow, dict):
        return artifacts

    nodes = flow.get("nodes") or []
    edges = flow.get("edges") or []

    # ── Expand skeleton if LLM under-generated ──────────────────────────────
    GENERIC_LABELS = {"llm node", "data source node", "hitl node", "output node",
                      "code node", "condition node", "skill node"}
    is_generic = all((n.get("label") or "").lower() in GENERIC_LABELS for n in nodes)

    if len(nodes) <= 3 or is_generic:
        # Build a minimal but complete skeleton from the system_prompt / description
        system_prompt = ((artifacts.get("prompt_contract") or {}).get("system_prompt") or "").lower()
        data_sources  = (artifacts.get("retrieval_recipe") or {}).get("data_sources", [])

        skeleton: list[dict] = []
        # Ingest node
        skeleton.append({"id": "n1", "type": "data_source", "label": "Ingest Input Data",
                          "config": {"sources": data_sources or ["sdtm"]}})
        # Context graph if IG / references mentioned
        if any(k in system_prompt for k in ("context", "implementation guide", "reference", "feedback")):
            skeleton.append({"id": "n2", "type": "context_graph", "label": "Load Context & References", "config": {}})
        # Skill if skill usage mentioned
        if any(k in system_prompt for k in ("skill", "adam mapping", "sdtm mapping")):
            skeleton.append({"id": "n3", "type": "skill", "label": "Apply Mapping Skill", "config": {}})
        # LLM analysis
        skeleton.append({"id": "n4", "type": "llm", "label": "Analyse & Derive", "config": {}})
        # Validation
        if any(k in system_prompt for k in ("valid", "conformance", "cdisc", "check")):
            skeleton.append({"id": "n5", "type": "code", "label": "Validate Conformance", "config": {}})
        # HITL if review / approve mentioned
        if any(k in system_prompt for k in ("review", "approve", "human", "hitl")):
            skeleton.append({"id": "n6", "type": "hitl", "label": "Human Review & Approval", "config": {}})
            skeleton.append({"id": "n7", "type": "condition", "label": "Approved?", "config": {}})
        # Export if file output mentioned
        if any(k in system_prompt for k in ("export", "xls", "csv", "file", "download")):
            skeleton.append({"id": "n8", "type": "file_op", "label": "Export Results", "config": {}})
        # Output
        skeleton.append({"id": "n9", "type": "output", "label": "Deliver Output", "config": {}})

        nodes = skeleton
        edges = []  # will be wired below
        log.info("vibe_build.flow_expanded", node_count=len(nodes))

    # ── Repair edges ─────────────────────────────────────────────────────────
    node_ids = [n["id"] for n in nodes if n.get("id")]
    id_set   = set(node_ids)

    # Drop stale edges
    edges = [e for e in edges if e.get("source") in id_set and e.get("target") in id_set]

    # Wire missing outgoing edges sequentially
    has_outgoing = {e["source"] for e in edges}
    repaired = 0
    for i, nid in enumerate(node_ids[:-1]):
        if nid not in has_outgoing:
            edges.append({"source": nid, "target": node_ids[i + 1]})
            has_outgoing.add(nid)
            repaired += 1

    if repaired:
        log.info("vibe_build.edges_repaired", count=repaired)

    artifacts["flow_definition"] = {**flow, "nodes": nodes, "edges": edges}
    return artifacts



# Node type normalization map: unknown -> nearest valid type
NODE_TYPE_FIXES: dict[str, str] = {
    # agent-like compound nodes → llm
    "ingestion_agent": "llm",
    "rule_engine_agent": "llm",
    "processing_agent": "llm",
    "ml_agent": "llm",
    "nlp_agent": "llm",
    "ai_agent": "llm",
    "decision_agent": "llm",
    "reasoning_agent": "llm",
    "analysis_agent": "llm",
    "transformation_agent": "llm",
    "mapper_agent": "llm",
    # data-like nodes
    "database": "data_source",
    "db": "data_source",
    "source": "data_source",
    "data": "data_source",
    "query": "data_source",
    "fetch": "data_source",
    "retrieval": "data_source",
    "file": "data_source",
    "api": "data_source",
    # code-like nodes
    "script": "code",
    "function": "code",
    "transform": "code",
    "compute": "code",
    "rule": "code",
    "rule_engine": "code",
    "validator": "code",
    "validation": "code",
    "parser": "code",
    "processor": "code",
    "formatter": "code",
    "calculator": "code",
    # hitl-like nodes
    "review": "hitl",
    "approval": "hitl",
    "human_review": "hitl",
    "human_approval": "hitl",
    "manual_review": "hitl",
    # output-like nodes
    "report": "output",
    "result": "output",
    "response": "output",
    "export": "output",
    # tool-call-like nodes
    "tool": "tool_call",
    "api_call": "tool_call",
    "external": "tool_call",
    # condition-like
    "decision": "condition",
    "branch": "condition",
    "router": "condition",
    "switch": "condition",
    "filter": "condition",
}

# Tool normalization: unknown tool name → nearest registered tool
TOOL_NAME_FIXES: dict[str, str] = {
    # Common hallucinations → real tools
    "tool_call agent": "read_sdtm_domain",
    "tool_call_agent": "read_sdtm_domain",
    "tool_call": "read_sdtm_domain",
    "read_data": "read_sdtm_domain",
    "read_sdtm": "read_sdtm_domain",
    "read_sdtm_data": "read_sdtm_domain",
    "read_edc": "read_raw_edc_data",
    "read_edc_data": "read_raw_edc_data",
    "read_adam": "read_adam_dataset",
    "read_adam_data": "read_adam_dataset",
    "search_docs": "search_documents",
    "search_document": "search_documents",
    "search_ig": "search_implementation_guides",
    "read_ig": "search_implementation_guides",
    "validate_sdtm": "validate_sdtm_mapping",
    "run_mapping": "run_sdtm_mapping",
    "create_report": "generate_pdf_report",
    "generate_report": "generate_pdf_report",
    "send_alert": "send_notification",
    "notify": "send_notification",
    "raise_query": "raise_data_query",
    "close_query": "close_data_query",
    "check_cdisc": "check_cdisc_conformance",
    "cdisc_check": "check_cdisc_conformance",
    "read_protocol": "read_protocol_section",
    "read_crf": "read_crf_specification",
    "query_budget": "query_budget_data",
    "create_doc": "create_document",
    "generate_chart_tool": "generate_chart",
    "create_chart": "generate_chart",
}


def _auto_fix_artifacts(artifacts: dict) -> tuple[dict, list[dict]]:
    """
    Auto-fix known issues in vibe artifacts. Returns (fixed_artifacts, fixes_applied).
    fixes_applied is a list of {issue, fix, location}.
    """
    import copy
    artifacts = copy.deepcopy(artifacts)
    fixes: list[dict] = []

    flow = artifacts.get("flow_definition") or {}
    nodes = flow.get("nodes", [])

    # Fix 1: Normalize unknown node types
    for node in nodes:
        nt = node.get("type", "")
        if nt and nt not in VALID_NODE_TYPES:
            replacement = NODE_TYPE_FIXES.get(nt)
            if not replacement:
                # fuzzy: find closest match by keyword
                nt_lower = nt.lower()
                for kw, repl in NODE_TYPE_FIXES.items():
                    if kw in nt_lower or nt_lower in kw:
                        replacement = repl
                        break
                if not replacement:
                    replacement = "llm"  # safest default
            fixes.append({
                "issue": f"Unknown node type '{nt}'",
                "fix": f"Changed to '{replacement}'",
                "location": f"node '{node.get('id', node.get('label', nt))}'",
                "auto_fixed": True,
            })
            node["type"] = replacement
            # If we turned something into an LLM node, ensure it has a label
            if replacement == "llm" and not node.get("config", {}).get("prompt"):
                node.setdefault("config", {})["prompt"] = (
                    f"You are a {nt.replace('_', ' ')} component. "
                    f"Process the input data and produce structured output."
                )

    # Fix 2: Normalize unknown tools
    recipe = artifacts.get("retrieval_recipe") or {}
    declared = recipe.get("declared_tools", [])
    fixed_tools = []
    for t in declared:
        if t in TOOL_REGISTRY_SCOPES:
            fixed_tools.append(t)
        else:
            replacement = TOOL_NAME_FIXES.get(t) or TOOL_NAME_FIXES.get(t.strip())
            if not replacement:
                # try substring match
                t_lower = t.lower().replace(" ", "_")
                for known in TOOL_REGISTRY_SCOPES:
                    if known in t_lower or t_lower in known:
                        replacement = known
                        break
                if not replacement:
                    replacement = "read_sdtm_domain"  # safest default
            fixes.append({
                "issue": f"Unknown tool '{t}'",
                "fix": f"Replaced with '{replacement}'",
                "location": "retrieval_recipe.declared_tools",
                "auto_fixed": True,
            })
            fixed_tools.append(replacement)
    recipe["declared_tools"] = list(dict.fromkeys(fixed_tools))  # dedup preserving order
    artifacts["retrieval_recipe"] = recipe

    artifacts["flow_definition"] = flow
    return artifacts, fixes


def _validate_vibe_artifacts(artifacts: dict, target_type: str) -> list[str]:
    """Validate generated artifacts and collect warnings (strings for backward compat)."""
    return [w["message"] for w in _validate_vibe_artifacts_structured(artifacts, target_type)]


def _validate_vibe_artifacts_structured(artifacts: dict, target_type: str) -> list[dict]:
    """Validate artifacts and return structured warnings with recommended fixes."""
    warnings = []
    if target_type == "agent":
        flow = artifacts.get("flow_definition") or {}
        nodes = flow.get("nodes", [])
        edges = flow.get("edges", [])
        skills = artifacts.get("skills") or []
        skill_names = {s.get("name", "").strip() for s in skills}

        for node in nodes:
            nt = node.get("type", "")
            node_label = node.get("label") or node.get("id") or nt
            if nt and nt not in VALID_NODE_TYPES:
                fix = NODE_TYPE_FIXES.get(nt)
                if not fix:
                    fix_suggestion = next(
                        (repl for kw, repl in NODE_TYPE_FIXES.items() if kw in nt.lower()),
                        "llm"
                    )
                else:
                    fix_suggestion = fix
                warnings.append({
                    "message": f"Unknown node type '{nt}' — may not execute correctly",
                    "recommended_fix": f"Change node type to '{fix_suggestion}' (best match for '{nt}')",
                    "auto_fixable": True,
                    "location": f"node '{node_label}'",
                    "severity": "error",
                })
            if nt == "skill":
                cfg = node.get("config") or {}
                skill_ref = cfg.get("skill_ref", "")
                skill_id = cfg.get("skill_id", "")
                if not skill_ref and not skill_id:
                    warnings.append({
                        "message": f"Skill node '{node.get('id')}' has no skill_ref or skill_id",
                        "recommended_fix": "Add a skill definition to the 'skills' array and reference it via skill_ref",
                        "auto_fixable": False,
                        "location": f"node '{node_label}'",
                        "severity": "error",
                    })
                elif skill_ref and skill_ref not in skill_names:
                    warnings.append({
                        "message": f"Skill node references '{skill_ref}' but no matching skill found",
                        "recommended_fix": f"Add a skill named '{skill_ref}' to the 'skills' array",
                        "auto_fixable": False,
                        "location": f"node '{node_label}'",
                        "severity": "warning",
                    })

        declared = (artifacts.get("retrieval_recipe") or {}).get("declared_tools", [])
        for t in declared:
            if t not in TOOL_REGISTRY_SCOPES:
                fix = TOOL_NAME_FIXES.get(t) or next(
                    (k for k in TOOL_REGISTRY_SCOPES if k in t.lower() or t.lower().replace(" ", "_") in k),
                    "read_sdtm_domain"
                )
                warnings.append({
                    "message": f"Unknown tool '{t}' — not in TOOL_REGISTRY_SCOPES",
                    "recommended_fix": f"Replace '{t}' with '{fix}' (registered tool with similar purpose)",
                    "auto_fixable": True,
                    "location": "retrieval_recipe.declared_tools",
                    "severity": "warning",
                })

        node_ids = {n.get("id") for n in nodes}
        for e in edges:
            if e.get("source") not in node_ids:
                warnings.append({
                    "message": f"Edge source '{e.get('source')}' references unknown node",
                    "recommended_fix": "Remove this edge or correct the source node ID",
                    "auto_fixable": False,
                    "location": "flow_definition.edges",
                    "severity": "error",
                })
            if e.get("target") not in node_ids:
                warnings.append({
                    "message": f"Edge target '{e.get('target')}' references unknown node",
                    "recommended_fix": "Remove this edge or correct the target node ID",
                    "auto_fixable": False,
                    "location": "flow_definition.edges",
                    "severity": "error",
                })

        for skill in skills:
            body = skill.get("body", "")
            sname = skill.get("name", "unnamed")
            if not body or body == "result = {}":
                warnings.append({
                    "message": f"Skill '{sname}' has empty/placeholder body",
                    "recommended_fix": "Regenerate the skill or manually add implementation code",
                    "auto_fixable": False,
                    "location": f"skills['{sname}']",
                    "severity": "warning",
                })
            for marker in ("# TODO", "# FIXME", "raise NotImplementedError"):
                if marker in body:
                    warnings.append({
                        "message": f"Skill '{sname}' has incomplete code marker: '{marker.strip()}'",
                        "recommended_fix": "Complete the skill implementation before saving",
                        "auto_fixable": False,
                        "location": f"skills['{sname}']",
                        "severity": "warning",
                    })

    elif target_type == "skill":
        body = artifacts.get("body", "")
        for marker in ("# TODO", "# FIXME", "raise NotImplementedError", "pass  #", "..."):
            if marker in body:
                warnings.append({
                    "message": f"Incomplete code marker found: '{marker.strip()}'",
                    "recommended_fix": "Complete the implementation before saving",
                    "auto_fixable": False,
                    "location": "skill.body",
                    "severity": "warning",
                })

    return warnings


class VibeAutoFixRequest(BaseModel):
    org_id: str
    artifacts: dict
    target_type: str = "agent"


@app.post("/agents/vibe-autofix")
async def vibe_autofix(req: VibeAutoFixRequest):
    """
    Auto-fix all auto-fixable issues in vibe artifacts (unknown node types, unknown tools).
    Returns the repaired artifacts, list of fixes applied, and updated warnings/confidence.
    """
    fixed, fixes_applied = _auto_fix_artifacts(req.artifacts)
    warnings_structured = _validate_vibe_artifacts_structured(fixed, req.target_type)
    warnings_msgs = [w["message"] for w in warnings_structured]
    confidence = _compute_confidence(fixed, warnings_msgs, req.target_type)
    log.info("vibe_autofix.done", org_id=req.org_id, fixes=len(fixes_applied),
             remaining_warnings=len(warnings_msgs))
    return {
        "artifacts": fixed,
        "fixes_applied": fixes_applied,
        "warnings": warnings_msgs,
        "warnings_structured": warnings_structured,
        "confidence": confidence,
    }



def _build_agent_prompt(description: str, context: dict) -> str:
    tools_list = "\n".join(f"  - {t}: {s}" for t, s in TOOL_REGISTRY_SCOPES.items())
    node_types = ", ".join(sorted(VALID_NODE_TYPES))
    has_hitl = any(kw in description.lower() for kw in HITL_KEYWORDS)
    agent_mode = context.get("agent_mode", "standard")
    hitl_instruction = ""
    if has_hitl or agent_mode == "deep":
        hitl_instruction = """
IMPORTANT — HITL Node Configuration:
The flow MUST include a 'hitl' node. Every HITL node config must be fully specified:
{
  "type": "hitl",
  "label": "Human Review Step",
  "config": {
    "title": "Descriptive title shown to the reviewer",
    "description": "Instructions for the reviewer — what to check/approve/correct",
    "assigned_role": "data_manager|biostatistician|medical_writer|cra|sponsor|site_coordinator",
    "field_mappings": {"formFieldName": "upstreamNodeId.outputKey"},
    "fields": [
      {
        "name": "field_name",
        "label": "Human-readable label",
        "type": "text|textarea|number|boolean|select|table",
        "editable": true,
        "required": false,
        "description": "What this field means / what the reviewer should verify"
      }
    ]
  }
}
field_mappings links form fields to upstream node outputs (reviewer sees pre-filled data from previous steps).
fields defines exactly what the reviewer sees and can edit in the task form.
assigned_role determines which user role receives the task notification.
Generate realistic, domain-specific fields that match the agent's clinical purpose."""

    skills_instruction = ""
    if agent_mode == "deep":
        skills_instruction = """
IMPORTANT — Skills, Memory & Knowledge Graph for Deep Agents:

Deep agents MUST identify and generate embedded skills, memory nodes, and knowledge graph nodes.

1. SKILLS: For any specialist logic, data transformation, validation or computation that can be reused,
   add a "skill" node to the flow AND define the skill in the top-level "skills" array.
   In the flow node config, use "skill_ref" (a human-readable name) to reference the skill by name:
   {
     "id": "n3", "type": "skill", "label": "Validate Mapping",
     "config": { "skill_ref": "SDTM Mapping Validator", "params": {} }
   }
   The skill definition in "skills" array must have matching "name":
   {
     "name": "SDTM Mapping Validator",
     "description": "Validates SDTM variable mappings against CDISC rules",
     "skill_type": "function",
     "execution_type": "transformation",
     "tags": ["sdtm", "validation", "cdisc"],
     "input_schema": {
       "type": "object",
       "properties": { "mappings": { "type": "array" } },
       "required": ["mappings"]
     },
     "body": "# Complete Python code\\n# state_data is available\\nmappings = params.get('mappings', state_data.get('mappings', []))\\nerrors = []\\nfor m in mappings:\\n    if not m.get('target_var'):\\n        errors.append(f'Missing target for {m.get(\"source_var\")}')\\nresult = {'valid': len(errors) == 0, 'errors': errors, 'count': len(mappings)}"
   }

   skill_type must be: "function" (Python code) or "prompt" (LLM template).
   For "function" skills: body must be complete Python — access inputs via state_data dict and params dict,
     assign output to `result = {...}`.
   For "prompt" skills: body is the full LLM system prompt template with {{variable}} placeholders.

2. MEMORY: For agents that need to persist or recall state across steps (e.g., store intermediate results,
   recall user preferences, accumulate findings), add "memory" nodes with this config:
   {
     "id": "n5", "type": "memory", "label": "Store Analysis Results",
     "config": { "operation": "write", "memory_key": "analysis_results", "value_path": "n3.result", "scoped_to_study": true }
   }
   Use operation "write" to save and "read" to recall.

3. KNOWLEDGE GRAPH: For agents that need contextual document retrieval (protocols, IGs, SAPs),
   add a "context_graph" node:
   {
     "id": "n2", "type": "context_graph", "label": "Protocol Context",
     "config": { "graph_id": "", "query_template": "{messages[-1]}", "top_k": 8 }
   }
   graph_id can be empty string (resolved at runtime from org context).

4. REFLECT: For quality self-checking after LLM steps, add "reflect" nodes:
   {
     "id": "n6", "type": "reflect", "label": "Quality Check",
     "config": { "rubric": "Is the output accurate, complete and clinically valid?", "score_threshold": 0.75 }
   }

Generate at least 1 skill node + 1 memory node for deep agents. More if clinically appropriate."""

    return f"""You are an expert clinical trial AI agent architect. Generate a complete, production-ready agent specification for TrialOS.

User request: {description}

Context: {json.dumps(context)}

Valid node types: {node_types}

Available tools and their permission scopes:
{tools_list}
{hitl_instruction}
{skills_instruction}

Return ONLY a valid JSON object with this exact structure:
{{
  "agent_spec": {{
    "name": "descriptive agent name",
    "slug": "kebab-case-slug",
    "category": "data_management|safety|site_monitoring|analytics|regulatory|medical_writing|operations",
    "description": "2-3 sentence description",
    "agent_type": "langchain-flow",
    "agent_mode": "standard|deep",
    "version": "1.0.0"
  }},
  "allowed_purposes": ["conversational|chart_generation|sdtm_mapping|budget_analysis|protocol_writing|custom"],
  "retrieval_recipe": {{
    "data_sources": ["sdtm|adam|raw_edc|ctms|budget|documents|ig|crf|sap"],
    "declared_tools": ["tool names from the list above"],
    "required_permissions": ["permission scopes"]
  }},
  "output_schema": {{
    "format": "narrative|table|json|pdf",
    "fields": [{{"name": "field_name", "type": "string|number|boolean|array|object", "description": "field purpose"}}]
  }},
  "prompt_contract": {{
    "system_prompt": "Full system prompt text for this agent",
    "expertise_scaffold": {{
      "role": "agent role description",
      "domain": "clinical domain",
      "constraints": ["constraint 1", "constraint 2"],
      "reasoning_style": "systematic|creative|analytical",
      "output_format": "format description"
    }},
    "input_variables": ["variable names used in prompts"]
  }},
  "flow_definition": {{
    "nodes": [
      {{"id": "n1", "type": "data_source", "label": "Node Label", "config": {{}}}}
    ],
    "edges": [
      {{"source": "n1", "target": "n2"}}
    ]
  }},
  "skills": [],
  "test_cases": [
    {{
      "name": "test scenario name",
      "description": "what this test verifies",
      "input": {{"key": "value"}},
      "expected_output": "description of expected result",
      "success_criteria": "how to determine success"
    }}
  ]
}}

Generate exactly 3-5 test cases. Include HITL node in flow_definition if the description mentions human review, approval, or sign-off.
For deep agents, populate the "skills" array with at least one fully-defined skill."""


def _build_skill_prompt(description: str, context: dict) -> str:
    return f"""You are an expert clinical trial software engineer. Generate a complete, production-ready skill for TrialOS.

User request: {description}

Context: {json.dumps(context)}

Return ONLY a valid JSON object with this exact structure:
{{
  "skill_spec": {{
    "name": "descriptive skill name",
    "description": "2-3 sentence description",
    "skill_type": "function|prompt",
    "tags": ["tag1", "tag2"]
  }},
  "input_output_contract": {{
    "input_schema": {{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {{}},
      "required": []
    }},
    "output_schema": {{
      "type": "object",
      "properties": {{}},
      "description": "what the skill returns"
    }}
  }},
  "execution_type": "reasoning|query|transformation|tool_call",
  "safety_constraints": ["constraint 1", "constraint 2"],
  "body": "complete Python function code or prompt template — no placeholders",
  "test_cases": [
    {{
      "name": "test scenario name",
      "input": {{"key": "value"}},
      "expected_output": "description of expected result",
      "success_criteria": "how to determine success"
    }}
  ]
}}

For function skills, write complete Python code with a result = {{...}} assignment.
For prompt skills, write the full prompt template with {{{{variable}}}} placeholders.
Generate exactly 3-5 test cases."""


def _build_refine_prompt(previous: dict, refinement: str, section: Optional[str], target_type: str) -> str:
    section_hint = f"Focus on updating only the '{section}' section." if section else "Update all relevant sections."
    return f"""You are refining an existing {target_type} artifact set based on a user refinement request.

Current artifacts:
{json.dumps(previous, indent=2)}

Refinement request: {refinement}

{section_hint}

Return ONLY a valid JSON object with the same structure as the input, but with the requested changes applied.
Only modify sections that are directly affected by the refinement. Keep unchanged sections identical."""


def _compute_confidence(artifacts: dict, warnings: list[str], target_type: str) -> float:
    """
    Compute a confidence score (0.0–1.0) based on artifact completeness and warning severity.

    Scoring breakdown (agent):
      - Base: 1.0
      - Deductions for missing required sections
      - Deductions weighted by warning severity (error > warning)
      - Bonus for richer artifacts

    Post-auto-fix, warnings that were auto-fixable are resolved, so the remaining
    warnings are genuinely unresolvable — they get a smaller penalty.
    """
    score = 1.0

    if target_type == "agent":
        flow = artifacts.get("flow_definition") or {}
        nodes = flow.get("nodes", [])
        edges = flow.get("edges", [])

        # ── Required sections ──────────────────────────────────
        if len(nodes) < 2:
            score -= 0.20   # flow is nearly empty
        elif len(nodes) < 4:
            score -= 0.05   # small but may be fine

        if not edges:
            score -= 0.05   # no connections (may be repaired)

        if not (artifacts.get("prompt_contract") or {}).get("system_prompt"):
            score -= 0.10   # missing system prompt is significant

        if not artifacts.get("test_cases"):
            score -= 0.07

        if not artifacts.get("retrieval_recipe"):
            score -= 0.05

        if not artifacts.get("output_schema"):
            score -= 0.03

        # ── Bonus for rich artifacts ───────────────────────────
        if len(nodes) >= 5:
            score += 0.02
        if artifacts.get("agent_spec", {}).get("description"):
            score += 0.01
        if artifacts.get("skills"):
            score += 0.01

        # ── Penalize by remaining warning severity ─────────────
        # At this point warnings should already reflect post-fix state
        for w in warnings:
            w_lower = w.lower()
            # Only penalise if it's a genuine error (unknown type still present, broken edge)
            if "unknown node type" in w_lower or "references unknown node" in w_lower:
                score -= 0.08
            elif "no skill_ref" in w_lower or "no matching skill" in w_lower:
                score -= 0.05
            elif "unknown tool" in w_lower:
                score -= 0.03
            elif "empty" in w_lower or "placeholder" in w_lower or "incomplete" in w_lower:
                score -= 0.04
            else:
                score -= 0.02  # generic minor warning

    elif target_type == "skill":
        body = artifacts.get("body", "")
        lines = [l for l in body.splitlines() if l.strip()]
        if len(lines) < 5:
            score -= 0.20
        elif len(lines) < 10:
            score -= 0.08

        if not artifacts.get("test_cases"):
            score -= 0.07
        if not (artifacts.get("input_output_contract") or {}).get("input_schema"):
            score -= 0.05
        if not (artifacts.get("input_output_contract") or {}).get("output_schema"):
            score -= 0.03

        for w in warnings:
            score -= 0.04

    return round(max(0.40, min(1.0, score)), 2)


@app.post("/agents/vibe-build")
async def vibe_build(req: VibeBuildRequest):
    """
    Single-shot LLM generation of all agent or skill artifacts from natural language.
    Returns complete artifact set with confidence score and warnings.
    """
    if req.target_type not in ("agent", "skill"):
        raise HTTPException(400, "target_type must be 'agent' or 'skill'")

    if req.target_type == "agent":
        prompt = _build_agent_prompt(req.description, req.context)
    else:
        prompt = _build_skill_prompt(req.description, req.context)

    try:
        raw = _vibe_llm_call(prompt, max_tokens=4000)
        artifacts = _safe_parse(raw)
    except Exception as exc:
        log.error("vibe_build.llm_failed", error=str(exc))
        raise HTTPException(500, f"LLM generation failed: {str(exc)}")

    if not artifacts:
        raise HTTPException(500, "LLM returned no parseable JSON")

    # Sanitize to prevent circular references
    try:
        artifacts = json.loads(json.dumps(artifacts))
    except Exception:
        raise HTTPException(500, "Generated artifacts contain invalid JSON")

    # Auto-repair missing flow edges (LLMs often drop connections)
    if req.target_type == "agent":
        artifacts = _repair_flow_edges(artifacts)
        # Auto-fix unknown node types and tools immediately after generation
        artifacts, auto_fixes = _auto_fix_artifacts(artifacts)
    else:
        auto_fixes = []

    warnings_structured = _validate_vibe_artifacts_structured(artifacts, req.target_type)
    warnings = [w["message"] for w in warnings_structured]
    confidence = _compute_confidence(artifacts, warnings, req.target_type)

    log.info("vibe_build.completed", target_type=req.target_type, org_id=req.org_id,
             confidence=confidence, warnings=len(warnings), auto_fixes=len(auto_fixes))

    return {
        "target_type": req.target_type,
        "artifacts": artifacts,
        "warnings": warnings,
        "warnings_structured": warnings_structured,
        "auto_fixes_applied": auto_fixes,
        "confidence": confidence,
    }


@app.post("/agents/vibe-refine")
async def vibe_refine(req: VibeRefineRequest):
    """
    Iterative refinement of existing vibe artifacts based on a natural language instruction.
    Returns updated artifacts for changed sections only.
    """
    target_type = req.previous_artifacts.get("target_type", "agent")
    prompt = _build_refine_prompt(
        req.previous_artifacts.get("artifacts", req.previous_artifacts),
        req.refinement,
        req.section,
        target_type,
    )

    try:
        raw = _vibe_llm_call(prompt, max_tokens=4000)
        updated = _safe_parse(raw)
    except Exception as exc:
        log.error("vibe_refine.llm_failed", error=str(exc))
        raise HTTPException(500, f"LLM refinement failed: {str(exc)}")

    if not updated:
        raise HTTPException(500, "LLM returned no parseable JSON")

    try:
        updated = json.loads(json.dumps(updated))
    except Exception:
        raise HTTPException(500, "Refined artifacts contain invalid JSON")

    if target_type == "agent":
        updated = _repair_flow_edges(updated)
        updated, auto_fixes = _auto_fix_artifacts(updated)
    else:
        auto_fixes = []

    warnings_structured = _validate_vibe_artifacts_structured(updated, target_type)
    warnings = [w["message"] for w in warnings_structured]
    confidence = _compute_confidence(updated, warnings, target_type)

    log.info("vibe_refine.completed", target_type=target_type, org_id=req.org_id,
             section=req.section, confidence=confidence)

    return {
        "target_type": target_type,
        "artifacts": updated,
        "warnings": warnings,
        "warnings_structured": warnings_structured,
        "auto_fixes_applied": auto_fixes,
        "confidence": confidence,
    }


@app.post("/agents/vibe-save")
async def vibe_save(req: VibeSaveRequest):
    """
    Save vibe-generated artifacts to the database.
    Delegates to create-flow for agents and POST /skills for skills.
    """
    artifacts = req.artifacts
    target_type = req.target_type

    if target_type == "agent":
        spec = artifacts.get("agent_spec") or {}
        recipe = artifacts.get("retrieval_recipe") or {}
        flow_def = artifacts.get("flow_definition") or {"nodes": [], "edges": []}
        purposes = artifacts.get("allowed_purposes") or ["custom"]
        test_cases = artifacts.get("test_cases") or []
        embedded_skills = artifacts.get("skills") or []

        name = spec.get("name") or "Vibe Agent"
        category = spec.get("category") or "data_management"
        description = spec.get("description") or ""
        agent_mode = spec.get("agent_mode") or "standard"
        data_sources = recipe.get("data_sources") or []
        agent_purpose = purposes[0] if purposes else "custom"

        agent_id = str(uuid.uuid4())
        slug = f"{req.org_id[:8]}-{name.lower().replace(' ', '-')[:30]}-{agent_id[:8]}"

        tools: set[str] = set()
        for node in flow_def.get("nodes", []):
            if node.get("config", {}).get("tool"):
                tools.add(node["config"]["tool"])
            for src in node.get("config", {}).get("sources", []):
                src_tool_map = {
                    "sdtm": "read_sdtm_domain", "adam": "read_adam_dataset",
                    "raw_edc": "read_raw_edc_data", "ctms": "read_ctms_data",
                    "budget": "query_budget_data", "documents": "search_documents",
                    "sap": "search_documents", "ig": "search_implementation_guides",
                    "crf": "read_crf_specification",
                }
                if src in src_tool_map:
                    tools.add(src_tool_map[src])
        for t in recipe.get("declared_tools", []):
            tools.add(t)
        declared_tools = list(tools)
        required_permissions = list({TOOL_REGISTRY_SCOPES.get(t, "study:data:read") for t in declared_tools})

        async with db_pool.acquire() as conn:
            # ── 1. Save embedded skills and build name→id map ───────────────────
            skill_name_to_id: dict[str, str] = {}
            saved_skills: list[dict] = []
            for skill_def in embedded_skills:
                sname = (skill_def.get("name") or "").strip()
                if not sname:
                    continue
                execution_type = skill_def.get("execution_type") or "transformation"
                if execution_type not in ("reasoning", "query", "transformation", "tool_call"):
                    execution_type = "transformation"
                skill_type = skill_def.get("skill_type") or "function"
                if skill_type not in ("function", "prompt"):
                    skill_type = "function"
                body = skill_def.get("body") or "result = {}"
                input_schema = skill_def.get("input_schema") or {}
                output_schema = skill_def.get("output_schema") or {}
                tags = skill_def.get("tags") or []
                skill_description = skill_def.get("description") or ""
                safety_constraints = skill_def.get("safety_constraints") or []
                skill_test_cases = skill_def.get("test_cases") or []

                sid = str(uuid.uuid4())
                # Partial unique indexes can't be used with ON CONFLICT ON CONSTRAINT.
                # Use manual upsert: check existence, then insert or update.
                existing = await conn.fetchrow(
                    "SELECT id FROM agent_skills WHERE org_id=$1 AND name=$2",
                    req.org_id, sname,
                )
                if existing:
                    await conn.execute("""
                        UPDATE agent_skills SET
                            description=$3, skill_type=$4, body=$5,
                            input_schema=$6::jsonb, tags=$7,
                            test_cases=$8::jsonb, output_schema=$9::jsonb,
                            safety_constraints=$10, execution_type=$11,
                            updated_at=NOW()
                        WHERE org_id=$1 AND name=$2
                    """,
                        req.org_id, sname, skill_description, skill_type, body,
                        json.dumps(input_schema), tags,
                        json.dumps(skill_test_cases), json.dumps(output_schema),
                        safety_constraints, execution_type,
                    )
                    actual_id = str(existing["id"])
                else:
                    await conn.execute("""
                        INSERT INTO agent_skills
                            (id, org_id, name, description, skill_type, body, input_schema,
                             tags, created_by, test_cases, output_schema, safety_constraints, execution_type)
                        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11::jsonb,$12,$13)
                    """,
                        sid, req.org_id, sname, skill_description, skill_type, body,
                        json.dumps(input_schema), tags, req.created_by,
                        json.dumps(skill_test_cases), json.dumps(output_schema),
                        safety_constraints, execution_type,
                    )
                    actual_id = sid
                skill_name_to_id[sname] = actual_id
                saved_skills.append({"skill_id": actual_id, "name": sname, "skill_type": skill_type})
                log.info("vibe_save.skill_created", skill_id=actual_id, name=sname, org_id=req.org_id)

            # ── 2. Link skill_ref in flow nodes → skill_id ──────────────────────
            for node in flow_def.get("nodes", []):
                if node.get("type") == "skill":
                    cfg = node.get("config") or {}
                    skill_ref = cfg.get("skill_ref", "")
                    if skill_ref and skill_ref in skill_name_to_id:
                        cfg["skill_id"] = skill_name_to_id[skill_ref]
                        cfg["skill_type"] = next(
                            (s["skill_type"] for s in saved_skills if s["name"] == skill_ref),
                            "function",
                        )
                        cfg.pop("skill_ref", None)
                        node["config"] = cfg

            # ── 3. Save agent definition ────────────────────────────────────────
            agent_config = {
                "org_id": req.org_id,
                "created_by": req.created_by,
                "output_format": (artifacts.get("output_schema") or {}).get("format", "narrative"),
                "flow_definition": flow_def,
                "data_scope": {"data_sources": data_sources},
                "prompt_contract": artifacts.get("prompt_contract") or {},
                "expertise_scaffold": (artifacts.get("prompt_contract") or {}).get("expertise_scaffold") or {},
                "embedded_skills": saved_skills,
            }

            await conn.execute("""
                INSERT INTO agent_definitions (
                    id, name, slug, version, category, description, publisher_type,
                    publisher_org_id, agent_type, agent_config, declared_tools,
                    required_permissions, agent_purpose, data_sources,
                    flow_definition, test_cases, is_published, is_verified, agent_mode
                ) VALUES ($1,$2,$3,'1.0.0',$4,$5,'org-created',$6,'langchain-flow',$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,FALSE,FALSE,$14)
            """,
                agent_id, name, slug, category, description,
                req.org_id, json.dumps(agent_config), declared_tools,
                required_permissions, agent_purpose, data_sources,
                json.dumps(flow_def), json.dumps(test_cases), agent_mode,
            )

            install_id = str(uuid.uuid4())
            await conn.execute("""
                INSERT INTO agent_installations
                    (id, org_id, agent_id, installed_version, installed_by, consented_permissions, is_active)
                VALUES ($1,$2,$3,'1.0.0',$4,$5,TRUE)
            """, install_id, req.org_id, agent_id, req.created_by, required_permissions)

        log.info("vibe_save.agent_created", agent_id=agent_id, org_id=req.org_id, name=name,
                 skills_saved=len(saved_skills))
        return {
            "target_type": "agent", "agent_id": agent_id, "installation_id": install_id,
            "slug": slug, "status": "created", "skills_created": saved_skills,
        }

    elif target_type == "skill":
        spec = artifacts.get("skill_spec") or {}
        contract = artifacts.get("input_output_contract") or {}
        test_cases = artifacts.get("test_cases") or []
        execution_type = artifacts.get("execution_type") or "reasoning"
        safety_constraints = artifacts.get("safety_constraints") or []

        if execution_type not in ("reasoning", "query", "transformation", "tool_call"):
            execution_type = "reasoning"

        skill_id = str(uuid.uuid4())
        async with db_pool.acquire() as conn:
            await conn.execute("""
                INSERT INTO agent_skills
                    (id, org_id, name, description, skill_type, body, input_schema,
                     tags, created_by, test_cases, output_schema, safety_constraints, execution_type)
                VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11::jsonb,$12,$13)
            """,
                skill_id, req.org_id,
                spec.get("name") or "Vibe Skill",
                spec.get("description") or "",
                spec.get("skill_type") or "function",
                artifacts.get("body") or "",
                json.dumps(contract.get("input_schema") or {}),
                spec.get("tags") or [],
                req.created_by,
                json.dumps(test_cases),
                json.dumps(contract.get("output_schema") or {}),
                safety_constraints,
                execution_type,
            )

        log.info("vibe_save.skill_created", skill_id=skill_id, org_id=req.org_id)
        return {"target_type": "skill", "skill_id": skill_id, "status": "created"}

    else:
        raise HTTPException(400, "target_type must be 'agent' or 'skill'")


class VibeGenerateTestRequest(BaseModel):
    org_id: str
    artifacts: dict
    target_type: str = "agent"
    scenario: str = ""  # user-described test scenario (optional)


@app.post("/agents/vibe-generate-test-data")
async def vibe_generate_test_data(req: VibeGenerateTestRequest):
    """
    Generate realistic synthetic test data for a vibe-built agent or skill.
    The LLM reads the artifact spec and produces a JSON input payload + expected
    outcomes that can be fed directly into POST /runs.
    """
    artifacts = req.artifacts
    spec = artifacts.get("agent_spec") or artifacts.get("skill_spec") or {}
    flow_def = artifacts.get("flow_definition") or {}
    contract = artifacts.get("input_output_contract") or {}
    output_schema = artifacts.get("output_schema") or {}
    test_cases = artifacts.get("test_cases") or []

    scenario_hint = f"\nUser has specified this test scenario: {req.scenario}" if req.scenario.strip() else ""
    name = spec.get("name", "Agent")
    description_text = spec.get("description", "")

    prompt = f"""You are a clinical trial AI testing expert. Generate realistic synthetic test data for the following agent/skill.

Agent/Skill: {name}
Description: {description_text}
Target type: {req.target_type}
{scenario_hint}

Flow nodes: {json.dumps([{'id': n.get('id'), 'type': n.get('type'), 'label': n.get('label')} for n in flow_def.get('nodes', [])], indent=2) if flow_def else 'N/A'}
Output schema: {json.dumps(output_schema, indent=2)}
Existing test cases for reference: {json.dumps(test_cases[:2], indent=2) if test_cases else 'none'}

Generate 3 realistic test scenarios with synthetic clinical data. Return ONLY valid JSON:
{{
  "test_scenarios": [
    {{
      "name": "Scenario name",
      "description": "What this scenario tests",
      "input_context": {{
        "query": "The user query or task description",
        "data": {{
          "any_relevant_input_data": "realistic synthetic values — use real clinical terminology and plausible values"
        }},
        "study_id": "STUDY-001",
        "session_id": "test-session-001"
      }},
      "expected_behavior": "What the agent should do",
      "expected_output_keywords": ["keyword1", "keyword2"],
      "success_criteria": "How to determine success",
      "test_type": "happy_path|edge_case|error_case"
    }}
  ],
  "recommended_evaluators": ["llm_judge", "hallucination_detector", "task_completion"]
}}

Use realistic clinical data: USUBJID like STUDY-001-0001, real AE terms, CDISC variable names, plausible dates (2023-2025), actual drug names where relevant."""

    try:
        raw = _vibe_llm_call(prompt, max_tokens=3000)
        result = _safe_parse(raw)
        if not result:
            raise ValueError("No parseable JSON from LLM")
        result = json.loads(json.dumps(result))
    except Exception as exc:
        log.error("vibe_generate_test_data.failed", error=str(exc))
        raise HTTPException(500, f"Test data generation failed: {str(exc)}")

    log.info("vibe_generate_test_data.done", org_id=req.org_id, scenarios=len(result.get("test_scenarios", [])))
    return result


async def build_agent_step(req: StepRequest):
    """Step-by-step AI-powered agent builder endpoint."""
    handler = _STEP_HANDLERS.get(req.step)
    if not handler:
        raise HTTPException(400, f"Unknown step: {req.step}")
    try:
        result, hitl_required, confidence, message = await handler(req, db_pool, settings)
    except Exception as exc:
        log.error("build_step.error", step=req.step, error=str(exc))
        raise HTTPException(500, f"Step {req.step} failed: {str(exc)}")
    return StepResponse(
        step=req.step,
        result=result,
        hitl_required=hitl_required,
        confidence=confidence,
        message=message,
    )
