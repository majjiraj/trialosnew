# TrialOS Deployment Standards

This document defines the standard usernames, passwords, ports, and credentials for all TrialOS services across each environment.

> **Security rule:** Never commit real credentials to Git. Use this document as the source of truth for naming conventions and structure only. Actual secrets must be stored in a secrets manager (Vault, AWS Secrets Manager, GCP Secret Manager) or as Kubernetes sealed secrets.

---

## Environments

| Environment | Domain | K8s Namespace |
|-------------|--------|---------------|
| Development (local) | localhost | trialo-dev |
| Staging | staging.trialo.io | trialo-staging |
| Production | app.trialo.io | trialo-prod |

---

## Naming Conventions

| Field | Convention | Example |
|-------|-----------|---------|
| DB usernames | `trialo_<env>` | `trialo_prod` |
| DB names | `trialo_<env>` | `trialo_prod` |
| MinIO access key | `trialo-<env>` | `trialo-prod` |
| K8s secret name | `trialo-secrets` | `trialo-secrets` |
| Service account | `trialo-sa` | `trialo-sa` |

---

## 1. PostgreSQL (pgvector)

Port: **5432**

| Parameter | Dev | Staging | Production |
|-----------|-----|---------|------------|
| Host | `localhost` | `postgres.trialo-staging.svc` | `postgres.trialo-prod.svc` |
| Port | `5432` | `5432` | `5432` |
| Database | `trialo` | `trialo_staging` | `trialo_prod` |
| Username | `trialo` | `trialo_staging` | `trialo_prod` |
| Password | `trialo_dev` | `<from secrets manager>` | `<from secrets manager>` |
| Vector DB name | `trialo_vectors` | `trialo_vectors_staging` | `trialo_vectors_prod` |
| Extensions required | `uuid-ossp`, `pgcrypto`, `vector` | same | same |

**Connection string format:**
```
postgresql://<user>:<password>@<host>:5432/<dbname>
```

**Env vars:**
```
POSTGRES_HOST=
POSTGRES_PORT=5432
POSTGRES_DB=
POSTGRES_USER=
POSTGRES_PASSWORD=
PGVECTOR_CONNECTION_STRING=postgresql://<user>:<password>@<host>:5432/<vector-db>
```

---

## 2. MongoDB

Port: **27017**

| Parameter | Dev | Staging | Production |
|-----------|-----|---------|------------|
| Host | `localhost` | `mongo.trialo-staging.svc` | `mongo.trialo-prod.svc` |
| Port | `27017` | `27017` | `27017` |
| Database | `trialo` | `trialo_staging` | `trialo_prod` |
| Username | `trialo` | `trialo_staging` | `trialo_prod` |
| Password | `trialopass` | `<from secrets manager>` | `<from secrets manager>` |

**Connection string format:**
```
mongodb://<user>:<password>@<host>:27017/<dbname>
```

**Env var:**
```
MONGO_URI=mongodb://<user>:<password>@<host>:27017/<dbname>
```

---

## 3. Redis

Port: **6379**

| Parameter | Dev | Staging | Production |
|-----------|-----|---------|------------|
| Host | `localhost` | `redis.trialo-staging.svc` | `redis.trialo-prod.svc` |
| Port | `6379` | `6379` | `6379` |
| Password | *(none)* | `<from secrets manager>` | `<from secrets manager>` |
| TLS | No | Yes | Yes |

**Env var:**
```
REDIS_URL=redis://:<password>@<host>:6379
```

---

## 4. Neo4j

Ports: **7474** (HTTP), **7687** (Bolt)

| Parameter | Dev | Staging | Production |
|-----------|-----|---------|------------|
| Host (bolt) | `bolt://localhost:7687` | `bolt://neo4j.trialo-staging.svc:7687` | `bolt://neo4j.trialo-prod.svc:7687` |
| Username | `neo4j` | `neo4j` | `neo4j` |
| Password | `trialo_dev` | `<from secrets manager>` | `<from secrets manager>` |

**Env vars:**
```
NEO4J_URI=bolt://<host>:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=
```

---

## 5. Elasticsearch

Port: **9200**

| Parameter | Dev | Staging | Production |
|-----------|-----|---------|------------|
| Host | `localhost` | `elasticsearch.trialo-staging.svc` | `elasticsearch.trialo-prod.svc` |
| Port | `9200` | `9200` | `9200` |
| Username | *(none)* | `elastic` | `elastic` |
| Password | *(none)* | `<from secrets manager>` | `<from secrets manager>` |
| TLS | No | Yes | Yes |

**Env var:**
```
ELASTICSEARCH_URL=https://<user>:<password>@<host>:9200
```

---

## 6. MinIO (S3-Compatible Object Storage)

Ports: **9000** (API), **9001** (console)

| Parameter | Dev | Staging | Production |
|-----------|-----|---------|------------|
| Endpoint | `http://localhost:9000` | `http://minio.trialo-staging.svc:9000` | S3 or managed MinIO |
| Access Key | `trialo-dev` | `trialo-staging` | `trialo-prod` |
| Secret Key | `trialo_dev_secret` | `<from secrets manager>` | `<from secrets manager>` |

**Standard bucket names:**

| Bucket | Purpose |
|--------|---------|
| `trialo-bronze` | Raw ingested documents |
| `trialo-silver` | Processed/normalized data |
| `trialo-gold` | Analysis-ready data |
| `trialo-artifacts` | Agent outputs, reports |

**Env vars:**
```
S3_ENDPOINT=
S3_ACCESS_KEY=
S3_SECRET_KEY=
S3_BUCKET_BRONZE=trialo-bronze
S3_BUCKET_SILVER=trialo-silver
S3_BUCKET_GOLD=trialo-gold
S3_BUCKET_ARTIFACTS=trialo-artifacts
```

---

## 7. Kafka

Port: **9092**

| Parameter | Dev | Staging | Production |
|-----------|-----|---------|------------|
| Brokers | `localhost:9092` | `kafka.trialo-staging.svc:9092` | `kafka.trialo-prod.svc:9092` |
| Auth | None | SASL/SCRAM | SASL/SCRAM |
| Username | — | `trialo_staging` | `trialo_prod` |
| Password | — | `<from secrets manager>` | `<from secrets manager>` |

**Standard topics:**

| Topic | Producer | Consumer |
|-------|----------|----------|
| `trialo.audit.events` | All services | audit-service |
| `trialo.ingestion.jobs` | graphql-api | ingestion-service |
| `trialo.agent.events` | agent-runtime | audit-service |
| `trialo.notifications` | All services | notification-service |

**Env vars:**
```
KAFKA_BROKERS=
KAFKA_USERNAME=
KAFKA_PASSWORD=
```

---

## 8. Zeebe (Camunda)

Port: **26500** (gRPC)

| Parameter | Dev | Staging | Production |
|-----------|-----|---------|------------|
| Address | `localhost:26500` | `zeebe.trialo-staging.svc:26500` | `zeebe.trialo-prod.svc:26500` |
| Auth | None | OAuth2 | OAuth2 |

**Env var:**
```
ZEEBE_ADDRESS=
ZEEBE_CLIENT_ID=
ZEEBE_CLIENT_SECRET=
```

---

## 9. Authentication — Auth0

| Parameter | Dev | Staging | Production |
|-----------|-----|---------|------------|
| Domain | `trialo-dev.auth0.com` | `trialo-staging.auth0.com` | `trialo.auth0.com` |
| Audience | `https://api.trialo.io` | `https://api.trialo.io` | `https://api.trialo.io` |
| Client ID | `<from Auth0 dashboard>` | `<from Auth0 dashboard>` | `<from Auth0 dashboard>` |
| Client Secret | `<from secrets manager>` | `<from secrets manager>` | `<from secrets manager>` |

**Env vars:**
```
AUTH0_DOMAIN=
AUTH0_CLIENT_ID=
AUTH0_CLIENT_SECRET=
AUTH0_AUDIENCE=https://api.trialo.io
JWT_SECRET=          # 256-bit hex — generate with: openssl rand -hex 32
```

---

## 10. LLM Providers

| Provider | Env var | Notes |
|----------|---------|-------|
| Anthropic | `ANTHROPIC_API_KEY` | Prefix: `sk-ant-` |
| OpenAI | `OPENAI_API_KEY` | Prefix: `sk-proj-` |
| Ollama (local) | `OLLAMA_BASE_URL` | `http://localhost:11434` for dev |

**Embedding config:**
```
EMBEDDING_PROVIDER=openai        # openai | ollama | huggingface
EMBEDDING_MODEL=text-embedding-3-large
EMBEDDING_DIM=1536               # 768 for nomic-embed-text, 1024 for BAAI/bge-m3
```

---

## 11. Notification Services

| Service | Env vars |
|---------|---------|
| SendGrid (email) | `SENDGRID_API_KEY` |
| Twilio (SMS) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` |
| Slack | `SLACK_BOT_TOKEN` |

---

## 12. Stripe (Billing)

```
STRIPE_SECRET_KEY=sk_live_...    # Use sk_test_ for dev/staging
STRIPE_WEBHOOK_SECRET=whsec_...
```

---

## 13. Langfuse (LLM Observability)

Port: **3100**

| Parameter | Dev | Staging | Production |
|-----------|-----|---------|------------|
| Host | `http://localhost:3100` | `https://langfuse.trialo.io` | `https://langfuse.trialo.io` |
| Public Key | `pk-lf-trialo` | `<from Langfuse>` | `<from Langfuse>` |
| Secret Key | `sk-lf-trialo` | `<from secrets manager>` | `<from secrets manager>` |

**Env vars:**
```
LANGFUSE_HOST=
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
```

---

## 14. Application Composition Platform (ACP)

```
FIELD_ENCRYPTION_KEY=    # 256-bit AES key — generate with: openssl rand -hex 32
APP_COMPOSER_URL=http://localhost:8009
FORM_ENGINE_URL=http://localhost:8010
WORKFLOW_BRIDGE_URL=http://localhost:8011
```

---

## 15. Internal Service URLs

### Development (localhost)

| Service | URL |
|---------|-----|
| auth-service | `http://localhost:8001` |
| audit-service | `http://localhost:8002` |
| ingestion-service | `http://localhost:8003` |
| agent-runtime | `http://localhost:8004` |
| marketplace | `http://localhost:8005` |
| notification-service | `http://localhost:8006` |
| data-platform | `http://localhost:8007` |
| context-graph | `http://localhost:8008` |
| app-composer | `http://localhost:8009` |
| form-engine | `http://localhost:8010` |
| workflow-bridge | `http://localhost:8011` |
| graphql-api | `http://localhost:4000` |
| frontend | `http://localhost:3000` |
| OPA | `http://localhost:8181` |

### Kubernetes (in-cluster)

Replace `localhost:<port>` with `http://<service-name>.trialo-<env>.svc.cluster.local:<port>`.

---

## 16. Feature Flags

```
ENABLE_PHI_LOGGING=false         # Must be false in prod (HIPAA)
OCR_PROVIDER=tesseract           # tesseract | textract
ENABLE_AGENT_MARKETPLACE=true
ENABLE_UI_AGENT_BUILDER=true
```

---

## Secret Management

### Development
Store all credentials in a local `.env` file (never commit to Git — `.env` is in `.gitignore`).

### Staging / Production
Use one of:
- **Kubernetes Sealed Secrets** — encrypt with `kubeseal`, commit the sealed secret, Helm reads from `trialo-secrets` K8s Secret
- **External Secrets Operator** — sync from AWS Secrets Manager / GCP Secret Manager / HashiCorp Vault
- **HashiCorp Vault** — inject secrets as env vars via Vault Agent sidecar

All secrets are mounted into pods via the `trialo-secrets` Kubernetes Secret object, referenced in `infrastructure/helm/trialo-core/templates/secret.yaml`.

### Generating secure credentials

```bash
# 256-bit random hex (for JWT_SECRET, FIELD_ENCRYPTION_KEY)
openssl rand -hex 32

# 32-character alphanumeric password
openssl rand -base64 24 | tr -d '/+=' | cut -c1-32

# UUID
python3 -c "import uuid; print(uuid.uuid4())"
```

---

## Checklist: New Environment Setup

- [ ] Generate fresh credentials for all databases (do not reuse across environments)
- [ ] Create PostgreSQL user and database, run migrations (`infrastructure/scripts/migrate.sh`)
- [ ] Create MongoDB user and database
- [ ] Set Neo4j password (default `neo4j` must be changed on first login)
- [ ] Create MinIO access key and buckets (`infrastructure/scripts/seed-minio-buckets.sh`)
- [ ] Create Kafka topics (`infrastructure/scripts/seed-kafka-topics.sh`)
- [ ] Create Auth0 application for the environment
- [ ] Store all secrets in secrets manager and create K8s `trialo-secrets` Secret
- [ ] Set `ENABLE_PHI_LOGGING=false` in all non-local environments
- [ ] Use `sk_test_` Stripe keys in dev/staging; `sk_live_` only in production
- [ ] Rotate all dev/staging credentials before go-live
