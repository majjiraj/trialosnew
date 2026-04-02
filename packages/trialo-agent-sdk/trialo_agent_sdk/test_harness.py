"""
TrialOS Agent TestHarness — Local development and unit testing.
"""
import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any, Optional
from .models import AgentContext, AgentOutput, Artifact


class MockDataAccessClient:
    def __init__(self, mock_data: dict = None):
        self._data = mock_data or {}
        self.calls: list[tuple] = []

    async def read_sdtm_domain(self, domain: str, filters: dict = None, limit: int = 1000) -> list[dict]:
        self.calls.append(("read_sdtm_domain", domain, filters))
        return self._data.get(domain, [])[:limit]

    async def read_adam_dataset(self, dataset: str, filters: dict = None) -> list[dict]:
        self.calls.append(("read_adam_dataset", dataset, filters))
        return self._data.get(dataset, [])

    async def search_documents(self, query: str, document_types: list = None, top_k: int = 5) -> list[dict]:
        self.calls.append(("search_documents", query, document_types))
        return self._data.get("documents", [])[:top_k]

    async def raise_query(self, domain: str, query_text: str, subject_id: str = None, field_name: str = None) -> dict:
        self.calls.append(("raise_query", domain, query_text))
        return {"query_id": str(uuid.uuid4()), "status": "raised"}

    async def query_budget(self, query_type: str, site_id: str = None) -> dict:
        self.calls.append(("query_budget", query_type, site_id))
        return self._data.get("budget", {})


class MockArtifactStore:
    def __init__(self):
        self.saved: list[dict] = []

    async def save_report(self, title: str, content: str) -> dict:
        artifact = {"title": title, "content": content, "s3_key": f"test/{title}.md", "format": "markdown"}
        self.saved.append(artifact)
        return artifact

    async def save_text(self, content: str, filename: str) -> dict:
        return await self.save_report(filename, content)


class MockNotificationClient:
    def __init__(self):
        self.sent: list[dict] = []
        self.approvals: list[dict] = []

    async def notify(self, user_id: str, title: str, body: str, severity: str = "info"):
        self.sent.append({"user_id": user_id, "title": title, "body": body, "severity": severity})

    async def request_approval(self, title: str, description: str, proposed_action: dict, assignee_id: str) -> dict:
        approval = {"id": str(uuid.uuid4()), "title": title, "assignee": assignee_id, "proposed_action": proposed_action}
        self.approvals.append(approval)
        return approval


class TestHarness:
    """
    Run your agent locally with mock data. No live TrialOS instance needed.

    Usage:
        harness = TestHarness()
        harness.load_sample_ae_data(20).load_sample_lb_data(50)
        result = await harness.run(MyAgent, study_id="TEST-001")
        assert "findings" in result.summary
        print(harness.data_client.calls)
    """

    def __init__(self):
        self.mock_data: dict = {}
        self.data_client = MockDataAccessClient(self.mock_data)
        self.artifact_store = MockArtifactStore()
        self.notification_client = MockNotificationClient()

    def set_mock_data(self, key: str, data: list) -> "TestHarness":
        self.mock_data[key] = data
        self.data_client._data = self.mock_data
        return self

    def load_sample_ae_data(self, n: int = 10) -> "TestHarness":
        from random import choice, randint
        severities = ["MILD", "MODERATE", "SEVERE"]
        terms = ["Headache", "Nausea", "Fatigue", "Dizziness", "Rash", "Vomiting", "Insomnia", "Arthralgia"]
        records = [
            {
                "STUDYID": "TEST-001", "DOMAIN": "AE", "USUBJID": f"TEST-001-001-{i:03d}",
                "AESEQ": i, "AETERM": choice(terms),
                "AESEV": choice(severities), "AESER": "Y" if randint(1, 8) == 1 else "N",
                "AEREL": "POSSIBLY RELATED", "AEOUT": "RECOVERED/RESOLVED",
                "AESTDTC": "2024-01-15", "AEENDTC": "2024-01-20",
                "SITEID": f"SITE-{str(randint(1, 4)).zfill(2)}",
            }
            for i in range(1, n + 1)
        ]
        return self.set_mock_data("AE", records)

    def load_sample_lb_data(self, n: int = 20) -> "TestHarness":
        from random import uniform, choice
        tests = [
            ("HGB", "Hemoglobin", "g/dL", 12.0, 16.0),
            ("WBC", "White Blood Cell Count", "10^3/uL", 4.0, 11.0),
            ("ALT", "Alanine Aminotransferase", "U/L", 7.0, 56.0),
            ("CREAT", "Creatinine", "mg/dL", 0.6, 1.2),
            ("GLUC", "Glucose", "mg/dL", 70.0, 100.0),
            ("PLT", "Platelets", "10^3/uL", 150.0, 400.0),
        ]
        records = []
        for i in range(n):
            test = choice(tests)
            val = round(uniform(test[3] * 0.6, test[4] * 1.4), 2)
            nrind = "NORMAL" if test[3] <= val <= test[4] else ("HIGH" if val > test[4] else "LOW")
            records.append({
                "STUDYID": "TEST-001", "DOMAIN": "LB",
                "USUBJID": f"TEST-001-001-{(i % 5) + 1:03d}",
                "LBSEQ": i + 1, "LBTESTCD": test[0], "LBTEST": test[1],
                "LBORRES": str(val), "LBSTRESN": val, "LBSTRESC": str(val),
                "LBORRESU": test[2], "LBSTRESU": test[2],
                "LBNRLO": str(test[3]), "LBNRHI": str(test[4]), "LBNRIND": nrind,
                "LBCAT": "CHEMISTRY", "LBDTC": "2024-01-15",
                "VISIT": "Week 4" if i % 3 == 0 else "Screening",
                "confidence_score": 1.0,
            })
        return self.set_mock_data("LB", records)

    def load_sample_dm_data(self, n: int = 5) -> "TestHarness":
        from random import choice, randint
        records = [
            {
                "STUDYID": "TEST-001", "DOMAIN": "DM",
                "USUBJID": f"TEST-001-001-{i:03d}", "SUBJID": f"{i:03d}",
                "SITEID": f"SITE-{str((i % 4) + 1).zfill(2)}",
                "AGE": randint(30, 70), "AGEU": "YEARS",
                "SEX": choice(["M", "F"]), "RACE": "WHITE", "ETHNIC": "NOT HISPANIC OR LATINO",
                "COUNTRY": "USA", "ARM": "Treatment A" if i % 2 == 0 else "Placebo",
                "ARMCD": "TRT_A" if i % 2 == 0 else "PBO",
                "RFSTDTC": "2024-01-15",
            }
            for i in range(1, n + 1)
        ]
        return self.set_mock_data("DM", records)

    async def run(self, agent_class, study_id: str = "TEST-001",
                  org_id: str = "test-org", **kwargs) -> AgentOutput:
        context = AgentContext(
            run_id=str(uuid.uuid4()),
            study_id=study_id,
            org_id=org_id,
            study_name="Phase II Safety Study (Test)",
            protocol_number=study_id,
            study_phase="II",
            consented_permissions=list(agent_class.REQUIRED_PERMISSIONS),
            declared_tools=list(agent_class.DECLARED_TOOLS),
            trigger_type="manual",
            trigger_payload={},
            data_client=self.data_client,
            artifact_store=self.artifact_store,
            notification_client=self.notification_client,
            is_test_run=True,
            extra=kwargs,
        )
        agent = agent_class(context)
        return await agent.run(context)
