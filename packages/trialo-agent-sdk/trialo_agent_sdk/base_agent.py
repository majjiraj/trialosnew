"""Base class for all TrialOS agents."""
import abc
import logging
import time
from typing import Any, Optional
from .models import AgentContext, AgentOutput
from .features import (
    augment_ig_queries,
    augment_conformance_queries,
    augment_terminology_queries,
    compute_agent_confidence,
    branch_on_confidence as _branch_on_confidence,
    BranchResult,
    escalate_findings as _escalate_findings,
    is_blocked_by_escalation,
    escalation_summary,
    build_hitl_context,
    inject_hitl_context_into_description,
    build_hitl_notification_body,
    build_memory_context_block,
    retrieve_relevant_memories,
)

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
    AUTO_APPLY_PLATFORM_FEATURES: bool = True
    AUTO_RETRIEVAL_TOP_K: int = 5
    AUTO_CONFIDENCE_THRESHOLDS: dict[str, float] = {
        "proceed": 0.70,
        "escalate": 0.40,
        "defer": 0.20,
    }

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
            await self._prepare_automatic_feature_context()
            output = await self.run(self.context)
            output = self._apply_automatic_feature_postprocessing(output)
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

    async def _prepare_automatic_feature_context(self) -> None:
        """Populate reusable retrieval and HITL context before agent execution."""
        if not self.AUTO_APPLY_PLATFORM_FEATURES:
            return

        self.context.extra.setdefault("auto_platform_features", {})
        feature_state = self.context.extra["auto_platform_features"]

        domains = self._infer_feature_domains()
        feature_state["domains"] = domains

        prior_corrections = self.context.extra.get("prior_corrections") or []
        hitl_context = self.build_hitl_context(prior_corrections, domain=domains[0] if len(domains) == 1 else "")
        if hitl_context:
            feature_state["hitl_context"] = hitl_context
            self.context.extra.setdefault("auto_hitl_context", hitl_context)

        if "study:docs:read" not in self.context.consented_permissions:
            feature_state["retrieval_skipped"] = "missing_permission"
            return

        queries = self._build_auto_retrieval_queries(domains)
        if not queries:
            feature_state["retrieval_skipped"] = "no_queries"
            return

        results: list[dict[str, Any]] = []
        seen: set[str] = set()
        for query in queries:
            try:
                batch = await self.augmented_ig_search(
                    query,
                    domains=domains,
                    top_k=self.AUTO_RETRIEVAL_TOP_K,
                )
            except Exception:
                continue
            for item in batch:
                key = str(item.get("id") or item.get("source") or item.get("title") or item)[:160]
                if key not in seen:
                    seen.add(key)
                    results.append(item)

        feature_state["retrieval_queries"] = queries
        feature_state["retrieval_results"] = results
        self.context.extra.setdefault("auto_retrieval_results", results)

        # Feature 5: Memory Context Injection
        # Rank and inject the top-3 most relevant memory items so the agent
        # sees prior learnings before generating output.
        memory_items = list(self.context.extra.get("memory_context") or [])
        if memory_items:
            relevant = retrieve_relevant_memories(
                task_type=self.context.trigger_payload.get("purpose", ""),
                context=" ".join(queries[:2]),
                memories=memory_items,
                top_k=3,
            )
            if relevant:
                memory_block = build_memory_context_block(
                    relevant,
                    task_type=self.context.trigger_payload.get("purpose", ""),
                )
                feature_state["memory_context_block"] = memory_block
                self.context.extra.setdefault("auto_memory_context", memory_block)

    def _apply_automatic_feature_postprocessing(self, output: AgentOutput) -> AgentOutput:
        """Attach automatic validation/confidence/HITL metadata to agent output."""
        if not self.AUTO_APPLY_PLATFORM_FEATURES:
            return output

        metadata = dict(output.metadata or {})
        feature_state = self.context.extra.get("auto_platform_features", {})
        domains = self._infer_feature_domains(output)
        flattened_findings = self._flatten_output_findings(output)

        escalation_result = self.escalate_findings(flattened_findings, domain=domains[0] if len(domains) == 1 else "ALL")
        confidence = self.compute_confidence(
            evidence_count=max(len(flattened_findings), len(output.artifacts or []), len(domains)),
            quality_signals=self._derive_quality_signals(output, escalation_result),
            validation_methods=self._derive_validation_methods(output, escalation_result),
        )
        branch = self.branch_on_confidence(
            confidence,
            thresholds=dict(self.AUTO_CONFIDENCE_THRESHOLDS),
            context_hint=f"{self.AGENT_NAME} automatic output gate",
        )

        metadata.setdefault("auto_platform_features", True)
        metadata.setdefault("auto_feature_domains", domains)
        metadata.setdefault("auto_retrieval_queries", feature_state.get("retrieval_queries", []))
        metadata.setdefault("auto_retrieval_result_count", len(feature_state.get("retrieval_results", [])))
        metadata.setdefault("hitl_context_injected", bool(feature_state.get("hitl_context")))
        metadata.setdefault("confidence", confidence)
        metadata.setdefault("branch_action", branch.action)
        metadata.setdefault("branch_reason", branch.reason)
        metadata.setdefault("escalation", escalation_result.get("escalation_policy"))
        metadata.setdefault("escalation_summary", self.escalation_summary(escalation_result))
        metadata.setdefault("escalation_blocked", self.is_blocked(escalation_result))

        output.metadata = metadata
        output.proposed_actions = self._inject_hitl_context_into_actions(output.proposed_actions)
        return output

    def _infer_feature_domains(self, output: Optional[AgentOutput] = None) -> list[str]:
        """Infer likely SDTM or agent domains from context and output."""
        candidates: list[str] = []

        for value in (
            self.context.extra.get("domains"),
            self.context.extra.get("domains_checked"),
            self.context.extra.get("domain"),
            self.context.trigger_payload.get("domains"),
            self.context.trigger_payload.get("domain"),
            self.context.trigger_payload.get("config", {}).get("domains"),
            self.context.trigger_payload.get("config", {}).get("domain"),
        ):
            if isinstance(value, list):
                candidates.extend(str(item).strip().upper() for item in value if str(item).strip())
            elif value:
                candidates.append(str(value).strip().upper())

        if output is not None:
            for finding in output.findings or []:
                if isinstance(finding, dict):
                    for key in ("domain", "domains_checked"):
                        value = finding.get(key)
                        if isinstance(value, list):
                            candidates.extend(str(item).strip().upper() for item in value if str(item).strip())
                        elif value:
                            candidates.append(str(value).strip().upper())

        seen: set[str] = set()
        ordered: list[str] = []
        for candidate in candidates:
            if candidate and candidate not in seen:
                seen.add(candidate)
                ordered.append(candidate)
        return ordered

    def _build_auto_retrieval_queries(self, domains: list[str]) -> list[str]:
        """Build generic retrieval queries for agents that do not wire retrieval manually."""
        queries = [
            f"{self.AGENT_NAME} operating guidance for clinical trial data review",
            f"{self.context.study_phase} study monitoring guidance {self.context.protocol_number}",
        ]
        if domains:
            queries.append(
                f"{' '.join(domains[:4])} domain guidance required variables conformance review"
            )

        seen: set[str] = set()
        deduped: list[str] = []
        for query in queries:
            normalized = query.strip()
            if normalized and normalized not in seen:
                seen.add(normalized)
                deduped.append(normalized)
        return deduped

    def _flatten_output_findings(self, output: AgentOutput) -> list[dict[str, Any]]:
        """Normalize output findings into escalation-ready finding dicts."""
        normalized: list[dict[str, Any]] = []

        for finding in output.findings or []:
            if not isinstance(finding, dict):
                continue

            if any(key in finding for key in ("type", "rule_id", "severity", "level", "message")):
                normalized.append(dict(finding))
                continue

            domain = str(finding.get("domain") or "").strip().upper()
            errors = int(finding.get("errors") or 0)
            warnings = int(finding.get("warnings") or 0)
            if errors:
                normalized.append({
                    "type": "agent_reported_error",
                    "rule_id": str(finding.get("top_rule") or "agent_reported_error"),
                    "severity": "ERROR",
                    "level": "error",
                    "domain": domain,
                    "message": f"{errors} error(s) reported by {self.AGENT_NAME}",
                })
            if warnings:
                normalized.append({
                    "type": "agent_reported_warning",
                    "rule_id": str(finding.get("top_rule") or "agent_reported_warning"),
                    "severity": "WARNING",
                    "level": "warning",
                    "domain": domain,
                    "message": f"{warnings} warning(s) reported by {self.AGENT_NAME}",
                })
            if bool(finding.get("sla_breached")):
                normalized.append({
                    "type": "sla_response_rate_breach",
                    "rule_id": "agent_sla_breach",
                    "severity": "WARNING",
                    "level": "warning",
                    "domain": domain or "SITE_SLA",
                    "message": f"SLA breach reported by {self.AGENT_NAME}",
                })

        metadata_findings = output.metadata.get("validation_findings") if isinstance(output.metadata, dict) else None
        if isinstance(metadata_findings, list):
            for finding in metadata_findings:
                if isinstance(finding, dict):
                    normalized.append(dict(finding))

        return normalized

    def _derive_quality_signals(self, output: AgentOutput, escalation_result: dict[str, Any]) -> list[float]:
        """Compute conservative quality signals for automatic confidence scoring."""
        findings = self._flatten_output_findings(output)
        if not findings:
            return [0.75 if output.summary else 0.50]

        error_count = int(escalation_result.get("error_count") or 0)
        warning_count = int(escalation_result.get("warning_count") or 0)
        total = max(len(findings), 1)
        clean_ratio = max(0.0, 1.0 - ((error_count + (warning_count * 0.5)) / total))
        artifact_ratio = 1.0 if output.artifacts else 0.6
        return [round(clean_ratio, 3), artifact_ratio]

    def _derive_validation_methods(self, output: AgentOutput, escalation_result: dict[str, Any]) -> list[str]:
        """Infer which validation methods contributed to the automatic branch."""
        methods = ["output_findings_normalization", "validation_escalation"]
        if output.artifacts:
            methods.append("artifact_generation")
        if escalation_result.get("blocking_issues"):
            methods.append("blocking_issue_detection")
        if self.context.extra.get("auto_platform_features", {}).get("retrieval_results"):
            methods.append("retrieval_augmentation")
        return methods

    def _inject_hitl_context_into_actions(self, proposed_actions: list[dict]) -> list[dict]:
        """Best-effort enrichment of proposed action descriptions with HITL context."""
        hitl_context = self.context.extra.get("auto_platform_features", {}).get("hitl_context")
        if not hitl_context:
            return proposed_actions

        enriched: list[dict] = []
        for action in proposed_actions or []:
            if not isinstance(action, dict):
                enriched.append(action)
                continue
            updated = dict(action)
            for field_name in ("description", "body", "reason"):
                value = updated.get(field_name)
                if isinstance(value, str) and value.strip():
                    updated[field_name] = self.inject_hitl_context(value, self.context.extra.get("prior_corrections") or [])
                    break
            enriched.append(updated)
        return enriched

    # ── Feature 1: Dynamic Retrieval Augmentation ─────────────────────────────

    async def augmented_ig_search(
        self,
        base_query: str,
        domains: list[str],
        top_k: int = 10,
        document_types: list[str] | None = None,
    ) -> list[dict]:
        """Search documents with mandatory domain-chapter IG query injection.

        Automatically appends SDTMIG domain-chapter anchor queries alongside
        base_query so retrieval returns domain-specific variable definitions
        instead of only generic SDTM fundamentals.
        """
        queries = augment_ig_queries(base_query, domains)
        seen: set[str] = set()
        results: list[dict] = []
        for q in queries:
            try:
                batch = await self.data.search_documents(
                    q, document_types=document_types, top_k=top_k
                )
                for r in batch:
                    key = r.get("id") or r.get("source") or r.get("title") or str(r)[:80]
                    if key not in seen:
                        seen.add(key)
                        results.append(r)
            except Exception:
                pass
        return results

    async def augmented_conformance_search(
        self,
        base_query: str,
        domains: list[str],
        rule_ids: list[str] | None = None,
        top_k: int = 10,
    ) -> list[dict]:
        """Search with domain chapter + conformance rule query injection."""
        queries = augment_conformance_queries(base_query, domains, rule_ids)
        seen: set[str] = set()
        results: list[dict] = []
        for q in queries:
            try:
                batch = await self.data.search_documents(q, top_k=top_k)
                for r in batch:
                    key = r.get("id") or r.get("source") or r.get("title") or str(r)[:80]
                    if key not in seen:
                        seen.add(key)
                        results.append(r)
            except Exception:
                pass
        return results

    # ── Feature 2: Confidence-Based Execution Branching ───────────────────────

    def compute_confidence(
        self,
        evidence_count: int,
        quality_signals: list[float] | None = None,
        validation_methods: list[str] | None = None,
        base: float = 0.5,
    ) -> float:
        """Compute grounded confidence from evidence count and quality signals."""
        return compute_agent_confidence(
            evidence_count,
            quality_signals=quality_signals,
            validation_methods_used=validation_methods,
            base=base,
        )

    def branch_on_confidence(
        self,
        confidence: float,
        thresholds: dict[str, float] | None = None,
        context_hint: str = "",
    ) -> BranchResult:
        """Decide whether to proceed, escalate, defer, or skip based on confidence.

        Emit a telemetry audit event automatically when action != 'proceed'.
        """
        result = _branch_on_confidence(confidence, thresholds=thresholds, context_hint=context_hint)
        return result

    # ── Feature 3: Validation Escalation ─────────────────────────────────────

    def escalate_findings(
        self,
        findings: list[dict],
        domain: str = "",
        blocking_types: frozenset[str] | set[str] | None = None,
    ) -> dict:
        """Apply validation escalation policy (validation_escalation_v1).

        Promotes configured warning types to blocking errors and returns a
        structured escalation report for embedding in metadata/audit output.
        """
        return _escalate_findings(findings, blocking_types=blocking_types, domain=domain)

    def is_blocked(self, escalation_result: dict) -> bool:
        """Return True if escalation produced any blocking issues."""
        return is_blocked_by_escalation(escalation_result)

    def escalation_summary(self, escalation_result: dict) -> str:
        """Return a one-line human-readable escalation status for logs/alerts."""
        return escalation_summary(escalation_result)

    # ── Feature 4: Contextual Prompt Injection for HITL ──────────────────────

    def build_hitl_context(
        self,
        prior_corrections: list[dict] | None,
        domain: str = "",
        include_rejections: bool = True,
    ) -> str:
        """Build a context block to inject into HITL reviewer task descriptions.

        Surfaces prior reviewer corrections and known rejected patterns so
        the human reviewer is immediately aware of historical feedback.
        """
        return build_hitl_context(
            prior_corrections, domain=domain, include_rejections=include_rejections
        )

    def inject_hitl_context(
        self,
        base_description: str,
        prior_corrections: list[dict] | None,
        domain: str = "",
    ) -> str:
        """Prepend HITL prior-feedback context to a reviewer task description."""
        return inject_hitl_context_into_description(
            base_description, prior_corrections, domain=domain
        )

    def build_hitl_body(
        self,
        base_body: str,
        escalation_result: dict | None = None,
        branch_result: BranchResult | None = None,
    ) -> str:
        """Enrich a HITL notification body with escalation and confidence signals."""
        return build_hitl_notification_body(base_body, escalation_result, branch_result)


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
