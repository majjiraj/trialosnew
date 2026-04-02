# TrialOS Infrastructure

Kubernetes/Helm infrastructure for the TrialOS clinical trials platform. This directory contains everything required to deploy TrialOS to a Kubernetes cluster using GitOps (ArgoCD) or directly with Helm.

---

## Directory Structure

```
infrastructure/
├── helm/
│   └── trialo-core/          # Main Helm chart
│       ├── Chart.yaml
│       ├── values.yaml       # Default values
│       ├── values-dev.yaml   # Dev overrides
│       ├── values-prod.yaml  # Production overrides
│       └── templates/
│           ├── _helpers.tpl
│           ├── serviceaccount.yaml
│           ├── secret.yaml
│           ├── configmap.yaml
│           ├── services.yaml       # All 9 service deployments
│           ├── ingress.yaml
│           ├── hpa.yaml
│           ├── networkpolicy.yaml
│           ├── opa-deployment.yaml
│           └── opa-configmap.yaml
├── kafka/
│   ├── strimzi-kafka.yaml    # Strimzi Kafka cluster CR
│   └── topics.yaml           # KafkaTopic CRs
├── argocd/
│   ├── application.yaml      # ArgoCD Application
│   └── project.yaml          # ArgoCD AppProject
├── k8s/
│   ├── base/                 # Base Kustomize layer
│   │   ├── namespace.yaml
│   │   └── kustomization.yaml
│   └── overlays/
│       ├── dev/              # Dev environment overlay
│       │   ├── kustomization.yaml
│       │   └── patches.yaml
│       └── prod/             # Production overlay
│           ├── kustomization.yaml
│           └── patches.yaml
├── kong/
│   └── kong.yaml             # Kong declarative config (deck format)
└── scripts/
    ├── migrate.sh             # Database migration runner
    ├── seed-kafka-topics.sh   # Kafka topic creation
    ├── seed-minio-buckets.sh  # MinIO bucket creation
    ├── dev-setup.sh           # All-in-one dev environment setup
    ├── init-db.sql            # PostgreSQL schema (initial)
    └── migrations/
        └── 001_initial_schema.sql
```

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Docker | 24+ | https://docs.docker.com/get-docker/ |
| kubectl | 1.28+ | https://kubernetes.io/docs/tasks/tools/ |
| Helm | 3.14+ | https://helm.sh/docs/intro/install/ |
| ArgoCD CLI | 2.10+ | https://argo-cd.readthedocs.io/en/stable/cli_installation/ |
| mc (MinIO Client) | latest | https://min.io/docs/minio/linux/reference/minio-mc.html |
| deck (Kong) | 1.39+ | https://docs.konghq.com/deck/latest/installation/ |
| Strimzi Operator | 0.40+ | https://strimzi.io/docs/operators/latest/deploying.html |
| kustomize | 5.3+ | https://kubectl.docs.kubernetes.io/installation/kustomize/ |

---

## Local Development (Docker Compose)

The fastest way to get a full TrialOS environment running locally:

```bash
# One-command setup: starts all services, runs migrations, seeds MinIO
bash infrastructure/scripts/dev-setup.sh

# Tear down (removes volumes)
bash infrastructure/scripts/dev-setup.sh --teardown
```

The script will:
1. Check prerequisites
2. Start `docker-compose.dev.yml`
3. Wait for PostgreSQL to be ready
4. Run database migrations
5. Create MinIO buckets
6. Print service URLs

### Manual docker-compose steps

```bash
# Start all services
docker compose -f docker-compose.dev.yml up -d

# Run migrations manually
PGHOST=localhost PGPORT=5432 PGUSER=trialo PGPASSWORD=changeme PGDATABASE=trialo \
  bash infrastructure/scripts/migrate.sh

# Seed MinIO buckets
MINIO_ENDPOINT=http://localhost:9000 MINIO_ACCESS_KEY=admin MINIO_SECRET_KEY=changeme \
  bash infrastructure/scripts/seed-minio-buckets.sh
```

---

## Kubernetes Deployment

### 1. Add Helm repositories

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
```

### 2. Install Helm chart dependencies

```bash
cd infrastructure/helm/trialo-core
helm dependency update
```

### 3. Create the namespace

```bash
kubectl apply -f infrastructure/k8s/base/namespace.yaml
```

### 4. Create prerequisite secrets

The Helm chart references two external secrets that must be created before install:

```bash
# Database password secret
kubectl create secret generic trialo-db-secret \
  --namespace trialo \
  --from-literal=postgres-password='<POSTGRES_ADMIN_PASSWORD>' \
  --from-literal=password='<TRIALO_USER_PASSWORD>'

# In production, use sealed-secrets or Vault instead:
# kubeseal --format yaml < trialo-db-secret.yaml > trialo-db-secret-sealed.yaml
```

### 5. Install the Helm chart

#### Development

```bash
helm install trialo-core infrastructure/helm/trialo-core \
  --namespace trialo \
  --create-namespace \
  -f infrastructure/helm/trialo-core/values.yaml \
  -f infrastructure/helm/trialo-core/values-dev.yaml \
  --set secrets.DATABASE_URL="postgresql://trialo:changeme@trialo-core-postgresql:5432/trialo" \
  --set secrets.ANTHROPIC_API_KEY="sk-ant-..." \
  --set secrets.JWT_SECRET="$(openssl rand -hex 32)"
```

#### Production

```bash
# Secrets should be provided via sealed-secrets or external-secrets-operator.
# Pass any remaining overrides as --set arguments or in a local values-secret.yaml
# that is NOT committed to git.

helm install trialo-core infrastructure/helm/trialo-core \
  --namespace trialo \
  --create-namespace \
  -f infrastructure/helm/trialo-core/values.yaml \
  -f infrastructure/helm/trialo-core/values-prod.yaml \
  --set secrets.DATABASE_URL="${DATABASE_URL}" \
  --set secrets.ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  --set secrets.JWT_SECRET="${JWT_SECRET}" \
  --set secrets.STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY}" \
  --set secrets.SENDGRID_API_KEY="${SENDGRID_API_KEY}"
```

### 6. Upgrade an existing release

```bash
helm upgrade trialo-core infrastructure/helm/trialo-core \
  --namespace trialo \
  -f infrastructure/helm/trialo-core/values.yaml \
  -f infrastructure/helm/trialo-core/values-prod.yaml
```

### 7. Kustomize overlays

```bash
# Dev
kubectl apply -k infrastructure/k8s/overlays/dev

# Production
kubectl apply -k infrastructure/k8s/overlays/prod
```

---

## Kafka Topic Setup

### Using Strimzi operator (Kubernetes)

```bash
# Install Strimzi operator first
kubectl create namespace kafka
kubectl apply -f https://strimzi.io/install/latest?namespace=kafka -n kafka

# Wait for operator to be ready
kubectl wait --for=condition=Ready pod -l strimzi.io/kind=Kafka -n kafka --timeout=120s

# Create the Kafka cluster
kubectl apply -f infrastructure/kafka/strimzi-kafka.yaml -n trialo

# Wait for cluster
kubectl wait kafka/trialo-kafka --for=condition=Ready --timeout=300s -n trialo

# Create topics
kubectl apply -f infrastructure/kafka/topics.yaml -n trialo
```

### Using the seed script (non-Kubernetes / local)

```bash
KAFKA_BOOTSTRAP_SERVERS=localhost:9092 REPLICATION_FACTOR=1 \
  bash infrastructure/scripts/seed-kafka-topics.sh
```

### Verify topics

```bash
# Via kubectl (Strimzi)
kubectl get kafkatopics -n trialo

# Via kafka-topics.sh
kafka-topics.sh --bootstrap-server localhost:9092 --list
```

---

## Database Migration

Migrations are tracked in the `schema_migrations` table. They are idempotent and safe to re-run.

```bash
# Run all pending migrations
PGHOST=localhost \
PGPORT=5432 \
PGUSER=trialo \
PGPASSWORD=changeme \
PGDATABASE=trialo \
  bash infrastructure/scripts/migrate.sh
```

### Adding a new migration

1. Create a numbered SQL file: `infrastructure/scripts/migrations/002_add_feature.sql`
2. Write idempotent SQL (use `IF NOT EXISTS`, `IF EXISTS` guards)
3. Commit and run `migrate.sh` — it will detect and apply only the new file

### Running migrations in Kubernetes

Use a Kubernetes Job:

```bash
kubectl run trialo-migrate \
  --image=trialo/migrate:1.0.0 \
  --restart=Never \
  --namespace=trialo \
  --env="PGHOST=trialo-core-postgresql" \
  --env="PGPORT=5432" \
  --env="PGUSER=trialo" \
  --env="PGDATABASE=trialo" \
  --command -- bash /app/infrastructure/scripts/migrate.sh
```

---

## ArgoCD Setup

### 1. Install ArgoCD

```bash
kubectl create namespace argocd
kubectl apply -n argocd \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

kubectl wait --for=condition=Ready pod -l app.kubernetes.io/name=argocd-server \
  -n argocd --timeout=120s
```

### 2. Log in to ArgoCD

```bash
# Get initial admin password
argocd admin initial-password -n argocd

# Port-forward and log in
kubectl port-forward svc/argocd-server -n argocd 8080:443 &
argocd login localhost:8080 --username admin --password <password>
```

### 3. Create the AppProject and Application

```bash
# Create the project first
kubectl apply -f infrastructure/argocd/project.yaml

# Register the Git repository
argocd repo add https://github.com/your-org/trialo \
  --type git \
  --ssh-private-key-path ~/.ssh/id_rsa

# Create the application
kubectl apply -f infrastructure/argocd/application.yaml

# Trigger initial sync
argocd app sync trialo-core
```

### 4. Monitor deployments

```bash
# CLI
argocd app get trialo-core
argocd app history trialo-core

# kubectl
kubectl get applications -n argocd
```

---

## Kong API Gateway

### Apply declarative config

```bash
# Validate config
deck validate --state infrastructure/kong/kong.yaml

# Diff against running Kong
deck diff --state infrastructure/kong/kong.yaml --kong-addr http://localhost:8001

# Apply config
deck sync --state infrastructure/kong/kong.yaml --kong-addr http://localhost:8001
```

### Verify routes

```bash
# List all services
curl -s http://localhost:8001/services | jq '.data[].name'

# List all routes
curl -s http://localhost:8001/routes | jq '.data[] | {name: .name, paths: .paths}'

# Test rate limiting headers
curl -I http://localhost:8000/api/auth/health
```

---

## OPA Policy

The OPA policy is embedded in the `opa-policies` ConfigMap and loaded by the OPA server at startup. To update policies:

1. Edit `/packages/opa-policies/trialo/authz/policy.rego`
2. Run `helm upgrade trialo-core ...` — the ConfigMap checksum annotation triggers a pod restart

### Test a policy locally

```bash
# Install OPA CLI
brew install opa  # macOS

# Evaluate a policy
opa eval \
  --input - \
  --data packages/opa-policies/trialo/authz/policy.rego \
  'data.trialo.authz.allow' <<'EOF'
{
  "actor_type": "user",
  "org_id": "org-123",
  "action": "study:data:read",
  "context": {
    "roles": ["cro_data_manager"],
    "required_scope": "study:data:read",
    "is_blinded_data": false,
    "permitted_study_ids": ["study-456"]
  },
  "resource": {
    "type": "study:data",
    "org_id": "org-123",
    "study_id": "study-456"
  }
}
EOF
```

---

## Secrets Management

### Development

Secrets are stored in `values-dev.yaml` with placeholder values. For local development, override via `--set` flags or a local `.env` file that is not committed to git.

### Production

Use one of the following approaches:

**Option 1: Sealed Secrets (recommended for GitOps)**

```bash
# Install sealed-secrets controller
helm install sealed-secrets \
  https://bitnami-labs.github.io/sealed-secrets/helm/sealed-secrets \
  --namespace kube-system

# Seal a secret
kubectl create secret generic trialo-secrets \
  --dry-run=client \
  --from-literal=ANTHROPIC_API_KEY="sk-ant-..." \
  -o yaml | kubeseal --format yaml > trialo-secrets-sealed.yaml
```

**Option 2: External Secrets Operator (for Vault / AWS Secrets Manager)**

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: trialo-secrets
  namespace: trialo
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: trialo-secrets
  data:
    - secretKey: ANTHROPIC_API_KEY
      remoteRef:
        key: trialo/prod
        property: anthropic_api_key
```

---

## Monitoring and Observability

- **Prometheus metrics**: Kong's `prometheus` plugin exposes metrics at `/metrics`
- **Logs**: All services write structured JSON logs; collect with Fluentd or Vector
- **Traces**: Add OpenTelemetry sidecar or use FastAPI's OTEL middleware
- **Health checks**: All services expose `/health` on their respective ports

---

## Troubleshooting

### Service not starting

```bash
kubectl logs -n trialo deployment/<service-name> --previous
kubectl describe pod -n trialo -l app.kubernetes.io/name=<service-name>
```

### Database connection issues

```bash
# Check PostgreSQL is running
kubectl get pod -n trialo -l app.kubernetes.io/name=postgresql

# Exec into a service pod and test connectivity
kubectl exec -it -n trialo deployment/auth-service -- \
  python -c "import psycopg2; psycopg2.connect('$DATABASE_URL'); print('OK')"
```

### Kafka not receiving messages

```bash
# Check Strimzi cluster status
kubectl get kafka -n trialo
kubectl describe kafka trialo-kafka -n trialo

# Check topic list
kubectl get kafkatopics -n trialo

# Consume from a topic for debugging
kubectl run kafka-consumer \
  --image=bitnami/kafka:3.7 \
  --restart=Never \
  -n trialo \
  --command -- \
  kafka-console-consumer.sh \
    --bootstrap-server trialo-kafka-kafka-bootstrap:9092 \
    --topic trialo.events.system \
    --from-beginning \
    --max-messages 10
```

### OPA policy issues

```bash
# Check OPA pod logs
kubectl logs -n trialo deployment/trialo-opa

# Query OPA health
kubectl port-forward -n trialo svc/trialo-opa 8181:8181 &
curl http://localhost:8181/health
curl http://localhost:8181/v1/policies
```

---

## Security Notes

- All pods run as non-root (UID 1000) with `readOnlyRootFilesystem: true`
- Pod Security Standards are set to `restricted` on the `trialo` namespace
- NetworkPolicies enforce default-deny with explicit allow rules
- Agent-runtime egress is restricted — only intra-namespace + DNS + HTTPS:443
- Secrets are never logged; use `helm diff` before upgrades to review changes
- Rotate JWT_SECRET, S3 credentials, and API keys quarterly at minimum
