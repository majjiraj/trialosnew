"""
TrialOS Agent SDK
Build custom clinical trial AI agents for the TrialOS marketplace.
"""
from .base_agent import BaseAgent
from .tools import tool, DataAccessClient, ArtifactStore, NotificationClient, TelemetryClient
from .test_harness import TestHarness
from .models import AgentContext, AgentOutput, ToolCall
from .features import (
    # Feature 1: Dynamic Retrieval Augmentation
    augment_ig_queries,
    augment_conformance_queries,
    # Feature 2: Confidence-Based Execution Branching
    BranchResult,
    compute_agent_confidence,
    branch_on_confidence,
    # Feature 3: Validation Escalation
    escalate_findings,
    is_blocked_by_escalation,
    escalation_summary,
    ESCALATION_BLOCKING_TYPES,
    ESCALATION_POLICY_ID,
    # Feature 4: Contextual Prompt Injection for HITL
    build_hitl_context,
    inject_hitl_context_into_description,
    build_hitl_notification_body,
    # Feature 5: Memory Retrieval and Context Building
    retrieve_relevant_memories,
    build_memory_context_block,
    augment_terminology_queries,
    _CODELIST_QUERY_TEMPLATES,
)

__all__ = [
    "BaseAgent", "tool", "DataAccessClient", "ArtifactStore", "NotificationClient",
    "TelemetryClient", "TestHarness", "AgentContext", "AgentOutput", "ToolCall",
    # Feature 1
    "augment_ig_queries", "augment_conformance_queries",
    # Feature 2
    "BranchResult", "compute_agent_confidence", "branch_on_confidence",
    # Feature 3
    "escalate_findings", "is_blocked_by_escalation", "escalation_summary",
    "ESCALATION_BLOCKING_TYPES", "ESCALATION_POLICY_ID",
    # Feature 4
    "build_hitl_context", "inject_hitl_context_into_description",
    "build_hitl_notification_body",
    # Feature 5
    "retrieve_relevant_memories", "build_memory_context_block",
    "augment_terminology_queries", "_CODELIST_QUERY_TEMPLATES",
]
__version__ = "1.3.0"
