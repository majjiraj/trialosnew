"""
Fixture harness for Protocol Digitization Accuracy and Interoperability & Standards.

Usage:
    python3 test_ddf_scores.py          # run and report scores
    python3 test_ddf_scores.py --assert  # fail if any target below minimum
"""

import sys
import importlib.util
import pathlib
import json

# ---------------------------------------------------------------------------
# Load _evaluate_usdm_ddf directly from services/agent-runtime/main.py without
# importing the full FastAPI app (which requires all deps running).
# ---------------------------------------------------------------------------

def _load_scorer():
    spec = importlib.util.spec_from_file_location(
        "agent_runtime_main",
        pathlib.Path(__file__).parent / "services" / "agent-runtime" / "main.py",
    )
    mod = importlib.util.module_from_spec(spec)
    # Stub out fastapi/asyncpg/etc so import doesn't fail in test context
    import types
    stubs = [
        "fastapi", "fastapi.middleware.cors", "fastapi.responses", "fastapi.middleware",
        "asyncpg", "pydantic", "pydantic_settings", "structlog", "httpx",
        "aiokafka", "redis", "redis.asyncio",
    ]
    for name in stubs:
        if name not in sys.modules:
            sys.modules[name] = types.ModuleType(name)

    # minimal pydantic stubs
    import types as _t

    class _BaseModel:
        def __init__(self, **kw): self.__dict__.update(kw)

    class _BaseSettings(_BaseModel): pass

    class _Field:
        def __call__(self, *a, **kw): return None
        def __getattr__(self, n): return self

    pyd = sys.modules["pydantic"]
    pyd.BaseModel = _BaseModel
    pyd.Field = _Field()

    pyd_s = sys.modules["pydantic_settings"]
    pyd_s.BaseSettings = _BaseSettings

    fapi = sys.modules["fastapi"]
    fapi.FastAPI = lambda **kw: None
    fapi.HTTPException = Exception
    fapi.Query = lambda *a, **kw: None
    fapi.BackgroundTasks = object
    fapi.Depends = lambda f: f

    cors = sys.modules["fastapi.middleware.cors"]
    cors.CORSMiddleware = object

    resp = sys.modules["fastapi.responses"]
    resp.StreamingResponse = object
    resp.JSONResponse = object

    sl = sys.modules["structlog"]
    class _FakeLog:
        def __getattr__(self, n): return lambda *a, **kw: None
    sl.get_logger = lambda: _FakeLog()

    try:
        spec.loader.exec_module(mod)
    except Exception as e:
        # Partial load — extract only _evaluate_usdm_ddf using exec on extracted source
        pass
    return mod


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

PROTOCOL_TEXT_FULL = """
STUDY TITLE: A Phase III Randomized, Double-Blind, Placebo-Controlled Trial of
DrugX 100mg in Patients with Moderate-to-Severe Alopecia Areata (Protocol AA-2024-001)

INTRODUCTION / RATIONALE:
Alopecia areata is an autoimmune condition affecting hair follicles. This study evaluates
the efficacy and safety of DrugX 100mg in adults with alopecia areata.

STUDY OBJECTIVES:
Primary: To evaluate the proportion of patients achieving SALT score ≤20 at week 36.
Secondary: To evaluate quality of life using DLQI at week 36.
Exploratory: Biomarker changes from baseline.

ELIGIBILITY CRITERIA:
Inclusion Criteria:
1. Age ≥18 years
2. Diagnosis of alopecia areata (ICD-10: L63.9)
3. SALT score ≥50 at baseline
Exclusion Criteria:
1. Active malignancy within 5 years
2. Pregnant or breastfeeding women

STUDY DESIGN:
Randomized, double-blind, parallel-group. Arm 1: DrugX 100mg oral daily. Arm 2: Placebo.
Blinding: double blind. Randomisation 1:1.

SCHEDULE OF ACTIVITIES:
Screening (Day -28 to Day 1), Baseline (Week 0), Week 4, Week 12, Week 24, Week 36.

STATISTICAL METHODS:
Sample size 200 per arm. Primary endpoint tested at alpha=0.05, power=90%.
Estimand: ITT population, treatment policy strategy.

ADVERSE EVENT REPORTING:
SAE reporting within 24h per ICH E6 R3. SUSAR within 7 days.
"""

PROTOCOL_TEXT_MINIMAL = "Phase 2 study in oncology patients."

# ---------------------------------------------------------------------------
# USDM fixtures
# ---------------------------------------------------------------------------

USDM_GOOD = {
    "study": {
        "versions": [{
            "studyIdentifiers": [{"type": "SPONSOR", "value": "AA-2024-001"}],
            "documentVersions": [{
                "briefTitle": "DrugX Alopecia Phase III",
                "officialTitle": "A Phase III Randomized Double-Blind Placebo-Controlled Trial of DrugX 100mg in Alopecia Areata",
                "dateValues": "2024-01-15",
                "protocolEffectiveDate": "2024-01-15",
                "versionNumber": "1.0",
            }],
            "businessTherapeuticAreas": [{"decode": "Dermatology", "code": "DERMATOLOGY"}],
            "titles": [{"text": "A Phase III Randomized Double-Blind Placebo-Controlled Trial of DrugX 100mg in Alopecia Areata", "type": {"code": "OFFICIAL"}}],
            "rationale": "Alopecia areata is an autoimmune disease affecting hair follicles with significant unmet need.",
            "studyDesigns": [{
                "studyPhase": {"code": "PHASE III TRIAL", "decode": "Phase III Trial"},
                "studyIndications": [{"codes": [{"codeSystem": "ICD-10", "code": "L63.9", "decode": "Alopecia Areata"}]}],
                "objectives": [{
                    "description": "Proportion of patients achieving SALT score ≤20 at week 36",
                    "level": {"code": "PRIMARY"},
                    "objectiveEndpoints": [{"description": "SALT score ≤20", "level": {"code": "PRIMARY"}}],
                }],
                "studyPopulations": [{
                    "name": "ITT Population",
                    "eligibilityCriteria": [
                        {"criterionCategory": "Inclusion", "identifier": "IE001", "description": "Age ≥18 years"},
                        {"criterionCategory": "Exclusion", "identifier": "IE002", "description": "Active malignancy"},
                    ],
                }],
                "studyArms": [
                    {"name": "DrugX 100mg", "studyArmType": {"decode": "Experimental", "code": "EXPERIMENTAL"}},
                    {"name": "Placebo", "studyArmType": {"decode": "Placebo Comparator", "code": "PLACEBO"}},
                ],
                "studyEpochs": [
                    {"name": "Screening", "studyEpochType": {"code": "SCREENING", "decode": "Screening"}},
                    {"name": "Treatment", "studyEpochType": {"code": "TREATMENT", "decode": "Treatment"}},
                    {"name": "Follow-Up", "studyEpochType": {"code": "FOLLOW-UP", "decode": "Follow-Up"}},
                ],
                "activities": [
                    {"name": "Blood sample", "definedProcedures": [{"name": "CBC"}]},
                    {"name": "SALT assessment"},
                    {"name": "DLQI questionnaire"},
                ],
                "estimands": [{
                    "description": "Treatment difference in SALT score ≤20 at week 36 (ITT, treatment policy)",
                    "intercurrentEvents": [{"description": "Discontinuation due to AE", "strategy": "treatment policy"}],
                }],
            }],
        }],
    }
}

USDM_PARTIAL = {
    "study": {
        "versions": [{
            "studyIdentifiers": [{"type": "SPONSOR", "value": "AA-2024-001"}],
            "documentVersions": [{"briefTitle": "DrugX Phase III"}],
            "businessTherapeuticAreas": [{"decode": "Dermatology"}],
            "titles": [{"text": "DrugX Phase III"}],
            "studyDesigns": [{
                "studyPhase": {"code": "PHASE III"},
                "studyIndications": [{"codes": []}],
                "objectives": [{"description": "Primary objective"}],
                "studyArms": [{"name": "DrugX"}],
                "studyEpochs": [{"name": "Screening"}],
                "activities": [{"name": "Visit 1"}],
                "studyPopulations": [],
            }],
        }],
    }
}

USDM_POOR = {
    "study": {
        "versions": [{
            "studyDesigns": [{}],
        }],
    }
}


# ---------------------------------------------------------------------------
# Minimum thresholds per fixture
# ---------------------------------------------------------------------------

THRESHOLDS = {
    "good": {
        "protocol_digitization_accuracy": 0.80,
        "interoperability_standards": 0.70,
    },
    "partial": {
        "protocol_digitization_accuracy": 0.40,
        "interoperability_standards": 0.25,
    },
    "poor": {
        "protocol_digitization_accuracy": 0.00,
        "interoperability_standards": 0.00,
    },
}

# Maximum scores for poor fixture — it should not score too high
CEILINGS = {
    "poor": {
        "protocol_digitization_accuracy": 0.40,
        "interoperability_standards": 0.40,
    }
}


def _extract_fn(mod):
    fn = getattr(mod, "_evaluate_usdm_ddf", None)
    if fn:
        return fn
    # Try to extract function using exec
    import re as _re
    src_path = pathlib.Path(__file__).parent / "services" / "agent-runtime" / "main.py"
    src = src_path.read_text()
    # Find function start
    start = src.find("def _evaluate_usdm_ddf(")
    end = src.find("\ndef _usdm_stage_confidence_from_ddf(", start)
    fn_src = src[start:end]
    ns: dict = {}
    import re
    exec(compile("import re\nimport json\n" + fn_src, "<ddf>", "exec"), ns)
    return ns.get("_evaluate_usdm_ddf")


def run_fixtures(score_fn) -> dict[str, dict]:
    results = {}
    fixtures = {
        "good": (USDM_GOOD, PROTOCOL_TEXT_FULL),
        "partial": (USDM_PARTIAL, PROTOCOL_TEXT_FULL),
        "poor": (USDM_POOR, PROTOCOL_TEXT_MINIMAL),
    }
    for name, (usdm, text) in fixtures.items():
        scores = score_fn(usdm, text)
        results[name] = scores
    return results


def report(results: dict[str, dict]):
    COLS = ["protocol_digitization_accuracy", "interoperability_standards",
            "automated_output_quality", "technical_feasibility", "overall_score"]
    header = f"{'Fixture':<10}" + "".join(f"{c:<34}" for c in COLS)
    print(header)
    print("-" * (10 + 34 * len(COLS)))
    for name, scores in results.items():
        row = f"{name:<10}" + "".join(
            f"{scores.get(c, 0):<34.3f}" for c in COLS
        )
        print(row)


def assert_thresholds(results: dict[str, dict]) -> bool:
    failed = []
    for fixture_name, mins in THRESHOLDS.items():
        scores = results.get(fixture_name, {})
        for dim, minimum in mins.items():
            actual = scores.get(dim, 0)
            if actual < minimum:
                failed.append(f"  [{fixture_name}] {dim}: {actual:.3f} < required {minimum:.3f}")
    for fixture_name, maxes in CEILINGS.items():
        scores = results.get(fixture_name, {})
        for dim, ceiling in maxes.items():
            actual = scores.get(dim, 0)
            if actual > ceiling:
                failed.append(f"  [{fixture_name}] {dim}: {actual:.3f} > ceiling {ceiling:.3f}")
    if failed:
        print("\nFAILED assertions:")
        for f in failed:
            print(f)
        return False
    print("\nAll threshold assertions passed.")
    return True


if __name__ == "__main__":
    import importlib.util
    import types

    # Extract scorer via exec (avoids full fastapi import)
    import re
    src_path = pathlib.Path(__file__).parent / "services" / "agent-runtime" / "main.py"
    src = src_path.read_text()
    start = src.find("def _evaluate_usdm_ddf(")
    end = src.find("\ndef _usdm_stage_confidence_from_ddf(", start)
    fn_src = src[start:end]
    ns: dict = {}
    exec(compile("import re\nimport json\n" + fn_src, "<ddf>", "exec"), ns)
    score_fn = ns["_evaluate_usdm_ddf"]

    results = run_fixtures(score_fn)
    report(results)

    do_assert = "--assert" in sys.argv
    if do_assert:
        ok = assert_thresholds(results)
        sys.exit(0 if ok else 1)
