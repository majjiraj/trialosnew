"""Hallucination detection: verify extracted source_spans against retrieved chunks."""
from __future__ import annotations
from typing import Any


def verify_source_spans(section_data: Any, chunks: list[dict]) -> tuple[Any, int, int]:
    """Walk section_data and mark each source_span as verified or hallucinated.

    Returns (annotated_data, verified_count, hallucinated_count).
    """
    full_corpus = " ".join(" ".join(c.get("content", "").split()) for c in chunks)
    verified = 0
    hallucinated = 0

    def _check(node: Any) -> None:
        nonlocal verified, hallucinated
        if isinstance(node, dict):
            if "source_span" in node:
                span_norm = " ".join(node["source_span"].split())
                if span_norm and span_norm not in full_corpus:
                    node["hallucination_detected"] = True
                    node["hallucination_reason"] = (
                        f"source_span not found in retrieved chunks: '{node['source_span'][:80]}'"
                    )
                    hallucinated += 1
                else:
                    node["verified"] = True
                    verified += 1
                    for chunk in chunks:
                        if span_norm in " ".join(chunk.get("content", "").split()):
                            node["source_chunk_id"] = chunk.get("chunk_id")
                            node["source_chunk_index"] = chunk.get("chunk_index")
                            break
            for k, v in node.items():
                if k not in ("hallucination_detected", "hallucination_reason",
                             "verified", "source_chunk_id", "source_chunk_index"):
                    _check(v)
        elif isinstance(node, list):
            for item in node:
                _check(item)

    _check(section_data)
    return section_data, verified, hallucinated


def collect_field_quality(section_data: Any, path_prefix: str = "") -> dict[str, str]:
    """Return a flat {path: quality_state} map from already-annotated section data."""
    quality: dict[str, str] = {}

    def _walk(node: Any, path: str) -> None:
        if isinstance(node, dict):
            if "source_span" in node:
                if node.get("hallucination_detected"):
                    quality[path] = "hallucinated"
                elif node.get("verified"):
                    quality[path] = "verified"
                else:
                    quality[path] = "unverified"
            for k, v in node.items():
                if k not in ("hallucination_detected", "hallucination_reason",
                             "verified", "source_chunk_id", "source_chunk_index"):
                    _walk(v, f"{path}.{k}")
        elif isinstance(node, list):
            for i, item in enumerate(node):
                _walk(item, f"{path}[{i}]")

    _walk(section_data, path_prefix)
    return quality


def check_scalar_quality(raw_val: Any) -> str | None:
    """Return quality state for a single source_span-wrapped value, or None if not wrapped."""
    if not isinstance(raw_val, dict) or "source_span" not in raw_val:
        return None
    if raw_val.get("hallucination_detected"):
        return "hallucinated"
    if raw_val.get("verified"):
        return "verified"
    return "unverified"
