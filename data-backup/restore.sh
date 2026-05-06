#!/usr/bin/env bash
# TrialOS — Data Restore Script
# Restores PostgreSQL, MongoDB, Neo4j, and MinIO data from this backup directory.
# Run AFTER docker-compose is up and healthy.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/../docker-compose.dev.yml"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()     { echo -e "${CYAN}[$(date -u '+%H:%M:%S')]${NC} $*"; }
success() { echo -e "${GREEN}[$(date -u '+%H:%M:%S')] ✓${NC} $*"; }
warn()    { echo -e "${YELLOW}[$(date -u '+%H:%M:%S')] ⚠${NC} $*" >&2; }
err()     { echo -e "${RED}[$(date -u '+%H:%M:%S')] ✗${NC} $*" >&2; exit 1; }

wait_for_container() {
  local name="$1"
  local max=30
  for i in $(seq 1 $max); do
    if docker ps --format '{{.Names}}' | grep -q "^${name}$"; then
      return 0
    fi
    log "Waiting for container ${name} (${i}/${max})..."
    sleep 3
  done
  err "Container ${name} did not start in time."
}

# ─── 1. PostgreSQL ────────────────────────────────────────────────────────────
restore_postgres() {
  log "Restoring PostgreSQL..."
  local dump="${SCRIPT_DIR}/postgres/trialo_full_dump.dump"
  [[ -f "$dump" ]] || err "Dump not found: $dump"

  wait_for_container trialo-postgres-1

  # Wait for postgres to accept connections
  local max=30
  for i in $(seq 1 $max); do
    if docker exec trialo-postgres-1 sh -c "PGPASSWORD=trialo_dev pg_isready -U trialo -d trialo -q" 2>/dev/null; then
      break
    fi
    log "Waiting for PostgreSQL to be ready (${i}/${max})..."
    sleep 3
    [[ $i -eq $max ]] && err "PostgreSQL not ready"
  done

  log "Loading PostgreSQL dump (this may take a few minutes for large datasets)..."
  # Copy dump into container then restore with pg_restore (custom format = compressed)
  docker cp "$dump" trialo-postgres-1:/tmp/trialo_full_dump.dump
  docker exec trialo-postgres-1 sh -c \
    "PGPASSWORD=trialo_dev pg_restore -U trialo -d trialo --clean --if-exists --no-privileges -v /tmp/trialo_full_dump.dump && rm /tmp/trialo_full_dump.dump"
  success "PostgreSQL restored."
}

# ─── 2. MongoDB ──────────────────────────────────────────────────────────────
restore_mongodb() {
  log "Restoring MongoDB..."
  local archive="${SCRIPT_DIR}/mongodb/trialo_dump.archive.gz"
  [[ -f "$archive" ]] || err "Dump not found: $archive"

  wait_for_container trialo-mongodb-1

  docker exec -i trialo-mongodb-1 sh -c \
    "mongorestore --username trialo --password trialopass --authenticationDatabase admin --nsInclude='trialo.*' --drop --archive --gzip" \
    < "$archive"
  success "MongoDB restored."
}

# ─── 3. Neo4j ────────────────────────────────────────────────────────────────
restore_neo4j() {
  local nodes="${SCRIPT_DIR}/neo4j/nodes_raw.txt"
  local rels="${SCRIPT_DIR}/neo4j/relationships_raw.txt"

  if [[ ! -f "$nodes" ]]; then
    warn "Neo4j backup not found — skipping (graph will rebuild from agent runs)."
    return 0
  fi

  log "Neo4j backup exists (${nodes}) — Note: Neo4j data is rebuilt automatically"
  log "by the agent-runtime and context-graph services as agent runs are processed."
  warn "Manual Neo4j restore requires APOC plugin. Skipping raw import."
  log "Neo4j will be populated when you re-run agents or re-process documents."
}

# ─── 4. MinIO Documents ──────────────────────────────────────────────────────
restore_minio() {
  local src="${SCRIPT_DIR}/minio/documents"
  if [[ ! -d "$src" ]]; then
    warn "MinIO backup directory not found at ${src} — skipping."
    return 0
  fi

  wait_for_container trialo-minio-1

  # Wait for MinIO to be healthy
  local max=20
  for i in $(seq 1 $max); do
    if docker exec trialo-minio-1 sh -c "mc alias set local http://localhost:9000 trialo trialo_dev_secret > /dev/null 2>&1 && mc ls local/ > /dev/null 2>&1"; then
      break
    fi
    log "Waiting for MinIO (${i}/${max})..."
    sleep 3
    [[ $i -eq $max ]] && err "MinIO not ready"
  done

  log "Uploading documents to MinIO trialo-documents bucket..."
  # Copy backed up files into container then upload
  docker cp "$src/." trialo-minio-1:/tmp/restore-docs/
  docker exec trialo-minio-1 sh -c \
    "mc alias set local http://localhost:9000 trialo trialo_dev_secret > /dev/null 2>&1 && mc cp --recursive /tmp/restore-docs/ local/trialo-documents/ && rm -rf /tmp/restore-docs"
  success "MinIO documents restored."
}

# ─── Main ────────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo "  TrialOS Data Restore"
  echo "  ===================="
  echo ""

  if [[ "${1:-}" == "--help" ]]; then
    echo "Usage: $0 [--postgres-only | --mongodb-only | --minio-only]"
    echo ""
    echo "  (no args)        Restore all databases"
    echo "  --postgres-only  Restore PostgreSQL only"
    echo "  --mongodb-only   Restore MongoDB only"
    echo "  --minio-only     Restore MinIO documents only"
    exit 0
  fi

  case "${1:-all}" in
    --postgres-only) restore_postgres ;;
    --mongodb-only)  restore_mongodb ;;
    --minio-only)    restore_minio ;;
    all)
      restore_postgres
      restore_mongodb
      restore_neo4j
      restore_minio
      ;;
  esac

  echo ""
  success "Data restore complete!"
  echo ""
  echo "  Next: open http://localhost:3000"
  echo ""
}

main "$@"
