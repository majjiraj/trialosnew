"""Data models for the TrialOS Agent SDK."""
from dataclasses import dataclass, field
from typing import Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .tools import DataAccessClient, ArtifactStore, NotificationClient, TelemetryClient

@dataclass
class AgentContext:
    """Execution context passed to agent.run()."""
    run_id: str
    study_id: str
    org_id: str
    study_name: str
    protocol_number: str
    study_phase: str
    consented_permissions: list[str]
    declared_tools: list[str]
    trigger_type: str
    trigger_payload: dict
    data_client: Any  # DataAccessClient
    artifact_store: Any  # ArtifactStore
    notification_client: Any  # NotificationClient
    telemetry: Any  # TelemetryClient — auto-emits audit/eval on run completion
    runtime_url: str = ""  # Agent-runtime base URL for callbacks
    is_test_run: bool = False
    memory_context: list[dict] = field(default_factory=list)
    extra: dict = field(default_factory=dict)

@dataclass
class Artifact:
    """A generated artifact (report, listing, etc.)."""
    name: str
    s3_key: str
    content_type: str
    size_bytes: int

@dataclass
class AgentOutput:
    """Return value from agent.run()."""
    summary: str
    findings: list[dict] = field(default_factory=list)
    artifacts: list[Artifact] = field(default_factory=list)
    proposed_actions: list[dict] = field(default_factory=list)
    notifications_sent: int = 0
    metadata: dict = field(default_factory=dict)

@dataclass
class ToolCall:
    """Record of a tool call made during execution."""
    tool_name: str
    inputs: dict
    output: Any
    duration_ms: int
