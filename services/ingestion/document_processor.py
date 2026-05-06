"""
Document text extraction and chunking — content-type aware.

Strategy per content type
─────────────────────────
TEXT   — ToC-driven section extraction for structured PDFs; prose accumulated
         per section (cross-page), prefixed with full hierarchical section path.
TABLE  — Extracted atomically with PyMuPDF find_tables(); column list + domain
         stored in metadata; structured preamble prepended before embedding.
FIGURE — Caption text near image bounding box; tagged content_type='figure'.
OTHER  — Page-by-page fallback when no ToC or <5 sections.

Public API
──────────
  extract_and_chunk_pdf(content, doc_type) → List[dict]
  prepare_embedding_text(chunk)            → str   (call before embedding)
  extract_text(content, doc_type)          → str   (non-PDF)
  chunk_text(text, doc_type)               → List[dict]  (non-PDF)

Each chunk dict:
  text       : str   — what to store / display
  section    : str   — section path (flat, for DB column)
  page       : int   — first page (1-indexed)
  is_table   : bool  — True for table chunks
  metadata   : dict  — content_type, section_path, domain, columns, row_count, …
"""
import io
import re
from typing import Optional
import structlog

log = structlog.get_logger()


# ── Constants ─────────────────────────────────────────────────────────────────

CHUNK_SIZE    = 1500   # slightly larger because section prefix consumes ~60 chars
CHUNK_OVERLAP = 200
MIN_CHUNK     = 300

# Column headers that identify an SDTM variable definition table
SDTM_VAR_TABLE_HEADERS = {"variable name", "variable label", "type", "core", "controlled terms"}

# Column headers for the "Controlled Terms or Format" column
_CT_KEYWORDS = {"controlled terms", "controlled terminology", "codelist", "ct/format", "format or codelist",
                "controlled terms or format", "controlled terms\\or format"}

# Doc types that have reliable ToC → use structured extraction
STRUCTURED_DOC_TYPES = {
    "sdtm_ig", "adam_ig", "protocol", "sap", "csr", "dmp", "lab_manual", "icf",
    "usdm_ig", "ich_guideline", "controlled_terminology",
}

# All SDTM domain acronyms (used for domain detection in section paths)
SDTM_DOMAINS = {
    "AE", "LB", "VS", "CM", "DM", "DS", "EX", "MH", "EG", "PR",
    "FA", "IE", "SV", "TV", "QS", "SC", "SE", "PE", "IN", "OE",
    "MI", "MB", "MS", "PC", "PP", "NV", "RP", "RS", "SR", "TU", "TR",
    "DD", "BE", "BW", "CE", "CG", "CP", "CV", "DA", "DD", "DR", "FT",
    "GF", "HO", "LR", "ML", "MO", "MP", "OI", "OM", "PF", "PH",
}


# ── Primary entry points ──────────────────────────────────────────────────────

async def extract_and_chunk_pdf(
    content: bytes,
    doc_type: str = "other",
    chunk_size: int = CHUNK_SIZE,
    overlap: int = CHUNK_OVERLAP,
) -> list[dict]:
    """
    PDF → content-type-aware chunks.

    Structured doc types (SDTM IG, protocol, …) get ToC-driven section
    extraction — prose is accumulated per section across page boundaries,
    preserving narrative context.

    Falls back to page-by-page when no usable ToC is found (< 5 entries).
    """
    import asyncio
    try:
        if doc_type in STRUCTURED_DOC_TYPES:
            fn = lambda: _chunk_structured_pdf_sync(content, doc_type, chunk_size, overlap)
        else:
            fn = lambda: _extract_and_chunk_pdf_sync(content, chunk_size, overlap)

        chunks = await asyncio.to_thread(fn)
        if not chunks:
            log.info("pdf.low_text_extraction", using="ocr")
            text = await extract_pdf_ocr(content)
            return _sliding_window_split(text, chunk_size, overlap)
        return chunks
    except ImportError:
        log.warning("pymupdf.not_installed")
        text = content.decode("utf-8", errors="replace")
        return _sliding_window_split(text, chunk_size, overlap)


def prepare_embedding_text(chunk: dict) -> str:
    """
    Per-content-type text serialisation before embedding.

    • text   → used as-is (already carries [section path] prefix)
    • table  → structured preamble (domain, columns, section) + raw table markdown
    • figure → "Figure in <section>. <caption>"

    This makes the 768-dim nomic-embed-text vectors semantically richer:
    table columns are now part of the embedded representation, so
    "what is AETERM" retrieves the AE variable table directly.
    """
    meta  = chunk.get("metadata") or {}
    ctype = meta.get("content_type", "text")
    text  = chunk.get("text", "")

    if ctype == "table":
        cols    = meta.get("columns") or []
        domain  = meta.get("domain")
        section = meta.get("section_path") or chunk.get("section") or ""
        n_rows  = meta.get("row_count")

        parts = ["Structured table"]
        if domain:
            parts.append(f"for {domain} domain")
        if cols:
            parts.append(f"columns: {', '.join(str(c) for c in cols[:10])}")
        if n_rows:
            parts.append(f"{n_rows} data rows")
        if section:
            parts.append(f"in section: {section}")
        return ". ".join(parts) + ".\n" + text

    elif ctype == "figure":
        section = meta.get("section_path") or chunk.get("section") or ""
        return (f"Figure in section {section}.\n" if section else "") + text

    elif ctype == "table_row":
        var = meta.get("variable", "")
        if var:
            # SDTM variable row (from PDF IG tables)
            label    = meta.get("label", "")
            core     = meta.get("core", "")
            dom      = meta.get("domain", "")
            codelist = meta.get("codelist", "")
            parts = [f"SDTM variable {var}"]
            if label:    parts.append(f"label: {label}")
            if dom:      parts.append(f"domain: {dom}")
            if core:     parts.append(f"core: {core}")
            if codelist: parts.append(f"codelist: {codelist}")
            return ". ".join(parts) + ".\n" + text
        else:
            variable_labels = meta.get("variable_labels") or {}
            cols            = meta.get("columns") or []
            if variable_labels and cols:
                # XPT dataset row — enrich embedding with full variable labels
                col_summary = "  ".join(
                    f"{c}({variable_labels[c]})" if variable_labels.get(c) else c
                    for c in cols[:10]
                )
                lines = text.split("\n", 1)
                range_line = lines[0]
                rest       = lines[1] if len(lines) > 1 else ""
                return f"{range_line}  Columns: {col_summary}\n{rest}"
            else:
                # General table row — embed as key=value pairs
                row_data = meta.get("row_data") or {}
                section  = meta.get("section_path", "")
                kv_parts = [f"{k}: {v}" for k, v in list(row_data.items())[:5] if k and v]
                emb_prefix = "; ".join(kv_parts) + ". " if kv_parts else ""
                if section:
                    emb_prefix += f"In section: {section}. "
                return emb_prefix + text

    elif ctype == "statistics":
        # XPT statistics chunk — prepend a rich keyword preamble so semantic search
        # retrieves this for queries like "how many patients", "treatment arms", etc.
        domain  = meta.get("domain") or ""
        n_subj  = meta.get("unique_subjects")
        n_sites = meta.get("unique_sites")
        parts   = ["Clinical dataset statistics"]
        if domain:
            parts.append(f"SDTM {domain} domain")
        if n_subj is not None:
            parts.append(f"{n_subj} unique patients")
        if n_sites is not None:
            parts.append(f"{n_sites} sites")
        return ". ".join(parts) + ".\n" + text

    else:  # text
        return text


# ── Row-level SDTM variable table splitter ────────────────────────────────────

def _split_variable_table_rows(
    table_md: str, section: str, domain: str, page: int, columns: list
) -> list[dict] | None:
    """
    If this table looks like an SDTM variable definition table, return one chunk
    per data row (one chunk per variable). Otherwise return None — caller falls
    back to the original single-table-chunk path.
    """
    col_lower = {c.lower().strip() for c in (columns or [])}
    if not (col_lower & SDTM_VAR_TABLE_HEADERS):
        return None

    rows = [r for r in table_md.split("\n") if r.strip() and not r.startswith("|---")]
    if len(rows) < 3:  # header + separator + ≥1 data row
        return None

    header_row = rows[0]
    data_rows  = rows[1:]  # rows[0]=header, rows[1:]=data (separator already filtered)

    # Rebuild separator from column count
    header_cells = [c.strip() for c in header_row.strip("|").split("|")]
    sep_row = "| " + " | ".join(["---"] * len(header_cells)) + " |"

    # Find the controlled terms column index.
    # Column headers in PDFs often contain embedded newlines and footnote markers (e.g. "Format1").
    # Normalize: collapse whitespace, strip digits/punctuation suffix, then check for keyword substrings.
    def _is_ct_col(h: str) -> bool:
        n = " ".join(h.lower().split())  # collapse whitespace/newlines
        n = re.sub(r'\d+$', '', n).strip()  # strip trailing footnote digits
        return n in _CT_KEYWORDS or ("controlled" in n and ("term" in n or "codelist" in n))

    ct_col_idx = next(
        (i for i, h in enumerate(header_cells) if _is_ct_col(h)),
        None
    )

    chunks = []
    for row in data_rows:
        cells = [c.strip() for c in row.strip("|").split("|")]
        if not cells or not cells[0]:
            continue

        var_name = cells[0].strip()
        # Must look like an SDTM variable: 2-8 uppercase alphanum chars
        if not re.match(r'^[A-Z][A-Z0-9]{1,7}$', var_name):
            continue

        label    = cells[1].strip() if len(cells) > 1 else ""
        core_val = next((c.strip() for c in cells if c.strip() in {"Req", "Exp", "Perm"}), "")

        # Extract controlled terms / codelist reference from structured column
        controlled_terms = cells[ct_col_idx].strip() if ct_col_idx is not None and ct_col_idx < len(cells) else ""
        # Keep only uppercase codelist names (2-10 uppercase alphanumeric chars); drop ISO dates, numeric formats, etc.
        codelist_ref = controlled_terms if re.match(r'^[A-Z][A-Z0-9]{1,9}$', controlled_terms) else ""

        row_md = f"{header_row}\n{sep_row}\n{row}"
        prefix = f"[{section}]\n" if section else ""
        text   = f"{prefix}SDTM variable {var_name} — {label}.\n{row_md}"

        chunks.append({
            "text":     text,
            "section":  section,
            "page":     page,
            "is_table": True,
            "metadata": {
                "content_type": "table_row",
                "section_path": section,
                "domain":       domain,
                "variable":     var_name,
                "label":        label,
                "core":         core_val,
                "codelist":     codelist_ref,
                "columns":      columns,
                "row_count":    1,
                "page":         page,
            },
        })
    return chunks if chunks else None


# ── Structured PDF extraction (ToC-driven) ───────────────────────────────────

# Regex patterns that identify numbered section headings (e.g. "1.", "2.3", "A.1")
_SECTION_HEADING_RE = re.compile(
    r"^(?:"
    r"\d{1,2}(?:\.\d{1,2}){0,3}"   # 1  /  1.2  /  1.2.3
    r"|[A-Z]\.\d{1,2}"             # A.1
    r")\s+[A-Z][^\n]{3,80}$",
    re.MULTILINE,
)

def _extract_toc_from_headings(doc) -> list:
    """
    Build a synthetic ToC by scanning each page for large-font or numbered
    headings.  Returns a list in PyMuPDF toc format: [(level, title, page_1idx)].

    Strategy (in order of priority):
    1. Use span font-size to detect headings: spans whose font-size is
       significantly larger than the body text median are treated as headings.
       Level 1 = largest; Level 2 = second-largest font class; Level 3+ rest.
    2. If font-size approach yields < 3 headings, fall back to regex matching
       numbered section patterns in the plain text.
    """
    from statistics import median

    all_sizes: list[float] = []
    page_spans: list[list[dict]] = []

    for page in doc:
        spans: list[dict] = []
        try:
            blocks = page.get_text("dict", flags=16)["blocks"]
        except Exception:
            page_spans.append(spans)
            continue
        for blk in blocks:
            for line in blk.get("lines", []):
                for span in line.get("spans", []):
                    txt = span.get("text", "").strip()
                    sz  = span.get("size", 0)
                    if txt and sz > 0:
                        all_sizes.append(sz)
                        spans.append({"text": txt, "size": sz, "page": page.number + 1})
        page_spans.append(spans)

    if not all_sizes:
        return []

    body_size = median(all_sizes)
    # Collect distinct large sizes (>15% above median)
    large_sizes = sorted({s for s in all_sizes if s > body_size * 1.15}, reverse=True)
    if not large_sizes:
        return []

    # Map size → heading level (1 = largest)
    size_level: dict[float, int] = {}
    for i, sz in enumerate(large_sizes[:3]):
        size_level[sz] = i + 1

    toc: list = []
    seen_titles: set = set()
    for spans in page_spans:
        for sp in spans:
            lvl = size_level.get(sp["size"])
            if lvl is None:
                continue
            title = sp["text"].strip()
            # Skip very short or all-numeric titles (page numbers etc.)
            if len(title) < 4 or title.isdigit():
                continue
            key = (sp["page"], title[:40])
            if key in seen_titles:
                continue
            seen_titles.add(key)
            toc.append((lvl, title, sp["page"]))

    if len(toc) >= 3:
        return toc

    # Fallback: regex on plain text
    toc = []
    for page in doc:
        text = page.get_text("text") or ""
        for m in _SECTION_HEADING_RE.finditer(text):
            title = m.group().strip()
            # Infer level from depth of dotted number
            first_token = title.split()[0]
            dots = first_token.count(".")
            lvl = min(dots + 1, 3)
            toc.append((lvl, title, page.number + 1))
    return toc


def _chunk_structured_pdf_sync(
    content: bytes, doc_type: str, chunk_size: int, overlap: int
) -> list[dict]:
    import fitz, tempfile, os

    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    try:
        tmp.write(content); tmp.flush(); tmp.close()
        chunks = _chunk_structured_pdf(tmp.name, doc_type, chunk_size, overlap)
    finally:
        os.unlink(tmp.name)

    if not chunks:
        return []
    return _merge_small(chunks, MIN_CHUNK)


def _chunk_structured_pdf(
    path: str, doc_type: str, chunk_size: int, overlap: int
) -> list[dict]:
    """
    ToC-driven extraction.

    1. Build page→section map (deepest ToC section for each page).
    2. For every page: extract tables atomically, accumulate prose per section.
    3. After all pages: chunk each section's prose with a sliding window.
    4. Detect figure captions adjacent to image bounding boxes.

    If the PDF has fewer than 5 ToC entries (e.g. USDM IG with sparse embedded
    bookmarks), falls back to _extract_sections_from_text which detects headings
    by font-size heuristics and numbered-section patterns before giving up to
    the page-by-page fallback.

    Tables and figures each get content_type metadata; text chunks carry
    the full hierarchical section path so retrieval has rich context.
    """
    import fitz

    doc = fitz.open(path)
    toc = doc.get_toc()

    if len(toc) < 5:
        # Try heading-based section extraction before giving up
        synthetic_toc = _extract_toc_from_headings(doc)
        if len(synthetic_toc) >= 3:
            toc = synthetic_toc
        else:
            doc.close()
            chunks, _ = _chunk_pdf_file(path, chunk_size, overlap)
            return chunks

    page_map = _build_page_section_map(toc, len(doc))

    all_chunks: list[dict] = []
    # prose_buckets: section_path → list[str text blocks]
    prose_buckets: dict[str, list[str]]  = {}
    bucket_meta:   dict[str, dict]       = {}  # first page + domain per section

    try:
        for page_num in range(len(doc)):
            page     = doc[page_num]
            sec_info = page_map[page_num]
            sec_path = sec_info["path"]
            domain   = sec_info.get("domain")

            if sec_path not in bucket_meta:
                bucket_meta[sec_path] = {"page_start": page_num + 1, "domain": domain}

            quick_text  = page.get_text("text") or ""
            table_rects: list = []

            # ── Tables ──────────────────────────────────────────────────────
            # Always attempt find_tables on structured docs; PyMuPDF is fast
            fitz_tables = page.find_tables()
            for t in fitz_tables:
                rows = t.extract()
                if not rows:
                    continue
                md = _table_to_markdown(rows)
                if not md:
                    continue
                cols      = [str(r or "").strip() for r in rows[0]]
                row_count = len(rows) - 1
                prefix    = f"[{sec_path}]\n"

                row_chunks = _split_variable_table_rows(md, sec_path, domain, page_num + 1, cols)
                if row_chunks:
                    all_chunks.extend(row_chunks)      # SDTM variable rows
                else:
                    general_chunks = _split_general_table_rows(md, sec_path, domain, page_num + 1, cols)
                    if general_chunks:
                        all_chunks.extend(general_chunks)   # general row split
                    else:
                        for block_md in _split_table_block(md, chunk_size):
                            all_chunks.append({
                                "text":     prefix + block_md,
                                "section":  sec_path,
                                "page":     page_num + 1,
                                "is_table": True,
                                "metadata": {
                                    "content_type": "table",
                                    "section_path": sec_path,
                                    "domain":       domain,
                                    "page":         page_num + 1,
                                    "columns":      cols[:12],
                                    "row_count":    row_count,
                                },
                            })
                table_rects.append(t.bbox)

            # ── Figures: extract caption + image bytes ───────────────────────
            images = page.get_images(full=True)
            if images:
                for fi in _extract_figure_info(page, images):
                    caption = fi["caption"]
                    stub    = caption if caption else (
                        f"Figure on page {page_num + 1} in section: {sec_path}"
                    )
                    chunk: dict = {
                        "text":    f"[{sec_path}]\n{stub}",
                        "section": sec_path,
                        "page":    page_num + 1,
                        "metadata": {
                            "content_type": "figure",
                            "section_path": sec_path,
                            "domain":       domain,
                            "page":         page_num + 1,
                            "has_caption":  bool(caption),
                            "image_width":  fi["width"],
                            "image_height": fi["height"],
                        },
                    }
                    if fi["image_bytes"]:
                        chunk["image_bytes"] = fi["image_bytes"]  # stripped by main.py
                        chunk["image_ext"]   = fi["image_ext"]
                    all_chunks.append(chunk)

            # ── Prose: exclude table regions ────────────────────────────────
            if table_rects:
                blocks = page.get_text("blocks")
                for blk in blocks:
                    bx0, by0, bx1, by1, btext = blk[:5]
                    br = fitz.Rect(bx0, by0, bx1, by1)
                    if any(br.intersects(fitz.Rect(r)) for r in table_rects):
                        continue
                    t = btext.strip()
                    if t:
                        prose_buckets.setdefault(sec_path, []).append((page_num + 1, t))
            else:
                t = quick_text.strip()
                if t:
                    prose_buckets.setdefault(sec_path, []).append((page_num + 1, t))

    finally:
        doc.close()

    # ── Chunk prose buckets ──────────────────────────────────────────────────
    for sec_path, page_text_pairs in prose_buckets.items():
        meta       = bucket_meta.get(sec_path, {})
        domain     = meta.get("domain")
        first_page = meta.get("page_start", 1)
        prefix     = f"[{sec_path}]\n"
        eff_size   = max(chunk_size - len(prefix), 400)

        prose = "\n\n".join(t for _, t in page_text_pairs)

        # For long sections, track which pages each window falls on
        # by building a cumulative char→page index
        char_page: list[int] = []
        for pg, t in page_text_pairs:
            char_page.extend([pg] * (len(t) + 2))  # +2 for "\n\n" separator

        def _page_at(char_pos: int) -> int:
            if not char_page or char_pos >= len(char_page):
                return first_page
            return char_page[char_pos]

        char_offset = 0
        for window in _windows(prose, eff_size, overlap):
            win_start_page = _page_at(char_offset)
            win_end_page   = _page_at(min(char_offset + len(window) - 1, len(char_page) - 1))
            page_ref       = win_start_page if win_start_page == win_end_page else win_start_page
            page_range     = f"p{win_start_page}" if win_start_page == win_end_page else f"p{win_start_page}-{win_end_page}"
            all_chunks.append({
                "text":    prefix + window,
                "section": sec_path,
                "page":    page_ref,
                "metadata": {
                    "content_type": "text",
                    "section_path": sec_path,
                    "domain":       domain,
                    "page_start":   win_start_page,
                    "page_end":     win_end_page,
                    "page_range":   page_range,
                },
            })
            char_offset += max(eff_size - overlap, 1)

    return all_chunks


def _build_page_section_map(toc: list, n_pages: int) -> list[dict]:
    """
    Assign each 0-indexed page to the deepest ToC section covering it.

    Algorithm: iterate ToC in document order; for each entry compute its
    page range (until the next entry at the same or higher level).  Assign
    that section to every page in the range — later iterations with deeper
    level will override shallower assignments, so the final map always
    reflects the most specific section.
    """
    # Pre-compute full hierarchical paths for every ToC entry
    entry_info: list[dict] = []
    for i, (level, title, page_1idx) in enumerate(toc):
        parts = [title.strip()]
        lv    = level
        for j in range(i - 1, -1, -1):
            pl, pt, _ = toc[j]
            if pl < lv:
                parts.insert(0, pt.strip())
                lv = pl
                if lv == 1:
                    break
        full_path = " > ".join(parts)
        entry_info.append({
            "level":      level,
            "path":       full_path,
            "page_start": max(page_1idx - 1, 0),
            "domain":     _detect_sdtm_domain(full_path),
        })

    # Initialise map; default = top-level document
    page_map: list[dict] = [
        {"path": "Document", "level": 0, "domain": None}
        for _ in range(n_pages)
    ]

    for i, sec in enumerate(entry_info):
        # Compute page range end: next entry at same or higher level
        next_start = n_pages
        for j in range(i + 1, len(entry_info)):
            if entry_info[j]["level"] <= sec["level"]:
                next_start = entry_info[j]["page_start"]
                break

        for p in range(sec["page_start"], min(next_start, n_pages)):
            if sec["level"] >= page_map[p]["level"]:
                page_map[p] = {
                    "path":   sec["path"],
                    "level":  sec["level"],
                    "domain": sec["domain"],
                }

    return page_map


def _detect_sdtm_domain(text: str) -> Optional[str]:
    """Return the first SDTM domain acronym found in text, or None."""
    for domain in sorted(SDTM_DOMAINS, key=len, reverse=True):
        if re.search(rf"(?<![A-Z]){re.escape(domain)}(?![A-Z])", text):
            return domain
    return None


def _extract_figure_info(page, images: list) -> list[dict]:
    """
    For each significant image on the page, extract:
    - caption: nearest text within 120pt above OR below the image bbox
    - image_bytes / image_ext: raw bytes for MinIO upload
    Skips duplicate xrefs and images smaller than 50×50px (icons/borders).
    """
    results    = []
    seen_xrefs: set = set()
    blocks     = page.get_text("blocks")

    for img_info in images:
        xref = img_info[0]
        if xref in seen_xrefs:
            continue
        seen_xrefs.add(xref)

        width, height = img_info[2], img_info[3]
        if width < 50 or height < 50:      # skip icons / decorative elements
            continue

        try:
            rects = page.get_image_rects(xref)
        except Exception:
            continue
        if not rects:
            continue
        img_rect = rects[0]

        # Extract image bytes via PyMuPDF
        try:
            img_data    = page.parent.extract_image(xref)
            image_bytes = img_data.get("image", b"")
            image_ext   = img_data.get("ext", "png")
        except Exception:
            image_bytes, image_ext = b"", "png"

        # Search for caption ABOVE or BELOW the image (120pt radius)
        best_caption, best_dist = "", float("inf")
        for blk in blocks:
            bx0, by0, bx1, by1, btext = blk[:5]
            t = btext.strip()
            if not t:
                continue
            if by0 >= img_rect.y1:          # below image
                dist = by0 - img_rect.y1
            elif by1 <= img_rect.y0:        # above image
                dist = img_rect.y0 - by1
            else:
                continue                    # overlapping — skip
            if dist < 120 and dist < best_dist:
                best_dist, best_caption = dist, t

        results.append({
            "caption":     best_caption,
            "image_bytes": image_bytes,
            "image_ext":   image_ext,
            "width":       width,
            "height":      height,
        })
    return results


# ── Generic page-by-page fallback ─────────────────────────────────────────────

def _extract_and_chunk_pdf_sync(content: bytes, chunk_size: int, overlap: int) -> list[dict]:
    import fitz, tempfile, os

    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    try:
        tmp.write(content); tmp.flush(); tmp.close()
        all_chunks, total_chars = _chunk_pdf_file(tmp.name, chunk_size, overlap)
    finally:
        os.unlink(tmp.name)

    if total_chars < 100:
        return []
    return _merge_small(all_chunks, MIN_CHUNK)


def _chunk_pdf_file(path: str, chunk_size: int, overlap: int):
    """Page-by-page fallback. Returns (chunks, total_chars)."""
    import fitz

    all_chunks:  list[dict] = []
    total_chars: int        = 0
    doc = fitz.open(path)
    try:
        for page_num in range(len(doc)):
            page       = doc[page_num]
            page_label = f"[Page {page_num + 1}]"
            quick_text = page.get_text("text") or ""

            if _page_likely_has_table(quick_text):
                fitz_tables = page.find_tables()
                table_mds:   list[str] = []
                table_rects: list      = []

                for t in fitz_tables:
                    rows = t.extract()
                    if rows:
                        md = _table_to_markdown(rows)
                        if md:
                            table_mds.append(md)
                            table_rects.append(t.bbox)

                if table_rects:
                    import fitz as _fitz
                    blocks      = page.get_text("blocks")
                    prose_lines = []
                    for blk in blocks:
                        bx0, by0, bx1, by1, btext = blk[:5]
                        br = _fitz.Rect(bx0, by0, bx1, by1)
                        if not any(br.intersects(_fitz.Rect(r)) for r in table_rects):
                            t_clean = btext.strip()
                            if t_clean:
                                prose_lines.append(t_clean)
                    prose_text = "\n".join(prose_lines)
                else:
                    prose_text = quick_text

                parts: list[str] = []
                if prose_text.strip():
                    parts.append(prose_text.strip())
                parts.extend(table_mds)
                page_text = (page_label + "\n" + "\n\n".join(parts)) if parts else ""
            else:
                page_text = (page_label + "\n" + quick_text.strip()) if quick_text.strip() else ""

            if not page_text.strip():
                continue
            total_chars += len(page_text)

            for sub in _split_text_and_tables(page_text):
                if sub["type"] == "table":
                    for block in _split_table_block(sub["content"], chunk_size):
                        all_chunks.append({
                            "text": block, "section": None,
                            "page": page_num + 1, "is_table": True,
                            "metadata": {"content_type": "table", "page": page_num + 1},
                        })
                else:
                    for window in _windows(sub["content"], chunk_size, overlap):
                        all_chunks.append({
                            "text": window, "section": None,
                            "page": page_num + 1,
                            "metadata": {"content_type": "text", "page": page_num + 1},
                        })
    finally:
        doc.close()

    return all_chunks, total_chars


# ── Non-PDF extraction ─────────────────────────────────────────────────────────

async def extract_text(content: bytes, doc_type: str) -> str:
    if content[:2] == b'PK':
        return await extract_docx(content)
    elif content[:8] == b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1':
        return extract_text_fallback(content)
    else:
        return content.decode("utf-8", errors="replace")


async def extract_pdf_ocr(content: bytes) -> str:
    try:
        import pytesseract
        from pdf2image import convert_from_bytes
        images     = convert_from_bytes(content, dpi=300)
        text_parts = []
        for i, img in enumerate(images):
            text = pytesseract.image_to_string(img, lang="eng")
            text_parts.append(f"[Page {i+1}]\n{text}")
        return "\n\n".join(text_parts)
    except ImportError:
        log.warning("tesseract.not_installed", fallback="raw_bytes")
        return extract_text_fallback(content)


async def extract_docx(content: bytes) -> str:
    try:
        import docx
        doc   = docx.Document(io.BytesIO(content))
        parts = [p.text for p in doc.paragraphs if p.text.strip()]
        return "\n\n".join(parts)
    except ImportError:
        log.warning("python_docx.not_installed")
        return extract_text_fallback(content)


def extract_text_fallback(content: bytes) -> str:
    return content.decode("utf-8", errors="replace")


# ── XPT (SAS Transport) chunker ───────────────────────────────────────────────

_XPT_ROWS_PER_CHUNK = 20   # rows batched together into one table_row chunk


def chunk_xpt(content: bytes, filename: str = "", doc_type: str = "sdtm_dataset") -> list[dict]:
    """
    Read a SAS XPT file and produce chunks:
      • 1 header/summary chunk (variable list, dtypes, shape)
      • 1 variable-definitions table chunk (content_type='table', one row per variable)
      • N table_row chunks — _XPT_ROWS_PER_CHUNK rows each, with variable_labels metadata
    """
    import os
    import tempfile
    import pandas as pd

    # ── Extract variable labels from XPT namestr records ─────────────────────
    # reader.fields is a list of dicts with keys 'name' (bytes, 8 chars) and 'label' (bytes, 40 chars)
    labels: dict[str, str] = {}
    try:
        from pandas.io.sas.sas_xport import XportReader
        with XportReader(io.BytesIO(content)) as reader:
            for f in reader.fields:
                raw_name  = f["name"]  if isinstance(f, dict) else getattr(f, "name",  b"")
                raw_label = f["label"] if isinstance(f, dict) else getattr(f, "label", b"")
                name  = raw_name.decode("ascii", errors="replace").strip()  if isinstance(raw_name,  bytes) else str(raw_name).strip()
                label = raw_label.decode("ascii", errors="replace").strip() if isinstance(raw_label, bytes) else str(raw_label).strip()
                if name:
                    labels[name] = label
    except Exception:
        pass  # labels stays {} — embedding preamble will fall back to plain col=val

    # ── Read DataFrame ────────────────────────────────────────────────────────
    parse_errors: list[str] = []
    try:
        df = pd.read_sas(io.BytesIO(content), format="xport", encoding="utf-8")
    except Exception as exc_utf8:
        parse_errors.append(f"pandas utf-8: {exc_utf8}")
        try:
            df = pd.read_sas(io.BytesIO(content), format="xport", encoding="latin-1")
        except Exception as exc_latin1:
            parse_errors.append(f"pandas latin-1: {exc_latin1}")
            # Fallback: pyreadstat handles some valid XPT variants pandas rejects.
            try:
                import pyreadstat

                tmp_path = ""
                try:
                    with tempfile.NamedTemporaryFile(suffix=".xpt", delete=False) as tmp:
                        tmp.write(content)
                        tmp_path = tmp.name
                    df, meta = pyreadstat.read_xport(tmp_path)
                finally:
                    if tmp_path and os.path.exists(tmp_path):
                        os.remove(tmp_path)

                # Backfill labels from pyreadstat metadata if namestr read failed.
                if not labels:
                    try:
                        labels = {
                            col: (meta.column_labels[idx] or "")
                            for idx, col in enumerate(df.columns)
                            if idx < len(meta.column_labels) and meta.column_labels[idx]
                        }
                    except Exception:
                        pass
            except Exception as exc_pyreadstat:
                parse_errors.append(f"pyreadstat: {exc_pyreadstat}")
                merged = " | ".join(parse_errors)
                log.warning("xpt.parse_failed", error=merged)
                return [{
                    "text": f"SAS XPT file (parse failed: {merged})",
                    "section": "header",
                    "page": 1,
                    "is_table": False,
                    "metadata": {"content_type": "text"},
                }]

    # Infer domain from filename (e.g. DM.xpt, LB.xpt, study_ae.xpt, AE_2024.xpt)
    domain = ""
    if filename:
        stem_parts = filename.upper().split(".")[0].split("_")
        # Check each segment; prefer longer matches (e.g. 'DM' over 'D' if both were valid)
        domain = next((p for p in stem_parts if p in SDTM_DOMAINS), "")
    # Fallback: if DOMAIN column present in data, use its first non-null value
    if not domain and "DOMAIN" in df.columns:
        first_domain = df["DOMAIN"].dropna().astype(str).str.upper().iloc[0:1]
        if len(first_domain) and first_domain.iloc[0] in SDTM_DOMAINS:
            domain = first_domain.iloc[0]

    cols = list(df.columns)
    n_rows, n_cols = df.shape

    # Header / variable summary chunk
    col_types = {c: str(df[c].dtype) for c in cols}
    header_lines = [
        f"Dataset: {filename or 'unknown'}" + (f"  Domain: {domain}" if domain else ""),
        f"Rows: {n_rows}   Variables: {n_cols}",
        "",
        "Variables:",
    ] + [
        f"  {c} ({col_types[c]})" + (f" — {labels[c]}" if labels.get(c) else "")
        for c in cols
    ]

    chunks: list[dict] = [{
        "text": "\n".join(header_lines),
        "section": f"{domain} Dataset Header" if domain else "Dataset Header",
        "page": 1,
        "is_table": False,
        "metadata": {
            "content_type": "text",
            "domain": domain or None,
            "columns": cols,
            "row_count": n_rows,
        },
    }]

    # ── Analytics / statistics summary chunk ─────────────────────────────────
    stats_lines = [
        f"[{domain} Dataset Statistics]" if domain else "[Dataset Statistics]",
        f"Dataset: {filename or 'unknown'}",
        f"Total records (rows): {n_rows}",
    ]
    stat_meta: dict = {"domain": domain or None}
    if "USUBJID" in df.columns:
        n_unique_subjects = int(df["USUBJID"].nunique())
        stat_meta["unique_subjects"] = n_unique_subjects
        stats_lines.append(f"Unique subjects (USUBJID): {n_unique_subjects}")
        stats_lines.append(f"Unique patients: {n_unique_subjects}")
    if "SITEID" in df.columns:
        site_counts = df["SITEID"].value_counts()
        stat_meta["unique_sites"] = int(site_counts.shape[0])
        stats_lines.append(f"Unique sites (SITEID): {stat_meta['unique_sites']}")
        top_sites = "  ".join(f"{s}({c})" for s, c in site_counts.head(5).items())
        stats_lines.append(f"Site distribution (top 5): {top_sites}")
    # Arms / treatment groups
    for arm_col in ("ARMCD", "ARM", "TRTP", "TRTPN"):
        if arm_col in df.columns:
            arm_counts = df[arm_col].value_counts()
            stat_meta["treatment_arms"] = arm_counts.to_dict()
            arm_dist = "  ".join(f"{a}({c})" for a, c in arm_counts.items())
            stats_lines.append(f"Treatment arms ({arm_col}): {arm_dist}")
            break
    # Date ranges for ALL date-like columns
    _date_cols = [c for c in df.columns if c.upper().endswith("DTC") or "DATE" in c.upper()]
    for date_col in _date_cols[:6]:
        non_null = df[date_col].dropna().astype(str)
        if len(non_null):
            stats_lines.append(f"{date_col} range: {non_null.min()} to {non_null.max()}")
    # Key flag/severity/outcome distributions — covers AE, DM, DS, DD domains
    for dist_col in ("AESEV", "AESER", "AESDTH", "AEOUT", "AEREL", "AEACN",
                     "DTHFL", "DSDECOD", "DSTERM", "DDTERM", "EXDOSE"):
        if dist_col in df.columns:
            vc = df[dist_col].dropna().value_counts()
            dist_str = "  ".join(f"{v}:{c}" for v, c in vc.items())
            stats_lines.append(f"{dist_col} distribution: {dist_str}")
    # DM: explicit death count for clarity
    if "DTHFL" in df.columns:
        n_deaths = int((df["DTHFL"].dropna() == "Y").sum())
        stats_lines.append(f"Deaths (DTHFL=Y): {n_deaths}")
        if "DTHDTC" in df.columns:
            death_dates = df.loc[df["DTHFL"] == "Y", "DTHDTC"].dropna().astype(str)
            if len(death_dates):
                stats_lines.append(f"DTHDTC range (deaths): {death_dates.min()} to {death_dates.max()}")
    # DS: count death-related disposition terms
    if "DSDECOD" in df.columns:
        _death_ds = df[df["DSDECOD"].str.upper().str.contains("DEATH|DIED|FATAL", na=False)]
        if len(_death_ds):
            stats_lines.append(f"DS death records (DSDECOD contains DEATH/DIED/FATAL): {len(_death_ds)}")
    # DD: summarise death detail records if domain is DD
    if domain == "DD" and "DDTERM" in df.columns:
        dd_terms = df["DDTERM"].dropna().value_counts()
        dd_str = "  ".join(f"{v}:{c}" for v, c in dd_terms.head(10).items())
        stats_lines.append(f"DDTERM distribution: {dd_str}")
    # Missing rate for key variables
    _key_vars = [c for c in ("USUBJID", "AETERM", "AEBODSYS", "LBTESTCD", "VSTESTCD") if c in df.columns]
    if _key_vars:
        missing_rates = "  ".join(
            f"{c}:{int(df[c].isna().sum())}" for c in _key_vars
        )
        stats_lines.append(f"Missing values (key cols): {missing_rates}")
    if domain:
        stats_lines.append(f"Domain: {domain}")
    stats_lines.append(f"Variables: {n_cols}")

    chunks.append({
        "text": "\n".join(stats_lines),
        "section": f"{domain} Dataset Statistics" if domain else "Dataset Statistics",
        "page": 1,
        "is_table": False,
        "metadata": {
            "content_type": "statistics",
            "row_count": n_rows,
            **stat_meta,
        },
    })

    # ── Variable definitions table chunk (content_type='table') ──────────────
    tbl_header = "| Variable | Label | Type |"
    tbl_sep    = "| --- | --- | --- |"
    tbl_rows   = [
        f"| {c} | {labels.get(c, '')} | {'Char' if 'object' in col_types[c] else 'Num'} |"
        for c in cols
    ]
    tbl_md = "\n".join([tbl_header, tbl_sep] + tbl_rows)
    prefix = f"[{domain} Dataset Variables]\n" if domain else "[Dataset Variables]\n"
    chunks.append({
        "text":     prefix + tbl_md,
        "section":  f"{domain} Dataset Variables" if domain else "Dataset Variables",
        "page":     1,
        "is_table": True,
        "metadata": {
            "content_type":    "table",
            "domain":          domain or None,
            "columns":         ["Variable", "Label", "Type"],
            "row_count":       n_cols,           # one row per variable
            "variable_labels": labels,
        },
    })

    # ── Table-row chunks ──────────────────────────────────────────────────────
    for start in range(0, n_rows, _XPT_ROWS_PER_CHUNK):
        batch = df.iloc[start: start + _XPT_ROWS_PER_CHUNK]
        # Trailing '  ' ensures the last field is caught by regex `var=val  ` patterns
        rows_text = "\n".join(
            "  ".join(f"{c}={batch.at[idx, c]}" for c in cols) + "  "
            for idx in batch.index
        )
        chunks.append({
            "text": f"[{domain or doc_type}] rows {start + 1}–{min(start + _XPT_ROWS_PER_CHUNK, n_rows)}\n{rows_text}",
            "section": f"{domain} rows {start + 1}–{min(start + _XPT_ROWS_PER_CHUNK, n_rows)}" if domain else f"rows {start + 1}–{min(start + _XPT_ROWS_PER_CHUNK, n_rows)}",
            "page": 1,
            "is_table": True,
            "metadata": {
                "content_type":    "table_row",
                "domain":          domain or None,
                "columns":         cols,
                "row_count":       int(len(batch)),
                "variable_labels": labels,
            },
        })

    log.info("xpt.chunked", filename=filename, domain=domain, rows=n_rows, chunks=len(chunks))
    return chunks


# ── Chunking for non-PDF (text/docx) ─────────────────────────────────────────

def chunk_text(text: str, doc_type: str,
               chunk_size: int = CHUNK_SIZE,
               overlap: int = CHUNK_OVERLAP) -> list[dict]:
    if doc_type in {"protocol", "sap", "csr", "dmp"}:
        return _section_aware_split(text, chunk_size, overlap)
    return _sliding_window_split(text, chunk_size, overlap)


# ── General table row splitter ────────────────────────────────────────────────

_GENERAL_ROW_MIN = 5   # only row-split tables that have at least this many data rows
_ABBREV_BATCH_SIZE = 50  # abbreviation rows consolidated to this batch size


_ABBREV_SECTION_SIGNALS = {"abbreviation", "abbreviations", "acronym", "acronyms", "glossary"}


def _is_abbreviation_table(header_cells: list[str], section: str = "") -> bool:
    """Return True if the table looks like an abbreviation/glossary table.

    Checks column headers first; falls back to section path keywords so that
    continuation pages (where PyMuPDF omits the header row) are still detected.
    """
    abbrev_signals = {"abbreviation", "abbreviations", "acronym", "acronyms",
                      "term", "terms", "definition", "definitions", "meaning"}
    normalized = {h.lower().strip() for h in header_cells if h}
    if bool(normalized & abbrev_signals) and len(header_cells) <= 3:
        return True
    # Fallback: section path contains abbreviation/glossary keyword
    section_lower = section.lower()
    return any(sig in section_lower for sig in _ABBREV_SECTION_SIGNALS)


def _split_general_table_rows(
    table_md: str, section: str, domain: str, page: int, columns: list
) -> list[dict] | None:
    """
    Row-split any non-SDTM table that has ≥5 data rows AND a text-based first
    column (not purely numeric). Each row becomes a `table_row` chunk with a
    `row_data` dict in metadata for richer key-value embedding.

    Abbreviation/glossary tables are batched (_ABBREV_BATCH_SIZE rows per chunk)
    instead of one row per chunk to prevent vector search pollution. Continuation
    pages (no repeated header) are detected via the section path.

    Returns None to fall back to single-chunk path when the table doesn't qualify.
    """
    rows = [r for r in table_md.split("\n") if r.strip() and not r.startswith("|---")]
    if len(rows) < _GENERAL_ROW_MIN + 1:    # header + min data rows
        return None

    header_row   = rows[0]
    header_cells = [c.strip() for c in header_row.strip("|").split("|")]
    sep_row      = "| " + " | ".join(["---"] * len(header_cells)) + " |"
    data_rows    = rows[1:]

    # Abbreviation tables: consolidate to batches to avoid vector search pollution
    if _is_abbreviation_table(header_cells, section):
        prefix = f"[{section}]\n" if section else ""
        chunks = []
        for i in range(0, len(data_rows), _ABBREV_BATCH_SIZE):
            batch = data_rows[i:i + _ABBREV_BATCH_SIZE]
            lines = []
            for row in batch:
                cells = [c.strip() for c in row.strip("|").split("|")]
                if len(cells) >= 2 and cells[0]:
                    lines.append(f"{cells[0]}: {cells[1]}")
            if not lines:
                continue
            batch_text = f"{prefix}Abbreviations and definitions:\n" + "\n".join(lines)
            chunks.append({
                "text":     batch_text,
                "section":  section,
                "page":     page,
                "is_table": True,
                "metadata": {
                    "content_type": "table_row",
                    "section_path": section,
                    "domain":       domain,
                    "columns":      columns,
                    "row_count":    len(lines),
                    "page":         page,
                    "is_abbreviation_batch": True,
                },
            })
        return chunks if chunks else None

    chunks = []
    for row in data_rows:
        cells     = [c.strip() for c in row.strip("|").split("|")]
        if not cells or not cells[0]:
            continue
        first_val = cells[0]
        if re.match(r'^\d+(\.\d+)?$', first_val):   # purely numeric → bail out
            return None

        row_data = {
            col: cells[i]
            for i, col in enumerate(header_cells)
            if col and i < len(cells)
        }
        row_md = f"{header_row}\n{sep_row}\n{row}"
        prefix = f"[{section}]\n" if section else ""
        label  = cells[1] if len(cells) > 1 else ""
        text   = f"{prefix}{first_val}{' — ' + label if label else ''}.\n{row_md}"

        chunks.append({
            "text":     text,
            "section":  section,
            "page":     page,
            "is_table": True,
            "metadata": {
                "content_type": "table_row",
                "section_path": section,
                "domain":       domain,
                "columns":      columns,
                "row_data":     row_data,
                "row_count":    1,
                "page":         page,
            },
        })
    return chunks if len(chunks) >= _GENERAL_ROW_MIN else None


# ── Table helpers ─────────────────────────────────────────────────────────────

def _page_likely_has_table(text: str) -> bool:
    """SDTM-specific table heuristic."""
    indicators = [
        "Variable Name", "Variable Label", "CDISC Notes", "Codelist",
        "Core", "Req", "Exp", "Perm", "Identifier", "Topic", "Qualifier",
        "Timing", "Type", "Role", "Order",
    ]
    return sum(1 for kw in indicators if kw in text) >= 3


def _table_to_markdown(rows: list[list]) -> str:
    if not rows:
        return ""
    cleaned: list[list[str]] = []
    for row in rows:
        cells = []
        for cell in row:
            if cell is None:
                cells.append("")
            else:
                cells.append(str(cell).strip().replace("\n", " ").replace("|", "\\|"))
        cleaned.append(cells)

    if not cleaned:
        return ""
    n_cols = max(len(row) for row in cleaned)
    if n_cols == 0:
        return ""
    for row in cleaned:
        while len(row) < n_cols:
            row.append("")

    lines = [
        "| " + " | ".join(cleaned[0]) + " |",
        "| " + " | ".join(["---"] * n_cols) + " |",
    ]
    for row in cleaned[1:]:
        lines.append("| " + " | ".join(row[:n_cols]) + " |")

    return "\n".join(lines) if len(lines) >= 3 else ""


def _split_text_and_tables(text: str) -> list[dict]:
    segments:  list[dict] = []
    text_buf:  list[str]  = []
    table_buf: list[str]  = []
    in_table = False

    for line in text.splitlines():
        stripped      = line.strip()
        is_table_line = stripped.startswith("|")

        if is_table_line:
            if not in_table:
                if text_buf:
                    content = "\n".join(text_buf).strip()
                    if content:
                        segments.append({"type": "text", "content": content})
                    text_buf = []
                in_table = True
            table_buf.append(line)
        else:
            if in_table and stripped == "":
                table_buf.append(line)
            else:
                if in_table:
                    content = "\n".join(table_buf).strip()
                    if content:
                        segments.append({"type": "table", "content": content})
                    table_buf = []
                    in_table  = False
                text_buf.append(line)

    if in_table and table_buf:
        content = "\n".join(table_buf).strip()
        if content:
            segments.append({"type": "table", "content": content})
    elif text_buf:
        content = "\n".join(text_buf).strip()
        if content:
            segments.append({"type": "text", "content": content})

    return segments


def _split_table_block(table_md: str, chunk_size: int) -> list[str]:
    """Split large markdown table keeping header on every sub-chunk. O(N)."""
    if len(table_md) <= chunk_size:
        return [table_md]

    lines = table_md.splitlines()
    if len(lines) < 3:
        return [table_md]

    data_rows   = lines[2:]
    header_size = len(lines[0]) + 1 + len(lines[1])

    chunks:        list[str]  = []
    current_lines: list[str]  = list(lines[:2])
    current_size:  int        = header_size

    for row in data_rows:
        new_size = current_size + 1 + len(row)
        if new_size > chunk_size and len(current_lines) > 2:
            chunks.append("\n".join(current_lines))
            current_lines = list(lines[:2]) + [row]
            current_size  = header_size + 1 + len(row)
        else:
            current_lines.append(row)
            current_size = new_size

    if len(current_lines) > 2:
        chunks.append("\n".join(current_lines))

    return chunks or [table_md]


# ── Chunking helpers ──────────────────────────────────────────────────────────

def _section_aware_split(text: str, chunk_size: int, overlap: int) -> list[dict]:
    section_pattern = re.compile(
        r'(?m)^('
        r'\d+(?:\.\d+){0,2}[ \t]+[A-Z][A-Za-z][^\n]{5,78}'
        r'|SECTION[ \t]+\d+[^\n]{0,60}'
        r'|[A-Z]{2}[A-Z ]{2,58}[A-Z]{2}'
        r')$'
    )

    segments:       list[tuple[str, str]] = []
    current_header = "Introduction"
    last_end       = 0

    for m in section_pattern.finditer(text):
        body = text[last_end:m.start()].strip()
        if body:
            segments.append((current_header, body))
        current_header = m.group(0).strip()
        last_end       = m.end()

    tail = text[last_end:].strip()
    if tail:
        segments.append((current_header, tail))

    raw_chunks: list[dict] = []
    for section, body in segments:
        prefix     = f"[{section}]\n"
        eff_size   = max(chunk_size - len(prefix), 200)

        for sub in _split_text_and_tables(body):
            if sub["type"] == "table":
                for block in _split_table_block(sub["content"], eff_size):
                    raw_chunks.append({
                        "text": prefix + block, "section": section,
                        "page": None, "is_table": True,
                        "metadata": {"content_type": "table", "section_path": section},
                    })
            else:
                for window in _windows(sub["content"], eff_size, overlap):
                    raw_chunks.append({
                        "text": prefix + window, "section": section,
                        "page": None,
                        "metadata": {"content_type": "text", "section_path": section},
                    })

    return _merge_small(raw_chunks, MIN_CHUNK)


def _sliding_window_split(text: str, chunk_size: int, overlap: int) -> list[dict]:
    chunks: list[dict] = []
    for sub in _split_text_and_tables(text):
        if sub["type"] == "table":
            for block in _split_table_block(sub["content"], chunk_size):
                chunks.append({
                    "text": block, "section": None, "page": None, "is_table": True,
                    "metadata": {"content_type": "table"},
                })
        else:
            for window in _windows(sub["content"], chunk_size, overlap):
                chunks.append({
                    "text": window, "section": None, "page": None,
                    "metadata": {"content_type": "text"},
                })
    return chunks


def _windows(text: str, size: int, overlap: int) -> list[str]:
    """Sliding window; snaps end to sentence boundary."""
    if not text:
        return []
    size   = max(size, 200)
    chunks = []
    start  = 0
    while start < len(text):
        end = min(start + size, len(text))
        if end < len(text):
            snap = text.rfind(".", start, end)
            if snap > start + size // 2:
                end = snap + 1
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(text):
            break
        start = end - overlap
    return chunks


def _merge_small(chunks: list[dict], min_size: int) -> list[dict]:
    """Merge sub-threshold text chunks into predecessor. Tables are never merged."""
    if not chunks:
        return chunks
    merged = [chunks[0]]
    for c in chunks[1:]:
        prev = merged[-1]
        if (
            len(c["text"]) < min_size
            and not c.get("is_table")
            and not prev.get("is_table")
            and (c.get("metadata") or {}).get("content_type") != "table_row"
            and (prev.get("metadata") or {}).get("content_type") != "table_row"
        ):
            merged[-1] = {
                "text":     prev["text"] + " " + c["text"],
                "section":  prev["section"],
                "page":     prev["page"],
                "metadata": prev.get("metadata") or {},
            }
        else:
            merged.append(c)
    return merged
