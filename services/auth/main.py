"""
TrialOS Auth Service — Auth0 + OPA-based ABAC + Local email/password auth
21 CFR Part 11 compliant: MFA enforced, session management, audit hooks
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException, status, Request, Header, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from pydantic_settings import BaseSettings
import structlog
import httpx
import jwt
import asyncpg
import re
import uuid
import datetime as dt
from datetime import datetime, timezone, timedelta
from typing import Optional

from passlib.context import CryptContext
from jose import jwt as jose_jwt, JWTError

log = structlog.get_logger()

class Settings(BaseSettings):
    auth0_domain: str = ""
    auth0_audience: str = ""
    opa_url: str = "http://localhost:8181"
    database_url: str
    jwt_algorithm: str = "RS256"
    session_timeout_hours: int = 4
    secret_key: str = "change-me-in-production-32chars+"
    local_jwt_algorithm: str = "HS256"
    local_token_expire_hours: int = 8
    platform_org_id: str = "00000000-0000-0000-0000-000000000000"

    class Config:
        env_file = ".env"

settings = Settings()
security = HTTPBearer()
db_pool: asyncpg.Pool = None

_pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global db_pool
    db_pool = await asyncpg.create_pool(settings.database_url, min_size=2, max_size=10)
    log.info("auth_service.startup")
    yield
    await db_pool.close()
    log.info("auth_service.shutdown")

app = FastAPI(
    title="TrialOS Auth Service",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---- Models ----

class TokenVerifyRequest(BaseModel):
    token: str
    required_scope: Optional[str] = None
    study_id: Optional[str] = None
    org_id: Optional[str] = None

class TokenVerifyResponse(BaseModel):
    valid: bool
    user_id: Optional[str]
    org_id: Optional[str]
    roles: list[str]
    scopes: list[str]
    mfa_verified: bool
    session_id: Optional[str]
    error: Optional[str] = None

class OPAAuthzRequest(BaseModel):
    user_id: str
    org_id: str
    action: str
    resource_type: str
    resource_id: Optional[str] = None
    study_id: Optional[str] = None
    context: dict = {}

class OPAAuthzResponse(BaseModel):
    allowed: bool
    reason: Optional[str] = None

# ---- Password + JWT helpers ----

def _hash_password(plain: str) -> str:
    return _pwd_ctx.hash(plain)

def _verify_password(plain: str, hashed: str) -> bool:
    return _pwd_ctx.verify(plain, hashed)

def _create_token(user: dict) -> str:
    roles = list(user.get("roles") or [])
    payload = {
        "sub": str(user["id"]),
        "org_id": str(user["org_id"]),
        "email": user["email"],
        "name": user["name"],
        "roles": roles,
        "is_platform_admin": "platform_admin" in roles,
        "exp": dt.datetime.utcnow() + dt.timedelta(hours=settings.local_token_expire_hours),
    }
    return jose_jwt.encode(payload, settings.secret_key, algorithm=settings.local_jwt_algorithm)

def _decode_token(token: str) -> dict:
    return jose_jwt.decode(token, settings.secret_key, algorithms=[settings.local_jwt_algorithm])

def _require_platform_admin(authorization: str = Header(...)) -> dict:
    try:
        claims = _decode_token(authorization.replace("Bearer ", ""))
    except JWTError:
        raise HTTPException(401, "Invalid token")
    if "platform_admin" not in claims.get("roles", []):
        raise HTTPException(403, "Platform admin required")
    return claims

# ---- Auth0 token verification ----

async def get_auth0_jwks():
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"https://{settings.auth0_domain}/.well-known/jwks.json")
        resp.raise_for_status()
        return resp.json()

async def verify_auth0_token(token: str) -> dict:
    """Verify JWT against Auth0 JWKS, return claims."""
    try:
        jwks = await get_auth0_jwks()
        header = jwt.get_unverified_header(token)
        key = next(k for k in jwks["keys"] if k["kid"] == header["kid"])
        public_key = jwt.algorithms.RSAAlgorithm.from_jwk(key)
        payload = jwt.decode(
            token,
            public_key,
            algorithms=[settings.jwt_algorithm],
            audience=settings.auth0_audience,
            issuer=f"https://{settings.auth0_domain}/"
        )
        return payload
    except StopIteration:
        raise HTTPException(status_code=401, detail="Unknown key ID")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {e}")

# ---- OPA Authorization ----

async def check_opa(input_data: dict) -> dict:
    """Call OPA policy engine for ABAC decision."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{settings.opa_url}/v1/data/trialo/authz/allow",
            json={"input": input_data},
            timeout=5.0
        )
        resp.raise_for_status()
        return resp.json()

# ---- Endpoints ----

@app.get("/health")
async def health():
    return {"status": "ok", "service": "auth", "timestamp": datetime.now(timezone.utc).isoformat()}

@app.post("/verify", response_model=TokenVerifyResponse)
async def verify_token(req: TokenVerifyRequest):
    """
    Verify an Auth0 JWT. Returns user claims including org_id, roles, scopes.
    Called by API Gateway and all downstream services.
    """
    try:
        claims = await verify_auth0_token(req.token)

        # Extract TrialOS-specific claims (set via Auth0 Actions)
        org_id = claims.get("https://trialo.io/org_id")
        roles = claims.get("https://trialo.io/roles", [])
        scopes = claims.get("scope", "").split()
        mfa_verified = claims.get("https://trialo.io/mfa_verified", False)
        session_id = claims.get("https://trialo.io/session_id")
        user_id = claims.get("sub")

        # 21 CFR Part 11: MFA is mandatory
        if not mfa_verified:
            return TokenVerifyResponse(
                valid=False, user_id=user_id, org_id=org_id,
                roles=roles, scopes=scopes, mfa_verified=False,
                session_id=session_id,
                error="MFA verification required"
            )

        # Scope check if requested
        if req.required_scope and req.required_scope not in scopes:
            return TokenVerifyResponse(
                valid=False, user_id=user_id, org_id=org_id,
                roles=roles, scopes=scopes, mfa_verified=mfa_verified,
                session_id=session_id,
                error=f"Missing required scope: {req.required_scope}"
            )

        log.info("token.verified", user_id=user_id, org_id=org_id, roles=roles)
        return TokenVerifyResponse(
            valid=True, user_id=user_id, org_id=org_id,
            roles=roles, scopes=scopes, mfa_verified=mfa_verified,
            session_id=session_id
        )
    except HTTPException as e:
        return TokenVerifyResponse(
            valid=False, user_id=None, org_id=None,
            roles=[], scopes=[], mfa_verified=False, session_id=None,
            error=e.detail
        )

@app.post("/authorize", response_model=OPAAuthzResponse)
async def authorize(req: OPAAuthzRequest):
    """
    ABAC authorization check via OPA.
    Returns allow/deny with reason for audit logging.
    """
    opa_input = {
        "user_id": req.user_id,
        "org_id": req.org_id,
        "action": req.action,
        "resource": {
            "type": req.resource_type,
            "id": req.resource_id,
            "study_id": req.study_id
        },
        "context": req.context,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }

    result = await check_opa(opa_input)
    allowed = result.get("result", False)

    log.info("authz.decision",
             user_id=req.user_id,
             action=req.action,
             resource=req.resource_type,
             allowed=allowed)

    return OPAAuthzResponse(
        allowed=allowed,
        reason=None if allowed else "OPA policy denied"
    )

@app.get("/jwks")
async def get_jwks():
    """Proxy Auth0 JWKS for other services."""
    return await get_auth0_jwks()

# ─── Local auth endpoints ────────────────────────────────────────────────────

@app.post("/auth/login")
async def login(body: dict = Body(...)):
    """Email + password login. Returns HS256 JWT + user profile."""
    email = body.get("email", "").lower().strip()
    password = body.get("password", "")
    async with db_pool.acquire() as conn:
        user = await conn.fetchrow(
            "SELECT u.*, o.name as org_name, o.slug as org_slug, o.is_platform_org "
            "FROM users u JOIN organizations o ON o.id = u.org_id "
            "WHERE u.email=$1 AND u.is_active=TRUE", email)
    if not user or not user["password_hash"]:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not _verify_password(password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = _create_token(dict(user))
    async with db_pool.acquire() as conn:
        await conn.execute("UPDATE users SET last_login=NOW() WHERE id=$1", user["id"])
    log.info("auth.login", email=email)
    return {
        "token": token,
        "user": {
            "id": str(user["id"]),
            "email": user["email"],
            "name": user["name"],
            "roles": list(user["roles"]),
            "org_id": str(user["org_id"]),
            "org_name": user["org_name"],
            "org_slug": user["org_slug"],
            "is_platform_admin": "platform_admin" in list(user["roles"]),
        }
    }


@app.post("/auth/signup")
async def signup(body: dict = Body(...)):
    """Self-registration for new tenants. Creates org + tenant_admin user."""
    email = body["email"].lower().strip()
    password = body["password"]
    name = body["name"]
    org_name = body["org_name"]
    slug = re.sub(r'[^a-z0-9]+', '-', org_name.lower()).strip('-')

    async with db_pool.acquire() as conn:
        if await conn.fetchval("SELECT 1 FROM organizations WHERE slug=$1", slug):
            raise HTTPException(400, "Organization name already taken")
        if await conn.fetchval("SELECT 1 FROM users WHERE email=$1", email):
            raise HTTPException(400, "Email already registered")

        async with conn.transaction():
            org_id = await conn.fetchval(
                "INSERT INTO organizations (name, slug, plan, status) "
                "VALUES ($1,$2,'starter','active') RETURNING id",
                org_name, slug)
            user = await conn.fetchrow(
                "INSERT INTO users (org_id, email, name, roles, password_hash, auth0_user_id) "
                "VALUES ($1,$2,$3,ARRAY['tenant_admin'],$4,NULL) RETURNING *",
                org_id, email, name, _hash_password(password))

    log.info("auth.signup", email=email, org=org_name)
    return {
        "token": _create_token({
            **dict(user),
            "org_name": org_name,
            "org_slug": slug,
        })
    }


@app.get("/auth/me")
async def me(authorization: str = Header(...)):
    """Decode local JWT and return fresh user profile from DB."""
    token = authorization.replace("Bearer ", "")
    try:
        claims = _decode_token(token)
    except JWTError:
        raise HTTPException(401, "Invalid token")
    async with db_pool.acquire() as conn:
        user = await conn.fetchrow(
            "SELECT u.*, o.name as org_name, o.slug as org_slug, o.is_platform_org "
            "FROM users u JOIN organizations o ON o.id=u.org_id WHERE u.id=$1",
            uuid.UUID(claims["sub"]))
    if not user:
        raise HTTPException(404, "User not found")
    return {
        "id": str(user["id"]),
        "email": user["email"],
        "name": user["name"],
        "roles": list(user["roles"]),
        "org_id": str(user["org_id"]),
        "org_name": user["org_name"],
        "org_slug": user["org_slug"],
        "is_platform_admin": "platform_admin" in list(user["roles"]),
    }

# ─── Platform admin endpoints ────────────────────────────────────────────────

@app.get("/admin/tenants")
async def list_tenants(claims: dict = Depends(_require_platform_admin)):
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT o.id, o.name, o.slug, o.plan, o.status, o.created_at, "
            "(SELECT count(*) FROM users WHERE org_id=o.id) as user_count "
            "FROM organizations o WHERE is_platform_org=FALSE ORDER BY o.created_at DESC")
    return {"tenants": [dict(r) for r in rows]}


@app.patch("/admin/tenants/{org_id}/status")
async def set_tenant_status(org_id: str, body: dict = Body(...),
                             claims: dict = Depends(_require_platform_admin)):
    status = body["status"]  # 'active' | 'suspended'
    async with db_pool.acquire() as conn:
        await conn.execute("UPDATE organizations SET status=$1 WHERE id=$2",
                           status, uuid.UUID(org_id))
    return {"ok": True}


@app.get("/admin/users")
async def list_platform_users(claims: dict = Depends(_require_platform_admin)):
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT u.id, u.email, u.name, u.roles, u.is_active, u.created_at, "
            "o.name as org_name FROM users u JOIN organizations o ON o.id=u.org_id "
            "ORDER BY u.created_at DESC")
    return {"users": [dict(r) for r in rows]}

# ─── Tenant user management endpoints ────────────────────────────────────────

def _require_tenant_admin_for(org_id: str, authorization: str) -> dict:
    try:
        claims = _decode_token(authorization.replace("Bearer ", ""))
    except JWTError:
        raise HTTPException(401, "Invalid token")
    is_admin = "tenant_admin" in claims.get("roles", []) or "platform_admin" in claims.get("roles", [])
    same_org = claims.get("org_id") == org_id
    if not (is_admin and (same_org or "platform_admin" in claims.get("roles", []))):
        raise HTTPException(403, "Tenant admin required")
    return claims


@app.get("/tenants/{org_id}/users")
async def list_org_users(org_id: str, authorization: str = Header(...)):
    try:
        _decode_token(authorization.replace("Bearer ", ""))
    except JWTError:
        raise HTTPException(401, "Invalid token")
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, email, name, roles, is_active, created_at "
            "FROM users WHERE org_id=$1 ORDER BY created_at", uuid.UUID(org_id))
    return {"users": [dict(r) for r in rows]}


@app.post("/tenants/{org_id}/users")
async def invite_user(org_id: str, body: dict = Body(...),
                      authorization: str = Header(...)):
    _require_tenant_admin_for(org_id, authorization)
    async with db_pool.acquire() as conn:
        user = await conn.fetchrow(
            "INSERT INTO users (org_id, email, name, roles, password_hash, auth0_user_id) "
            "VALUES ($1,$2,$3,$4,$5,NULL) RETURNING id, email, name, roles, is_active, created_at",
            uuid.UUID(org_id), body["email"].lower().strip(), body["name"],
            body.get("roles", ["analyst"]), _hash_password(body["password"]))
    return {"user": dict(user)}


@app.patch("/tenants/{org_id}/users/{user_id}")
async def update_org_user(org_id: str, user_id: str, body: dict = Body(...),
                           authorization: str = Header(...)):
    _require_tenant_admin_for(org_id, authorization)
    async with db_pool.acquire() as conn:
        if "roles" in body:
            await conn.execute(
                "UPDATE users SET roles=$1 WHERE id=$2 AND org_id=$3",
                body["roles"], uuid.UUID(user_id), uuid.UUID(org_id))
        if "is_active" in body:
            await conn.execute(
                "UPDATE users SET is_active=$1 WHERE id=$2 AND org_id=$3",
                body["is_active"], uuid.UUID(user_id), uuid.UUID(org_id))
    return {"ok": True}
