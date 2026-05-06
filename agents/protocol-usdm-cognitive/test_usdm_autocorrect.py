import sys
import types
from types import SimpleNamespace


def _install_sdk_stub() -> None:
    """Install a minimal trialo_agent_sdk stub for isolated unit testing."""
    sdk = types.ModuleType("trialo_agent_sdk")

    class BaseAgent:
        def __init__(self, context):
            self.context = context
            self.data = getattr(context, "data_client", None)
            self.artifacts = getattr(context, "artifact_store", None)
            self.notifications = getattr(context, "notification_client", None)
            self.telemetry = getattr(context, "telemetry", None)

        async def augmented_ig_search(self, *args, **kwargs):
            return []

        def branch_on_confidence(self, *args, **kwargs):
            return SimpleNamespace(action="proceed")

        def escalate_findings(self, *args, **kwargs):
            return {"escalation_policy": "none"}

        def is_blocked(self, *args, **kwargs):
            return False

        def escalation_summary(self, *args, **kwargs):
            return ""

        def build_hitl_context(self, *args, **kwargs):
            return {}

        def build_hitl_body(self, *args, **kwargs):
            return ""

    class AgentContext:  # pragma: no cover - placeholder for typing import
        pass

    class AgentOutput:  # pragma: no cover - placeholder for typing import
        pass

    sdk.BaseAgent = BaseAgent
    sdk.AgentContext = AgentContext
    sdk.AgentOutput = AgentOutput
    sdk.escalate_findings = lambda *args, **kwargs: {"escalation_policy": "none"}
    sdk.is_blocked_by_escalation = lambda *args, **kwargs: False
    sdk.escalation_summary = lambda *args, **kwargs: ""
    sdk.build_hitl_context = lambda *args, **kwargs: {}
    sdk.inject_hitl_context_into_description = lambda text, *args, **kwargs: text
    sdk.build_hitl_notification_body = lambda *args, **kwargs: ""
    sdk.compute_agent_confidence = lambda *args, **kwargs: 1.0
    sdk.branch_on_confidence = lambda *args, **kwargs: SimpleNamespace(action="proceed")
    sdk.augment_ig_queries = lambda *args, **kwargs: []
    sdk.retrieve_relevant_memories = lambda *args, **kwargs: []
    sdk.build_memory_context_block = lambda *args, **kwargs: ""

    sys.modules["trialo_agent_sdk"] = sdk


_install_sdk_stub()

from agent import ProtocolUSDMCognitiveAgent
from evaluators import evaluate_standards


def _build_dummy_agent() -> ProtocolUSDMCognitiveAgent:
    ctx = SimpleNamespace(
        data_client=None,
        artifact_store=None,
        notification_client=None,
        telemetry=None,
    )
    return ProtocolUSDMCognitiveAgent(ctx)


def test_malformed_usdm_standards_fail_then_autocorrect_passes_in_one_run():
    agent = _build_dummy_agent()

    malformed_usdm = {
        "meta": [],
        "studyIdentifiers": {},
        "studyProtocols": [],
        "therapeuticAreas": {},
        "objectives": {},
        "estimands": {},
        "populations": {},
        "arms": {},
        "epochs": {},
        "activities": {},
    }

    before = evaluate_standards(malformed_usdm)
    assert before["passed"] is False
    assert any("GAP-USDM-" in msg for msg in before.get("gap_failures", []))

    section_map = {
        "title_page": "A Randomized, Double-Blind, Placebo-Controlled Study",
        "introduction": "This study evaluates efficacy and safety in target patients.",
        "study_objectives": "Primary objective is to evaluate efficacy at Week 12.",
        "estimands": "Primary estimand compares treatment vs placebo at Week 12.",
        "study_design": "Arm A active treatment. Arm B placebo comparator.",
        "populations": "Inclusion criteria include adults with confirmed diagnosis.",
        "interventions": "Investigational product and placebo are administered daily.",
        "discontinuation": "Subjects may discontinue for safety reasons.",
        "study_assessments": "Visit 1 screening, Visit 2 baseline, Week 4, Week 8, Week 12.",
        "statistical_methods": "Primary endpoint analyzed using mixed model repeated measures.",
        "adverse_event_reporting": "All adverse events are collected and reviewed.",
        "ethics": "The protocol follows ethics committee requirements.",
        "informed_consent": "Written informed consent is required before procedures.",
        "appendices": "Appendix includes schedule of events and assessments.",
    }

    corrected = agent._auto_correct_usdm_quality(malformed_usdm, section_map)
    after = evaluate_standards(corrected)

    assert after["passed"] is True
    assert after["score"] > before["score"]
    assert not after.get("gap_failures", [])


def test_v5_feedback_style_root_duplication_and_ice_are_autofixed():
    agent = _build_dummy_agent()

    malformed = {
        "study": {
            "id": "STUDY-B7981027",
            "studyDesigns": [{"id": "SD-ROOT"}],
            "studyIdentifiers": [{"id": "SID-ROOT"}],
            "organizations": [{"id": "ORG-ROOT"}],
            "studyRoles": [{"id": "ROLE-ROOT"}],
            "abbreviations": [{"id": "ABBR-ROOT"}],
            "unstructuredContents": [{"id": "UC-ROOT"}],
            "studyTitle": "Flat non-USDM title",
            "studyVersion": "1.0",
            "studyRationale": "Flat rationale",
            "studyProtocolVersions": [{"version": "1.0"}],
            "versions": [
                {
                    "studyDesigns": [{"id": "SD-V1"}],
                    "studyIdentifiers": [{"id": "SID-V1"}],
                    "organizations": [{"id": "ORG-V1"}],
                    "studyRoles": [{"id": "ROLE-V1"}],
                    "abbreviations": [{"id": "ABBR-V1"}],
                    "unstructuredContents": [{"id": "UC-V1"}],
                    "estimands": [
                        {
                            "id": "EST-001",
                            "intercurrentEvents": ["Treatment discontinuation", "Rescue therapy"],
                        }
                    ],
                }
            ],
        },
        "meta": {"version": "4.0", "generatedAt": "2026-01-01T00:00:00Z", "generatedBy": "test"},
        "studyIdentifiers": [{"type": "sponsor", "value": "B7981027"}],
        "studyProtocols": {"officialTitle": "Protocol", "version": "1.0", "date": "2026-01-01"},
        "therapeuticAreas": [],
        "objectives": [{"description": "Obj"}],
        "estimands": [{"description": "Est", "intercurrentEvents": ["Dose interruption"]}],
        "populations": [{"description": "Pop"}],
        "arms": [{"name": "Arm A"}],
        "epochs": [{"name": "Treatment"}],
        "activities": [{"name": "Visit"}],
    }

    before = evaluate_standards(malformed)
    assert any("GAP-USDM-009" in msg for msg in before.get("gap_failures", []))
    assert any("GAP-USDM-019" in msg for msg in before.get("gap_failures", []))

    corrected = agent._auto_correct_usdm_quality(malformed, section_map={})
    after = evaluate_standards(corrected)

    assert after["passed"] is True
    assert not any("GAP-USDM-009" in msg for msg in after.get("gap_failures", []))
    assert not any("GAP-USDM-019" in msg for msg in after.get("gap_failures", []))

    study = corrected["study"]
    for removed in [
        "studyDesigns", "studyIdentifiers", "organizations", "studyRoles",
        "abbreviations", "unstructuredContents", "studyTitle",
        "studyVersion", "studyRationale", "studyProtocolVersions",
    ]:
        assert removed not in study

    ice = study["versions"][0]["estimands"][0]["intercurrentEvents"]
    assert isinstance(ice, list)
    assert all(isinstance(x, dict) and x.get("description") for x in ice)
