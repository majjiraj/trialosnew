"""
TrialOS Agent SDK — Scoped Tool Clients
Agents use these clients (not direct DB/API access) to ensure:
- Permission enforcement
- Automatic audit logging
- No arbitrary query construction
"""
import httpx
import json
import time
from typing import Optional, Any
import logging

logger = logging.getLogger(__name__)

class DataAccessClient:
    """
    Scoped data access for agents.
    Cannot construct arbitrary queries — only permitted operations.
    """

    def __init__(self, runtime_url: str, run_id: str, study_id: str, org_id: str,
                 consented_permissions: list[str]):
        self.runtime_url = runtime_url
        self.run_id = run_id
        self.study_id = study_id
        self.org_id = org_id
        self.consented_permissions = consented_permissions

    def _require_permission(self, scope: str):
        if scope not in self.consented_permissions:
            raise PermissionError(f"Agent does not have permission: {scope}")

    async def read_sdtm_domain(self, domain: str, filters: dict = None, limit: int = 1000) -> list[dict]:
        """Read records from a SDTM domain. Requires study:data:read."""
        self._require_permission("study:data:read")
        async with httpx.AsyncClient() as client:
            resp = await client.post(f"{self.runtime_url}/tools/execute", json={
                "tool_name": "read_sdtm_domain",
                "input": {"domain": domain, "study_id": self.study_id, "filters": filters or {}, "limit": limit},
                "run_id": self.run_id
            })
            resp.raise_for_status()
            return resp.json().get("records", [])

    async def read_adam_dataset(self, dataset: str, filters: dict = None) -> list[dict]:
        """Read an ADaM dataset. Requires study:data:read."""
        self._require_permission("study:data:read")
        async with httpx.AsyncClient() as client:
            resp = await client.post(f"{self.runtime_url}/tools/execute", json={
                "tool_name": "read_adam_dataset",
                "input": {"dataset": dataset, "study_id": self.study_id, "filters": filters or {}},
                "run_id": self.run_id
            })
            resp.raise_for_status()
            return resp.json().get("records", [])

    async def search_documents(self, query: str, document_types: list[str] = None, top_k: int = 5) -> list[dict]:
        """Semantic search across study documents. Requires study:docs:read."""
        self._require_permission("study:docs:read")
        async with httpx.AsyncClient() as client:
            resp = await client.post(f"{self.runtime_url}/tools/execute", json={
                "tool_name": "search_documents",
                "input": {"query": query, "study_id": self.study_id, "document_types": document_types, "top_k": top_k},
                "run_id": self.run_id
            })
            resp.raise_for_status()
            return resp.json().get("results", [])

    async def raise_query(self, domain: str, query_text: str, subject_id: str = None, field_name: str = None) -> dict:
        """Raise a data query. Requires study:queries:write."""
        self._require_permission("study:queries:write")
        async with httpx.AsyncClient() as client:
            resp = await client.post(f"{self.runtime_url}/tools/execute", json={
                "tool_name": "raise_data_query",
                "input": {"study_id": self.study_id, "domain": domain, "query_text": query_text,
                          "subject_id": subject_id, "field_name": field_name},
                "run_id": self.run_id
            })
            resp.raise_for_status()
            return resp.json()

    async def query_budget(self, query_type: str, site_id: str = None) -> dict:
        """Query budget data. Requires study:data:read."""
        self._require_permission("study:data:read")
        async with httpx.AsyncClient() as client:
            resp = await client.post(f"{self.runtime_url}/tools/execute", json={
                "tool_name": "query_budget_data",
                "input": {"study_id": self.study_id, "query_type": query_type, "site_id": site_id},
                "run_id": self.run_id
            })
            resp.raise_for_status()
            return resp.json()

class ArtifactStore:
    """Write-only artifact storage for agent outputs."""

    def __init__(self, runtime_url: str, run_id: str, study_id: str, org_id: str, consented_permissions: list[str]):
        self.runtime_url = runtime_url
        self.run_id = run_id
        self.study_id = study_id
        self.org_id = org_id
        self.consented_permissions = consented_permissions

    async def save_report(self, title: str, content: str) -> dict:
        """Generate and save a PDF/Markdown report. Requires study:reports:write."""
        if "study:reports:write" not in self.consented_permissions:
            raise PermissionError("Agent does not have study:reports:write permission")
        async with httpx.AsyncClient() as client:
            resp = await client.post(f"{self.runtime_url}/tools/execute", json={
                "tool_name": "generate_pdf_report",
                "input": {"title": title, "content": content, "study_id": self.study_id},
                "run_id": self.run_id
            })
            resp.raise_for_status()
            return resp.json()

    async def save_text(self, content: str, filename: str) -> dict:
        return await self.save_report(filename, content)

class NotificationClient:
    """Send notifications from agents."""

    def __init__(self, runtime_url: str, run_id: str, org_id: str, study_id: str, consented_permissions: list[str]):
        self.runtime_url = runtime_url
        self.run_id = run_id
        self.org_id = org_id
        self.study_id = study_id
        self.consented_permissions = consented_permissions

    async def notify(self, user_id: str, title: str, body: str, severity: str = "info"):
        """Send notification. Requires platform:notify:write."""
        if "platform:notify:write" not in self.consented_permissions:
            raise PermissionError("Agent does not have platform:notify:write permission")
        async with httpx.AsyncClient() as client:
            await client.post(f"{self.runtime_url}/tools/execute", json={
                "tool_name": "send_notification",
                "input": {"user_id": user_id, "title": title, "body": body, "severity": severity},
                "run_id": self.run_id
            })

    async def request_approval(self, title: str, description: str, proposed_action: dict, assignee_id: str) -> dict:
        """Create approval request. Requires platform:approvals:write."""
        if "platform:approvals:write" not in self.consented_permissions:
            raise PermissionError("Agent does not have platform:approvals:write permission")
        async with httpx.AsyncClient() as client:
            resp = await client.post(f"{self.runtime_url}/tools/execute", json={
                "tool_name": "create_approval_request",
                "input": {"title": title, "description": description,
                          "proposed_action": proposed_action, "assignee_id": assignee_id},
                "run_id": self.run_id
            })
            resp.raise_for_status()
            return resp.json()


class TelemetryClient:
    """
    Auto-telemetry client for SDK-based agents.

    Agents do not need to call this directly — BaseAgent wraps run() and calls
    _complete_run() automatically on success or failure.

    If you need to emit a custom audit event mid-run (e.g., a validation step),
    call self.telemetry.emit_event(...) from your agent.
    """

    def __init__(self, runtime_url: str, run_id: str, org_id: str, study_id: str,
                 installation_id: str, agent_type: str, is_test_run: bool = False):
        self.runtime_url = runtime_url
        self.run_id = run_id
        self.org_id = org_id
        self.study_id = study_id
        self.installation_id = installation_id
        self.agent_type = agent_type
        self.is_test_run = is_test_run
        self._started_at = time.monotonic()

    async def complete_run(
        self,
        output: str,
        tool_results: list[dict] = None,
        tokens_used: int = 0,
        model: str = "",
        reasoning_steps: list[str] = None,
        sources_cited: list[dict] = None,
        deterministic_scores: Optional[dict] = None,
        hitl_actor: Optional[str] = None,
        hitl_action: Optional[str] = None,
    ) -> None:
        """
        Submit the completed run to agent-runtime for full telemetry emission:
          - agent.run.completed audit event
          - agent_run_evaluations row (LLM judge or deterministic)
          - output decision trace
        Called automatically by BaseAgent at the end of run().
        """
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                await client.post(f"{self.runtime_url}/runs/{self.run_id}/complete", json={
                    "org_id":               self.org_id,
                    "study_id":             self.study_id,
                    "installation_id":      self.installation_id,
                    "agent_type":           self.agent_type,
                    "is_test_run":          self.is_test_run,
                    "output":               output,
                    "tool_results":         tool_results or [],
                    "tokens_used":          tokens_used,
                    "model":                model,
                    "reasoning_steps":      reasoning_steps or [],
                    "sources_cited":        sources_cited or [],
                    "deterministic_scores": deterministic_scores,
                    "hitl_actor":           hitl_actor,
                    "hitl_action":          hitl_action,
                })
        except Exception as e:
            logger.warning(f"telemetry.complete_run.failed run_id={self.run_id}: {e}")

    async def emit_event(
        self,
        action: str,
        resource_type: str,
        resource_id: str,
        metadata: dict = None,
        before_state: dict = None,
        after_state: dict = None,
    ) -> None:
        """Emit a custom mid-run audit event (e.g., validation.completed, data.parsed)."""
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(f"{self.runtime_url}/runs/{self.run_id}/audit-event", json={
                    "org_id":        self.org_id,
                    "study_id":      self.study_id,
                    "actor_type":    "agent",
                    "actor_id":      self.installation_id,
                    "action":        action,
                    "resource_type": resource_type,
                    "resource_id":   resource_id,
                    "before_state":  before_state,
                    "after_state":   after_state,
                    "metadata":      metadata or {},
                    "is_test_run":   self.is_test_run,
                })
        except Exception as e:
            logger.warning(f"telemetry.emit_event.failed run_id={self.run_id}: {e}")
