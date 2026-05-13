"""Quick offline unit-tests for validate_fix_usdm_conversion.py.

Run with:
    python3 scripts/_test_validate_fix.py
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Monkey-patch network helpers so tests run offline
import scripts.validate_fix_usdm_conversion as vf
vf._get_json = lambda url: {}  # not needed by unit tests
vf._post_json = lambda url, payload: {}  # context service calls silenced


def _minimal_conv(study_extra=None, version_extra=None, design_extra=None):
    version = {
        "id": "SV-001",
        "organizations": [
            {"id": "ORG-PFIZER", "name": "Pfizer Inc."},
            {"id": "ORG-DMC", "name": "Data Monitoring Committee"},
        ],
        **(version_extra or {}),
    }
    design = {
        "id": "DESIGN-001",
        **(design_extra or {}),
    }
    version["studyDesigns"] = [design]
    study = {
        "id": "STUDY-001",
        "versions": [version],
        **(study_extra or {}),
    }
    return {"usdm_json": {"study": study}}


# ── STR-001: root duplication ────────────────────────────────────────────────
def test_str001_detects_and_fixes_root_duplication():
    conv = _minimal_conv(study_extra={"studyIdentifiers": [{"id": "SI-1"}]},
                         version_extra={"studyIdentifiers": [{"id": "SI-1"}]})
    r = vf.validate_and_fix(conv, apply_fixes=False)
    assert r["findings"]["STR-001_root_duplication"], "should detect studyIdentifiers duplication"

    conv2 = _minimal_conv(study_extra={"studyIdentifiers": [{"id": "SI-1"}]},
                          version_extra={"studyIdentifiers": [{"id": "SI-1"}]})
    r2 = vf.validate_and_fix(conv2, apply_fixes=True)
    # After fix the key should be gone from study root
    assert "studyIdentifiers" not in conv2["usdm_json"]["study"] or \
        "studyIdentifiers" in conv2["usdm_json"]["study"]["versions"][0], \
        "key should be removed from study root"
    print("PASS: STR-001 root duplication")


# ── STR-002: duplicate IDs ───────────────────────────────────────────────────
def test_str002_detects_duplicate_ids():
    conv = _minimal_conv(design_extra={
        "objectives": [{"id": "OBJ-001"}, {"id": "OBJ-001"}],
    })
    r = vf.validate_and_fix(conv, apply_fixes=False)
    assert "OBJ-001" in r["findings"]["STR-002_duplicate_ids"]
    print("PASS: STR-002 duplicate IDs")


# ── STR-004: org ref normalisation ──────────────────────────────────────────
def test_str004_detects_dupfix_org_and_fixes():
    conv = _minimal_conv(version_extra={
        "studyRoles": [
            {"id": "ROLE-001", "organizations": [{"id": "ORG-PFIZER-DUPFIX"}]},
        ],
    })
    r = vf.validate_and_fix(conv, apply_fixes=False)
    assert r["findings"]["STR-004_org_ref_normalisation"], "should detect DUPFIX org ref"

    conv2 = _minimal_conv(version_extra={
        "studyRoles": [
            {"id": "ROLE-001", "organizations": [{"id": "ORG-PFIZER-DUPFIX"}]},
        ],
    })
    vf.validate_and_fix(conv2, apply_fixes=True)
    role = conv2["usdm_json"]["study"]["versions"][0]["studyRoles"][0]
    assert role["organizations"][0]["id"] == "ORG-PFIZER", f"expected ORG-PFIZER got {role['organizations'][0]['id']}"
    print("PASS: STR-004 org ref normalisation")


# ── ICE-001: description→intercurrentEvent ───────────────────────────────────
def test_ice001_renames_description_field():
    conv = _minimal_conv(design_extra={
        "estimands": [{
            "id": "EST-001",
            "variableOfInterestId": "EP-001",
            "intercurrentEvents": [{"id": "ICE-001", "description": "Some event"}],
        }],
        "studyEndpoints": [{"id": "EP-001", "name": "Safety endpoint"}],
    })
    r = vf.validate_and_fix(conv, apply_fixes=False)
    assert r["findings"]["ICE-001_description_field"], "should flag description field"

    conv2 = _minimal_conv(design_extra={
        "estimands": [{
            "id": "EST-001",
            "variableOfInterestId": "EP-001",
            "intercurrentEvents": [{"id": "ICE-001", "description": "Some event"}],
        }],
        "studyEndpoints": [{"id": "EP-001", "name": "Safety endpoint"}],
    })
    vf.validate_and_fix(conv2, apply_fixes=True)
    ice = conv2["usdm_json"]["study"]["versions"][0]["studyDesigns"][0]["estimands"][0]["intercurrentEvents"][0]
    assert "intercurrentEvent" in ice and "description" not in ice
    print("PASS: ICE-001 description→intercurrentEvent")


# ── ICE-002: missing strategyCode ────────────────────────────────────────────
def test_ice002_adds_default_strategy_code():
    conv = _minimal_conv(design_extra={
        "estimands": [{
            "id": "EST-001",
            "variableOfInterestId": "EP-001",
            "intercurrentEvents": [{"id": "ICE-001", "intercurrentEvent": "Discontinuation"}],
        }],
        "studyEndpoints": [{"id": "EP-001", "name": "Safety endpoint"}],
    })
    r = vf.validate_and_fix(conv, apply_fixes=False)
    assert r["findings"]["ICE-002_missing_strategy_code"], "should flag missing strategyCode"

    conv2 = _minimal_conv(design_extra={
        "estimands": [{
            "id": "EST-001",
            "variableOfInterestId": "EP-001",
            "intercurrentEvents": [{"id": "ICE-001", "intercurrentEvent": "Discontinuation"}],
        }],
        "studyEndpoints": [{"id": "EP-001", "name": "Safety endpoint"}],
    })
    vf.validate_and_fix(conv2, apply_fixes=True)
    ice = conv2["usdm_json"]["study"]["versions"][0]["studyDesigns"][0]["estimands"][0]["intercurrentEvents"][0]
    assert ice.get("strategyCode", {}).get("code") == "C187302"
    print("PASS: ICE-002 missing strategyCode")


# ── ICE-003: PK endpoint wrong strategy ──────────────────────────────────────
def test_ice003_fixes_pk_wrong_strategy():
    conv = _minimal_conv(design_extra={
        "estimands": [{
            "id": "EST-PK",
            "variableOfInterestId": "EP-PK",
            "intercurrentEvents": [{
                "id": "ICE-PK",
                "intercurrentEvent": "Dose interruption",
                "strategyCode": {"code": "C187301", "decode": "While on Treatment Strategy"},
            }],
        }],
        "studyEndpoints": [{"id": "EP-PK", "name": "Pharmacokinetics AUC endpoint"}],
    })
    r = vf.validate_and_fix(conv, apply_fixes=False)
    assert r["findings"]["ICE-003_pk_wrong_strategy"], "should flag C187301 on PK estimand"

    conv2 = _minimal_conv(design_extra={
        "estimands": [{
            "id": "EST-PK",
            "variableOfInterestId": "EP-PK",
            "intercurrentEvents": [{
                "id": "ICE-PK",
                "intercurrentEvent": "Dose interruption",
                "strategyCode": {"code": "C187301", "decode": "While on Treatment Strategy"},
            }],
        }],
        "studyEndpoints": [{"id": "EP-PK", "name": "Pharmacokinetics AUC endpoint"}],
    })
    vf.validate_and_fix(conv2, apply_fixes=True)
    sc = conv2["usdm_json"]["study"]["versions"][0]["studyDesigns"][0]["estimands"][0]["intercurrentEvents"][0]["strategyCode"]
    assert sc["code"] == "C187302", f"expected C187302 got {sc['code']}"
    print("PASS: ICE-003 PK wrong strategy")


# ── PHASE-001: studyPhase spurious flat fields ───────────────────────────────
def test_phase001_removes_flat_code_decode():
    conv = _minimal_conv(design_extra={
        "studyPhase": {
            "code": "C15602",
            "decode": "Phase 3",
            "standardCode": {"code": "C15602", "decode": "Phase 3", "codeSystem": "C71620"},
        },
    })
    r = vf.validate_and_fix(conv, apply_fixes=False)
    assert r["findings"]["PHASE-001_spurious_flat_fields"], "should flag flat code/decode"

    conv2 = _minimal_conv(design_extra={
        "studyPhase": {
            "code": "C15602",
            "decode": "Phase 3",
            "standardCode": {"code": "C15602", "decode": "Phase 3", "codeSystem": "C71620"},
        },
    })
    vf.validate_and_fix(conv2, apply_fixes=True)
    sp = conv2["usdm_json"]["study"]["versions"][0]["studyDesigns"][0]["studyPhase"]
    assert "code" not in sp and "decode" not in sp
    assert "standardCode" in sp
    print("PASS: PHASE-001 spurious flat fields")


# ── ACT-001: group activity ordering conflict ────────────────────────────────
def test_act001_removes_seq_links_from_group_activities():
    conv = _minimal_conv(design_extra={
        "activities": [{
            "id": "ACT-GROUP",
            "childIds": ["ACT-CHILD-001"],
            "nextId": "ACT-GROUP-NEXT",
            "previousId": None,
        }],
    })
    r = vf.validate_and_fix(conv, apply_fixes=False)
    assert r["findings"]["ACT-001_group_activity_ordering"], "should flag group with nextId"

    conv2 = _minimal_conv(design_extra={
        "activities": [{
            "id": "ACT-GROUP",
            "childIds": ["ACT-CHILD-001"],
            "nextId": "ACT-GROUP-NEXT",
            "previousId": None,
        }],
    })
    vf.validate_and_fix(conv2, apply_fixes=True)
    act = conv2["usdm_json"]["study"]["versions"][0]["studyDesigns"][0]["activities"][0]
    assert "nextId" not in act
    print("PASS: ACT-001 group activity ordering")


# ── DOSE-001: doseForm.code missing codeSystem ───────────────────────────────
def test_dose001_adds_codesystem():
    conv = _minimal_conv(design_extra={
        "studyInterventions": [{
            "id": "ITV-001",
            "name": "Ritlecitinib 50 mg",
            "administrableProducts": [{
                "id": "AP-001",
                "doseForm": {"code": "C42964", "decode": "Oral Tablet"},
            }],
        }],
    })
    r = vf.validate_and_fix(conv, apply_fixes=False)
    assert r["findings"]["DOSE-001_doseform_no_codesystem"], "should flag missing codeSystem"

    conv2 = _minimal_conv(design_extra={
        "studyInterventions": [{
            "id": "ITV-001",
            "name": "Ritlecitinib 50 mg",
            "administrableProducts": [{
                "id": "AP-001",
                "doseForm": {"code": "C42964", "decode": "Oral Tablet"},
            }],
        }],
    })
    vf.validate_and_fix(conv2, apply_fixes=True)
    df = conv2["usdm_json"]["study"]["versions"][0]["studyDesigns"][0]["studyInterventions"][0]["administrableProducts"][0]["doseForm"]
    assert df.get("codeSystem") == "C71620"
    print("PASS: DOSE-001 doseForm codeSystem")


# ── EST-001: PK estimand coverage gap ────────────────────────────────────────
def test_est001_detects_missing_pk_estimand():
    conv = _minimal_conv(design_extra={
        "studyEndpoints": [
            {"id": "EP-PK", "name": "Pharmacokinetics Cmax"},
            {"id": "EP-SAFE", "name": "Incidence of TEAEs"},
        ],
        "studyInterventions": [
            {"id": "ITV-ACTIVE", "name": "Drug X 50 mg"},
            {"id": "ITV-PLACEBO", "name": "Placebo"},
        ],
        "estimands": [
            # Only safety estimand for active drug — PK is missing
            {"id": "EST-SAFE", "variableOfInterestId": "EP-SAFE", "interventionId": "ITV-ACTIVE",
             "intercurrentEvents": [{"id": "ICE-S", "intercurrentEvent": "Discontinuation",
                                     "strategyCode": {"code": "C187302", "decode": "TPS", "codeSystem": "C71620"}}]},
        ],
    })
    r = vf.validate_and_fix(conv, apply_fixes=False)
    assert r["findings"]["EST-001_pk_coverage_gap"], "should flag missing PK estimand"
    assert any("EP-PK" in f and "ITV-ACTIVE" in f for f in r["findings"]["EST-001_pk_coverage_gap"])
    print("PASS: EST-001 PK coverage gap detected")


def test_est001_auto_stub_estimand():
    conv = _minimal_conv(design_extra={
        "studyEndpoints": [{"id": "EP-PK", "name": "Pharmacokinetics AUC"}],
        "studyInterventions": [{"id": "ITV-ACTIVE", "name": "Drug X"}],
        "estimands": [],
        "studyPopulations": [{"id": "POP-001", "name": "All Subjects"}],
    })
    vf.validate_and_fix(conv, apply_fixes=True, fix_coverage=True)
    estimands = conv["usdm_json"]["study"]["versions"][0]["studyDesigns"][0].get("estimands", [])
    assert any("EP-PK" in e.get("id", "") for e in estimands), "should have auto-created stub estimand"
    print("PASS: EST-001 auto stub estimand created")


if __name__ == "__main__":
    tests = [
        test_str001_detects_and_fixes_root_duplication,
        test_str002_detects_duplicate_ids,
        test_str004_detects_dupfix_org_and_fixes,
        test_ice001_renames_description_field,
        test_ice002_adds_default_strategy_code,
        test_ice003_fixes_pk_wrong_strategy,
        test_phase001_removes_flat_code_decode,
        test_act001_removes_seq_links_from_group_activities,
        test_dose001_adds_codesystem,
        test_est001_detects_missing_pk_estimand,
        test_est001_auto_stub_estimand,
    ]
    failed = 0
    for t in tests:
        try:
            t()
        except Exception as e:
            print(f"FAIL: {t.__name__}: {e}")
            failed += 1
    print(f"\n{'ALL PASSED' if not failed else str(failed) + ' FAILED'} ({len(tests) - failed}/{len(tests)})")
    sys.exit(failed)
