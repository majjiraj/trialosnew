"""
TrialOS Data Platform API
Exposes endpoints for triggering and monitoring Bronze→Silver→Gold pipelines.
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, BackgroundTasks, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pydantic_settings import BaseSettings
import structlog
import asyncpg
from sdtm_pipeline import BronzeToSilverPipeline, SilverToGoldPipeline, SDTMConformanceChecker
from datetime import datetime, timezone
import uuid
import io
import zipfile
import tempfile
import os
from typing import List, Optional

log = structlog.get_logger()

class Settings(BaseSettings):
    database_url: str
    s3_endpoint: str = "http://localhost:9000"

    class Config:
        env_file = ".env"
        extra = 'ignore'

settings = Settings()
db_pool: asyncpg.Pool = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global db_pool
    db_pool = await asyncpg.create_pool(settings.database_url)
    log.info("data_platform.startup")
    yield
    await db_pool.close()

app = FastAPI(title="TrialOS Data Platform", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class PipelineRunRequest(BaseModel):
    study_id: str
    org_id: str
    domains: list[str] = ["DM","AE","LB","VS","CM"]
    source_records: dict[str, list[dict]]  # domain -> records

class ConformanceCheckRequest(BaseModel):
    study_id: str
    org_id: str
    domain_data: dict[str, list[dict]]

@app.get("/health")
async def health():
    return {"status": "ok", "service": "data-platform"}

@app.post("/pipeline/bronze-to-silver")
async def run_bronze_to_silver(req: PipelineRunRequest, background_tasks: BackgroundTasks):
    run_id = str(uuid.uuid4())
    background_tasks.add_task(_run_pipeline, run_id, req)
    return {"run_id": run_id, "status": "queued"}

async def _run_pipeline(run_id: str, req: PipelineRunRequest):
    pipeline = BronzeToSilverPipeline(db_pool)
    async with db_pool.acquire() as conn:
        study = await conn.fetchrow("SELECT * FROM studies WHERE id=$1", req.study_id)

    study_info = dict(study) if study else {}

    results = {}
    for domain in req.domains:
        if domain in req.source_records:
            result = await pipeline.transform_domain(
                req.study_id, req.org_id, domain,
                req.source_records[domain], study_info
            )
            results[domain] = result

    log.info("pipeline.bronze_to_silver.complete", run_id=run_id, domains=list(results.keys()))

@app.post("/conformance/check")
async def run_conformance_check(req: ConformanceCheckRequest):
    checker = SDTMConformanceChecker()
    result = checker.check_all_domains(req.domain_data)
    return result


# ── SDTM → Raw Dataset Reverse Generator ─────────────────────────────────────
#
# Accepts one or more SDTM source files (XPT / CSV / XLS / XLSX) plus an
# optional blank CRF (PDF / XLS / XLSX / CSV).  For every domain detected it
# produces a raw CSV whose columns are mapped back to study-form field names
# derived from (a) the CRF field labels when available, or (b) a built-in
# SDTM→raw name lookup table.  All per-domain CSVs are bundled into a ZIP
# that is streamed back to the caller.

# Standard SDTM variable → typical raw CRF field name mapping (per domain)
_SDTM_TO_RAW: dict[str, dict[str, str]] = {
    "DM": {
        "STUDYID": "Study_ID", "USUBJID": "Subject_ID", "SUBJID": "Patient_Number",
        "SITEID": "Site_Number", "AGE": "Age_Years", "AGEU": "Age_Unit",
        "SEX": "Gender", "RACE": "Race", "ETHNIC": "Ethnicity",
        "ARMCD": "Treatment_Arm_Code", "ARM": "Treatment_Arm",
        "DTHFL": "Death_Flag", "DTHDTC": "Death_Date",
        "RFSTDTC": "First_Dose_Date", "RFENDTC": "Last_Dose_Date",
        "COUNTRY": "Country", "INVID": "Investigator_ID",
    },
    "AE": {
        "USUBJID": "Subject_ID", "AETERM": "Adverse_Event_Term",
        "AEVERBATIM": "Verbatim_AE", "AEBODSYS": "Body_System",
        "AESTDTC": "AE_Start_Date", "AEENDTC": "AE_End_Date",
        "AESEV": "Severity", "AESER": "Serious_AE",
        "AEREL": "Causality", "AEOUT": "Outcome",
        "AESDTH": "Related_to_Death", "AESLIFE": "Life_Threatening",
        "AESHOSP": "Hospitalisation_Required", "AEACN": "Action_Taken",
        "AEDTHDTC": "Death_Date_AE", "AETOXGR": "Toxicity_Grade",
    },
    "CM": {
        "USUBJID": "Subject_ID", "CMTRT": "Medication_Name",
        "CMCAT": "Category", "CMSTDTC": "Start_Date",
        "CMENDTC": "End_Date", "CMDOSE": "Dose",
        "CMDOSU": "Dose_Unit", "CMROUTE": "Route",
        "CMINDCD": "Indication_Code", "CMINDC": "Indication",
    },
    "LB": {
        "USUBJID": "Subject_ID", "LBTEST": "Lab_Test_Name",
        "LBCAT": "Lab_Category", "LBORRES": "Lab_Result_Original",
        "LBORRESU": "Lab_Result_Unit", "LBSTRESN": "Lab_Result_Numeric",
        "LBSTNRLO": "Normal_Range_Low", "LBSTNRHI": "Normal_Range_High",
        "LBNRIND": "Normal_Range_Indicator", "LBDTC": "Lab_Date",
        "LBBLFL": "Baseline_Flag",
    },
    "VS": {
        "USUBJID": "Subject_ID", "VSTEST": "Vital_Sign_Test",
        "VSORRES": "Result_Original", "VSORRESU": "Result_Unit",
        "VSSTRESN": "Result_Numeric", "VSDTC": "Assessment_Date",
        "VSPOS": "Position", "VISITNUM": "Visit_Number", "VISIT": "Visit_Name",
        "VSBLFL": "Baseline_Flag",
    },
    "EX": {
        "USUBJID": "Subject_ID", "EXTRT": "Study_Treatment",
        "EXDOSE": "Dose", "EXDOSU": "Dose_Unit",
        "EXDOSFRM": "Dosage_Form", "EXROUTE": "Route",
        "EXSTDTC": "Start_Date", "EXENDTC": "End_Date",
        "VISITNUM": "Visit_Number", "VISIT": "Visit_Name",
    },
    "DS": {
        "USUBJID": "Subject_ID", "DSDECOD": "Disposition_Term",
        "DSTERM": "Verbatim_Disposition", "DSCAT": "Category",
        "DSSCAT": "Sub_Category", "DSSTDTC": "Disposition_Date",
        "VISITNUM": "Visit_Number",
    },
    "MH": {
        "USUBJID": "Subject_ID", "MHTERM": "Medical_History_Term",
        "MHBODSYS": "Body_System", "MHSTDTC": "Start_Date",
        "MHENDTC": "End_Date", "MHONGO": "Ongoing_Flag",
    },
    "SC": {
        "USUBJID": "Subject_ID", "SCTESTCD": "Characteristic_Code",
        "SCTEST": "Characteristic", "SCORRES": "Result",
        "SCORRESN": "Result_Numeric", "SCDTC": "Date",
    },
    "IE": {
        "USUBJID": "Subject_ID", "IETESTCD": "Criterion_Code",
        "IETEST": "Criterion", "IEORRES": "Result",
        "IECAT": "Category",
    },
    "SV": {
        "USUBJID": "Subject_ID", "VISITNUM": "Visit_Number",
        "VISIT": "Visit_Name", "SVSTDTC": "Visit_Start_Date",
        "SVENDTC": "Visit_End_Date",
    },
    "TU": {
        "USUBJID": "Subject_ID", "TUTESTCD": "Tumor_Test_Code",
        "TUTEST": "Tumor_Test", "TUORRES": "Result",
        "TULOC": "Location", "TUMETHOD": "Method", "TUDTC": "Date",
    },
    "TR": {
        "USUBJID": "Subject_ID", "TRTESTCD": "Response_Code",
        "TRTEST": "Response_Test", "TRORRES": "Result",
        "TRLOC": "Location", "TRDTC": "Date",
    },
    "RS": {
        "USUBJID": "Subject_ID", "RSTESTCD": "Response_Code",
        "RSTEST": "Response", "RSORRES": "Result",
        "RSDTC": "Date", "RSEVAL": "Evaluator",
    },
    "QS": {
        "USUBJID": "Subject_ID", "QSTESTCD": "Questionnaire_Code",
        "QSTEST": "Question", "QSORRES": "Answer",
        "QSORRESU": "Unit", "QSSTRESN": "Numeric_Result",
        "QSDTC": "Date", "VISIT": "Visit_Name",
    },
    "FA": {
        "USUBJID": "Subject_ID", "FATESTCD": "Finding_Code",
        "FATEST": "Finding", "FAORRES": "Result",
        "FADTC": "Date",
    },
    "ML": {
        "USUBJID": "Subject_ID", "MLTESTCD": "Meal_Code",
        "MLTEST": "Meal_Type", "MLORRES": "Result", "MLDTC": "Date",
    },
    "DD": {
        "USUBJID": "Subject_ID", "DDTERM": "Death_Cause",
        "DDCAT": "Category", "DDDTC": "Date",
        "DDDECOD": "Coded_Cause",
    },
    # ── Special-Purpose Datasets ───────────────────────────────────────────────
    "SE": {
        "STUDYID": "Study_ID", "USUBJID": "Subject_ID", "SESEQ": "SE_Sequence",
        "ETCD": "Element_Code", "ELEMENT": "Element_Name",
        "SESTDTC": "Element_Start_Date", "SEENDTC": "Element_End_Date",
        "TAETORD": "Planned_Element_Order", "EPOCH": "Epoch",
    },
    "RELREC": {
        "STUDYID": "Study_ID", "RDOMAIN": "Related_Domain",
        "USUBJID": "Subject_ID", "IDVAR": "Identifier_Variable",
        "IDVARVAL": "Identifier_Value", "RELTYPE": "Relationship_Type",
        "RELID": "Relationship_ID",
    },
    # ── Trial Design Datasets (no USUBJID — study-level) ───────────────────────
    "TA": {
        "STUDYID": "Study_ID", "ARMCD": "Arm_Code", "ARM": "Arm_Name",
        "TAETORD": "Element_Order", "ETCD": "Element_Code",
        "ELEMENT": "Element_Name", "TABRANCH": "Branching_Rule",
        "TATRANS": "Transition_Rule", "EPOCH": "Epoch",
    },
    "TE": {
        "STUDYID": "Study_ID", "ETCD": "Element_Code", "ELEMENT": "Element_Name",
        "TESTRL": "Start_Rule", "TEENRL": "End_Rule", "TEDUR": "Planned_Duration",
    },
    "TI": {
        "STUDYID": "Study_ID", "IETESTCD": "Criterion_Code",
        "IETEST": "Criterion_Description", "IECAT": "Category",
        "IESCAT": "Sub_Category", "TIRL": "Rule", "TIVERS": "Version",
    },
    "TS": {
        "STUDYID": "Study_ID", "TSPARMCD": "Parameter_Code",
        "TSPARM": "Parameter_Name", "TSVAL": "Value",
        "TSVALNF": "Value_Not_Found", "TSVALCD": "Value_Code",
        "TSVCDREF": "Codelist_Reference", "TSVCDVER": "Codelist_Version",
    },
    "TV": {
        "STUDYID": "Study_ID", "VISITNUM": "Visit_Number",
        "VISIT": "Visit_Name", "VISITDY": "Planned_Study_Day",
        "ARMCD": "Arm_Code", "TVSTRL": "Visit_Start_Rule",
        "TVENRL": "Visit_End_Rule",
    },
}
# Fallback: columns not in the domain map keep the SDTM name as-is.

# SUPP columns that are infrastructure — not written to the pivoted output
_SUPP_META_COLS = {"STUDYID", "RDOMAIN", "IDVAR", "IDVARVAL", "QORIG", "QEVAL"}

# Flat cross-domain lookup — used as third-priority fallback in _apply_raw_mapping
# (domain-specific map is checked first, CRF map is checked before both)
_GLOBAL_SDTM_MAP: dict[str, str] = {}
for _d in _SDTM_TO_RAW.values():
    for _k, _v in _d.items():
        if _k not in _GLOBAL_SDTM_MAP:
            _GLOBAL_SDTM_MAP[_k] = _v
# Inject cross-domain variables absent from the per-domain maps
_GLOBAL_SDTM_MAP.update({
    k: v for k, v in {
        "DOMAIN": "Domain", "STUDYID": "Study_ID",
        "USUBJID": "Subject_ID", "EPOCH": "Epoch",
        "GRPID": "Group_ID", "REFID": "Reference_ID", "SPID": "Sponsor_ID",
        # Sequence variables (one per domain)
        "AESEQ": "AE_Sequence", "CMSEQ": "CM_Sequence", "DMSEQ": "DM_Sequence",
        "DSSEQ": "DS_Sequence", "EXSEQ": "EX_Sequence", "LBSEQ": "LB_Sequence",
        "MHSEQ": "MH_Sequence", "QSSEQ": "QS_Sequence", "SCSEQ": "SC_Sequence",
        "SESEQ": "SE_Sequence", "SVSEQ": "SV_Sequence", "TUSEQ": "TU_Sequence",
        "TRSEQ": "TR_Sequence", "RSSEQ": "RS_Sequence", "VSSEQ": "VS_Sequence",
    }.items()
    if k not in _GLOBAL_SDTM_MAP
})


def _humanize_sdtm_name(col: str) -> str:
    """
    Last-resort conversion of an unmapped SDTM variable name to a readable
    label.  Output must never look like a CDISC abbreviation.
    Examples: AESTDTC → "AE Start Date", LBSTNRHI → "LB Normal High"

    Only called for pure-uppercase SDTM names.  Columns that already contain
    spaces or mixed case are treated as already human-readable by the caller
    (_apply_raw_mapping) and will never reach this function.
    """
    import re
    # Expand known SDTM suffix tokens to English words
    _SUFFIX_MAP = {
        "STDTC": "Start Date", "ENDTC": "End Date", "DTC": "Date",
        "ORRES": "Original Result", "ORRESU": "Original Unit",
        "STRESN": "Numeric Result", "STRESU": "Result Unit",
        "STNRLO": "Normal Low", "STNRHI": "Normal High",
        "NRIND": "Normal Range Indicator", "BLFL": "Baseline Flag",
        "TESTCD": "Test Code", "TEST": "Test", "CAT": "Category",
        "SCAT": "Sub-Category", "SEQ": "Sequence", "GRPID": "Group ID",
        "REFID": "Reference ID", "SPID": "Sponsor ID", "FL": "Flag",
        "TERM": "Term", "BODSYS": "Body System", "REL": "Causality",
        "OUT": "Outcome", "ACN": "Action Taken", "TOXGR": "Toxicity Grade",
        "DOSE": "Dose", "DOSU": "Dose Unit", "ROUTE": "Route",
        "FORM": "Form", "IND": "Indication", "LOC": "Location",
    }
    # SDTM domain codes are exactly 2 uppercase letters — never 3
    _SDTM_DOMAINS = {
        "AE", "CM", "DM", "DS", "EX", "FA", "IE", "LB",
        "ML", "MH", "QS", "RS", "SC", "SE", "SV", "TR",
        "TU", "TV", "VS", "TA", "TE", "TI", "TS", "DD",
    }
    upper = col.upper()
    # Only strip an exact 2-char domain prefix
    domain_prefix = ""
    remainder = upper
    prefix_match = re.match(r'^([A-Z]{2})(?=[A-Z])', upper)
    if prefix_match and prefix_match.group(1) in _SDTM_DOMAINS:
        domain_prefix = prefix_match.group(1)
        remainder = upper[2:]
    # Try to match a known suffix token (longest match first)
    label_parts: list[str] = []
    for token, word in sorted(_SUFFIX_MAP.items(), key=lambda x: -len(x[0])):
        if remainder.endswith(token):
            label_parts.insert(0, word)
            remainder = remainder[: -len(token)]
            break
    if remainder:
        label_parts.insert(0, remainder.title())
    if domain_prefix:
        label_parts.insert(0, domain_prefix)
    result = " ".join(label_parts).strip()
    return result if result else col.title()


def _is_supp(domain: str) -> bool:
    """True for SUPPAE, SUPPDM, SUPPLB, etc."""
    return domain.upper().startswith("SUPP") and len(domain) > 4


def _parent_of_supp(supp_domain: str) -> str:
    """SUPPAE → AE, SUPPDM → DM, SUPPLB → LB, etc."""
    return supp_domain[4:].upper()


def _detect_domain_from_filename(filename: str) -> str:
    stem = os.path.splitext(filename)[0].upper()
    # Exact match in known maps
    if stem in _SDTM_TO_RAW or _is_supp(stem):
        return stem
    # Files like "DM_2024.xpt" or "AE-final.xpt" — try first token
    first = stem.split("_")[0].split("-")[0]
    if first in _SDTM_TO_RAW or _is_supp(first):
        return first
    # Return whatever we have — will fall back to identity mapping
    return stem


def _pivot_supp(df: "pd.DataFrame", crf_map: dict[str, str] | None = None) -> "pd.DataFrame":
    """
    Convert a SUPP-- long dataset to wide format and name every column
    using the CRF-supplied label (priority: crf_map > QLABEL > QNAM).

    Key details:
    - IDVAR/IDVARVAL are resolved so the result has a real sequence column
      (e.g. AESEQ) that can be used as the merge key into the parent domain.
    - Sequence column values are coerced to numeric so the merge key type
      matches the parent domain dataframe.
    """
    import pandas as pd

    crf_map = crf_map or {}

    if "QNAM" not in df.columns or "QVAL" not in df.columns:
        return df

    # Build QNAM → display label map.
    # Priority: (1) crf_map keyed on QNAM, (2) QLABEL from SUPP dataset, (3) QNAM itself
    col_name_map: dict[str, str] = {}
    qlabel_map: dict[str, str] = {}
    if "QLABEL" in df.columns:
        for _, row in df.drop_duplicates(subset=["QNAM"]).iterrows():
            qnam = str(row["QNAM"]).strip()
            qlabel = str(row.get("QLABEL", "")).strip()
            if qlabel and qlabel.lower() not in ("nan", ""):
                qlabel_map[qnam] = qlabel

    for _, row in df.drop_duplicates(subset=["QNAM"]).iterrows():
        qnam = str(row["QNAM"]).strip()
        if qnam.upper() in crf_map:
            col_name_map[qnam] = crf_map[qnam.upper()]
        elif qnam in qlabel_map:
            col_name_map[qnam] = qlabel_map[qnam]
        else:
            col_name_map[qnam] = qnam  # last resort: keep QNAM (will be humanized later)

    # Resolve IDVAR/IDVARVAL into named columns (e.g. IDVAR=AESEQ → column AESEQ)
    df = df.copy()
    id_extra_cols: list[str] = []
    if "IDVAR" in df.columns and "IDVARVAL" in df.columns:
        for idvar_name in df["IDVAR"].dropna().unique():
            idvar_name = str(idvar_name).strip()
            if not idvar_name:
                continue
            mask = df["IDVAR"] == idvar_name
            if idvar_name not in df.columns:
                df[idvar_name] = None
            df.loc[mask, idvar_name] = df.loc[mask, "IDVARVAL"].values
            # Coerce to numeric — sequence variables in parent domains are numeric,
            # and a type mismatch silently produces an empty merge.
            try:
                df[idvar_name] = pd.to_numeric(df[idvar_name], errors="coerce")
            except Exception:
                pass
            if idvar_name not in id_extra_cols:
                id_extra_cols.append(idvar_name)

    index_cols = [c for c in ["USUBJID"] + id_extra_cols if c in df.columns]
    if not index_cols:
        keep = [c for c in df.columns if c.upper() not in _SUPP_META_COLS - {"RDOMAIN"}]
        return df[keep]

    try:
        pivoted = df.pivot_table(
            index=index_cols, columns="QNAM", values="QVAL", aggfunc="first"
        ).reset_index()
        pivoted.columns.name = None
        # Apply CRF/QLABEL label map to the pivot columns
        pivoted = pivoted.rename(columns=col_name_map)
        return pivoted
    except Exception as e:
        log.warning("supp_pivot.failed", error=str(e))
        label_col = "QLABEL" if "QLABEL" in df.columns else "QNAM"
        return df[[c for c in ["USUBJID"] + id_extra_cols + [label_col, "QVAL"] if c in df.columns]]


def _merge_supp_into_parent(
    parent_df: "pd.DataFrame",
    supp_pivoted: "pd.DataFrame",
    parent_domain: str,
) -> "pd.DataFrame":
    """
    Left-join a pivoted SUPP dataset back into its parent domain dataframe.
    Join key: USUBJID + sequence variable (e.g. AESEQ for AE).
    Coerces join-key types to match the parent so the merge is never silent-empty.
    """
    import pandas as pd

    seq_var = f"{parent_domain}SEQ"
    join_keys = [k for k in ["USUBJID", seq_var] if k in parent_df.columns and k in supp_pivoted.columns]
    if not join_keys:
        join_keys = [k for k in ["USUBJID"] if k in parent_df.columns and k in supp_pivoted.columns]
    if not join_keys:
        return parent_df

    # Coerce join-key dtypes: IDVARVAL in SUPP is always string; parent seq vars are
    # numeric. A type mismatch produces zero matches with no error.
    supp_pivoted = supp_pivoted.copy()
    for key in join_keys:
        if key not in parent_df.columns or key not in supp_pivoted.columns:
            continue
        parent_dtype = parent_df[key].dtype
        try:
            if pd.api.types.is_numeric_dtype(parent_dtype):
                supp_pivoted[key] = pd.to_numeric(supp_pivoted[key], errors="coerce")
            else:
                # Both to string
                parent_df = parent_df.copy()
                parent_df[key] = parent_df[key].astype(str)
                supp_pivoted[key] = supp_pivoted[key].astype(str)
        except Exception:
            pass

    # Only bring in new columns from SUPP (avoid duplicate non-key columns)
    new_cols = [c for c in supp_pivoted.columns if c not in parent_df.columns or c in join_keys]
    try:
        merged = pd.merge(parent_df, supp_pivoted[new_cols], on=join_keys, how="left")
        log.info("supp.merged", parent=parent_domain, join_keys=join_keys,
                 added_cols=len(new_cols) - len(join_keys), total_rows=len(merged))
        return merged
    except Exception as e:
        log.warning("supp.merge.failed", parent=parent_domain, error=str(e))
        return parent_df


def _apply_raw_mapping(df, domain: str, crf_map: dict[str, str]) -> "pd.DataFrame":
    """
    Rename every column to a CRF / human-readable label.

    Priority order (no SDTM name is ever emitted as-is):
      1. CRF map (from the uploaded CRF document)  — keyed on SDTM var name
      2. Domain-specific built-in map (_SDTM_TO_RAW)
      3. Cross-domain built-in map (_GLOBAL_SDTM_MAP)
      4. _humanize_sdtm_name()  — rule-based expansion for everything else

    Duplicate target names are disambiguated by appending the SDTM source name
    in parentheses.
    """
    import pandas as pd
    domain_map = _SDTM_TO_RAW.get(domain, {})
    seen: set[str] = set()
    rename: dict[str, str] = {}
    for col in df.columns:
        # Columns that already contain spaces or mixed case came from a SUPP
        # QLABEL, a CRF extraction pass, or a prior mapping step — they are
        # already display labels and must not be re-processed.
        if ' ' in col or (col != col.upper() and '_' not in col):
            seen.add(col)
            continue
        col_upper = col.upper()
        if col_upper in crf_map:
            target = crf_map[col_upper]
        elif col_upper in domain_map:
            target = domain_map[col_upper]
        elif col_upper in _GLOBAL_SDTM_MAP:
            target = _GLOBAL_SDTM_MAP[col_upper]
        else:
            target = _humanize_sdtm_name(col)
        # Avoid duplicate column names after mapping
        if target in seen:
            target = f"{target} ({col})"
        seen.add(target)
        if target != col:
            rename[col] = target
    return df.rename(columns=rename)


def _extract_crf_field_map(crf_bytes: bytes, crf_filename: str) -> dict[str, str]:
    """
    Extract SDTM_VAR→CRF_label mappings from a blank CRF file.
    Supports PDF (form fields / table headers), XLS/XLSX (header row), CSV.
    Returns a dict: {SDTM_VARIABLE_NAME_UPPER: crf_label}.
    If extraction fails or produces nothing, returns {}.
    """
    import pandas as pd
    ext = os.path.splitext(crf_filename)[1].lower()
    result: dict[str, str] = {}
    try:
        if ext == ".pdf":
            import fitz  # pymupdf
            doc = fitz.open(stream=crf_bytes, filetype="pdf")
            # Attempt 1: PDF form fields (AcroForm)
            for page in doc:
                for field in page.widgets() if hasattr(page, "widgets") else []:
                    name = getattr(field, "field_name", None) or ""
                    label = getattr(field, "field_label", None) or name
                    if name:
                        result[name.upper()] = label or name
            # Attempt 2: table-like text extraction — pick lines that look like
            # "SDTM_VAR: Label" or two-column text blocks
            if not result:
                all_text = "\n".join(page.get_text() for page in doc)
                for line in all_text.splitlines():
                    line = line.strip()
                    if ":" in line:
                        parts = line.split(":", 1)
                        key = parts[0].strip().upper().replace(" ", "_")
                        val = parts[1].strip()
                        if 2 <= len(key) <= 30 and val:
                            result[key] = val
        elif ext in (".xls", ".xlsx"):
            df = pd.read_excel(io.BytesIO(crf_bytes), header=0, nrows=5)
            # Row 0 assumed = SDTM variable names, row 1 = CRF labels
            if len(df) >= 1:
                sdtm_row = list(df.columns)
                label_row = list(df.iloc[0]) if len(df) >= 1 else sdtm_row
                for sdtm, label in zip(sdtm_row, label_row):
                    if sdtm and label:
                        result[str(sdtm).upper()] = str(label)
        elif ext == ".csv":
            df = pd.read_csv(io.BytesIO(crf_bytes), nrows=5)
            if len(df) >= 1:
                sdtm_row = list(df.columns)
                label_row = list(df.iloc[0]) if len(df) >= 1 else sdtm_row
                for sdtm, label in zip(sdtm_row, label_row):
                    if sdtm and label:
                        result[str(sdtm).upper()] = str(label)
    except Exception as e:
        log.warning("crf_extraction.failed", error=str(e))
    return result


async def _parse_sdtm_file(content: bytes, filename: str) -> "tuple[str, pd.DataFrame]":
    """Parse an SDTM file and return (domain, dataframe)."""
    import pandas as pd
    ext = os.path.splitext(filename)[1].lower()
    domain = _detect_domain_from_filename(filename)
    try:
        if ext == ".xpt":
            import pyreadstat
            with tempfile.NamedTemporaryFile(suffix=".xpt", delete=False) as tmp:
                tmp.write(content)
                tmp_path = tmp.name
            try:
                try:
                    df, meta = pyreadstat.read_xport(tmp_path)
                except UnicodeDecodeError:
                    # Older SAS Transport files may use Windows-1252 / latin-1
                    df, meta = pyreadstat.read_xport(tmp_path, encoding="latin1")
            finally:
                os.unlink(tmp_path)
        elif ext in (".xls", ".xlsx"):
            df = pd.read_excel(io.BytesIO(content))
        elif ext == ".csv":
            df = pd.read_csv(io.BytesIO(content))
        else:
            raise ValueError(f"Unsupported file type: {ext}")
        return domain, df
    except Exception as e:
        log.error("sdtm_parse.failed", filename=filename, error=str(e))
        raise HTTPException(status_code=422, detail=f"Could not parse {filename}: {e}")


def _domain_filename(domain: str) -> str:
    """
    Convert a SDTM domain code to a filesystem-safe human-readable name.
    Uses _DOMAIN_LABELS (defined below) at call time so the ordering in the
    module does not matter.
      AE          → Adverse_Events
      LB          → Laboratory_Results
      SUPPAE      → Supplemental_AE
      RELREC      → Related_Records
    Falls back to the domain code itself for unknown domains.
    """
    import re as _re
    label = _DOMAIN_LABELS.get(domain.upper(), domain)
    return _re.sub(r'[^A-Za-z0-9]+', '_', label).strip('_')


@app.post(
    "/raw-datasets/generate",
    summary="Reverse-generate raw datasets from SDTM files",
    response_description="ZIP archive containing one CSV per detected SDTM domain",
)
async def generate_raw_datasets(
    sdtm_files: List[UploadFile] = File(..., description="SDTM domain files: XPT, CSV, XLS, XLSX"),
    crf_file: Optional[UploadFile] = File(None, description="Blank CRF for field-name mapping: PDF, XLS, XLSX, CSV"),
    split_lb_by_category: bool = Form(False, description="When true, split the LB domain into one CSV per LBCAT value"),
):
    """
    Accept one or more SDTM files plus an optional blank CRF.
    For each domain file, reverse-map SDTM variable names to raw CRF field
    labels (using the CRF when provided, otherwise the built-in lookup table)
    and return all per-domain raw CSVs as a single ZIP download.
    """
    import pandas as pd

    if not sdtm_files:
        raise HTTPException(status_code=400, detail="At least one SDTM file is required.")

    # -- parse CRF field map if supplied
    crf_map: dict[str, str] = {}
    if crf_file and crf_file.filename:
        crf_bytes = await crf_file.read()
        crf_map = _extract_crf_field_map(crf_bytes, crf_file.filename)
        log.info("crf.loaded", fields=len(crf_map), filename=crf_file.filename)

    # -- parse each SDTM file and build domain → df map
    domain_dfs: dict[str, pd.DataFrame] = {}
    skipped_files: list[str] = []
    for upload in sdtm_files:
        content = await upload.read()
        try:
            domain, df = await _parse_sdtm_file(content, upload.filename or "unknown.xpt")
        except HTTPException as exc:
            # Log and skip — don't let one bad file abort all other domains
            skipped_files.append(upload.filename or "unknown")
            log.warning("sdtm_file.skipped", filename=upload.filename, reason=exc.detail)
            continue
        # If multiple files map to the same domain, concatenate
        if domain in domain_dfs:
            domain_dfs[domain] = pd.concat([domain_dfs[domain], df], ignore_index=True)
        else:
            domain_dfs[domain] = df
        log.info("sdtm_file.parsed", domain=domain, rows=len(df), cols=list(df.columns)[:8])

    if not domain_dfs:
        raise HTTPException(status_code=422, detail="No parseable SDTM domains found in uploaded files.")

    # -- split SUPP-- datasets from regular domains and pivot them
    supp_pivoted: dict[str, pd.DataFrame] = {}   # parent_domain → pivoted SUPP df
    regular_dfs: dict[str, pd.DataFrame] = {}
    for domain, df in domain_dfs.items():
        if _is_supp(domain):
            parent = _parent_of_supp(domain)
            # Pass crf_map so supplemental column labels respect the CRF
            pivoted = _pivot_supp(df, crf_map)
            # Multiple SUPP files for the same parent: merge columns
            if parent in supp_pivoted:
                join_keys = [c for c in ["USUBJID", f"{parent}SEQ"] if c in supp_pivoted[parent].columns and c in pivoted.columns]
                if join_keys:
                    supp_pivoted[parent] = pd.merge(supp_pivoted[parent], pivoted, on=join_keys, how="outer")
                else:
                    supp_pivoted[parent] = pd.concat([supp_pivoted[parent], pivoted], ignore_index=True)
            else:
                supp_pivoted[parent] = pivoted
            log.info("supp.pivoted", supp=domain, parent=parent, cols=list(pivoted.columns)[:10])
        else:
            regular_dfs[domain] = df

    # -- merge each pivoted SUPP into its parent domain when parent was also uploaded
    for parent, supp_df in supp_pivoted.items():
        if parent in regular_dfs:
            regular_dfs[parent] = _merge_supp_into_parent(regular_dfs[parent], supp_df, parent)
        else:
            # Parent not uploaded — output the pivoted SUPP as a standalone file
            regular_dfs[f"SUPP{parent}"] = supp_df

    if not regular_dfs:
        raise HTTPException(status_code=422, detail="No parseable SDTM domains found in uploaded files.")

    # -- build ZIP in-memory
    import re as _re
    zip_buf = io.BytesIO()
    summary_rows = []
    with zipfile.ZipFile(zip_buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for domain, df in regular_dfs.items():
            if domain == "LB" and split_lb_by_category and "LBCAT" in df.columns:
                # Split by LBCAT before renaming — one CSV per test category
                filled = df["LBCAT"].fillna("Uncategorized")
                categories = sorted(filled.unique())
                for cat in categories:
                    cat_df = df[filled == cat].copy()
                    raw_df = _apply_raw_mapping(cat_df, domain, crf_map)
                    safe_cat = _re.sub(r'[^A-Za-z0-9]+', '_', str(cat)).strip('_')
                    filename = f"{_domain_filename(domain)}_{safe_cat}_raw.csv"
                    csv_buf = io.StringIO()
                    raw_df.to_csv(csv_buf, index=False)
                    zf.writestr(filename, csv_buf.getvalue())
                    summary_rows.append({
                        "domain": "LB",
                        "category": str(cat),
                        "rows": len(raw_df),
                        "columns": len(raw_df.columns),
                        "file": filename,
                        "supp_merged": "LB" in supp_pivoted,
                    })
                    log.info("raw_csv.lb_split", category=cat, rows=len(raw_df))
            else:
                raw_df = _apply_raw_mapping(df, domain, crf_map)
                csv_buf = io.StringIO()
                raw_df.to_csv(csv_buf, index=False)
                fname = f"{_domain_filename(domain)}_raw.csv"
                zf.writestr(fname, csv_buf.getvalue())
                summary_rows.append({
                    "domain": domain,
                    "rows": len(raw_df),
                    "columns": len(raw_df.columns),
                    "file": fname,
                    "supp_merged": domain in supp_pivoted,
                })
                log.info("raw_csv.generated", domain=domain, rows=len(raw_df))

        # Embed a manifest listing what was generated
        import json as _json
        manifest_data: dict = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "domains": summary_rows,
            "crf_fields_used": len(crf_map),
        }
        if skipped_files:
            manifest_data["skipped_files"] = skipped_files
        zf.writestr("manifest.json", _json.dumps(manifest_data, indent=2))

    zip_buf.seek(0)
    return StreamingResponse(
        zip_buf,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=raw_datasets.zip"},
    )


@app.get("/raw-datasets/domains", summary="List supported SDTM domains")
async def list_supported_domains():
    """Return the list of SDTM domains with built-in reverse-mapping support."""
    return {
        "domains": [
            {"domain": k, "variables": len(v), "description": _DOMAIN_LABELS.get(k, k)}
            for k, v in _SDTM_TO_RAW.items()
        ]
    }


_DOMAIN_LABELS = {
    "DM": "Demographics", "AE": "Adverse Events", "CM": "Concomitant Medications",
    "LB": "Laboratory Results", "VS": "Vital Signs", "EX": "Exposure",
    "DS": "Disposition", "MH": "Medical History", "SC": "Subject Characteristics",
    "IE": "Inclusion/Exclusion", "SV": "Subject Visits", "TU": "Tumor Identification",
    "TR": "Tumor Results", "RS": "Response", "QS": "Questionnaires",
    "FA": "Findings About", "ML": "Meal Data", "DD": "Death Details",
    # Special-purpose
    "SE": "Subject Elements", "RELREC": "Related Records",
    # Trial design
    "TA": "Trial Arms", "TE": "Trial Elements", "TI": "Trial Inclusion/Exclusion",
    "TS": "Trial Summary", "TV": "Trial Visits",
    # SUPP (shown if parent not uploaded)
    "SUPPAE": "Supplemental AE", "SUPPDM": "Supplemental DM",
    "SUPPDS": "Supplemental DS", "SUPPLB": "Supplemental LB",
    "SUPPCM": "Supplemental CM", "SUPPVS": "Supplemental VS",
    "SUPPEX": "Supplemental EX", "SUPPMH": "Supplemental MH",
}

@app.get("/lineage/{study_id}")
async def get_lineage(study_id: str, org_id: str, source_record_id: str = None):
    async with db_pool.acquire() as conn:
        if source_record_id:
            rows = await conn.fetch(
                "SELECT * FROM lineage_records WHERE study_id=$1 AND org_id=$2 AND source_record_id=$3",
                study_id, org_id, source_record_id
            )
        else:
            rows = await conn.fetch(
                "SELECT * FROM lineage_records WHERE study_id=$1 AND org_id=$2 ORDER BY transformed_at DESC LIMIT 100",
                study_id, org_id
            )
    return {"lineage": [dict(r) for r in rows]}
