"""
TrialOS Standards Registry Service  (port 8012)
================================================
Layer 1 — Foundational Layer: CDISC CT dictionaries, SDTM/CDASH IGs,
regulatory requirements, temporal timelines, and provenance records.

All agents consume this service to:
  • Validate controlled terminology values against CDISC CT codelists
  • Look up regulatory requirements (FDA / EMA / ICH)
  • Query submission/CT publication deadlines
  • Record and traverse full data provenance

Design Principles
-----------------
• Terminology validation is on the hot path — Redis caching (TTL=86400s)
• Seeded with the 20 most-used CDISC CT codelists on startup
• Embeddings (768-dim, nomic-embed-text) enable semantic codelist search
• Kafka topic trialo.events.standards for CT version update notifications
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
import asyncio
import hashlib
import httpx
import csv
import io
import re
from datetime import datetime, timezone, date
from typing import Optional, Any

try:
    import redis.asyncio as aioredis
    _REDIS_AVAILABLE = True
except ImportError:
    _REDIS_AVAILABLE = False

log = structlog.get_logger()


# ─── Settings ────────────────────────────────────────────────────────────────

class Settings(BaseSettings):
    database_url: str
    redis_url: str              = "redis://localhost:6379"
    ollama_base_url: str        = "http://localhost:11434"
    embedding_model: str        = "nomic-embed-text"
    embedding_dim: int          = 768
    kafka_brokers: str          = "localhost:9092"
    cdisc_ct_version: str       = "2024-09-27"
    platform_org_id: str        = "00000000-0000-0000-0000-000000000000"
    ct_cache_ttl_secs: int      = 86400

    class Config:
        env_file = ".env"
        extra = 'ignore'


settings      = Settings()
db_pool:      asyncpg.Pool = None
redis_client: Any          = None


# ─── Helpers ─────────────────────────────────────────────────────────────────

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


async def _cache_get(key: str) -> Any:
    if redis_client:
        try:
            raw = await redis_client.get(key)
            return json.loads(raw) if raw else None
        except Exception:
            pass
    return None


async def _cache_set(key: str, value: Any, ttl: int = None) -> None:
    if redis_client:
        try:
            await redis_client.set(key, json.dumps(value), ex=ttl or settings.ct_cache_ttl_secs)
        except Exception:
            pass


# ─── Startup seed data ────────────────────────────────────────────────────────

_CDISC_CT_SEED: list[dict] = [
    {"code": "SEX",       "name": "Sex",                        "extensible": False,
     "terms": [{"code": "M", "decoded_value": "Male"}, {"code": "F", "decoded_value": "Female"},
               {"code": "U", "decoded_value": "Unknown"}, {"code": "UNDIFFERENTIATED", "decoded_value": "Undifferentiated"}]},
    {"code": "AESEV",     "name": "Adverse Event Severity",     "extensible": False,
     "terms": [{"code": "MILD", "decoded_value": "Mild"}, {"code": "MODERATE", "decoded_value": "Moderate"},
               {"code": "SEVERE", "decoded_value": "Severe"}]},
    {"code": "AEOUT",     "name": "Adverse Event Outcome",      "extensible": False,
     "terms": [{"code": "RECOVERED/RESOLVED", "decoded_value": "Recovered/Resolved"},
               {"code": "RECOVERING/RESOLVING", "decoded_value": "Recovering/Resolving"},
               {"code": "NOT RECOVERED/NOT RESOLVED", "decoded_value": "Not Recovered/Not Resolved"},
               {"code": "RECOVERED/RESOLVED WITH SEQUELAE", "decoded_value": "Recovered/Resolved with Sequelae"},
               {"code": "FATAL", "decoded_value": "Fatal"}, {"code": "UNKNOWN", "decoded_value": "Unknown"}]},
    {"code": "AEREL",     "name": "Adverse Event Causality",    "extensible": True,
     "terms": [{"code": "NOT RELATED", "decoded_value": "Not Related"},
               {"code": "UNLIKELY RELATED", "decoded_value": "Unlikely Related"},
               {"code": "POSSIBLY RELATED", "decoded_value": "Possibly Related"},
               {"code": "PROBABLY RELATED", "decoded_value": "Probably Related"},
               {"code": "RELATED", "decoded_value": "Related"}]},
    {"code": "AEACN",     "name": "Action Taken with Study Treatment", "extensible": False,
     "terms": [{"code": "DOSE REDUCED", "decoded_value": "Dose Reduced"},
               {"code": "DRUG INTERRUPTED", "decoded_value": "Drug Interrupted"},
               {"code": "DRUG WITHDRAWN", "decoded_value": "Drug Withdrawn"},
               {"code": "NOT APPLICABLE", "decoded_value": "Not Applicable"},
               {"code": "DOSE NOT CHANGED", "decoded_value": "Dose Not Changed"},
               {"code": "UNKNOWN", "decoded_value": "Unknown"}]},
    {"code": "AGEU",      "name": "Age Unit",                   "extensible": False,
     "terms": [{"code": "DAYS", "decoded_value": "Days"}, {"code": "WEEKS", "decoded_value": "Weeks"},
               {"code": "MONTHS", "decoded_value": "Months"}, {"code": "YEARS", "decoded_value": "Years"}]},
    {"code": "RACE",      "name": "Race",                       "extensible": True,
     "terms": [{"code": "AMERICAN INDIAN OR ALASKA NATIVE", "decoded_value": "American Indian or Alaska Native"},
               {"code": "ASIAN", "decoded_value": "Asian"},
               {"code": "BLACK OR AFRICAN AMERICAN", "decoded_value": "Black or African American"},
               {"code": "NATIVE HAWAIIAN OR OTHER PACIFIC ISLANDER", "decoded_value": "Native Hawaiian or Other Pacific Islander"},
               {"code": "WHITE", "decoded_value": "White"},
               {"code": "MULTIPLE", "decoded_value": "Multiple"},
               {"code": "NOT REPORTED", "decoded_value": "Not Reported"},
               {"code": "UNKNOWN", "decoded_value": "Unknown"}]},
    {"code": "ETHNIC",    "name": "Ethnicity",                  "extensible": True,
     "terms": [{"code": "HISPANIC OR LATINO", "decoded_value": "Hispanic or Latino"},
               {"code": "NOT HISPANIC OR LATINO", "decoded_value": "Not Hispanic or Latino"},
               {"code": "NOT REPORTED", "decoded_value": "Not Reported"},
               {"code": "UNKNOWN", "decoded_value": "Unknown"}]},
    {"code": "VSSTAT",    "name": "Vital Signs Test Status",    "extensible": False,
     "terms": [{"code": "NOT DONE", "decoded_value": "Not Done"}]},
    {"code": "LBSTAT",    "name": "Lab Test Status",            "extensible": False,
     "terms": [{"code": "NOT DONE", "decoded_value": "Not Done"}]},
    {"code": "EPOCH",     "name": "Epoch",                      "extensible": True,
     "terms": [{"code": "SCREENING", "decoded_value": "Screening"}, {"code": "RUN-IN", "decoded_value": "Run-In"},
               {"code": "TREATMENT", "decoded_value": "Treatment"}, {"code": "FOLLOW-UP", "decoded_value": "Follow-Up"},
               {"code": "WASHOUT", "decoded_value": "Washout"}]},
    {"code": "VISITNUM",  "name": "Visit Number",               "extensible": True, "terms": []},
    {"code": "NCOMPLT",   "name": "Not Completed Reason",       "extensible": True,
     "terms": [{"code": "ADVERSE EVENT", "decoded_value": "Adverse Event"},
               {"code": "DEATH", "decoded_value": "Death"},
               {"code": "LACK OF EFFICACY", "decoded_value": "Lack of Efficacy"},
               {"code": "LOST TO FOLLOW-UP", "decoded_value": "Lost to Follow-Up"},
               {"code": "PHYSICIAN DECISION", "decoded_value": "Physician Decision"},
               {"code": "PROTOCOL DEVIATION", "decoded_value": "Protocol Deviation"},
               {"code": "WITHDRAWAL BY SUBJECT", "decoded_value": "Withdrawal by Subject"},
               {"code": "OTHER", "decoded_value": "Other"}]},
    {"code": "NY",        "name": "No Yes Response",            "extensible": False,
     "terms": [{"code": "N", "decoded_value": "No"}, {"code": "Y", "decoded_value": "Yes"}]},
    {"code": "STENRF",    "name": "Start/End Relative to Reference Period", "extensible": False,
     "terms": [{"code": "BEFORE", "decoded_value": "Before"}, {"code": "DURING", "decoded_value": "During"},
               {"code": "AFTER", "decoded_value": "After"}, {"code": "BEFORE/DURING", "decoded_value": "Before/During"},
               {"code": "DURING/AFTER", "decoded_value": "During/After"}, {"code": "U", "decoded_value": "Unknown"}]},
    {"code": "OUT",       "name": "Outcome",                    "extensible": False,
     "terms": [{"code": "FAVORABLE", "decoded_value": "Favorable"}, {"code": "UNFAVORABLE", "decoded_value": "Unfavorable"},
               {"code": "UNKNOWN", "decoded_value": "Unknown"}]},
    {"code": "TRTORD",    "name": "Treatment Order",            "extensible": True, "terms": []},
    {"code": "LBTEST",    "name": "Lab Test Name",              "extensible": True, "terms": []},
    {"code": "VSTEST",    "name": "Vital Signs Test Name",      "extensible": True, "terms": []},
    {"code": "CMROUTE",   "name": "Route of Administration",    "extensible": True,
     "terms": [{"code": "INTRAVENOUS", "decoded_value": "Intravenous"},
               {"code": "ORAL", "decoded_value": "Oral"},
               {"code": "SUBCUTANEOUS", "decoded_value": "Subcutaneous"},
               {"code": "INTRAMUSCULAR", "decoded_value": "Intramuscular"},
               {"code": "TOPICAL", "decoded_value": "Topical"},
               {"code": "INHALED", "decoded_value": "Inhaled"}]},
    # ── USDM v4.0 specific codelists ────────────────────────────────────────
    # TI domain: Inclusion/Exclusion Criterion Category (USDM EligibilityCriterion.category)
    {"code": "IECAT",     "name": "Inclusion/Exclusion Criterion Category", "extensible": False,
     "terms": [{"code": "INCL", "decoded_value": "Inclusion"},
               {"code": "EXCL", "decoded_value": "Exclusion"}]},
    # TA/TE domain: Study Epoch Type (C99077, USDM StudyEpoch.type)
    {"code": "EPOCHTYPE", "name": "Study Epoch Type",                       "extensible": True,
     "terms": [{"code": "SCREENING", "decoded_value": "Screening"},
               {"code": "RUN-IN",    "decoded_value": "Run-In"},
               {"code": "TREATMENT", "decoded_value": "Treatment"},
               {"code": "FOLLOW-UP", "decoded_value": "Follow-Up"},
               {"code": "WASHOUT",   "decoded_value": "Washout"},
               {"code": "OPEN LABEL", "decoded_value": "Open Label"},
               {"code": "DOUBLE BLIND", "decoded_value": "Double Blind"},
               {"code": "OBSERVATION", "decoded_value": "Observation"}]},
    # TS domain: Study Phase (C66737, USDM InterventionalStudyDesign.studyPhase)
    {"code": "STUDYPHASE", "name": "Study Phase",                           "extensible": False,
     "terms": [{"code": "PHASE I TRIAL", "decoded_value": "Phase I Trial"},
               {"code": "PHASE I/II TRIAL", "decoded_value": "Phase I/II Trial"},
               {"code": "PHASE II TRIAL", "decoded_value": "Phase II Trial"},
               {"code": "PHASE II/III TRIAL", "decoded_value": "Phase II/III Trial"},
               {"code": "PHASE III TRIAL", "decoded_value": "Phase III Trial"},
               {"code": "PHASE IV TRIAL", "decoded_value": "Phase IV Trial"},
               {"code": "NOT APPLICABLE", "decoded_value": "Not Applicable"}]},
    # TS domain: Intervention Model Type (C98746, USDM InterventionalStudyDesign.model)
    {"code": "INTMODEL",  "name": "Intervention Model Type",                "extensible": False,
     "terms": [{"code": "PARALLEL ASSIGNMENT",   "decoded_value": "Parallel Assignment"},
               {"code": "CROSSOVER ASSIGNMENT",  "decoded_value": "Crossover Assignment"},
               {"code": "FACTORIAL ASSIGNMENT",  "decoded_value": "Factorial Assignment"},
               {"code": "SINGLE GROUP ASSIGNMENT","decoded_value": "Single Group Assignment"}]},
    # TS domain: Trial Blinding Schema (C49658, USDM InterventionalStudyDesign.blindingSchema)
    {"code": "BLNDSCM",   "name": "Trial Blinding Schema",                  "extensible": False,
     "terms": [{"code": "OPEN LABEL",        "decoded_value": "Open Label"},
               {"code": "SINGLE BLIND",      "decoded_value": "Single Blind"},
               {"code": "DOUBLE BLIND",      "decoded_value": "Double Blind"},
               {"code": "TRIPLE BLIND",      "decoded_value": "Triple Blind"},
               {"code": "QUADRUPLE BLIND",   "decoded_value": "Quadruple Blind"}]},
    # TS domain: Trial Intent Type (C49652)
    {"code": "TRTINTENT", "name": "Trial Intent Type",                      "extensible": True,
     "terms": [{"code": "TREATMENT", "decoded_value": "Treatment"},
               {"code": "PREVENTION", "decoded_value": "Prevention"},
               {"code": "DIAGNOSTIC", "decoded_value": "Diagnostic"},
               {"code": "SUPPORTIVE CARE", "decoded_value": "Supportive Care"},
               {"code": "SCREENING", "decoded_value": "Screening"},
               {"code": "HEALTH SERVICES RESEARCH", "decoded_value": "Health Services Research"},
               {"code": "BASIC SCIENCE", "decoded_value": "Basic Science"},
               {"code": "DEVICE FEASIBILITY", "decoded_value": "Device Feasibility"},
               {"code": "OTHER", "decoded_value": "Other"}]},
    # Study Arm Type — used in USDM StudyArm.type
    {"code": "ARMTYPE",   "name": "Study Arm Type",                         "extensible": True,
     "terms": [{"code": "Experimental",    "decoded_value": "Experimental"},
               {"code": "Active Comparator", "decoded_value": "Active Comparator"},
               {"code": "Placebo Comparator", "decoded_value": "Placebo Comparator"},
               {"code": "Sham Comparator", "decoded_value": "Sham Comparator"},
               {"code": "No Intervention", "decoded_value": "No Intervention"},
               {"code": "Other",           "decoded_value": "Other"}]},
]

_REGULATORY_REQUIREMENTS_SEED: list[dict] = [
    {"req_code": "FDA-21CFR-11.10", "authority": "FDA", "category": "audit_trail",
     "requirement_text": "Audit trails for electronic records must capture date and time of operator entries and actions that create, modify, or delete electronic records.",
     "applies_to": ["EDC", "SDTM", "CRF"]},
    {"req_code": "FDA-21CFR-312.62", "authority": "FDA", "category": "traceability",
     "requirement_text": "Investigators must maintain adequate records for all clinical investigations under IND, including case histories for each subject.",
     "applies_to": ["Protocol", "CRF", "SDTM"]},
    {"req_code": "ICH-E6R3-5.5", "authority": "ICH", "category": "gcp",
     "requirement_text": "The sponsor is responsible for implementing and maintaining quality assurance and quality control systems with written SOPs.",
     "applies_to": ["Protocol", "SOP", "Monitoring"]},
    {"req_code": "ICH-E6R3-8.3", "authority": "ICH", "category": "data_integrity",
     "requirement_text": "All clinical trial data must be verifiable, traceable, and complete. Source data verification must be possible.",
     "applies_to": ["CRF", "SDTM", "EDC"]},
    {"req_code": "FDA-21CFR-314.50", "authority": "FDA", "category": "submission",
     "requirement_text": "NDA submissions must include SDTM and ADaM datasets conforming to current CDISC standards.",
     "applies_to": ["SDTM", "ADaM", "Submission"]},
    {"req_code": "EMA-DMPG-3.1", "authority": "EMA", "category": "data_integrity",
     "requirement_text": "Data management processes must ensure data integrity throughout the trial lifecycle.",
     "applies_to": ["EDC", "SDTM", "DMP"]},
    {"req_code": "ICH-E9-5.1", "authority": "ICH", "category": "validation",
     "requirement_text": "The primary analysis should be conducted on the full analysis set (FAS) as defined in the SAP.",
     "applies_to": ["SAP", "ADaM", "Protocol"]},
    {"req_code": "FDA-Guidance-SDTM-2022", "authority": "FDA", "category": "submission",
     "requirement_text": "FDA requires SDTM v3.3+ for all NDA/BLA submissions. CDISC CT codelists must be used for all controlled terminology variables.",
     "applies_to": ["SDTM"]},
    # ── ICH M11 CeSHarP Protocol Structure Requirements ──────────────────────
    {"req_code": "ICH-M11-1.1", "authority": "ICH", "category": "protocol_structure",
     "requirement_text": "Protocol must include a unique title and version identifier (Section 1.1 General Information). Title must unambiguously identify the study.",
     "applies_to": ["Protocol"]},
    {"req_code": "ICH-M11-2.0", "authority": "ICH", "category": "protocol_structure",
     "requirement_text": "A protocol summary/synopsis section is required providing a concise overview of the study design, objectives, and methods.",
     "applies_to": ["Protocol"]},
    {"req_code": "ICH-M11-3.0", "authority": "ICH", "category": "protocol_structure",
     "requirement_text": "Background and rationale section is required, providing scientific justification for the study and the unmet medical need.",
     "applies_to": ["Protocol"]},
    {"req_code": "ICH-M11-4.1", "authority": "ICH", "category": "protocol_structure",
     "requirement_text": "Primary objectives and their associated estimands must be explicitly defined. At least one primary endpoint must be specified.",
     "applies_to": ["Protocol", "SAP"]},
    {"req_code": "ICH-M11-5.1", "authority": "ICH", "category": "eligibility",
     "requirement_text": "Inclusion and exclusion criteria must be separately enumerated. Each criterion must be unambiguously stated with measurable thresholds where applicable.",
     "applies_to": ["Protocol", "CRF"]},
    {"req_code": "ICH-M11-6.1", "authority": "ICH", "category": "study_design",
     "requirement_text": "Study design overview including a schema/schematic diagram is required. Must specify randomization, blinding, and arm descriptions.",
     "applies_to": ["Protocol"]},
    {"req_code": "ICH-M11-8.1", "authority": "ICH", "category": "schedule",
     "requirement_text": "A Schedule of Activities (SOA) table is mandatory. Must list all visits and assessments with timing relative to reference timepoints.",
     "applies_to": ["Protocol", "CRF"]},
    {"req_code": "ICH-M11-9.3", "authority": "ICH", "category": "statistics",
     "requirement_text": "Sample size justification with statistical power rationale must be documented. Assumptions and method of calculation must be stated.",
     "applies_to": ["Protocol", "SAP"]},
    {"req_code": "ICH-M11-12.1", "authority": "ICH", "category": "safety",
     "requirement_text": "SAE reporting timelines and procedures must be specified. SUSAR reporting obligations per regulatory requirements must be defined.",
     "applies_to": ["Protocol"]},
    {"req_code": "ICH-M11-13.0", "authority": "ICH", "category": "ethics",
     "requirement_text": "Ethical considerations section is required. Must include IEC/IRB reference, informed consent procedures, and GCP compliance statement.",
     "applies_to": ["Protocol"]},
]

_STANDARDS_SEED: list[dict] = [
    {"code": "SDTM-IG-3.4",    "name": "Study Data Tabulation Model Implementation Guide v3.4",   "type": "implementation_guide",   "version": "3.4",   "publisher": "CDISC"},
    {"code": "SDTM-3.4",       "name": "Study Data Tabulation Model v3.4",                         "type": "data_standard",          "version": "3.4",   "publisher": "CDISC"},
    {"code": "CDASH-IG-2.1",   "name": "Clinical Data Acquisition Standards Harmonization IG v2.1","type": "implementation_guide",   "version": "2.1",   "publisher": "CDISC"},
    {"code": "CDISC-CT-2024",  "name": "CDISC Controlled Terminology 2024-09-27",                  "type": "controlled_terminology", "version": "2024-09-27", "publisher": "CDISC/NCI"},
    {"code": "USDM-4.0",       "name": "Unified Study Definitions Model v4.0",                     "type": "study_design_model",     "version": "4.0",   "publisher": "CDISC"},
    {"code": "USDM-IG-4.0",   "name": "USDM Implementation Guide v4.0",                           "type": "implementation_guide",   "version": "4.0",   "publisher": "CDISC",
     "effective_date": "2025-06-03", "notes": "Defines 5-part model: Study Design, Arms/Epochs, Schedule Timelines, BiomedicalConcepts, Eligibility/Population. SDTM TA/TE/TV/TI/TS mapping. ISO 8601 timing."},
    {"code": "ICH-E6R3",       "name": "Good Clinical Practice ICH E6(R3)",                        "type": "regulatory_guidance",    "version": "R3",    "publisher": "ICH"},
    {"code": "ICH-E9",         "name": "Statistical Principles for Clinical Trials ICH E9",        "type": "regulatory_guidance",    "version": "1",     "publisher": "ICH"},
    {"code": "DDF-1.0",        "name": "Digital Data Flow v1.0",                                   "type": "study_design_model",     "version": "1.0",   "publisher": "CDISC"},
    {"code": "ICH-M11-2024",
     "name": "ICH M11 Clinical Electronic Structured Harmonised Protocol (CeSHarP) v2",
     "type": "regulatory_guidance", "version": "2", "publisher": "ICH",
     "effective_date": "2024-09-01",
     "s3_key": "ich-m11/ich_m11_ceshar_v4.pdf",
     "notes": "Defines 14-section mandatory structure for clinical trial protocols. "
              "FDA/EMA joint guideline. Maps to USDM v4.0 and CDISC CDASH. "
              "Covers objectives, eligibility, study design, SOA, statistics, safety reporting."},
    {"code": "PFIZER-MDR-2024",
     "name": "Pfizer Master Data Repository (MDR) Integration Standard",
     "type": "integration_standard", "version": "1.0", "publisher": "Pfizer",
     "effective_date": "2024-01-01",
     "notes": "USDM v4.0 JSON is the canonical exchange format for Pfizer MDR integration. "
              "Trialo exports study metadata, arms, objectives, eligibility, and SOA via USDM. "
              "Integration via REST API (GET /usdm/{id}), Kafka event stream "
              "(trialo.events.study), and GraphQL API (port 4000). "
              "All USDM exports are ICH M11 validated before MDR ingestion."},
]

# ── ICH M11 section structure (mirrors CeSHarP Table of Contents) ─────────────
ICH_M11_MANDATORY_SECTIONS: list[dict] = [
    {"id": "S01", "title": "General Information",
     "subsections": ["title", "identifiers", "dates", "sponsor"],
     "critical": True,
     "keywords": ["title", "version", "sponsor", "identifier", "protocol number"]},
    {"id": "S02", "title": "Protocol Summary",
     "subsections": [],
     "critical": True,
     "keywords": ["summary", "synopsis", "overview", "brief description"]},
    {"id": "S03", "title": "Background and Rationale",
     "subsections": [],
     "critical": True,
     "keywords": ["background", "rationale", "scientific justification", "unmet need", "disease"]},
    {"id": "S04", "title": "Objectives and Estimands",
     "subsections": ["primary", "secondary", "exploratory"],
     "critical": True,
     "keywords": ["objective", "endpoint", "estimand", "primary", "secondary", "hypothesis"]},
    {"id": "S05", "title": "Eligibility Criteria",
     "subsections": ["inclusion", "exclusion"],
     "critical": True,
     "keywords": ["inclusion", "exclusion", "eligibility", "criteria", "participant", "subject"]},
    {"id": "S06", "title": "Study Design",
     "subsections": ["overview", "schema", "population", "allocation", "blinding"],
     "critical": True,
     "keywords": ["study design", "randomization", "blinding", "arm", "phase", "parallel", "crossover"]},
    {"id": "S07", "title": "Study Interventions",
     "subsections": ["treatments", "concomitant", "rescue"],
     "critical": False,
     "keywords": ["intervention", "treatment", "drug", "dose", "administration", "medication"]},
    {"id": "S08", "title": "Schedule of Activities",
     "subsections": ["soa_table", "screening", "treatment", "followup"],
     "critical": True,
     "keywords": ["schedule", "visit", "SOA", "assessment", "activity", "timing", "encounter"]},
    {"id": "S09", "title": "Statistical Considerations",
     "subsections": ["estimands", "analyses", "sample_size"],
     "critical": True,
     "keywords": ["statistical", "sample size", "power", "analysis", "population", "FAS", "per protocol"]},
    {"id": "S10", "title": "Data Management",
     "subsections": [],
     "critical": False,
     "keywords": ["data management", "EDC", "data collection", "CRF", "database", "data quality"]},
    {"id": "S11", "title": "Monitoring",
     "subsections": [],
     "critical": False,
     "keywords": ["monitoring", "CRO", "site visit", "risk-based monitoring", "oversight"]},
    {"id": "S12", "title": "Safety Reporting",
     "subsections": ["sae", "susar"],
     "critical": True,
     "keywords": ["SAE", "serious adverse event", "SUSAR", "safety reporting", "pharmacovigilance", "adverse event"]},
    {"id": "S13", "title": "Ethical Considerations",
     "subsections": [],
     "critical": False,
     "keywords": ["ethics", "IEC", "IRB", "informed consent", "GCP", "ethical", "regulatory approval"]},
    {"id": "S14", "title": "Supporting Documentation",
     "subsections": ["references", "abbreviations"],
     "critical": False,
     "keywords": ["references", "bibliography", "abbreviation", "glossary", "appendix"]},
]

# ICH M11 PDF download constants
ICH_M11_PDF_URL = "https://www.fda.gov/media/164112/download"
ICH_M11_S3_KEY  = "ich-m11/ich_m11_ceshar_v4.pdf"
ICH_M11_BUCKET  = "standards"
SDTM_CT_TXT_URL = "https://evs.nci.nih.gov/ftp1/CDISC/SDTM/SDTM%20Terminology.txt"
SDTM_CT_VERSION_STAMP_URL = "https://evs.nci.nih.gov/ftp1/CDISC/SDTM/SDTM%20Publication%20Date%20Stamp.txt"


def _parse_sdtm_ct_tsv(raw_tsv: str) -> list[dict]:
    """Parse NCI EVS SDTM terminology TSV into codelists with terms."""
    reader = csv.reader(io.StringIO(raw_tsv), delimiter="\t")
    rows = [row for row in reader if row and any(cell.strip() for cell in row)]
    if not rows:
        return []

    # Normalize to at least 8 columns.
    norm_rows: list[list[str]] = []
    for row in rows[1:]:
        if len(row) < 8:
            row = row + [""] * (8 - len(row))
        norm_rows.append([c.strip() for c in row[:8]])

    codelists_by_nci: dict[str, dict] = {}

    # Pass 1: codelist header rows (no parent codelist code)
    for row in norm_rows:
        nci_code, parent_code, extensible, codelist_name, submission_value, _, _, _ = row
        if not nci_code or parent_code:
            continue
        if not submission_value:
            continue

        codelists_by_nci[nci_code] = {
            "codelist_code": submission_value,
            "codelist_name": codelist_name or submission_value,
            "is_extensible": extensible.lower() == "yes",
            "terms": [],
            "nci_code": nci_code,
        }

    # Pass 2: codelist item rows (parent codelist code present)
    for row in norm_rows:
        nci_code, parent_code, _, codelist_name, submission_value, synonym, _, preferred_term = row
        if not parent_code or not submission_value:
            continue

        cl = codelists_by_nci.get(parent_code)
        if cl is None:
            # Defensive fallback for unexpected ordering/shape.
            cl = {
                "codelist_code": parent_code,
                "codelist_name": codelist_name or parent_code,
                "is_extensible": True,
                "terms": [],
                "nci_code": parent_code,
            }
            codelists_by_nci[parent_code] = cl

        cl["terms"].append({
            "code": submission_value,
            "decoded_value": synonym or preferred_term or submission_value,
            "preferred_term": preferred_term or None,
            "nci_code": nci_code,
        })

    return list(codelists_by_nci.values())


async def _fetch_latest_sdtm_ct_version() -> Optional[str]:
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(SDTM_CT_VERSION_STAMP_URL)
            resp.raise_for_status()
            m = re.search(r"(\d{4}-\d{2}-\d{2})", resp.text)
            return m.group(1) if m else None
    except Exception as exc:
        log.warning("standards_registry.ct_version_fetch_failed", error=str(exc))
        return None


async def _resolve_ct_version(requested_version: Optional[str]) -> str:
    if requested_version:
        return requested_version

    async with db_pool.acquire() as conn:
        latest = await conn.fetchval("SELECT MAX(version) FROM standards_terminology")
    return latest or settings.cdisc_ct_version


async def _download_ich_m11_standard() -> None:
    """Download the ICH M11 CeSHarP PDF from FDA and upload to MinIO/S3 if not already present."""
    try:
        import boto3
        from botocore.config import Config as BotoConfig
        s3 = boto3.client(
            "s3",
            endpoint_url=settings.__dict__.get("s3_endpoint_url", "http://localhost:9000"),
            aws_access_key_id=settings.__dict__.get("s3_access_key", "minioadmin"),
            aws_secret_access_key=settings.__dict__.get("s3_secret_key", "minioadmin"),
            config=BotoConfig(signature_version="s3v4"),
        )
        # Check if already present
        try:
            s3.head_object(Bucket=ICH_M11_BUCKET, Key=ICH_M11_S3_KEY)
            log.info("standards_registry.ich_m11_already_present")
            return
        except Exception:
            pass

        # Ensure bucket exists
        try:
            s3.create_bucket(Bucket=ICH_M11_BUCKET)
        except Exception:
            pass

        # Download from FDA
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            resp = await client.get(ICH_M11_PDF_URL)
            resp.raise_for_status()
            pdf_bytes = resp.content

        # Upload to MinIO
        import io
        s3.upload_fileobj(
            io.BytesIO(pdf_bytes),
            ICH_M11_BUCKET,
            ICH_M11_S3_KEY,
            ExtraArgs={"ContentType": "application/pdf"},
        )
        log.info("standards_registry.ich_m11_downloaded", size_bytes=len(pdf_bytes), key=ICH_M11_S3_KEY)

        # Update standards_catalogue with s3_key
        async with db_pool.acquire() as conn:
            await conn.execute(
                "UPDATE standards_catalogue SET metadata = metadata || $1::jsonb "
                "WHERE standard_code = 'ICH-M11-2024'",
                json.dumps({"s3_key": ICH_M11_S3_KEY, "download_url": ICH_M11_PDF_URL}),
            )
    except Exception as exc:
        log.warning("standards_registry.ich_m11_download_failed", error=str(exc))


async def _seed_standards(conn) -> None:
    ct_standard_id = None
    for s in _STANDARDS_SEED:
        # Build insert with optional extra fields
        eff_date = None
        if s.get("effective_date"):
            from datetime import date
            try:
                eff_date = date.fromisoformat(s["effective_date"])
            except Exception:
                pass
        row = await conn.fetchrow(
            """INSERT INTO standards_catalogue
               (standard_code, standard_name, standard_type, version, publisher, effective_date)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (standard_code, version,
                   COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid))
               DO UPDATE SET standard_name=EXCLUDED.standard_name, updated_at=NOW()
               RETURNING id, standard_code""",
            s["code"], s["name"], s["type"], s["version"], s["publisher"], eff_date,
        )
        if s["code"] == "CDISC-CT-2024":
            ct_standard_id = row["id"]

    for cl in _CDISC_CT_SEED:
        terms_json = json.dumps(cl["terms"])
        await conn.execute(
            """INSERT INTO standards_terminology
               (codelist_code, codelist_name, standard_id, is_extensible, terms, version)
               VALUES ($1,$2,$3,$4,$5::jsonb,$6)
               ON CONFLICT (codelist_code, version) DO UPDATE
               SET terms=EXCLUDED.terms, updated_at=NOW()""",
            cl["code"], cl["name"], ct_standard_id, cl["extensible"],
            terms_json, settings.cdisc_ct_version,
        )

    for rr in _REGULATORY_REQUIREMENTS_SEED:
        await conn.execute(
            """INSERT INTO regulatory_requirements
               (req_code, authority, category, requirement_text, applies_to)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (req_code) DO NOTHING""",
            rr["req_code"], rr["authority"], rr["category"],
            rr["requirement_text"], rr["applies_to"],
        )
    log.info("standards_registry.seed_complete")


# ─── Lifespan ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global db_pool, redis_client

    async def _init_conn(conn):
        await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
        await conn.set_type_codec("json",  encoder=json.dumps, decoder=json.loads, schema="pg_catalog")

    db_pool = await asyncpg.create_pool(
        settings.database_url, min_size=3, max_size=15, init=_init_conn
    )

    async with db_pool.acquire() as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS standards_biomedical_concept_codelists (
                id BIGSERIAL PRIMARY KEY,
                concept_name TEXT NOT NULL,
                normalized_name TEXT NOT NULL,
                codelist_code TEXT NOT NULL,
                codelist_name TEXT,
                version TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'cdisc_ct',
                is_auto BOOLEAN NOT NULL DEFAULT TRUE,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (normalized_name, version)
            )
            """
        )

    if _REDIS_AVAILABLE:
        try:
            redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
            await redis_client.ping()
            log.info("standards_registry.redis_connected")
        except Exception as exc:
            log.warning("standards_registry.redis_unavailable", error=str(exc))
            redis_client = None

    try:
        async with db_pool.acquire() as conn:
            await _seed_standards(conn)
    except Exception as exc:
        log.warning("standards_registry.seed_failed", error=str(exc))

    # Download ICH M11 PDF into MinIO (fire-and-forget; non-fatal)
    asyncio.create_task(_download_ich_m11_standard())

    log.info("standards_registry.startup", port=8012)
    yield
    await db_pool.close()
    if redis_client:
        await redis_client.aclose()


app = FastAPI(title="TrialOS Standards Registry", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ─── Pydantic Models ──────────────────────────────────────────────────────────

class StandardCreate(BaseModel):
    standard_code:  str
    standard_name:  str
    standard_type:  str
    version:        str
    publisher:      str = "CDISC"
    effective_date: Optional[str] = None
    org_id:         Optional[str] = None
    metadata:       dict = {}

class TerminologyValidateRequest(BaseModel):
    value:   str
    version: Optional[str] = None


class BiomedicalConceptMapItem(BaseModel):
    concept_name: str = Field(..., min_length=1)
    datatype: Optional[str] = None


class BiomedicalConceptMapRequest(BaseModel):
    concepts: list[BiomedicalConceptMapItem]
    version: Optional[str] = None
    top_k: int = Field(default=5, ge=1, le=20)
    persist: bool = True

class RegulatoryValidateRequest(BaseModel):
    applies_to: list[str]
    authority:  Optional[str] = None
    category:   Optional[str] = None

class TimelineCreate(BaseModel):
    org_id:          Optional[str] = None
    study_id:        Optional[str] = None
    timeline_type:   str
    label:           str
    target_date:     str
    related_standard_id: Optional[str] = None
    alert_days_before: list[int] = [30, 7, 1]
    metadata:        dict = {}

class ProvenanceRecord(BaseModel):
    artifact_id:          str
    artifact_type:        str
    org_id:               str
    study_id:             Optional[str] = None
    action:               str
    actor_type:           str
    actor_id:             str
    parent_artifact_ids:  list[str] = []
    model_id:             Optional[str] = None
    model_version:        Optional[str] = None
    run_id:               Optional[str] = None
    metadata:             dict = {}


# ─── Health ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "standards-registry", "port": 8012}


# ─── Standards Catalogue ─────────────────────────────────────────────────────

@app.get("/standards")
async def list_standards(
    standard_type: Optional[str] = None,
    publisher: Optional[str] = None,
    org_id: Optional[str] = None,
    active_only: bool = True,
):
    conditions = ["TRUE"]
    params: list = []
    n = 1
    if active_only:
        conditions.append("is_active = TRUE")
    if standard_type:
        conditions.append(f"standard_type = ${n}"); params.append(standard_type); n += 1
    if publisher:
        conditions.append(f"publisher = ${n}"); params.append(publisher); n += 1
    if org_id:
        conditions.append(f"(org_id = ${n} OR org_id IS NULL)"); params.append(uuid.UUID(org_id)); n += 1
    else:
        conditions.append("org_id IS NULL")

    where = " AND ".join(conditions)
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT id,standard_code,standard_name,standard_type,version,publisher,"
            f"effective_date,expiry_date,is_active,metadata FROM standards_catalogue "
            f"WHERE {where} ORDER BY standard_type, standard_code", *params
        )
    return {"standards": [dict(r) for r in rows]}


@app.get("/standards/{standard_id}")
async def get_standard(standard_id: str):
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM standards_catalogue WHERE id = $1", uuid.UUID(standard_id)
        )
    if not row:
        raise HTTPException(404, "Standard not found")
    return dict(row)


@app.post("/standards", status_code=201)
async def upsert_standard(body: StandardCreate):
    org = uuid.UUID(body.org_id) if body.org_id else None
    effective = date.fromisoformat(body.effective_date) if body.effective_date else None
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO standards_catalogue
               (standard_code, standard_name, standard_type, version, publisher,
                effective_date, org_id, metadata)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
               ON CONFLICT (standard_code, version,
                   COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid))
               DO UPDATE SET standard_name=EXCLUDED.standard_name,
                             standard_type=EXCLUDED.standard_type,
                             updated_at=NOW()
               RETURNING id""",
            body.standard_code, body.standard_name, body.standard_type,
            body.version, body.publisher, effective, org,
            json.dumps(body.metadata),
        )
    return {"id": str(row["id"])}


# ─── Controlled Terminology ───────────────────────────────────────────────────

@app.get("/terminology/codelists")
async def list_codelists(
    is_extensible: Optional[bool] = None,
    version: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
):
    ver = await _resolve_ct_version(version)
    conditions = [f"version = $1"]
    params: list = [ver]
    n = 2
    if is_extensible is not None:
        conditions.append(f"is_extensible = ${n}"); params.append(is_extensible); n += 1
    where = " AND ".join(conditions)
    params.extend([limit, offset])
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT id,codelist_code,codelist_name,is_extensible,version,"
            f"submission_value_domain FROM standards_terminology "
            f"WHERE {where} ORDER BY codelist_code LIMIT ${n} OFFSET ${n+1}",
            *params,
        )
        total = await conn.fetchval(
            f"SELECT COUNT(*) FROM standards_terminology WHERE {where}",
            *params[:-2],
        )
    return {"codelists": [dict(r) for r in rows], "total": total}


def _normalize_concept_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (name or "").lower())


async def _find_codelist_for_concept(concept_name: str, version: str, top_k: int = 5) -> Optional[dict]:
    like_pattern = f"%{concept_name}%"
    prefix_pattern = f"{concept_name}%"
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT codelist_code, codelist_name, is_extensible
            FROM standards_terminology
            WHERE version = $1
              AND (
                codelist_code ILIKE $2
                OR codelist_name ILIKE $2
                OR terms::text ILIKE $2
              )
            ORDER BY
              CASE
                WHEN UPPER(codelist_code) = UPPER($3) THEN 0
                WHEN codelist_name ILIKE $4 THEN 1
                ELSE 2
              END,
              codelist_code
            LIMIT $5
            """,
            version,
            like_pattern,
            concept_name,
            prefix_pattern,
            top_k,
        )
    return dict(rows[0]) if rows else None


async def _find_fallback_codelist(version: str) -> Optional[dict]:
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT codelist_code, codelist_name, is_extensible
            FROM standards_terminology
            WHERE version = $1
            ORDER BY is_extensible DESC, codelist_code
            LIMIT 1
            """,
            version,
        )
    return dict(row) if row else None


@app.get("/terminology/biomedical-concepts")
async def list_biomedical_concept_codelists(version: Optional[str] = None, limit: int = 200, offset: int = 0):
    ver = await _resolve_ct_version(version)
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT concept_name, normalized_name, codelist_code, codelist_name, version,
                   source, is_auto, metadata, updated_at
            FROM standards_biomedical_concept_codelists
            WHERE version = $1
            ORDER BY concept_name
            LIMIT $2 OFFSET $3
            """,
            ver, limit, offset,
        )
        total = await conn.fetchval(
            "SELECT COUNT(*) FROM standards_biomedical_concept_codelists WHERE version = $1",
            ver,
        )
    return {"mappings": [dict(r) for r in rows], "total": total, "version": ver}


@app.post("/terminology/biomedical-concepts/map")
async def map_biomedical_concepts_to_codelists(body: BiomedicalConceptMapRequest):
    ver = await _resolve_ct_version(body.version)
    mappings: list[dict[str, Any]] = []
    fallback_codelist = await _find_fallback_codelist(ver)
    fallback_codelist_code = str((fallback_codelist or {}).get("codelist_code") or "").upper()

    for concept in body.concepts:
        concept_name = (concept.concept_name or "").strip()
        if not concept_name:
            continue
        normalized = _normalize_concept_name(concept_name)

        async with db_pool.acquire() as conn:
            existing = await conn.fetchrow(
                """
                SELECT concept_name, codelist_code, codelist_name, version, source, is_auto, metadata
                FROM standards_biomedical_concept_codelists
                WHERE normalized_name = $1 AND version = $2
                """,
                normalized, ver,
            )
        if existing:
            mappings.append(dict(existing))
            continue

        chosen = await _find_codelist_for_concept(concept_name, ver, body.top_k)

        if not chosen:
            if fallback_codelist_code:
                chosen = {
                    "codelist_code": fallback_codelist_code,
                    "codelist_name": (fallback_codelist or {}).get("codelist_name") or fallback_codelist_code,
                    "is_fallback": True,
                }
            else:
                mappings.append({
                    "concept_name": concept_name,
                    "codelist_code": None,
                    "codelist_name": None,
                    "version": ver,
                    "source": "unresolved",
                    "is_auto": True,
                    "metadata": {"datatype": concept.datatype, "reason": "no_cdisc_candidate_or_fallback"},
                })
                continue

        code = str(chosen.get("codelist_code", "")).upper().strip()
        if not code:
            code = fallback_codelist_code
        if not code:
            mappings.append({
                "concept_name": concept_name,
                "codelist_code": None,
                "codelist_name": None,
                "version": ver,
                "source": "unresolved",
                "is_auto": True,
                "metadata": {"datatype": concept.datatype, "reason": "candidate_without_code"},
            })
            continue

        codelist = await get_codelist(code, ver)
        row = {
            "concept_name": concept_name,
            "normalized_name": normalized,
            "codelist_code": code,
            "codelist_name": codelist.get("codelist_name") or chosen.get("codelist_name") or code,
            "version": ver,
            "source": "cdisc_ct_fallback" if chosen.get("is_fallback") else "cdisc_ct",
            "is_auto": True,
            "metadata": {
                "datatype": concept.datatype,
                "resolved_at": datetime.now(timezone.utc).isoformat(),
                "fallback": bool(chosen.get("is_fallback")),
            },
        }

        if body.persist:
            async with db_pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO standards_biomedical_concept_codelists
                        (concept_name, normalized_name, codelist_code, codelist_name, version, source, is_auto, metadata)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
                    ON CONFLICT (normalized_name, version) DO UPDATE
                    SET concept_name = EXCLUDED.concept_name,
                        codelist_code = EXCLUDED.codelist_code,
                        codelist_name = EXCLUDED.codelist_name,
                        source = EXCLUDED.source,
                        is_auto = EXCLUDED.is_auto,
                        metadata = EXCLUDED.metadata,
                        updated_at = NOW()
                    """,
                    row["concept_name"],
                    row["normalized_name"],
                    row["codelist_code"],
                    row["codelist_name"],
                    row["version"],
                    row["source"],
                    row["is_auto"],
                    json.dumps(row["metadata"]),
                )

        mappings.append(row)

    return {"version": ver, "mappings": mappings}


@app.get("/terminology/codelists/{codelist_code}")
async def get_codelist(codelist_code: str, version: Optional[str] = None):
    ver = await _resolve_ct_version(version)
    cache_key = f"ct:codelist:{codelist_code}:{ver}"
    cached = await _cache_get(cache_key)
    if cached:
        return cached

    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM standards_terminology WHERE codelist_code=$1 AND version=$2",
            codelist_code.upper(), ver,
        )
    if not row:
        raise HTTPException(404, f"Codelist {codelist_code!r} not found for version {ver}")

    result = dict(row)
    await _cache_set(cache_key, result)
    return result


@app.post("/terminology/codelists/{codelist_code}/validate")
async def validate_terminology(codelist_code: str, body: TerminologyValidateRequest):
    ver = await _resolve_ct_version(body.version)
    try:
        cl = await get_codelist(codelist_code, ver)
    except HTTPException:
        return {"valid": False, "reason": f"Codelist {codelist_code!r} not found",
                "codelist_code": codelist_code, "value": body.value}

    terms: list[dict] = cl.get("terms") or []
    value_upper = body.value.strip().upper()
    valid_codes = {t.get("code", "").upper() for t in terms}
    valid_decoded = {t.get("decoded_value", "").upper() for t in terms}
    is_extensible: bool = cl.get("is_extensible", False)

    # Exact match check
    if value_upper in valid_codes or value_upper in valid_decoded:
        return {"valid": True, "codelist_code": codelist_code, "value": body.value,
                "is_extensible": is_extensible, "matched_term": value_upper}

    # Non-extensible codelists: any value not in the codelist is a violation
    if not is_extensible:
        return {
            "valid": False,
            "codelist_code": codelist_code,
            "value": body.value,
            "is_extensible": False,
            "reason": f"Value {body.value!r} not in non-extensible codelist {codelist_code}",
            "valid_values": [t.get("code") for t in terms[:20]],
        }

    # Extensible codelists: value is technically allowed but flag for review
    return {"valid": True, "codelist_code": codelist_code, "value": body.value,
            "is_extensible": True, "note": "Value not in standard terms but codelist is extensible"}


@app.post("/terminology/import/sdtm")
async def import_sdtm_terminology(
    version: Optional[str] = None,
    source_url: str = SDTM_CT_TXT_URL,
    force: bool = False,
):
    target_version = version or await _fetch_latest_sdtm_ct_version() or settings.cdisc_ct_version

    async with db_pool.acquire() as conn:
        existing_count = await conn.fetchval(
            "SELECT COUNT(*) FROM standards_terminology WHERE version = $1",
            target_version,
        )
        if existing_count and not force:
            return {
                "status": "skipped",
                "reason": "version already imported",
                "version": target_version,
                "existing_codelists": existing_count,
            }

    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
        resp = await client.get(source_url)
        resp.raise_for_status()
        raw_tsv = resp.text

    parsed = _parse_sdtm_ct_tsv(raw_tsv)
    if not parsed:
        raise HTTPException(400, "No codelists parsed from SDTM terminology source")

    async with db_pool.acquire() as conn:
        std = await conn.fetchrow(
            """INSERT INTO standards_catalogue
               (standard_code, standard_name, standard_type, version, publisher)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (standard_code, version,
                   COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid))
               DO UPDATE SET standard_name=EXCLUDED.standard_name, updated_at=NOW()
               RETURNING id""",
            "CDISC-CT-SDTM",
            f"CDISC SDTM Controlled Terminology {target_version}",
            "controlled_terminology",
            target_version,
            "CDISC/NCI",
        )
        standard_id = std["id"]

        payload = [
            (
                cl["codelist_code"],
                cl["codelist_name"],
                standard_id,
                cl["is_extensible"],
                json.dumps(cl["terms"]),
                target_version,
            )
            for cl in parsed
        ]

        await conn.executemany(
            """INSERT INTO standards_terminology
               (codelist_code, codelist_name, standard_id, is_extensible, terms, version)
               VALUES ($1,$2,$3,$4,$5::jsonb,$6)
               ON CONFLICT (codelist_code, version) DO UPDATE
               SET codelist_name = EXCLUDED.codelist_name,
                   standard_id = EXCLUDED.standard_id,
                   is_extensible = EXCLUDED.is_extensible,
                   terms = EXCLUDED.terms,
                   updated_at = NOW()""",
            payload,
        )

    total_terms = sum(len(cl["terms"]) for cl in parsed)
    return {
        "status": "imported",
        "version": target_version,
        "source_url": source_url,
        "codelists_imported": len(parsed),
        "terms_imported": total_terms,
    }


@app.get("/terminology/search")
async def search_terminology(
    q: str,
    top_k: int = 10,
    version: Optional[str] = None,
):
    ver = await _resolve_ct_version(version)
    embedding = await _embed(q)
    if not embedding:
        # Fallback: text search
        async with db_pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT codelist_code,codelist_name,is_extensible,terms FROM standards_terminology "
                "WHERE version=$1 AND (codelist_name ILIKE $2 OR codelist_code ILIKE $2) LIMIT $3",
                ver, f"%{q}%", top_k,
            )
        return {"results": [dict(r) for r in rows]}

    vec = _vec_str(embedding)
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT codelist_code,codelist_name,is_extensible,"
            f"1 - (embedding <=> '{vec}'::vector) AS similarity "
            f"FROM standards_terminology "
            f"WHERE version=$1 AND embedding IS NOT NULL "
            f"ORDER BY embedding <=> '{vec}'::vector LIMIT $2",
            ver, top_k,
        )
    return {"results": [dict(r) for r in rows], "query": q}


# ─── Regulatory Requirements ──────────────────────────────────────────────────

@app.get("/regulatory/requirements")
async def list_regulatory_requirements(
    authority: Optional[str] = None,
    category: Optional[str] = None,
    applies_to: Optional[str] = None,
    active_only: bool = True,
):
    conditions = ["TRUE"]
    params: list = []
    n = 1
    if active_only:
        conditions.append("is_active = TRUE")
    if authority:
        conditions.append(f"authority = ${n}"); params.append(authority); n += 1
    if category:
        conditions.append(f"category = ${n}"); params.append(category); n += 1
    if applies_to:
        conditions.append(f"${n} = ANY(applies_to)"); params.append(applies_to); n += 1

    where = " AND ".join(conditions)
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT id,req_code,authority,category,requirement_text,rationale,"
            f"applies_to,effective_date FROM regulatory_requirements "
            f"WHERE {where} ORDER BY authority, category, req_code", *params
        )
    return {"requirements": [dict(r) for r in rows]}


@app.get("/regulatory/requirements/{req_code}")
async def get_regulatory_requirement(req_code: str):
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM regulatory_requirements WHERE req_code = $1", req_code
        )
    if not row:
        raise HTTPException(404, "Regulatory requirement not found")
    return dict(row)


@app.post("/regulatory/validate")
async def validate_regulatory(body: RegulatoryValidateRequest):
    conditions = ["is_active = TRUE"]
    params: list = []
    n = 1
    if body.authority:
        conditions.append(f"authority = ${n}"); params.append(body.authority); n += 1
    if body.category:
        conditions.append(f"category = ${n}"); params.append(body.category); n += 1

    applies_conditions = [f"${n} = ANY(applies_to)" for _ in body.applies_to]
    if applies_conditions:
        conditions.append("(" + " OR ".join(applies_conditions) + ")")
        params.extend(body.applies_to)

    where = " AND ".join(conditions)
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT req_code,authority,category,requirement_text,applies_to "
            f"FROM regulatory_requirements WHERE {where} ORDER BY authority",
            *params,
        )
    return {
        "applicable_requirements": [dict(r) for r in rows],
        "count": len(rows),
        "applies_to": body.applies_to,
    }


# ─── Temporal Timelines ───────────────────────────────────────────────────────

@app.get("/temporal/timelines")
async def list_timelines(
    org_id: Optional[str] = None,
    study_id: Optional[str] = None,
    timeline_type: Optional[str] = None,
    upcoming_days: Optional[int] = None,
):
    conditions = ["is_active = TRUE"]
    params: list = []
    n = 1
    if org_id:
        conditions.append(f"(org_id = ${n} OR org_id IS NULL)"); params.append(uuid.UUID(org_id)); n += 1
    if study_id:
        conditions.append(f"(study_id = ${n} OR study_id IS NULL)"); params.append(uuid.UUID(study_id)); n += 1
    if timeline_type:
        conditions.append(f"timeline_type = ${n}"); params.append(timeline_type); n += 1
    if upcoming_days:
        conditions.append(f"target_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '{upcoming_days} days')")

    where = " AND ".join(conditions)
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT id,org_id,study_id,timeline_type,label,target_date,"
            f"alert_days_before,metadata FROM temporal_timelines "
            f"WHERE {where} ORDER BY target_date ASC",
            *params,
        )
    return {"timelines": [dict(r) for r in rows]}


@app.post("/temporal/timelines", status_code=201)
async def create_timeline(body: TimelineCreate):
    org = uuid.UUID(body.org_id) if body.org_id else None
    study = uuid.UUID(body.study_id) if body.study_id else None
    std = uuid.UUID(body.related_standard_id) if body.related_standard_id else None
    target = date.fromisoformat(body.target_date)
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO temporal_timelines
               (org_id,study_id,timeline_type,label,target_date,
                related_standard_id,alert_days_before,metadata)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
               RETURNING id""",
            org, study, body.timeline_type, body.label, target,
            std, body.alert_days_before, json.dumps(body.metadata),
        )
    return {"id": str(row["id"])}


# ─── Provenance ───────────────────────────────────────────────────────────────

@app.get("/provenance/{artifact_id}")
async def get_provenance(artifact_id: str, org_id: Optional[str] = Query(None)):
    conditions = ["artifact_id = $1"]
    params: list = [artifact_id]
    n = 2
    if org_id:
        conditions.append(f"org_id = ${n}"); params.append(uuid.UUID(org_id)); n += 1

    where = " AND ".join(conditions)
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT id,artifact_id,artifact_type,org_id,study_id,action,"
            f"actor_type,actor_id,parent_artifact_ids,model_id,model_version,"
            f"run_id,metadata,created_at FROM provenance_records "
            f"WHERE {where} ORDER BY created_at ASC",
            *params,
        )
    if not rows:
        raise HTTPException(404, "No provenance records found for this artifact")

    records = [dict(r) for r in rows]
    # Build lineage chain
    lineage_chain = _build_lineage_chain(records)
    return {"artifact_id": artifact_id, "records": records, "lineage_chain": lineage_chain}


def _build_lineage_chain(records: list[dict]) -> list[dict]:
    """Return a simplified ordered lineage showing artifact transformation flow."""
    chain = []
    for r in records:
        chain.append({
            "step": r["action"],
            "actor": f"{r['actor_type']}:{r['actor_id']}",
            "timestamp": r["created_at"].isoformat() if r.get("created_at") else None,
            "from": r.get("parent_artifact_ids") or [],
        })
    return chain


# ─── ICH M11 Validation ──────────────────────────────────────────────────────

class ICHM11ValidateRequest(BaseModel):
    protocol_text:       Optional[str]  = None
    structured_sections: dict           = {}
    usdm_data:           Optional[dict] = None

@app.get("/ich-m11/sections")
async def get_ich_m11_sections():
    """Return the ICH M11 mandatory section structure."""
    return {"sections": ICH_M11_MANDATORY_SECTIONS, "total": len(ICH_M11_MANDATORY_SECTIONS),
            "standard": "ICH-M11-2024", "version": "2"}

@app.post("/ich-m11/validate")
async def validate_ich_m11(body: ICHM11ValidateRequest):
    """
    Validate a protocol against ICH M11 CeSHarP mandatory structure.

    Performs two-phase validation:
    Phase A — Section presence check using keyword matching on protocol_text
              or explicit structured_sections dict (keys = section ids like 'S04').
    Phase B — USDM alignment: when usdm_data provided, verifies USDM elements
              cover the required M11 sections (arms→S06, objectives→S04, etc.).
    """
    findings: list[dict] = []
    score = 100
    text_lower = (body.protocol_text or "").lower()
    sections_present: dict[str, str] = {}  # section_id → "found"|"partial"|"missing"

    def _deduct(section_id: str, severity: str, msg: str):
        nonlocal score
        findings.append({"section_id": section_id, "severity": severity, "message": msg})
        score -= {"critical": 15, "major": 8, "minor": 3}.get(severity, 5)

    # ── Phase A: Section presence (keyword + structured_sections) ──────────
    for sec in ICH_M11_MANDATORY_SECTIONS:
        sid = sec["id"]
        # 1. Explicit structured section provided
        if body.structured_sections.get(sid) or body.structured_sections.get(sec["title"]):
            sections_present[sid] = "found"
            continue
        # 2. Keyword scan in protocol text
        if text_lower:
            matched = sum(1 for kw in sec["keywords"] if kw.lower() in text_lower)
            if matched >= 2:
                sections_present[sid] = "found"
            elif matched == 1:
                sections_present[sid] = "partial"
                severity = "major" if sec["critical"] else "minor"
                _deduct(sid, severity,
                        f"Section '{sec['title']}' partially detected — strengthen with "
                        f"explicit headings or more content.")
            else:
                sections_present[sid] = "missing"
                severity = "critical" if sec["critical"] else "major"
                _deduct(sid, severity,
                        f"Section '{sec['title']}' ({sid}) not found in protocol. "
                        f"ICH M11 req: {', '.join(sec['keywords'][:3])}.")
        else:
            sections_present[sid] = "unknown"

    # ── Phase B: USDM alignment ────────────────────────────────────────────
    usdm_coverage: dict[str, bool] = {}
    if body.usdm_data:
        def _usdm_design(u: dict) -> dict:
            study = u.get("study", u)
            versions = study.get("versions", [])
            if versions:
                designs = versions[0].get("studyDesigns", [])
                if designs:
                    return designs[0]
            return study

        design = _usdm_design(body.usdm_data)
        pop = design.get("population", {})

        usdm_coverage = {
            "S03": bool(design.get("indications")),
            "S04": bool(design.get("objectives")),
            "S05": bool(pop.get("criteria") or design.get("eligibilityCriteria")),
            "S06": bool(design.get("arms")),
            "S08": bool(design.get("encounters") or design.get("scheduleTimelines")),
            "S09": bool(design.get("estimands")),
        }
        for sid, covered in usdm_coverage.items():
            if covered:
                sections_present[sid] = "found"  # USDM presence overrides text absence
            elif sections_present.get(sid) == "missing":
                sec_meta = next((s for s in ICH_M11_MANDATORY_SECTIONS if s["id"] == sid), {})
                if sec_meta.get("critical"):
                    _deduct(sid, "major",
                            f"Section '{sec_meta.get('title', sid)}' missing in both protocol text "
                            f"and USDM elements.")

    conformant = not any(f["severity"] == "critical" for f in findings)
    return {
        "standard": "ICH-M11-2024",
        "conformant": conformant,
        "score": max(0, score),
        "sections_present": sections_present,
        "usdm_coverage": usdm_coverage,
        "findings_count": len(findings),
        "findings": findings,
    }


# ─── USDM v4.0 Conformance Validation ───────────────────────────────────────

class USDMValidateRequest(BaseModel):
    usdm_data: dict
    version:   str = "4.0"

@app.post("/usdm/validate")
async def validate_usdm(body: USDMValidateRequest):
    """
    Validate a USDM document against v4.0 conformance rules.
    Checks mandatory class presence, arm/epoch cardinality, and
    eligibility criterion IETESTCD/IECAT mapping requirements.
    Returns findings list with severity and rule reference.
    """
    usdm = body.usdm_data
    findings: list[dict] = []
    score = 100

    # Navigate USDM v4.0 path
    study   = usdm.get("study", usdm)
    version = (study.get("versions") or [{}])[0]
    designs = version.get("studyDesigns", [])
    design  = designs[0] if designs else study

    def _add(rule_id: str, severity: str, msg: str):
        nonlocal score
        findings.append({"rule_id": rule_id, "severity": severity, "message": msg})
        score -= {"critical": 20, "major": 10, "minor": 2}.get(severity, 5)

    # USDM-CONF-001: at least one arm required
    arms = design.get("arms", design.get("studyArms", []))
    if not arms:
        _add("USDM-CONF-001", "critical", "StudyDesign must have at least one StudyArm (arms[]).")

    # USDM-CONF-002: at least one epoch required
    epochs = design.get("epochs", design.get("studyEpochs", []))
    if not epochs:
        _add("USDM-CONF-002", "critical", "StudyDesign must have at least one StudyEpoch (epochs[]).")

    # USDM-CONF-003: at least one objective/endpoint
    objectives = design.get("objectives", [])
    if not objectives:
        _add("USDM-CONF-003", "major", "StudyDesign should have at least one Objective.")
    else:
        has_endpoint = any(obj.get("endpoints") for obj in objectives)
        if not has_endpoint:
            _add("USDM-CONF-004", "major", "At least one Objective must have at least one Endpoint.")

    # USDM-CONF-005: population must be present
    population = design.get("population", {})
    if not population:
        _add("USDM-CONF-005", "major", "StudyDesign must have a population (StudyDesignPopulation).")

    # USDM-CONF-006: eligibility criteria must have identifier (IETESTCD) + category (IECAT)
    criteria_from_population = population.get("criteria", []) if population else []
    criteria_from_version    = version.get("eligibilityCriteria", [])
    all_criteria = criteria_from_population + criteria_from_version
    for i, crit in enumerate(all_criteria):
        if not crit.get("identifier"):
            _add("USDM-CONF-006", "minor",
                 f"EligibilityCriterion[{i}] missing 'identifier' attribute (maps to IETESTCD).")
        if not crit.get("category"):
            _add("USDM-CONF-007", "minor",
                 f"EligibilityCriterion[{i}] missing 'category' attribute (maps to IECAT: INCL/EXCL).")

    # USDM-CONF-008: studyCells should exist if both arms and epochs are present
    cells = design.get("studyCells", [])
    if arms and epochs and not cells:
        _add("USDM-CONF-008", "minor",
             "StudyDesign has arms and epochs but no studyCells. "
             "StudyCells define the arm×epoch matrix required for TA domain.")

    # USDM-CONF-009: epoch type should be coded
    for i, ep in enumerate(epochs):
        if not ep.get("type"):
            _add("USDM-CONF-009", "minor",
                 f"StudyEpoch[{i}] ('{ep.get('name', '')}') missing 'type' code (SDTM EPOCH codelist C99077).")

    # USDM-CONF-010: arm type should be coded
    for i, arm in enumerate(arms):
        if not arm.get("type"):
            _add("USDM-CONF-010", "minor",
                 f"StudyArm[{i}] ('{arm.get('name', '')}') missing 'type' code (ARMTYPE codelist).")

    conformant = not any(f["severity"] == "critical" for f in findings)
    return {
        "usdm_version": body.version,
        "conformant": conformant,
        "score": max(0, score),
        "findings_count": len(findings),
        "findings": findings,
    }


@app.get("/mdr-alignment")
async def get_mdr_alignment():
    """
    Pfizer MDR Integration Architecture manifest.
    Returns the USDM v4.0 → Pfizer MDR field mapping and integration patterns.
    Addresses Pfizer DDF Evaluation Criterion 6: Interoperability & Standards Alignment.
    """
    return {
        "title": "Trialo ↔ Pfizer MDR Integration Architecture",
        "version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "trialo_output_format": "USDM v4.0 JSON (CDISC standard)",
        "standards_alignment": [
            "USDM v4.0 (CDISC)",
            "ICH M11 CeSHarP v2 (FDA/EMA)",
            "CDISC Controlled Terminology 2024",
            "ICH E6(R3) GCP",
            "FDA 21 CFR Part 11",
            "ICH E9 Statistical Principles",
        ],
        "mdr_field_mapping": {
            "study_title":       "study.officialTitle → MDR StudyRecord.title",
            "protocol_number":   "study.studyIdentifiers[0].id → MDR StudyRecord.protocolNumber",
            "protocol_version":  "study.versions[0].versionIdentifier → MDR ProtocolVersion.identifier",
            "sponsor":           "study.studyIdentifiers[{org}] → MDR SponsorRecord.name",
            "therapeutic_area":  "study.businessTherapeuticAreas[0].code → MDR TherapeuticArea",
            "study_phase":       "study.versions[0].studyDesigns[0].studyPhase → MDR StudyPhase",
            "study_design":      "study.versions[0].studyDesigns[0] → MDR StudyDesign",
            "arms":              "studyDesigns[0].arms[] → MDR ArmRecord[]",
            "epochs":            "studyDesigns[0].epochs[] → MDR EpochRecord[]",
            "objectives":        "studyDesigns[0].objectives[] → MDR ObjectiveRecord[]",
            "primary_endpoint":  "studyDesigns[0].objectives[0].endpoints[0] → MDR PrimaryEndpoint",
            "eligibility_inc":   "studyDesigns[0].population.criteria[INCL] → MDR InclusionCriteria[]",
            "eligibility_exc":   "studyDesigns[0].population.criteria[EXCL] → MDR ExclusionCriteria[]",
            "soa":               "studyDesigns[0].scheduleTimelines[] → MDR ScheduleOfActivities",
            "estimands":         "studyDesigns[0].estimands[] → MDR EstimandRecord[]",
            "indications":       "studyDesigns[0].indications[] → MDR IndicationRecord[]",
        },
        "integration_patterns": [
            {
                "name": "REST Pull",
                "description": "Pfizer MDR polls Trialo REST API to consume study updates",
                "endpoint": "GET /usdm/{conversion_id}",
                "format": "application/json (USDM v4.0)",
                "authentication": "JWT Bearer (Auth0)",
            },
            {
                "name": "Event-Driven Push",
                "description": "Trialo publishes study events to Kafka; MDR subscribes",
                "topic": "trialo.events.study",
                "event_types": ["study.created", "study.design.extracted", "study.approved"],
                "format": "CloudEvents 1.0 + USDM v4.0 payload",
            },
            {
                "name": "GraphQL Governed Query",
                "description": "MDR or downstream systems query Trialo GraphQL for structured data",
                "endpoint": "POST graphql:4000/graphql",
                "schema": "StudyDesign, StudyArm, Objective, EligibilityCriterion, Estimand",
            },
            {
                "name": "Pre-Ingestion Validation",
                "description": "Before MDR ingestion, Trialo validates against ICH M11 + USDM schema",
                "endpoints": ["POST /ich-m11/validate", "POST /usdm/validate"],
                "validation_result": "conformant: bool, score: int, findings: []",
            },
        ],
        "data_quality_guarantees": {
            "hallucination_detection": "Every USDM conversion output is automatically evaluated by LLM judge for faithfulness and hallucination",
            "provenance": "Every field traces to source document chunks via decision_traces.sources_cited",
            "audit_trail": "21 CFR Part 11 compliant SHA-256 hash-chained audit trail",
            "ich_m11_validation": "Auto-triggered ICH M11 structural + USDM alignment check on every protocol",
            "hitl_approval": "Human-in-the-loop review before USDM output is promoted to 'approved' status",
        },
    }


@app.post("/provenance/record", status_code=201)
async def record_provenance(body: ProvenanceRecord):
    org = uuid.UUID(body.org_id)
    study = uuid.UUID(body.study_id) if body.study_id else None
    run = uuid.UUID(body.run_id) if body.run_id else None
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO provenance_records
               (artifact_id,artifact_type,org_id,study_id,action,
                actor_type,actor_id,parent_artifact_ids,model_id,
                model_version,run_id,metadata)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
               RETURNING id""",
            body.artifact_id, body.artifact_type, org, study, body.action,
            body.actor_type, body.actor_id, body.parent_artifact_ids,
            body.model_id, body.model_version, run, json.dumps(body.metadata),
        )
    return {"id": str(row["id"])}
