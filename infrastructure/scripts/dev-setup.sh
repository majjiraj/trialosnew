#!/usr/bin/env bash
# TrialOS — Developer Setup Script
# Checks prerequisites, starts docker-compose, runs DB migrations,
# seeds MinIO buckets, and prints service URLs.
set -euo pipefail

##############################################################################
# Configuration
##############################################################################
TRIALO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${TRIALO_ROOT}/docker-compose.dev.yml"
SCRIPTS_DIR="${TRIALO_ROOT}/infrastructure/scripts"

# Database settings
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-trialo}"
PGPASSWORD="${PGPASSWORD:-changeme}"
PGDATABASE="${PGDATABASE:-trialo}"

# MinIO settings
MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://localhost:9000}"
MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-admin}"
MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-changeme}"

export PGPASSWORD MINIO_ENDPOINT MINIO_ACCESS_KEY MINIO_SECRET_KEY

##############################################################################
# Color output
##############################################################################
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

log()     { echo -e "${CYAN}[$(date -u '+%H:%M:%S')]${NC} $*"; }
success() { echo -e "${GREEN}[$(date -u '+%H:%M:%S')] ✓${NC} $*"; }
warn()    { echo -e "${YELLOW}[$(date -u '+%H:%M:%S')] ⚠${NC} $*" >&2; }
err()     { echo -e "${RED}[$(date -u '+%H:%M:%S')] ✗${NC} $*" >&2; }
header()  { echo -e "\n${BOLD}${CYAN}=== $* ===${NC}\n"; }

##############################################################################
# 1. Check prerequisites
##############################################################################
check_prerequisites() {
  header "Checking prerequisites"

  local missing=0

  check_tool() {
    local tool="$1"
    local install_hint="$2"
    if command -v "${tool}" &>/dev/null; then
      success "${tool} found ($(${tool} --version 2>&1 | head -1))"
    else
      err "${tool} not found. ${install_hint}"
      missing=$(( missing + 1 ))
    fi
  }

  check_tool docker "Install from https://docs.docker.com/get-docker/"
  check_tool kubectl "Install from https://kubernetes.io/docs/tasks/tools/"
  check_tool helm   "Install from https://helm.sh/docs/intro/install/"

  # Check docker-compose (may be 'docker compose' or 'docker-compose')
  if command -v "docker" &>/dev/null && docker compose version &>/dev/null 2>&1; then
    success "docker compose (plugin) found"
    DOCKER_COMPOSE="docker compose"
  elif command -v docker-compose &>/dev/null; then
    success "docker-compose found"
    DOCKER_COMPOSE="docker-compose"
  else
    err "docker compose / docker-compose not found."
    missing=$(( missing + 1 ))
  fi

  # Optional but recommended
  if command -v mc &>/dev/null; then
    success "mc (MinIO Client) found"
  else
    warn "mc (MinIO Client) not found — bucket seeding will be skipped."
    warn "Install from: https://min.io/docs/minio/linux/reference/minio-mc.html"
  fi

  if command -v pg_isready &>/dev/null; then
    success "pg_isready found"
  else
    warn "pg_isready not found — DB wait loop will use a simple TCP check."
    warn "Install postgresql-client for full support."
  fi

  if [[ "${missing}" -gt 0 ]]; then
    err "${missing} required tool(s) missing. Please install them and retry."
    exit 1
  fi

  success "All required prerequisites satisfied."
}

##############################################################################
# 2. Validate docker-compose file exists
##############################################################################
check_compose_file() {
  if [[ ! -f "${COMPOSE_FILE}" ]]; then
    err "docker-compose.dev.yml not found at: ${COMPOSE_FILE}"
    err "Expected location: ${TRIALO_ROOT}/docker-compose.dev.yml"
    exit 1
  fi
  success "Found docker-compose.dev.yml"
}

##############################################################################
# 3. Start docker-compose
##############################################################################
start_compose() {
  header "Starting Docker Compose services"

  log "Running: ${DOCKER_COMPOSE} -f ${COMPOSE_FILE} up -d"
  ${DOCKER_COMPOSE} -f "${COMPOSE_FILE}" up -d

  success "Docker Compose services started."
}

##############################################################################
# 4. Wait for PostgreSQL to be ready
##############################################################################
wait_for_postgres() {
  header "Waiting for PostgreSQL"

  local max_attempts=60
  local attempt=0
  local wait_seconds=2

  log "Waiting for PostgreSQL at ${PGHOST}:${PGPORT}..."

  if command -v pg_isready &>/dev/null; then
    until pg_isready \
      --host="${PGHOST}" \
      --port="${PGPORT}" \
      --username="${PGUSER}" \
      --quiet 2>/dev/null; do
      attempt=$(( attempt + 1 ))
      if [[ "${attempt}" -ge "${max_attempts}" ]]; then
        err "PostgreSQL did not become ready. Check docker-compose logs."
        ${DOCKER_COMPOSE} -f "${COMPOSE_FILE}" logs postgres 2>/dev/null | tail -20 || true
        exit 1
      fi
      log "Not ready yet (attempt ${attempt}/${max_attempts})..."
      sleep "${wait_seconds}"
    done
  else
    # Fallback: simple TCP check via /dev/tcp
    until (echo >/dev/tcp/"${PGHOST}"/"${PGPORT}") 2>/dev/null; do
      attempt=$(( attempt + 1 ))
      if [[ "${attempt}" -ge "${max_attempts}" ]]; then
        err "PostgreSQL TCP port not open. Check docker-compose logs."
        exit 1
      fi
      log "TCP not open yet (attempt ${attempt}/${max_attempts})..."
      sleep "${wait_seconds}"
    done
    # Extra wait for PostgreSQL to finish initialization
    sleep 3
  fi

  success "PostgreSQL is ready."
}

##############################################################################
# 5. Run database migrations
##############################################################################
run_migrations() {
  header "Running database migrations"

  local migrate_script="${SCRIPTS_DIR}/migrate.sh"

  if [[ ! -f "${migrate_script}" ]]; then
    warn "migrate.sh not found at ${migrate_script}. Skipping migrations."
    return 0
  fi

  chmod +x "${migrate_script}"
  PGHOST="${PGHOST}" \
  PGPORT="${PGPORT}" \
  PGUSER="${PGUSER}" \
  PGPASSWORD="${PGPASSWORD}" \
  PGDATABASE="${PGDATABASE}" \
  bash "${migrate_script}"

  success "Database migrations complete."
}

##############################################################################
# 6. Create MinIO buckets
##############################################################################
seed_minio_buckets() {
  header "Seeding MinIO buckets"

  if ! command -v mc &>/dev/null; then
    warn "mc not found — skipping MinIO bucket seeding."
    return 0
  fi

  local seed_script="${SCRIPTS_DIR}/seed-minio-buckets.sh"

  if [[ ! -f "${seed_script}" ]]; then
    warn "seed-minio-buckets.sh not found. Skipping."
    return 0
  fi

  chmod +x "${seed_script}"
  MINIO_ENDPOINT="${MINIO_ENDPOINT}" \
  MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY}" \
  MINIO_SECRET_KEY="${MINIO_SECRET_KEY}" \
  bash "${seed_script}"

  success "MinIO buckets seeded."
}

##############################################################################
# 7. Print service URLs
##############################################################################
print_service_urls() {
  header "TrialOS Service URLs"

  echo -e "${BOLD}Frontend:${NC}"
  echo -e "  http://localhost:3000"
  echo ""
  echo -e "${BOLD}API Gateway (Kong):${NC}"
  echo -e "  http://localhost:8000  (proxy)"
  echo -e "  http://localhost:8002  (admin API)"
  echo ""
  echo -e "${BOLD}GraphQL API:${NC}"
  echo -e "  http://localhost:4000/api/graphql"
  echo -e "  http://localhost:4000/api/graphql (Apollo Sandbox in dev)"
  echo ""
  echo -e "${BOLD}Microservices:${NC}"
  echo -e "  auth-service         → http://localhost:8001"
  echo -e "  audit-service        → http://localhost:8002"
  echo -e "  ingestion-service    → http://localhost:8003"
  echo -e "  agent-runtime        → http://localhost:8004"
  echo -e "  marketplace          → http://localhost:8005"
  echo -e "  notification-service → http://localhost:8006"
  echo -e "  data-platform        → http://localhost:8007"
  echo ""
  echo -e "${BOLD}Infrastructure:${NC}"
  echo -e "  PostgreSQL  → localhost:5432 (db: ${PGDATABASE}, user: ${PGUSER})"
  echo -e "  Redis       → localhost:6379"
  echo -e "  MinIO       → ${MINIO_ENDPOINT}  (console: http://localhost:9001)"
  echo -e "  Kafka       → localhost:9092"
  echo -e "  OPA         → http://localhost:8181"
  echo ""
  echo -e "${BOLD}MinIO Console:${NC}"
  echo -e "  http://localhost:9001"
  echo -e "  Username: ${MINIO_ACCESS_KEY}"
  echo -e "  Password: ${MINIO_SECRET_KEY}"
  echo ""
}

##############################################################################
# Cleanup / teardown helper (not part of default flow)
##############################################################################
teardown() {
  header "Tearing down Docker Compose environment"
  ${DOCKER_COMPOSE} -f "${COMPOSE_FILE}" down --volumes --remove-orphans
  success "Environment stopped and volumes removed."
}

##############################################################################
# Usage
##############################################################################
usage() {
  echo "Usage: $0 [--teardown]"
  echo ""
  echo "  (no args)   Start and initialize the dev environment"
  echo "  --teardown  Stop docker-compose and remove volumes"
  echo ""
}

##############################################################################
# Main
##############################################################################
main() {
  echo -e "${BOLD}${CYAN}"
  echo "  ████████╗██████╗ ██╗ █████╗ ██╗      ██████╗ ███████╗"
  echo "     ██╔══╝██╔══██╗██║██╔══██╗██║     ██╔═══██╗██╔════╝"
  echo "     ██║   ██████╔╝██║███████║██║     ██║   ██║███████╗"
  echo "     ██║   ██╔══██╗██║██╔══██║██║     ██║   ██║╚════██║"
  echo "     ██║   ██║  ██║██║██║  ██║███████╗╚██████╔╝███████║"
  echo "     ╚═╝   ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚══════╝"
  echo -e "${NC}"
  echo -e "${BOLD}  TrialOS Clinical Trials Platform — Developer Setup${NC}"
  echo "  $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  echo ""

  if [[ "${1:-}" == "--teardown" ]]; then
    teardown
    return 0
  fi

  if [[ "${1:-}" == "--help" ]] || [[ "${1:-}" == "-h" ]]; then
    usage
    return 0
  fi

  check_prerequisites
  check_compose_file
  start_compose
  wait_for_postgres
  run_migrations
  seed_minio_buckets
  print_service_urls

  success "TrialOS development environment is ready!"
}

main "$@"
