"""
HITLCoordinator — TrialOS Native Agent v1.0.0
Routes pending approval requests to the correct reviewer based on domain expertise
and workload. Sets SLA deadlines and notifies reviewers with enriched context.

Platform features:
  • Dynamic Retrieval Augmentation  — domain expertise queries for reviewer matching
  • Confidence-Based Execution      — routing confidence determines escalation path
  • Validation Escalation           — overdue SLA items escalated to manager
  • Contextual Prompt Injection     — reviewer notifications enriched with prior decisions
  • Memory Retrieval                — prior reviewer decisions injected for consistency
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../packages/trialo-agent-sdk"))

import httpx
from datetime import datetime, timezone, timedelta
from trialo_agent_sdk import (
    BaseAgent, AgentContext, AgentOutput,
    escalate_findings, is_blocked_by_escalation, escalation_summary,
    build_hitl_context, inject_hitl_context_into_description, build_hitl_notification_body,
    compute_agent_confidence, branch_on_confidence,
    augment_ig_queries, retrieve_relevant_memories, build_memory_context_block,
)

AGENT_RUNTIME_URL = os.environ.get("AGENT_RUNTIME_URL", "http://localhost:8004")
MEMORY_ENGINE_URL = os.environ.get("MEMORY_ENGINE_URL", "http://localhost:8014")

SLA_HOURS_BY_TYPE = {
    "critical": 24,
    "compliance_violation": 48,
    "sdtm_mapping": 72,
    "protocol_analysis": 72,
    "data_quality": 48,
    "default": 72,
}

DOMAIN_TO_REVIEWER_TYPE = {
    "AE": "safety_reviewer",
    "DM": "data_manager",
    "SDTM": "data_manager",
    "PROTOCOL": "protocol_reviewer",
    "COMPLIANCE": "compliance_officer",
    "MAPPING": "data_manager",
    "CRF": "crf_designer",
    "WRITING": "medical_writer",
    "EVALUATION": "quality_reviewer",
}


class HITLCoordinator(BaseAgent):

    AGENT_NAME = "HITL Coordinator"
    AGENT_VERSION = "1.0.0"
    REQUIRED_PERMISSIONS = [
        "study:data:read", "study:reports:write",
        "platform:notify:write", "platform:hitl:write",
    ]
    DECLARED_TOOLS = [
        "recall_memory", "send_notification", "generate_pdf_report",
    ]

    async def run(self, context: AgentContext) -> AgentOutput:
        findings: list[dict] = []
        routing_results: list[dict] = []

        # ── Feature 1: Dynamic Retrieval Augmentation ──────────────────────
        if "study:docs:read" in context.consented_permissions:
            try:
                await self.augmented_ig_search(
                    "reviewer expertise domain routing human review clinical trial",
                    domains=["AE", "DM"],
                    top_k=4,
                )
            except Exception:
                pass

        # ── Feature 5: Memory Retrieval — prior reviewer decisions ────────
        memories = context.extra.get("memory_context", [])
        top_memories = retrieve_relevant_memories("hitl_routing", context.__dict__, memories, top_k=3)
        memory_block = build_memory_context_block(top_memories, "hitl_routing") if top_memories else ""

        # Fetch pending approval requests
        pending_requests = await _fetch_pending_approvals(context)
        sla_breached = [r for r in pending_requests if _is_sla_breached(r)]
        unassigned = [r for r in pending_requests if not r.get("assigned_reviewer_id")]

        # Escalate SLA breaches
        for req in sla_breached:
            findings.append({
                "type": "sla_breach",
                "rule_id": "HITL001",
                "level": "error",
                "severity": "ERROR",
                "approval_id": req.get("id"),
                "message": (
                    f"SLA breached for approval {req.get('id')}: "
                    f"deadline was {req.get('sla_deadline', 'unknown')}"
                ),
            })

        # Route unassigned requests
        reviewer_profiles = await _fetch_reviewer_profiles(AGENT_RUNTIME_URL, context.org_id)

        for req in unassigned:
            domain = req.get("domain", "default").upper()
            reviewer_type = DOMAIN_TO_REVIEWER_TYPE.get(domain, "data_manager")
            trigger_category = req.get("trigger_category", "unknown")
            sla_hours = SLA_HOURS_BY_TYPE.get(trigger_category, SLA_HOURS_BY_TYPE["default"])

            # Find least-loaded reviewer with matching domain
            reviewer = _select_reviewer(reviewer_profiles, reviewer_type, domain)
            sla_deadline = (datetime.now(timezone.utc) + timedelta(hours=sla_hours)).isoformat()

            if reviewer:
                # Assign reviewer
                await _assign_reviewer(AGENT_RUNTIME_URL, req.get("id"), reviewer["user_id"], sla_deadline)

                # Build enriched notification
                prior_corrections = req.get("prior_corrections", [])
                hitl_ctx = self.build_hitl_context(prior_corrections, domain=domain)
                base_desc = (
                    f"You have been assigned a {reviewer_type.replace('_', ' ')} review task. "
                    f"Study: {context.study_name}. "
                    f"Domain: {domain}. Trigger: {trigger_category}. "
                    f"SLA: {sla_hours}h ({sla_deadline[:10]})."
                )
                if memory_block:
                    base_desc += f"\n\nRELEVANT PRIOR DECISIONS:\n{memory_block}"
                enriched_desc = inject_hitl_context_into_description(base_desc, hitl_ctx)

                if not context.is_test_run:
                    await context.notification_client.notify(
                        user_id=reviewer["user_id"],
                        title=f"Review Assigned: {domain} — {context.study_name}",
                        body=enriched_desc,
                        severity="warning",
                    )

                routing_results.append({
                    "approval_id": req.get("id"),
                    "domain": domain,
                    "reviewer_type": reviewer_type,
                    "reviewer_id": reviewer["user_id"],
                    "sla_deadline": sla_deadline,
                    "status": "assigned",
                })
            else:
                findings.append({
                    "type": "no_reviewer_available",
                    "rule_id": "HITL002",
                    "level": "warning",
                    "severity": "WARNING",
                    "message": f"No available {reviewer_type} found for {domain} review (approval {req.get('id')})",
                })
                routing_results.append({
                    "approval_id": req.get("id"),
                    "domain": domain,
                    "reviewer_type": reviewer_type,
                    "status": "unassigned_no_reviewer",
                })

        # Escalate SLA breaches to managers
        if sla_breached and not context.is_test_run:
            for req in sla_breached[:10]:
                assigned = req.get("assigned_reviewer_id")
                if assigned:
                    manager_id = await _get_manager_id(AGENT_RUNTIME_URL, assigned)
                    if manager_id:
                        await context.notification_client.notify(
                            user_id=manager_id,
                            title=f"HITL SLA BREACHED: {context.study_name}",
                            body=(
                                f"Approval {req.get('id')} has breached its SLA deadline. "
                                f"Assigned to {assigned}. Immediate action required."
                            ),
                            severity="critical",
                        )

        # ── Feature 3: Validation Escalation ──────────────────────────────
        escalation_result = self.escalate_findings(findings, domain="HITL")
        blocked = self.is_blocked(escalation_result)

        # ── Feature 2: Confidence-Based Execution Branching ────────────────
        assigned_count = len([r for r in routing_results if r.get("status") == "assigned"])
        total_count = max(len(unassigned), 1)
        confidence = self.compute_confidence(
            evidence_count=len(reviewer_profiles),
            quality_signals=[
                assigned_count / total_count,
                1.0 - (len(sla_breached) / max(len(pending_requests), 1)),
            ],
            validation_methods=["reviewer_matching", "sla_check"],
        )
        branch = self.branch_on_confidence(
            confidence,
            thresholds={"proceed": 0.70, "escalate": 0.40, "defer": 0.20},
            context_hint="hitl-coordination gate",
        )

        report_md = _build_report(context, routing_results, findings, sla_breached,
                                  confidence, branch)
        artifact = await context.artifact_store.save_report(
            title=f"HITL_Routing_{context.protocol_number}",
            content=report_md,
        )

        return AgentOutput(
            summary=(
                f"Processed {len(pending_requests)} pending approvals. "
                f"Assigned: {assigned_count}. SLA breaches: {len(sla_breached)}. "
                f"Confidence: {confidence:.2f}."
            ),
            findings=findings,
            artifacts=[artifact] if artifact else [],
            metadata={
                "pending_approvals": len(pending_requests),
                "assigned": assigned_count,
                "sla_breached": len(sla_breached),
                "unassigned": len([r for r in routing_results if "unassigned" in r.get("status", "")]),
                "confidence": confidence,
                "branch_action": branch.action,
                "routing_results": routing_results,
            },
        )


async def _fetch_pending_approvals(context) -> list[dict]:
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{AGENT_RUNTIME_URL}/approval-requests",
                params={"status": "pending", "study_id": context.study_id, "limit": 50},
            )
            if resp.status_code == 200:
                return resp.json().get("requests", [])
    except Exception:
        pass
    return context.extra.get("pending_approvals", [])


async def _fetch_reviewer_profiles(runtime_url: str, org_id: str) -> list[dict]:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{runtime_url}/reviewer-profiles",
                params={"org_id": org_id},
            )
            if resp.status_code == 200:
                return resp.json().get("profiles", [])
    except Exception:
        pass
    return []


def _select_reviewer(profiles: list[dict], reviewer_type: str, domain: str) -> dict | None:
    candidates = [
        p for p in profiles
        if reviewer_type in (p.get("reviewer_types") or [])
        and (not p.get("max_workload") or p.get("workload_count", 0) < p.get("max_workload", 10))
    ]
    if not candidates:
        candidates = [p for p in profiles if reviewer_type in (p.get("reviewer_types") or [])]
    if not candidates:
        return None
    return min(candidates, key=lambda p: p.get("workload_count", 0))


async def _assign_reviewer(runtime_url: str, approval_id: str, reviewer_id: str, sla_deadline: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.patch(
                f"{runtime_url}/approval-requests/{approval_id}",
                json={"assigned_reviewer_id": reviewer_id, "sla_deadline": sla_deadline},
            )
    except Exception:
        pass


async def _get_manager_id(runtime_url: str, user_id: str) -> str | None:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{runtime_url}/users/{user_id}")
            if resp.status_code == 200:
                return resp.json().get("manager_id")
    except Exception:
        pass
    return None


def _is_sla_breached(req: dict) -> bool:
    deadline = req.get("sla_deadline")
    if not deadline:
        return False
    try:
        dt = datetime.fromisoformat(deadline.replace("Z", "+00:00"))
        return dt < datetime.now(timezone.utc)
    except Exception:
        return False


def _build_report(context, routing_results, findings, sla_breached, confidence, branch) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        "# HITL Routing Report",
        f"**Study:** {context.study_name}  |  **Generated:** {ts}",
        "",
        f"## Summary",
        f"| Metric | Value |", f"|--------|-------|",
        f"| Pending Approvals Processed | {len(routing_results)} |",
        f"| Successfully Assigned | {len([r for r in routing_results if r.get('status') == 'assigned'])} |",
        f"| SLA Breaches | {len(sla_breached)} |",
        f"| Confidence | {confidence:.2f} |",
        "",
        "## Routing Results",
        "| Approval ID | Domain | Reviewer Type | Status |",
        "|-------------|--------|---------------|--------|",
    ]
    for r in routing_results:
        lines.append(
            f"| {r.get('approval_id', '—')[:12]} | {r.get('domain')} "
            f"| {r.get('reviewer_type')} | {r.get('status')} |"
        )
    if findings:
        lines += ["", "## Issues"]
        for f in findings[:10]:
            lines.append(f"- [{f['level'].upper()}] {f['message']}")
    lines += ["", f"**Branch:** {branch.action}", "", "---", "*Generated by TrialOS HITLCoordinator v1.0.0*"]
    return "\n".join(lines)
