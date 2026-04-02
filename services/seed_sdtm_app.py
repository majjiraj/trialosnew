#!/usr/bin/env python3
"""
Seed script for SDTM Data Explorer app.

Steps:
1. POST /auth/login → token
2. GET  /agents?slug=sdtm-explorer → agent_id
3. POST /agents/install → installation_id
4. POST /forms (upload form) → form_id_upload
5. POST /forms (review form with installation_id) → form_id_review
6. Read sdtm-data-review.bpmn, replace form keys with actual IDs
7. POST /apps → app_id
8. Print all IDs
"""

import os
import sys
import json
import requests
from pathlib import Path

AUTH_URL = os.getenv("AUTH_URL", "http://localhost:8001")
MARKETPLACE_URL = os.getenv("MARKETPLACE_URL", "http://localhost:8005")
FORM_ENGINE_URL = os.getenv("FORM_ENGINE_URL", "http://localhost:8010")
APP_COMPOSER_URL = os.getenv("APP_COMPOSER_URL", "http://localhost:8009")
WORKFLOW_BRIDGE_URL = os.getenv("WORKFLOW_BRIDGE_URL", "http://localhost:8011")

DEMO_EMAIL = os.getenv("DEMO_EMAIL", "admin@acme.example")
DEMO_PASSWORD = os.getenv("DEMO_PASSWORD", "Demo@tenant1")

BPMN_TEMPLATE_PATH = Path(__file__).parent / "workflow-bridge" / "templates" / "sdtm-data-review.bpmn"


def login():
    resp = requests.post(f"{AUTH_URL}/auth/login", json={"email": DEMO_EMAIL, "password": DEMO_PASSWORD})
    resp.raise_for_status()
    data = resp.json()
    token = data.get("access_token") or data.get("token")
    user = data.get("user", {})
    org_id = data.get("org_id") or user.get("org_id")
    user_id = data.get("user_id") or user.get("id") or user.get("user_id")
    if not token:
        raise ValueError(f"No token in login response: {data}")
    if not org_id:
        raise ValueError(f"No org_id in login response: {data}")
    if not user_id:
        raise ValueError(f"No user_id in login response: {data}")
    print(f"[1] Logged in as {DEMO_EMAIL}, org_id={org_id}, user_id={user_id}")
    return token, org_id, user_id


def get_agent_id(token):
    resp = requests.get(
        f"{MARKETPLACE_URL}/agents",
        params={"slug": "sdtm-explorer"},
        headers={"Authorization": f"Bearer {token}"},
    )
    resp.raise_for_status()
    agents = resp.json()
    if isinstance(agents, dict):
        agents = agents.get("agents") or agents.get("items") or [agents]
    if not agents:
        raise ValueError("sdtm-explorer agent not found. Did you restart marketplace?")
    agent_id = agents[0]["id"]
    print(f"[2] Found agent id={agent_id}")
    return agent_id


def install_agent(token, org_id, user_id, agent_id):
    resp = requests.post(
        f"{MARKETPLACE_URL}/agents/install",
        json={
            "agent_id": agent_id,
            "org_id": org_id,
            "installed_by": user_id,
            "consented_permissions": ["study:docs:read", "study:data:read"],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    resp.raise_for_status()
    data = resp.json()
    installation_id = data.get("installation_id") or data.get("id")
    if not installation_id:
        raise ValueError(f"No installation_id in response: {data}")
    print(f"[3] Installed agent, installation_id={installation_id}")
    return installation_id


def create_upload_form(token, org_id):
    form_def = {
        "title": "Upload SDTM Files",
        "org_id": org_id,
        "json_schema": {
            "type": "object",
            "required": ["study_id", "sdtm_files"],
            "properties": {
                "study_id": {"type": "string", "title": "Study ID"},
                "sdtm_files": {
                    "type": "array",
                    "items": {"type": "string"},
                    "maxItems": 20,
                    "title": "SDTM XPT Files",
                },
            },
        },
        "ui_schema": {
            "sdtm_files": {
                "ui:widget": "file_upload",
                "ui:options": {"allowedTypes": ["xpt"], "maxFiles": 20},
            },
            "ui:page_components": [
                {"id": "pc_browse", "type": "file_browse", "label": "Uploaded Study Documents"}
            ],
        },
    }
    resp = requests.post(
        f"{FORM_ENGINE_URL}/forms",
        json=form_def,
        headers={"Authorization": f"Bearer {token}"},
    )
    resp.raise_for_status()
    data = resp.json()
    form_id = data.get("form_id") or data.get("id")
    if not form_id:
        raise ValueError(f"No form_id in response: {data}")
    print(f"[4] Created upload form, form_id={form_id}")
    return form_id


def create_review_form(token, org_id, installation_id):
    form_def = {
        "title": "SDTM Data Review",
        "org_id": org_id,
        "json_schema": {
            "type": "object",
            "required": [],
            "properties": {
                "review_notes": {"type": "string", "title": "Review Notes"},
            },
        },
        "ui_schema": {
            "review_notes": {
                "ui:widget": "textarea",
                "ui:options": {"rows": 4, "placeholder": "Summarize key findings..."},
            },
            "ui:page_components": [
                {"id": "pc_browse", "type": "file_browse", "label": "Study Documents"},
                {
                    "id": "pc_chat",
                    "type": "conversation",
                    "label": "SDTM Explorer",
                    "agentInstallationId": installation_id,
                    "agentName": "SDTM Explorer",
                    "placeholder": "Ask about your SDTM data... e.g. 'Show AE records for subject 101'",
                    "contextHint": "Answer questions about the uploaded SDTM XPT data for this study.",
                },
            ],
        },
    }
    resp = requests.post(
        f"{FORM_ENGINE_URL}/forms",
        json=form_def,
        headers={"Authorization": f"Bearer {token}"},
    )
    resp.raise_for_status()
    data = resp.json()
    form_id = data.get("form_id") or data.get("id")
    if not form_id:
        raise ValueError(f"No form_id in response: {data}")
    print(f"[5] Created review form, form_id={form_id}")
    return form_id


def install_app(token, org_id, user_id, app_id):
    resp = requests.post(
        f"{APP_COMPOSER_URL}/apps/{app_id}/install",
        json={"consented_permissions": [], "custom_config": {}},
        headers={"Authorization": f"Bearer {token}"},
    )
    if resp.status_code == 409:
        data = resp.json()
        install_id = data.get("installation_id")
        print(f"[8] App already installed, installation_id={install_id}")
        return install_id
    resp.raise_for_status()
    data = resp.json()
    install_id = data.get("id")
    if not install_id:
        raise ValueError(f"No installation id in response: {data}")
    print(f"[8] Installed app, app_installation_id={install_id}")
    return install_id


def redeploy_bpmn(org_id, app_id, form_id_upload, form_id_review):
    """Deploy the BPMN to Zeebe directly (no auth needed after our fix)."""
    bpmn_xml = BPMN_TEMPLATE_PATH.read_text()
    bpmn_xml = bpmn_xml.replace("form-sdtm-upload", form_id_upload)
    bpmn_xml = bpmn_xml.replace("form-sdtm-review", form_id_review)
    resp = requests.post(
        f"{WORKFLOW_BRIDGE_URL}/deployments",
        json={"org_id": org_id, "app_id": app_id, "bpmn_xml": bpmn_xml},
    )
    resp.raise_for_status()
    data = resp.json()
    deployment_key = data.get("deployment_key")
    process_id = data.get("process_id")
    print(f"[9] BPMN deployed to Zeebe, process_id={process_id}, deployment_key={deployment_key}")
    return deployment_key


def create_app(token, org_id, form_id_upload, form_id_review, installation_id):
    bpmn_xml = BPMN_TEMPLATE_PATH.read_text()
    bpmn_xml = bpmn_xml.replace("form-sdtm-upload", form_id_upload)
    bpmn_xml = bpmn_xml.replace("form-sdtm-review", form_id_review)

    app_def = {
        "name": "SDTM Data Explorer",
        "slug": "sdtm-data-explorer",
        "description": "Upload SDTM XPT files and interactively query study data with the SDTM Explorer AI agent.",
        "org_id": org_id,
        "bpmn_xml": bpmn_xml,
        "form_ids": [form_id_upload, form_id_review],
        "agent_attachments": [
            {
                "installation_id": installation_id,
                "task_id": "sdtm_review",
                "role": "reviewer",
            }
        ],
    }
    resp = requests.post(
        f"{APP_COMPOSER_URL}/apps",
        json=app_def,
        headers={"Authorization": f"Bearer {token}"},
    )
    if resp.status_code == 409:
        data = resp.json()
        app_id = data.get("app_id")
        print(f"[7] App already exists, app_id={app_id}")
        return app_id
    resp.raise_for_status()
    data = resp.json()
    app_id = data.get("id") or data.get("app_id")
    if not app_id:
        raise ValueError(f"No app_id in response: {data}")
    print(f"[7] Created app, app_id={app_id}")
    return app_id


def main():
    print("=== Seeding SDTM Data Explorer App ===\n")

    token, org_id, user_id = login()
    agent_id = get_agent_id(token)
    installation_id = install_agent(token, org_id, user_id, agent_id)
    form_id_upload = create_upload_form(token, org_id)
    form_id_review = create_review_form(token, org_id, installation_id)
    app_id = create_app(token, org_id, form_id_upload, form_id_review, installation_id)
    app_install_id = install_app(token, org_id, user_id, app_id)
    deployment_key = redeploy_bpmn(org_id, app_id, form_id_upload, form_id_review)

    print("\n=== Seed Complete ===")
    print(json.dumps({
        "org_id": org_id,
        "agent_id": agent_id,
        "installation_id": installation_id,
        "form_id_upload": form_id_upload,
        "form_id_review": form_id_review,
        "app_id": app_id,
        "app_installation_id": app_install_id,
        "zeebe_deployment_key": deployment_key,
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except requests.HTTPError as e:
        print(f"\nHTTP Error: {e}")
        print(f"Response: {e.response.text}")
        sys.exit(1)
    except Exception as e:
        print(f"\nError: {e}")
        sys.exit(1)
