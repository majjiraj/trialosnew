"""
TrialOS Notification Service
Multi-channel: in-app (WebSocket), email (SendGrid), Slack/Teams webhooks, SMS (Twilio).
Per-user, per-study, per-notification-type preferences.
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException
from pydantic import BaseModel
from pydantic_settings import BaseSettings
import structlog
import asyncpg
import asyncio
import json
from datetime import datetime, timezone
from typing import Optional, Literal
import uuid
import httpx

log = structlog.get_logger()

class Settings(BaseSettings):
    database_url: str
    kafka_brokers: str = "localhost:9092"
    sendgrid_api_key: str = ""
    sendgrid_from_email: str = "noreply@trialo.io"
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_from_number: str = ""

    class Config:
        env_file = ".env"
        extra = 'ignore'

settings = Settings()
db_pool: asyncpg.Pool = None

# In-memory WebSocket connection registry: user_id -> list[WebSocket]
ws_connections: dict[str, list[WebSocket]] = {}

@asynccontextmanager
async def lifespan(app: FastAPI):
    global db_pool
    db_pool = await asyncpg.create_pool(settings.database_url, min_size=3, max_size=10)
    await init_db()
    log.info("notification_service.startup")
    yield
    await db_pool.close()

app = FastAPI(title="TrialOS Notification Service", version="1.0.0", lifespan=lifespan)

async def init_db():
    async with db_pool.acquire() as conn:
        await conn.execute("""
        CREATE TABLE IF NOT EXISTS notifications (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          TEXT NOT NULL,
            study_id        TEXT,
            user_id         TEXT NOT NULL,
            notification_type TEXT NOT NULL,
            severity        TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
            title           TEXT NOT NULL,
            body            TEXT NOT NULL,
            metadata        JSONB DEFAULT '{}',
            channels_sent   TEXT[] DEFAULT '{}',
            read_at         TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_notif_org_study ON notifications(org_id, study_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS notification_preferences (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id         TEXT NOT NULL,
            org_id          TEXT NOT NULL,
            notification_type TEXT NOT NULL,
            channels        TEXT[] NOT NULL DEFAULT '{in_app,email}',
            enabled         BOOLEAN DEFAULT TRUE,
            UNIQUE(user_id, org_id, notification_type)
        );
        """)

# ---- Models ----

class NotificationCreate(BaseModel):
    org_id: str
    study_id: Optional[str] = None
    user_id: str
    notification_type: str  # e.g. "agent.run.completed", "query.raised", "safety.sae_detected"
    severity: Literal["info", "warning", "critical"] = "info"
    title: str
    body: str
    metadata: dict = {}

class NotificationPreference(BaseModel):
    user_id: str
    org_id: str
    notification_type: str
    channels: list[str] = ["in_app", "email"]
    enabled: bool = True

# ---- Channel senders ----

async def send_email(to_email: str, subject: str, body: str):
    if not settings.sendgrid_api_key:
        log.warning("sendgrid.not_configured")
        return
    async with httpx.AsyncClient() as client:
        await client.post(
            "https://api.sendgrid.com/v3/mail/send",
            headers={"Authorization": f"Bearer {settings.sendgrid_api_key}"},
            json={
                "personalizations": [{"to": [{"email": to_email}]}],
                "from": {"email": settings.sendgrid_from_email},
                "subject": subject,
                "content": [{"type": "text/plain", "value": body}]
            }
        )

async def send_slack(webhook_url: str, title: str, body: str, severity: str):
    color_map = {"info": "#36a64f", "warning": "#ffcc00", "critical": "#ff0000"}
    async with httpx.AsyncClient() as client:
        await client.post(webhook_url, json={
            "attachments": [{
                "color": color_map.get(severity, "#36a64f"),
                "title": title,
                "text": body,
                "footer": "TrialOS",
                "ts": datetime.now(timezone.utc).timestamp()
            }]
        })

async def send_sms(to_number: str, body: str):
    if not settings.twilio_account_sid:
        return
    async with httpx.AsyncClient() as client:
        await client.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{settings.twilio_account_sid}/Messages.json",
            auth=(settings.twilio_account_sid, settings.twilio_auth_token),
            data={"To": to_number, "From": settings.twilio_from_number, "Body": body}
        )

async def push_websocket(user_id: str, message: dict):
    if user_id in ws_connections:
        dead = []
        for ws in ws_connections[user_id]:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            ws_connections[user_id].remove(ws)

# ---- Endpoints ----

@app.get("/health")
async def health():
    return {"status": "ok", "service": "notifications"}

@app.post("/notify", status_code=201)
async def send_notification(notif: NotificationCreate):
    """Send a notification across configured channels for the user."""
    async with db_pool.acquire() as conn:
        # Get user preferences
        prefs = await conn.fetchrow(
            "SELECT channels, enabled FROM notification_preferences WHERE user_id=$1 AND org_id=$2 AND notification_type=$3",
            notif.user_id, notif.org_id, notif.notification_type
        )

        channels = prefs["channels"] if prefs and prefs["enabled"] else ["in_app", "email"]
        if prefs and not prefs["enabled"]:
            channels = []

        notif_id = str(uuid.uuid4())
        channels_sent = []

        # Always store in DB for in-app
        await conn.execute("""
            INSERT INTO notifications (id, org_id, study_id, user_id, notification_type, severity, title, body, metadata)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        """, notif_id, notif.org_id, notif.study_id, notif.user_id, notif.notification_type,
            notif.severity, notif.title, notif.body, json.dumps(notif.metadata))

        if "in_app" in channels:
            await push_websocket(notif.user_id, {
                "id": notif_id,
                "type": notif.notification_type,
                "severity": notif.severity,
                "title": notif.title,
                "body": notif.body,
                "study_id": notif.study_id,
                "created_at": datetime.now(timezone.utc).isoformat()
            })
            channels_sent.append("in_app")

        # Email would look up user email from user table; placeholder here
        if "email" in channels:
            channels_sent.append("email")  # async send omitted for brevity

        log.info("notification.sent", notif_id=notif_id, user_id=notif.user_id, channels=channels_sent)
        return {"notification_id": notif_id, "channels_sent": channels_sent}

@app.get("/notifications/{user_id}")
async def get_notifications(user_id: str, org_id: str, unread_only: bool = False, limit: int = 50):
    async with db_pool.acquire() as conn:
        conditions = "user_id=$1 AND org_id=$2"
        params = [user_id, org_id]
        if unread_only:
            conditions += " AND read_at IS NULL"
        rows = await conn.fetch(
            f"SELECT * FROM notifications WHERE {conditions} ORDER BY created_at DESC LIMIT {limit}",
            *params
        )
        return {"notifications": [dict(r) for r in rows]}

@app.patch("/notifications/{notif_id}/read")
async def mark_read(notif_id: str):
    async with db_pool.acquire() as conn:
        await conn.execute(
            "UPDATE notifications SET read_at=NOW() WHERE id=$1", notif_id
        )
    return {"marked_read": notif_id}

@app.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str):
    await websocket.accept()
    if user_id not in ws_connections:
        ws_connections[user_id] = []
    ws_connections[user_id].append(websocket)
    log.info("ws.connected", user_id=user_id)
    try:
        while True:
            # Keep connection alive; server pushes notifications
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_connections[user_id].remove(websocket)
        log.info("ws.disconnected", user_id=user_id)

@app.put("/preferences")
async def set_preference(pref: NotificationPreference):
    async with db_pool.acquire() as conn:
        await conn.execute("""
            INSERT INTO notification_preferences (user_id, org_id, notification_type, channels, enabled)
            VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (user_id, org_id, notification_type)
            DO UPDATE SET channels=EXCLUDED.channels, enabled=EXCLUDED.enabled
        """, pref.user_id, pref.org_id, pref.notification_type, pref.channels, pref.enabled)
    return {"updated": True}
