"""Pydantic request/response models for the Quality Service API."""
from __future__ import annotations
from typing import Any, Literal
from uuid import UUID
from datetime import datetime
from pydantic import BaseModel, Field


# ── Shared ────────────────────────────────────────────────────────────────────

QualityState = Literal["verified", "hallucinated", "unverified"]


class SourceChunk(BaseModel):
    chunk_id: str = Field(..., description="Unique chunk identifier from document_chunks table")
    chunk_index: int | None = Field(None, description="Positional index within the document")
    content: str = Field(..., description="Raw text content of the chunk")
    section: str | None = Field(None, description="Section label (e.g. 'Objectives')")
    page_number: int | None = Field(None, description="Source PDF page number")


# ── Hallucination check ───────────────────────────────────────────────────────

class HallucinationCheckRequest(BaseModel):
    section_data: dict[str, Any] = Field(
        ...,
        description=(
            "Extracted section JSON with source_span-wrapped fields. "
            "Each leaf value should be {'value': X, 'source_span': '...', ...}."
        ),
    )
    chunks: list[SourceChunk] = Field(
        ...,
        description="Source document chunks retrieved for this section.",
    )

    model_config = {
        "json_schema_extra": {
            "example": {
                "section_data": {
                    "objectiveDescription": {
                        "value": "To evaluate efficacy of drug X",
                        "source_span": "To evaluate efficacy of drug X in adult patients",
                    }
                },
                "chunks": [
                    {
                        "chunk_id": "abc-123",
                        "chunk_index": 5,
                        "content": "To evaluate efficacy of drug X in adult patients with...",
                        "section": "Objectives",
                        "page_number": 8,
                    }
                ],
            }
        }
    }


class FieldQualityEntry(BaseModel):
    field_path: str = Field(..., description="Dot-notation path, e.g. '.study.studyTitle'")
    quality_state: QualityState
    source_span: str | None = None
    chunk_id: str | None = None
    hallucination_reason: str | None = None


class HallucinationCheckResponse(BaseModel):
    spans_verified: int
    hallucinations_detected: int
    provenance_coverage: float = Field(..., description="verified / (verified + hallucinated)")
    field_quality: dict[str, QualityState] = Field(
        default_factory=dict,
        description="Flat map of field path → quality state",
    )
    annotated_data: dict[str, Any] = Field(
        ..., description="Original section_data with hallucination/verified flags added"
    )


# ── Structural validation ─────────────────────────────────────────────────────

class StructuralValidationRequest(BaseModel):
    usdm_json: dict[str, Any] = Field(
        ..., description="Fully assembled USDM v4 JSON (study root)"
    )

    model_config = {
        "json_schema_extra": {
            "example": {
                "usdm_json": {
                    "study": {
                        "id": "STUDY-001",
                        "versions": [
                            {
                                "id": "VERSION-001",
                                "versionIdentifier": "1.0",
                                "titles": [{"id": "T-001", "text": "A Phase 2 Study..."}],
                                "studyDesigns": [
                                    {
                                        "id": "DESIGN-001",
                                        "objectives": [],
                                        "studyArms": [],
                                        "studyEpochs": [],
                                    }
                                ],
                            }
                        ],
                    }
                }
            }
        }
    }


class ValidationResult(BaseModel):
    passed: bool
    score: float = Field(..., ge=0.0, le=1.0)
    gaps: list[str]


class StructuralValidationResponse(BaseModel):
    ich_m11: ValidationResult
    cdisc_ct: ValidationResult
    schema_check: ValidationResult
    overall_score: float = Field(..., ge=0.0, le=1.0)
    overall_passed: bool


# ── Full quality run ──────────────────────────────────────────────────────────

class QualityRunRequest(BaseModel):
    usdm_json: dict[str, Any] = Field(..., description="Assembled USDM v4 JSON")
    section_results: dict[str, Any] | None = Field(
        None,
        description=(
            "Raw section extraction results (before _unwrap_spans). "
            "Keys are section IDs like 'study_meta', 'objectives_endpoints'. "
            "If provided, hallucination checks are run per section."
        ),
    )
    chunks_by_section: dict[str, list[SourceChunk]] | None = Field(
        None,
        description="Source chunks per section ID. Required if section_results is provided.",
    )
    conversion_id: str | None = Field(
        None, description="UUID of the usdm_conversions record this quality run is for"
    )
    run_id: str | None = Field(
        None, description="UUID of the agent_runs record that produced this USDM"
    )

    model_config = {
        "json_schema_extra": {
            "example": {
                "usdm_json": {"study": {"id": "STUDY-001", "versions": []}},
                "conversion_id": "16a7158c-5250-4bd8-a7fe-b1ea5339fd5a",
                "run_id": "abc-def-123",
                "section_results": None,
                "chunks_by_section": None,
            }
        }
    }


class QualityRunResponse(BaseModel):
    report_id: str
    conversion_id: str | None
    run_id: str | None
    checked_at: datetime
    summary: dict[str, Any] = Field(
        ...,
        description="High-level counts: spans_verified, hallucinations_detected, provenance_coverage",
    )
    field_quality: dict[str, QualityState] = Field(
        default_factory=dict,
        description="Flat map of field path → quality state for every extracted field",
    )
    structural: StructuralValidationResponse
    overall_score: float
    overall_passed: bool


# ── Report retrieval ──────────────────────────────────────────────────────────

class QualityReportSummary(BaseModel):
    report_id: str
    conversion_id: str | None
    run_id: str | None
    checked_at: datetime
    overall_score: float
    overall_passed: bool
    spans_verified: int
    hallucinations_detected: int
    ich_m11_score: float
    cdisc_ct_score: float


class QualityReportListResponse(BaseModel):
    total: int
    reports: list[QualityReportSummary]
