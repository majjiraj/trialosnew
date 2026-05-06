#!/usr/bin/env python3
"""Backfill ddf_scores for existing agent_runs using v4-aware evaluation via agent-runtime."""
import httpx
import json
import subprocess
import sys

RUNS = [
    "79ab3c08-e8ae-4678-a592-ed78a436702a",
    "fe71ed53-04ee-4fda-99b3-ab6ccaad5ab5",
]

CONVERSION_MAP = {
    "79ab3c08-e8ae-4678-a592-ed78a436702a": "01bdec25-a440-4d2f-98b0-bbc945bff4b8",
    "fe71ed53-04ee-4fda-99b3-ab6ccaad5ab5": "107139cb-50d5-46a6-b995-c27ee32d2e20",
}

def get_usdm_json(conversion_id: str) -> dict:
    result = subprocess.run(
        ["docker", "exec", "-i", "trialo-postgres-1", "psql", "-U", "trialo", "trialo",
         "-t", "-A", "-c",
         f"SELECT usdm_json FROM usdm_conversions WHERE id='{conversion_id}';"],
        capture_output=True, text=True
    )
    return json.loads(result.stdout.strip())


def evaluate_ddf_via_api(usdm_json: dict) -> dict:
    """POST to the agent-runtime's evaluate endpoint."""
    resp = httpx.post(
        "http://localhost:8004/evaluate-usdm-ddf",
        json={"usdm_json": usdm_json},
        timeout=30.0
    )
    if resp.status_code == 200:
        return resp.json()
    print(f"  evaluate endpoint returned {resp.status_code}: {resp.text[:200]}")
    return None


def update_ddf_scores(run_id: str, ddf_scores: dict):
    scores_json = json.dumps(ddf_scores).replace("'", "''")
    sql = f"""
UPDATE agent_runs
SET metadata = jsonb_set(
    COALESCE(metadata, '{{}}'),
    '{{ddf_scores}}',
    '{scores_json}'::jsonb
)
WHERE id='{run_id}';
"""
    result = subprocess.run(
        ["docker", "exec", "-i", "trialo-postgres-1", "psql", "-U", "trialo", "trialo",
         "-c", sql],
        capture_output=True, text=True
    )
    print(f"  DB update: {result.stdout.strip()}")
    if result.returncode != 0:
        print(f"  DB error: {result.stderr.strip()}")


def main():
    for run_id in RUNS:
        conversion_id = CONVERSION_MAP[run_id]
        print(f"\nRun: {run_id}")
        print(f"  Conversion: {conversion_id}")

        print("  Fetching USDM JSON...")
        usdm = get_usdm_json(conversion_id)
        print(f"  USDM keys at root: {list(usdm.get('study', {}).keys())[:5]}")

        print("  Evaluating DDF...")
        scores = evaluate_ddf_via_api(usdm)
        if scores is None:
            print("  Skipping - evaluate endpoint not available")
            continue

        print(f"  Overall score: {scores.get('overall_score')}")
        print(f"  Digitization: {scores.get('protocol_digitization_accuracy')}")
        print(f"  Output quality: {scores.get('automated_output_quality')}")
        print(f"  Standards: {scores.get('interoperability_standards')}")
        print(f"  Feasibility: {scores.get('technical_feasibility')}")

        print("  Updating DB...")
        update_ddf_scores(run_id, scores)

    print("\nDone.")


if __name__ == "__main__":
    main()
