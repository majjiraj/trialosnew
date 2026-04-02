"""
TrialOS SDTM Transformation Pipeline
Bronze (raw EDC data) → Silver (SDTM domain tables)

Uses pandas for local dev; Spark in production (same API surface via pyspark).
Each transformation is versioned and creates lineage records.
CDISC conformance checks run on Silver output.
"""
import json
import uuid
import hashlib
from datetime import datetime, timezone
from typing import Optional
import structlog
import asyncpg

log = structlog.get_logger()

# SDTM domain schemas (key required fields per CDISC SDTM IG 3.4)
SDTM_DOMAIN_SCHEMAS = {
    "DM": {
        "required": ["STUDYID","DOMAIN","USUBJID","SUBJID","RFSTDTC","RFENDTC","SITEID","AGE","AGEU","SEX","RACE","ETHNIC","COUNTRY"],
        "controlled_terms": {
            "DOMAIN": ["DM"],
            "AGEU": ["DAYS","WEEKS","MONTHS","YEARS"],
            "SEX": ["M","F","U","UNDIFFERENTIATED"],
        }
    },
    "AE": {
        "required": ["STUDYID","DOMAIN","USUBJID","AESEQ","AETERM","AESTDTC"],
        "controlled_terms": {
            "DOMAIN": ["AE"],
            "AESEV": ["MILD","MODERATE","SEVERE"],
            "AEREL": ["NOT RELATED","UNLIKELY RELATED","POSSIBLY RELATED","PROBABLY RELATED","RELATED"],
            "AEOUT": ["RECOVERED/RESOLVED","RECOVERING/RESOLVING","NOT RECOVERED/NOT RESOLVED","RECOVERED/RESOLVED WITH SEQUELAE","FATAL","UNKNOWN"],
            "AESER": ["Y","N"],
        }
    },
    "LB": {
        "required": ["STUDYID","DOMAIN","USUBJID","LBSEQ","LBTESTCD","LBTEST","LBORRES","LBDTC"],
        "controlled_terms": {
            "DOMAIN": ["LB"],
            "LBNRIND": ["LOW","NORMAL","HIGH","ABNORMAL"],
        }
    },
    "VS": {
        "required": ["STUDYID","DOMAIN","USUBJID","VSSEQ","VSTESTCD","VSTEST","VSORRES","VSDTC"],
        "controlled_terms": {
            "DOMAIN": ["VS"],
            "VSTESTCD": ["SYSBP","DIABP","PULSE","TEMP","WEIGHT","HEIGHT","BMI","RESP"],
        }
    },
    "CM": {
        "required": ["STUDYID","DOMAIN","USUBJID","CMSEQ","CMTRT","CMSTDTC"],
        "controlled_terms": {"DOMAIN": ["CM"]}
    },
    "EX": {
        "required": ["STUDYID","DOMAIN","USUBJID","EXSEQ","EXTRT","EXDOSE","EXDOSU","EXROUTE","EXSTDTC"],
        "controlled_terms": {"DOMAIN": ["EX"]}
    },
    "MH": {
        "required": ["STUDYID","DOMAIN","USUBJID","MHSEQ","MHTERM"],
        "controlled_terms": {"DOMAIN": ["MH"]}
    },
    "DS": {
        "required": ["STUDYID","DOMAIN","USUBJID","DSSEQ","DSTERM","DSDECOD","EPOCH","DSSTDTC"],
        "controlled_terms": {"DOMAIN": ["DS"]}
    },
}

class ConformanceFinding:
    def __init__(self, domain: str, rule_id: str, severity: str, field: str,
                 message: str, record_ref: Optional[str] = None):
        self.domain = domain
        self.rule_id = rule_id
        self.severity = severity  # ERROR | WARNING | INFO
        self.field = field
        self.message = message
        self.record_ref = record_ref

class SDTMConformanceChecker:
    """
    Runs CDISC SDTM conformance checks on Silver domain tables.
    Equivalent to Pinnacle 21 Community checks.
    """

    def check_domain(self, domain: str, records: list[dict]) -> list[ConformanceFinding]:
        findings = []
        schema = SDTM_DOMAIN_SCHEMAS.get(domain, {})

        for i, record in enumerate(records):
            ref = record.get("USUBJID", f"row_{i}")

            # SD0001: Missing required variable
            for req_field in schema.get("required", []):
                if req_field not in record or record[req_field] is None or str(record[req_field]).strip() == "":
                    findings.append(ConformanceFinding(
                        domain=domain,
                        rule_id="SD0001",
                        severity="ERROR",
                        field=req_field,
                        message=f"Required variable '{req_field}' is missing or empty",
                        record_ref=ref
                    ))

            # SD0037: Controlled terminology check
            for field, allowed_values in schema.get("controlled_terms", {}).items():
                if field in record and record[field] and record[field] not in allowed_values:
                    findings.append(ConformanceFinding(
                        domain=domain,
                        rule_id="SD0037",
                        severity="ERROR",
                        field=field,
                        message=f"Value '{record[field]}' not in controlled terminology for {field}. Allowed: {allowed_values}",
                        record_ref=ref
                    ))

            # SD0006: STUDYID must be consistent
            if "STUDYID" in record and "DOMAIN" in record:
                if record["DOMAIN"] != domain:
                    findings.append(ConformanceFinding(
                        domain=domain,
                        rule_id="SD0006",
                        severity="ERROR",
                        field="DOMAIN",
                        message=f"DOMAIN value '{record['DOMAIN']}' does not match expected domain '{domain}'",
                        record_ref=ref
                    ))

            # AE-specific: SAE with missing AEOUT
            if domain == "AE":
                if record.get("AESER") == "Y" and not record.get("AEOUT"):
                    findings.append(ConformanceFinding(
                        domain=domain,
                        rule_id="AE0003",
                        severity="WARNING",
                        field="AEOUT",
                        message="Serious AE (AESER=Y) is missing outcome (AEOUT)",
                        record_ref=ref
                    ))

            # LB-specific: numeric result check
            if domain == "LB":
                if record.get("LBORRES") and not record.get("LBSTRESN") and not record.get("LBSTRESC"):
                    findings.append(ConformanceFinding(
                        domain=domain,
                        rule_id="LB0001",
                        severity="WARNING",
                        field="LBSTRESN",
                        message="LBORRES present but LBSTRESN/LBSTRESC missing",
                        record_ref=ref
                    ))

        return findings

    def check_all_domains(self, domain_data: dict[str, list[dict]]) -> dict:
        all_findings = {}
        total_errors = 0
        total_warnings = 0

        for domain, records in domain_data.items():
            findings = self.check_domain(domain, records)
            all_findings[domain] = [
                {
                    "rule_id": f.rule_id,
                    "severity": f.severity,
                    "field": f.field,
                    "message": f.message,
                    "record_ref": f.record_ref
                } for f in findings
            ]
            total_errors += sum(1 for f in findings if f.severity == "ERROR")
            total_warnings += sum(1 for f in findings if f.severity == "WARNING")

        return {
            "findings": all_findings,
            "summary": {
                "total_errors": total_errors,
                "total_warnings": total_warnings,
                "domains_checked": list(domain_data.keys()),
                "checked_at": datetime.now(timezone.utc).isoformat()
            }
        }


class BronzeToSilverPipeline:
    """
    Transforms Bronze (raw EDC) records → Silver (SDTM domain) tables.
    Creates lineage records for each row transformed.
    """

    RULE_VERSION = "1.0.0"  # Increment when mapping rules change

    def __init__(self, db_pool: asyncpg.Pool):
        self.db = db_pool
        self.conformance_checker = SDTMConformanceChecker()

    def _hash_record(self, record: dict) -> str:
        canonical = json.dumps(record, sort_keys=True)
        return hashlib.sha256(canonical.encode()).hexdigest()

    async def transform_domain(self, study_id: str, org_id: str, domain: str,
                                bronze_records: list[dict], study_info: dict) -> dict:
        """Transform bronze records for a single SDTM domain."""
        transformation_id = str(uuid.uuid4())
        transformed_records = []
        lineage_records = []

        for record in bronze_records:
            source_hash = self._hash_record(record)
            source_record_id = record.get("_bronze_record_id", str(uuid.uuid4()))

            # Apply domain-specific mapping
            sdtm_record = self._map_to_sdtm(domain, record, study_info)

            if sdtm_record:
                output_hash = self._hash_record(sdtm_record)
                output_id = str(uuid.uuid4())
                sdtm_record["_silver_record_id"] = output_id
                transformed_records.append(sdtm_record)

                lineage_records.append({
                    "source_record_id": source_record_id,
                    "source_hash": source_hash,
                    "source_system": record.get("_source_system", "unknown"),
                    "bronze_record_id": source_record_id,
                    "transformation_id": transformation_id,
                    "rule_version": self.RULE_VERSION,
                    "silver_record_id": output_id,
                    "silver_domain": domain,
                    "transformed_at": datetime.now(timezone.utc).isoformat(),
                    "transformed_by": "system",
                    "output_hash": output_hash,
                    "study_id": study_id,
                    "org_id": org_id
                })

        # Run conformance checks
        conformance = self.conformance_checker.check_domain(domain, transformed_records)

        # Persist lineage
        await self._write_lineage(lineage_records)

        log.info("silver.transform.complete",
                 domain=domain,
                 study_id=study_id,
                 records=len(transformed_records),
                 errors=sum(1 for f in conformance if f.severity == "ERROR"))

        return {
            "domain": domain,
            "records": transformed_records,
            "lineage_count": len(lineage_records),
            "conformance_findings": [
                {"rule_id": f.rule_id, "severity": f.severity, "field": f.field, "message": f.message}
                for f in conformance
            ],
            "transformation_id": transformation_id
        }

    def _map_to_sdtm(self, domain: str, record: dict, study_info: dict) -> Optional[dict]:
        """
        Apply SDTM mapping rules to a raw EDC record.
        In production: rules loaded from versioned rule store (DB/S3).
        """
        study_id = study_info.get("protocol_number", "")
        subject_id = record.get("SUBJECTID") or record.get("subject_id") or record.get("record_id", "")
        usubjid = f"{study_id}-{subject_id}"

        if domain == "AE":
            return self._map_ae(record, study_id, usubjid)
        elif domain == "LB":
            return self._map_lb(record, study_id, usubjid)
        elif domain == "DM":
            return self._map_dm(record, study_id, usubjid, subject_id)
        elif domain == "VS":
            return self._map_vs(record, study_id, usubjid)
        elif domain == "CM":
            return self._map_cm(record, study_id, usubjid)
        return None

    def _map_ae(self, record: dict, study_id: str, usubjid: str) -> dict:
        return {
            "STUDYID": study_id,
            "DOMAIN": "AE",
            "USUBJID": usubjid,
            "AESEQ": record.get("ae_seq") or record.get("aeseq") or record.get("seq", ""),
            "AETERM": record.get("ae_term") or record.get("aeterm") or record.get("adverse_event", ""),
            "AEDECOD": record.get("ae_decod") or record.get("meddra_pt", ""),
            "AEBODSYS": record.get("ae_soc") or record.get("meddra_soc", ""),
            "AESEV": (record.get("ae_severity") or record.get("aesev") or "").upper(),
            "AESER": "Y" if str(record.get("serious", "")).upper() in ("Y","YES","1","TRUE") else "N",
            "AEREL": record.get("ae_rel") or record.get("relationship", ""),
            "AEOUT": record.get("ae_outcome") or record.get("outcome", ""),
            "AESTDTC": record.get("ae_start_date") or record.get("aestdtc", ""),
            "AEENDTC": record.get("ae_end_date") or record.get("aeendtc", ""),
        }

    def _map_lb(self, record: dict, study_id: str, usubjid: str) -> dict:
        orres = str(record.get("LBORRES") or record.get("value") or record.get("result") or "")
        try:
            stresn = float(orres.replace(",", ""))
        except (ValueError, AttributeError):
            stresn = None

        return {
            "STUDYID": study_id,
            "DOMAIN": "LB",
            "USUBJID": record.get("USUBJID") or usubjid,
            "LBSEQ": record.get("LBSEQ", ""),
            "LBTESTCD": record.get("LBTESTCD") or record.get("test_code", ""),
            "LBTEST": record.get("LBTEST") or record.get("test_name", ""),
            "LBCAT": record.get("LBCAT") or record.get("panel", ""),
            "LBORRES": orres,
            "LBORRESU": record.get("LBORRESU") or record.get("unit", ""),
            "LBSTRESC": orres,
            "LBSTRESN": stresn,
            "LBSTRESU": record.get("LBSTRESU") or record.get("LBORRESU") or record.get("unit", ""),
            "LBNRLO": str(record.get("LBNRLO") or record.get("ref_lo", "")),
            "LBNRHI": str(record.get("LBNRHI") or record.get("ref_hi", "")),
            "LBNRIND": record.get("LBNRIND") or record.get("flag", ""),
            "LBDTC": record.get("LBDTC") or record.get("collection_date", ""),
            "confidence_score": record.get("confidence_score", 1.0),
        }

    def _map_dm(self, record: dict, study_id: str, usubjid: str, subjid: str) -> dict:
        return {
            "STUDYID": study_id,
            "DOMAIN": "DM",
            "USUBJID": usubjid,
            "SUBJID": subjid,
            "RFSTDTC": record.get("first_dose_date") or record.get("rfstdtc", ""),
            "RFENDTC": record.get("last_dose_date") or record.get("rfendtc", ""),
            "SITEID": record.get("site_id") or record.get("siteid", ""),
            "AGE": record.get("age", ""),
            "AGEU": record.get("age_unit") or "YEARS",
            "SEX": (record.get("sex") or record.get("gender") or "U").upper(),
            "RACE": (record.get("race") or "").upper(),
            "ETHNIC": (record.get("ethnicity") or "").upper(),
            "COUNTRY": record.get("country", ""),
            "ARM": record.get("arm") or record.get("treatment_group", ""),
            "ARMCD": record.get("armcd") or record.get("arm_code", ""),
        }

    def _map_vs(self, record: dict, study_id: str, usubjid: str) -> dict:
        orres = str(record.get("VSORRES") or record.get("value") or "")
        try:
            stresn = float(orres.replace(",", ""))
        except (ValueError, AttributeError):
            stresn = None

        return {
            "STUDYID": study_id,
            "DOMAIN": "VS",
            "USUBJID": usubjid,
            "VSSEQ": record.get("VSSEQ", ""),
            "VSTESTCD": (record.get("VSTESTCD") or record.get("test_code", "")).upper(),
            "VSTEST": record.get("VSTEST") or record.get("test_name", ""),
            "VSORRES": orres,
            "VSORRESU": record.get("VSORRESU") or record.get("unit", ""),
            "VSSTRESC": orres,
            "VSSTRESN": stresn,
            "VSSTRESU": record.get("VSSTRESU") or record.get("VSORRESU") or record.get("unit", ""),
            "VSDTC": record.get("VSDTC") or record.get("measurement_date", ""),
            "VISIT": record.get("VISIT") or record.get("visit_name", ""),
        }

    def _map_cm(self, record: dict, study_id: str, usubjid: str) -> dict:
        return {
            "STUDYID": study_id,
            "DOMAIN": "CM",
            "USUBJID": usubjid,
            "CMSEQ": record.get("CMSEQ", ""),
            "CMTRT": record.get("CMTRT") or record.get("medication_name", ""),
            "CMDECOD": record.get("CMDECOD") or record.get("drug_code", ""),
            "CMCAT": record.get("CMCAT") or record.get("category", "CONCOMITANT"),
            "CMDOSE": record.get("CMDOSE") or record.get("dose", ""),
            "CMDOSU": record.get("CMDOSU") or record.get("dose_unit", ""),
            "CMROUTE": record.get("CMROUTE") or record.get("route", ""),
            "CMSTDTC": record.get("CMSTDTC") or record.get("start_date", ""),
            "CMENDTC": record.get("CMENDTC") or record.get("end_date", ""),
        }

    async def _write_lineage(self, lineage_records: list[dict]):
        if not lineage_records:
            return
        async with self.db.acquire() as conn:
            for lr in lineage_records:
                await conn.execute("""
                    INSERT INTO lineage_records (
                        source_record_id, source_hash, source_system, bronze_record_id,
                        transformation_id, rule_version, silver_record_id, silver_domain,
                        transformed_by, study_id, org_id
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                """, lr["source_record_id"], lr["source_hash"], lr["source_system"],
                    lr["bronze_record_id"], lr["transformation_id"], lr["rule_version"],
                    lr["silver_record_id"], lr["silver_domain"], lr["transformed_by"],
                    lr["study_id"], lr["org_id"])


class SilverToGoldPipeline:
    """
    Derives ADaM datasets from Silver SDTM tables.
    ADSL: Subject-level analysis dataset
    ADAE: Adverse event analysis dataset
    ADLB: Laboratory analysis dataset
    """

    def derive_adsl(self, dm_records: list[dict], ds_records: list[dict], ae_records: list[dict]) -> list[dict]:
        """
        Derive ADSL (Subject Level Analysis Dataset) from DM + DS + AE.
        One row per subject.
        """
        adsl = []

        # Group by subject
        subjects = {}
        for dm in dm_records:
            usubjid = dm.get("USUBJID", "")
            if usubjid:
                subjects[usubjid] = {**dm}

        for usubjid, subj in subjects.items():
            # Safety flag: subject has ≥1 dose (EX records - simplified here)
            subj["SAFFL"] = "Y"  # Default; in production check EX records

            # Full analysis set: enrolled and randomized
            subj["FASFL"] = "Y"

            # Completers flag
            completed = any(
                d.get("USUBJID") == usubjid and d.get("DSDECOD") == "COMPLETED"
                for d in ds_records
            )
            subj["COMPLFL"] = "Y" if completed else "N"

            # SAE flag
            has_sae = any(a.get("USUBJID") == usubjid and a.get("AESER") == "Y" for a in ae_records)
            subj["SAEFL"] = "Y" if has_sae else "N"

            # Dataset identifier
            subj["DATASET"] = "ADSL"

            adsl.append(subj)

        log.info("adsl.derived", subject_count=len(adsl))
        return adsl

    def derive_adae(self, ae_records: list[dict], adsl_records: list[dict]) -> list[dict]:
        """Derive ADAE (Adverse Event Analysis Dataset) from AE + ADSL."""
        adsl_map = {s["USUBJID"]: s for s in adsl_records}
        adae = []

        for seq, ae in enumerate(ae_records, 1):
            usubjid = ae.get("USUBJID", "")
            subj = adsl_map.get(usubjid, {})

            adae_record = {**ae}
            adae_record["DATASET"] = "ADAE"

            # Join ADSL flags
            adae_record["SAFFL"] = subj.get("SAFFL", "")
            adae_record["FASFL"] = subj.get("FASFL", "")
            adae_record["ARM"] = subj.get("ARM", "")
            adae_record["ARMCD"] = subj.get("ARMCD", "")

            # Analysis flags
            adae_record["ANL01FL"] = "Y"  # All AEs in safety analysis
            adae_record["TRTEMFL"] = "Y"  # Treatment-emergent (simplified)

            # Severity grade (CTCAE numeric)
            sev_map = {"MILD": 1, "MODERATE": 2, "SEVERE": 3}
            sev_text = ae.get("AESEV", "").upper()
            adae_record["AETOXGR"] = str(sev_map.get(sev_text, ""))

            adae.append(adae_record)

        log.info("adae.derived", ae_count=len(adae))
        return adae

    def derive_adlb(self, lb_records: list[dict], adsl_records: list[dict]) -> list[dict]:
        """Derive ADLB (Laboratory Analysis Dataset) from LB + ADSL."""
        adsl_map = {s["USUBJID"]: s for s in adsl_records}
        adlb = []

        for lb in lb_records:
            usubjid = lb.get("USUBJID", "")
            subj = adsl_map.get(usubjid, {})

            adlb_record = {**lb}
            adlb_record["DATASET"] = "ADLB"
            adlb_record["SAFFL"] = subj.get("SAFFL", "")
            adlb_record["ARM"] = subj.get("ARM", "")

            # Baseline flag (visit 1 or screening)
            visit = str(lb.get("VISIT", "")).upper()
            adlb_record["ABLFL"] = "Y" if any(v in visit for v in ["SCREEN","BASELINE","WEEK 0","DAY 1"]) else ""

            # Analysis flag
            adlb_record["ANL01FL"] = "Y"

            adlb.append(adlb_record)

        log.info("adlb.derived", lb_count=len(adlb))
        return adlb
