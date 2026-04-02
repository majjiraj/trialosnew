#!/usr/bin/env bash
# TrialOS Database Migration Script
# Waits for PostgreSQL, runs init-db.sql, then applies numbered migration files.
set -euo pipefail

##############################################################################
# Configuration — override via environment variables
##############################################################################
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-trialo}"
PGPASSWORD="${PGPASSWORD:-changeme}"
PGDATABASE="${PGDATABASE:-trialo}"

EMBEDDING_DIM="${EMBEDDING_DIM:-1536}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INIT_SQL="${SCRIPT_DIR}/init-db.sql"
MIGRATIONS_DIR="${SCRIPT_DIR}/migrations"
MIGRATIONS_TABLE="schema_migrations"

export PGPASSWORD

##############################################################################
# Helpers
##############################################################################
log()  { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [INFO]  $*"; }
warn() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [WARN]  $*" >&2; }
err()  { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [ERROR] $*" >&2; }

psql_exec() {
  psql \
    --host="${PGHOST}" \
    --port="${PGPORT}" \
    --username="${PGUSER}" \
    --dbname="${PGDATABASE}" \
    --no-password \
    "$@"
}

##############################################################################
# 1. Wait for PostgreSQL to be ready
##############################################################################
wait_for_postgres() {
  local max_attempts=60
  local attempt=0
  local wait_seconds=2

  log "Waiting for PostgreSQL at ${PGHOST}:${PGPORT}..."

  until pg_isready \
    --host="${PGHOST}" \
    --port="${PGPORT}" \
    --username="${PGUSER}" \
    --quiet; do
    attempt=$(( attempt + 1 ))
    if [[ "${attempt}" -ge "${max_attempts}" ]]; then
      err "PostgreSQL did not become ready after $((max_attempts * wait_seconds)) seconds. Aborting."
      exit 1
    fi
    log "PostgreSQL not ready yet (attempt ${attempt}/${max_attempts}). Retrying in ${wait_seconds}s..."
    sleep "${wait_seconds}"
  done

  log "PostgreSQL is ready."
}

##############################################################################
# 2. Ensure the migrations tracking table exists
##############################################################################
ensure_migrations_table() {
  log "Ensuring schema_migrations table exists..."
  psql_exec --command="
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id          SERIAL PRIMARY KEY,
      version     TEXT NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum    TEXT NOT NULL
    );
  "
}

##############################################################################
# 3. Run init-db.sql if it hasn't been applied yet
##############################################################################
run_init_sql() {
  local init_marker="000_init_db"

  if psql_exec --tuples-only --command="
    SELECT 1 FROM ${MIGRATIONS_TABLE} WHERE version = '${init_marker}';
  " | grep -q 1; then
    log "Init SQL already applied — skipping."
    return 0
  fi

  if [[ ! -f "${INIT_SQL}" ]]; then
    warn "init-db.sql not found at ${INIT_SQL}. Skipping init phase."
    return 0
  fi

  log "Applying init-db.sql..."
  local checksum
  checksum="$(sha256sum "${INIT_SQL}" | awk '{print $1}')"

  psql_exec --file="${INIT_SQL}"

  psql_exec --command="
    INSERT INTO ${MIGRATIONS_TABLE} (version, checksum)
    VALUES ('${init_marker}', '${checksum}')
    ON CONFLICT (version) DO NOTHING;
  "
  log "init-db.sql applied successfully (checksum: ${checksum})."
}

##############################################################################
# 4. Run numbered migration files in order
##############################################################################
run_migrations() {
  if [[ ! -d "${MIGRATIONS_DIR}" ]]; then
    log "No migrations directory found at ${MIGRATIONS_DIR}. Skipping."
    return 0
  fi

  local migration_files
  # Find all .sql files and sort them numerically
  mapfile -t migration_files < <(
    find "${MIGRATIONS_DIR}" -maxdepth 1 -name '*.sql' | sort
  )

  if [[ "${#migration_files[@]}" -eq 0 ]]; then
    log "No migration files found in ${MIGRATIONS_DIR}."
    return 0
  fi

  log "Found ${#migration_files[@]} migration file(s) to evaluate."

  for migration_file in "${migration_files[@]}"; do
    local filename
    filename="$(basename "${migration_file}")"
    # Extract the version prefix (e.g., "001" from "001_initial_schema.sql")
    local version="${filename%.sql}"

    # Check if already applied
    if psql_exec --tuples-only --command="
      SELECT 1 FROM ${MIGRATIONS_TABLE} WHERE version = '${version}';
    " | grep -q 1; then
      log "Migration '${version}' already applied — skipping."
      continue
    fi

    log "Applying migration: ${filename}..."
    local checksum
    checksum="$(sha256sum "${migration_file}" | awk '{print $1}')"

    # Run the migration in a transaction
    psql_exec --single-transaction -v "embedding_dim=${EMBEDDING_DIM}" --file="${migration_file}"

    # Record the migration
    psql_exec --command="
      INSERT INTO ${MIGRATIONS_TABLE} (version, checksum)
      VALUES ('${version}', '${checksum}');
    "

    log "Migration '${version}' applied successfully (checksum: ${checksum})."
  done

  log "All migrations complete."
}

##############################################################################
# 5. Print migration status
##############################################################################
print_status() {
  log "Current migration state:"
  psql_exec --command="
    SELECT version, applied_at, checksum
    FROM ${MIGRATIONS_TABLE}
    ORDER BY applied_at;
  "
}

##############################################################################
# Main
##############################################################################
main() {
  log "TrialOS database migration starting..."
  log "Target: ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"

  wait_for_postgres
  ensure_migrations_table
  run_init_sql
  run_migrations
  print_status

  log "Database migration complete."
}

main "$@"
