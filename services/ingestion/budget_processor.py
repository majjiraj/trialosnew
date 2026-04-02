"""
Study Budget File Processor.
Parses Excel/CSV budget files into structured site_budgets rows.
Supports: per-site budgets, payment milestones, consolidated views.
"""
import io
import csv
from typing import Optional
import structlog

log = structlog.get_logger()

BUDGET_CATEGORIES = {
    "per_visit", "per_procedure", "startup", "closeout", "overhead",
    "screen_failure", "investigator_fee", "irb", "lab", "pharmacy", "other"
}

async def parse_budget_file(content: bytes) -> list[dict]:
    """Auto-detect format and parse budget file."""
    if content[:2] == b'PK':  # xlsx
        return await _parse_excel_budget(content)
    else:
        return await _parse_csv_budget(content)

async def _parse_excel_budget(content: bytes) -> list[dict]:
    try:
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(content))
        rows = []

        for sheet_name in wb.sheetnames:
            ws = wb[sheet_name]
            headers = [str(cell.value).strip().upper() if cell.value else "" for cell in ws[1]]

            for row in ws.iter_rows(min_row=2, values_only=True):
                row_dict = dict(zip(headers, row))
                parsed = _map_budget_row(row_dict, source_sheet=sheet_name)
                if parsed:
                    rows.append(parsed)

        log.info("excel_budget.parsed", row_count=len(rows))
        return rows
    except ImportError:
        log.error("openpyxl.not_installed")
        return []

async def _parse_csv_budget(content: bytes) -> list[dict]:
    text = content.decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for row in reader:
        parsed = _map_budget_row({k.strip().upper(): v for k, v in row.items()})
        if parsed:
            rows.append(parsed)
    log.info("csv_budget.parsed", row_count=len(rows))
    return rows

def _map_budget_row(row: dict, source_sheet: str = None) -> Optional[dict]:
    """Map budget row to internal schema. Returns None if insufficient data."""
    col_map = {
        "site_id": ["SITE_ID", "SITE", "SITE_NUMBER", "SITENUMBER"],
        "cost_category": ["COST_CATEGORY", "CATEGORY", "COST_TYPE", "TYPE"],
        "period": ["PERIOD", "QUARTER", "MONTH", "YEAR_PERIOD"],
        "budgeted_usd": ["BUDGETED", "BUDGET", "BUDGETED_USD", "PLANNED_COST", "BUDGET_USD"],
        "actual_usd": ["ACTUAL", "ACTUALS", "ACTUAL_USD", "ACTUAL_COST"],
        "currency": ["CURRENCY", "CCY"],
    }

    mapped = {}
    for field, variations in col_map.items():
        for var in variations:
            if var in row and row[var] is not None and str(row[var]).strip():
                mapped[field] = str(row[var]).strip()
                break

    if "site_id" not in mapped:
        return None

    # Clean numeric fields
    for num_field in ["budgeted_usd", "actual_usd"]:
        if num_field in mapped:
            try:
                mapped[num_field] = float(str(mapped[num_field]).replace(",", "").replace("$", "").strip())
            except ValueError:
                mapped.pop(num_field, None)

    mapped.setdefault("currency", "USD")
    mapped.setdefault("cost_category", "other")
    mapped.setdefault("actual_usd", 0.0)

    if "source_sheet" and source_sheet:
        mapped["source_sheet"] = source_sheet

    return mapped
