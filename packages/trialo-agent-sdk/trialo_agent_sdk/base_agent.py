"""Base class for all TrialOS agents."""
import abc
import json
import logging
import time
from typing import Any, Optional
from .models import AgentContext, AgentOutput

logger = logging.getLogger(__name__)

class BaseAgent(abc.ABC):
    """
    Base class for all TrialOS agents.

    Implement the run() method with your agent logic.
    Use self.data, self.artifacts, self.notifications for scoped access.

    Audit/evaluation/tracing telemetry is emitted AUTOMATICALLY when run()
    completes — you do not need to call anything special.

    To emit custom mid-run audit events (e.g., validation.completed):
        await self.telemetry.emit_event("validation.completed", "agent_run", self.context.run_id, ...)

    Example:
        class MyAgent(BaseAgent):
            AGENT_NAME = "My Custom Agent"
            AGENT_VERSION = "1.0.0"
            REQUIRED_PERMISSIONS = ["study:data:read", "study:reports:write"]

            async def run(self, context: AgentContext) -> AgentOutput:
                ae_records = await self.data.read_sdtm_domain("AE", context.study_id)
                report = f"Found {len(ae_records)} AE records."
                artifact = await self.artifacts.save_text(report, "ae_summary.txt")
                return AgentOutput(summary=report, artifacts=[artifact])
    """

    AGENT_NAME: str = "Unnamed Agent"
    AGENT_VERSION: str = "1.0.0"
    REQUIRED_PERMISSIONS: list[str] = []
    DECLARED_TOOLS: list[str] = []

    def __init__(self, context: AgentContext):
        self.context = context
        self.data = context.data_client
        self.artifacts = context.artifact_store
        self.notifications = context.notification_client
        self.telemetry = context.telemetry
        self._tool_calls_log: list[dict] = []
        self._started_at = time.monotonic()

    @abc.abstractmethod
    async def run(self, context: AgentContext) -> AgentOutput:
        """
        Main agent logic. Called once per trigger.
        Must return an AgentOutput with summary and optional artifacts.
        Telemetry is auto-emitted after this method returns.
        """
        ...

    async def execute(self) -> AgentOutput:
        """
        Wrapper that calls run() and auto-emits telemetry.
        Call this instead of run() directly from your agent runner / k8s job.
        """
        try:
            output = await self.run(self.context)
            await self._complete_run(output, success=True)
            return output
        except Exception as e:
            logger.exception(f"Agent run failed: {e}")
            await self._complete_run(None, success=False, error=str(e))
            raise

    async def _complete_run(self, output: Optional[AgentOutput], success: bool, error: str = "") -> None:
        """Auto-emit all telemetry at run completion. Called by execute()."""
        if not hasattr(self, "telemetry") or self.telemetry is None:
            return
        try:
            if success and output is not None:
                artifact_names = [a.name for a in (output.artifacts or [])]
                await self.telemetry.complete_run(
                    output=output.summary or "",
                    tool_results=self._tool_calls_log,
                    tokens_used=output.metadata.get("tokens_used", 0),
                    model=output.metadata.get("model", self.AGENT_NAME),
                    reasoning_steps=output.metadata.get("reasoning_steps", [
                        f"{self.AGENT_NAME} v{self.AGENT_VERSION} completed successfully",
                        f"Generated {len(artifact_names)} artifact(s): {', '.join(artifact_names) or 'none'}",
                    ]),
                    sources_cited=output.metadata.get("sources_cited", []),
                    deterministic_scores=output.metadata.get("deterministic_scores"),
                )
            else:
                await self.telemetry.complete_run(
                    output=f"[ERROR] {error}" if error else "[FAILED]",
                    tool_results=self._tool_calls_log,
                )
        except Exception as _e:
            logger.warning(f"BaseAgent._complete_run telemetry failed: {_e}")

    def log_tool_call(self, tool_name: str, inputs: dict, output: Any):
        """Automatically called by SDK clients. Do not call manually."""
        self._tool_calls_log.append({
            "tool": tool_name,
            "inputs": inputs,
            "output_summary": str(output)[:200],
        })

    @property
    def tool_calls(self) -> list[dict]:
        return self._tool_calls_log

    def validate_permissions(self, requested_tool: str, tool_scope: str) -> bool:
        """Check agent has permission for a tool. Called by DataAccessClient."""
        return tool_scope in self.context.consented_permissions


def tool(permission_scope: str, description: str = ""):
    """
    Decorator to declare a tool with its required permission scope.

    Usage:
        @tool("study:data:read", "Read adverse event records")
        async def get_ae_data(self, study_id: str):
            ...
    """
    def decorator(func):
        func._is_tool = True
        func._permission_scope = permission_scope
        func._description = description
        return func
    return decorator
