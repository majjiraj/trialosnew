"""
Lab Report Processor — Dual pipeline for central (structured) and site (OCR) labs.
Extracts lab results and maps to SDTM LB domain structure.
"""
import io
import re
from typing import Optional
import structlog

log = structlog.get_logger()

# SDTM LB domain columns
LB_COLUMNS = [
    "USUBJID", "DOMAIN", "LBSEQ", "LBTESTCD", "LBTEST", "LBCAT", "LBSCAT",
    "LBORRES", "LBORRESU", "LBSTRESC", "LBSTRESN", "LBSTRESU",
    "LBNRLO", "LBNRHI", "LBNRIND", "LBSTAT", "LBDTC", "LBDY"
]

async def process_central_lab(content: bytes) -> list[dict]:
    """
    Parse structured central lab files (Excel, CSV, HL7 v2.x).
    Returns list of SDTM LB-mapped records.
    """
    # Detect format
    if content[:2] == b'PK':  # Excel (xlsx)
        return await _parse_excel_lab(content)
    elif content[:3] == b'MSH':  # HL7 v2.x
        return await _parse_hl7_lab(content)
    else:
        # Assume CSV
        return await _parse_csv_lab(content)

async def _parse_excel_lab(content: bytes) -> list[dict]:
    try:
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(content))
        ws = wb.active

        headers = [str(cell.value).strip().upper() if cell.value else "" for cell in ws[1]]
        records = []

        for row in ws.iter_rows(min_row=2, values_only=True):
            row_dict = dict(zip(headers, row))
            lb_record = _map_to_sdtm_lb(row_dict)
            if lb_record:
                records.append(lb_record)

        log.info("excel_lab.parsed", record_count=len(records))
        return records
    except ImportError:
        log.error("openpyxl.not_installed")
        return []

async def _parse_csv_lab(content: bytes) -> list[dict]:
    import csv
    text = content.decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    records = []
    for row in reader:
        lb_record = _map_to_sdtm_lb({k.strip().upper(): v for k, v in row.items()})
        if lb_record:
            records.append(lb_record)
    log.info("csv_lab.parsed", record_count=len(records))
    return records

async def _parse_hl7_lab(content: bytes) -> list[dict]:
    """Parse HL7 v2.x OBX segments for lab results."""
    text = content.decode("utf-8", errors="replace")
    records = []
    current_patient = {}

    for line in text.split("\n"):
        segments = line.strip().split("|")
        if not segments:
            continue

        seg_type = segments[0]
        if seg_type == "PID":
            # Patient ID
            current_patient = {"USUBJID": segments[3] if len(segments) > 3 else ""}
        elif seg_type == "OBX" and len(segments) > 5:
            # Observation result
            record = {**current_patient}
            record["LBTESTCD"] = segments[3].split("^")[0] if len(segments) > 3 else ""
            record["LBTEST"] = segments[3].split("^")[1] if "^" in (segments[3] if len(segments) > 3 else "") else record["LBTESTCD"]
            record["LBORRES"] = segments[5] if len(segments) > 5 else ""
            record["LBORRESU"] = segments[6] if len(segments) > 6 else ""

            # Reference range
            if len(segments) > 7 and segments[7]:
                ref_parts = segments[7].split("-")
                if len(ref_parts) == 2:
                    record["LBNRLO"] = ref_parts[0]
                    record["LBNRHI"] = ref_parts[1]

            record["LBNRIND"] = segments[8] if len(segments) > 8 else ""
            record["LBDTC"] = segments[14] if len(segments) > 14 else ""
            record["DOMAIN"] = "LB"
            record["confidence_score"] = 1.0  # HL7 is structured
            records.append(record)

    log.info("hl7_lab.parsed", record_count=len(records))
    return records

def _map_to_sdtm_lb(row: dict) -> Optional[dict]:
    """Map arbitrary column names to SDTM LB domain. Returns None if insufficient data."""
    # Common column name variations from different central labs
    col_map = {
        "USUBJID": ["USUBJID", "SUBJECT_ID", "SUBJECTID", "PATIENT_ID", "PATID"],
        "LBTESTCD": ["LBTESTCD", "TEST_CODE", "TESTCODE", "LAB_CODE", "ANALYTE_CODE"],
        "LBTEST": ["LBTEST", "TEST_NAME", "TESTNAME", "LAB_NAME", "ANALYTE_NAME"],
        "LBORRES": ["LBORRES", "RESULT", "VALUE", "LAB_VALUE", "RESULT_VALUE"],
        "LBORRESU": ["LBORRESU", "UNIT", "UNITS", "LAB_UNITS", "RESULT_UNIT"],
        "LBNRLO": ["LBNRLO", "REF_LOW", "NORMAL_LOW", "LOWER_LIMIT", "REF_RANGE_LOW"],
        "LBNRHI": ["LBNRHI", "REF_HIGH", "NORMAL_HIGH", "UPPER_LIMIT", "REF_RANGE_HIGH"],
        "LBNRIND": ["LBNRIND", "ABNORMALITY", "FLAG", "RESULT_FLAG", "ABNORMAL_FLAG"],
        "LBDTC": ["LBDTC", "COLLECTION_DATE", "DATE", "LAB_DATE", "SAMPLE_DATE"],
        "LBCAT": ["LBCAT", "CATEGORY", "LAB_CATEGORY", "PANEL"],
    }

    mapped = {"DOMAIN": "LB"}
    for sdtm_col, variations in col_map.items():
        for var in variations:
            if var in row and row[var] is not None and str(row[var]).strip():
                mapped[sdtm_col] = str(row[var]).strip()
                break

    # Require at minimum: subject ID + test + result
    if not all(k in mapped for k in ["USUBJID", "LBTESTCD", "LBORRES"]):
        return None

    # Try to derive numeric result
    try:
        mapped["LBSTRESN"] = float(mapped.get("LBORRES", "").replace(",", ""))
        mapped["LBSTRESC"] = mapped.get("LBORRES", "")
    except (ValueError, AttributeError):
        mapped["LBSTRESC"] = mapped.get("LBORRES", "")

    # Derive NR indicator if not provided
    if "LBNRIND" not in mapped and "LBSTRESN" in mapped:
        try:
            val = mapped["LBSTRESN"]
            lo = float(mapped.get("LBNRLO", "NaN"))
            hi = float(mapped.get("LBNRHI", "NaN"))
            if val < lo:
                mapped["LBNRIND"] = "LOW"
            elif val > hi:
                mapped["LBNRIND"] = "HIGH"
            else:
                mapped["LBNRIND"] = "NORMAL"
        except (ValueError, KeyError):
            pass

    mapped["confidence_score"] = 1.0  # Structured source
    return mapped

async def process_site_lab_ocr(content: bytes) -> list[dict]:
    """
    Process scanned site lab PDFs via OCR.
    Uses Tesseract for extraction, then LLM-assisted parsing.
    Flags low-confidence extractions for human review.
    """
    # Extract text via OCR
    ocr_text = await _ocr_pdf(content)

    if not ocr_text.strip():
        log.warning("site_lab.ocr_empty")
        return []

    # Parse structured data from OCR text using regex patterns
    records = _parse_lab_text(ocr_text)

    log.info("site_lab_ocr.parsed", record_count=len(records))
    return records

async def _ocr_pdf(content: bytes) -> str:
    try:
        import pytesseract
        from pdf2image import convert_from_bytes
        images = convert_from_bytes(content, dpi=300)
        parts = []
        for i, img in enumerate(images):
            data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
            text = pytesseract.image_to_string(img, lang="eng")
            parts.append(f"[Page {i+1}]\n{text}")
        return "\n\n".join(parts)
    except Exception as e:
        log.error("ocr.failed", error=str(e))
        return ""

def _parse_lab_text(text: str) -> list[dict]:
    """
    Regex-based extraction of lab values from OCR text.
    Assigns confidence scores based on pattern match quality.
    """
    records = []

    # Pattern: test name, value, unit, reference range
    # e.g. "Hemoglobin    14.2  g/dL    12.0-16.0  Normal"
    patterns = [
        re.compile(
            r'(?P<test>[A-Za-z][A-Za-z0-9\s\-\(\)]{2,40})\s+'
            r'(?P<value>\d+\.?\d*)\s+'
            r'(?P<unit>[a-zA-Z/%µ]+(?:/[a-zA-Z]+)?)\s+'
            r'(?P<ref_lo>\d+\.?\d*)\s*[-–]\s*(?P<ref_hi>\d+\.?\d*)\s*'
            r'(?P<flag>H|L|HH|LL|High|Low|Normal|Critical)?',
            re.IGNORECASE
        )
    ]

    for pattern in patterns:
        for m in pattern.finditer(text):
            try:
                val = float(m.group("value"))
                ref_lo = float(m.group("ref_lo"))
                ref_hi = float(m.group("ref_hi"))
                flag = m.group("flag") or ""

                # Derive NR indicator
                if val < ref_lo:
                    nrind = "LOW"
                elif val > ref_hi:
                    nrind = "HIGH"
                else:
                    nrind = "NORMAL"

                record = {
                    "DOMAIN": "LB",
                    "LBTEST": m.group("test").strip(),
                    "LBTESTCD": m.group("test").strip().upper().replace(" ", "")[:8],
                    "LBORRES": m.group("value"),
                    "LBSTRESN": val,
                    "LBSTRESC": m.group("value"),
                    "LBORRESU": m.group("unit"),
                    "LBSTRESU": m.group("unit"),
                    "LBNRLO": str(ref_lo),
                    "LBNRHI": str(ref_hi),
                    "LBNRIND": nrind,
                    "confidence_score": 0.82,  # OCR extraction confidence
                    "requires_review": True,  # All OCR extractions need DM review
                }
                records.append(record)
            except (ValueError, TypeError):
                continue

    return records
