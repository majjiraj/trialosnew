#!/usr/bin/env bash
# TrialOS — Kafka Topic Seeder
# Creates all required Kafka topics if they don't already exist.
# Uses kafka-topics.sh from the Kafka distribution on the PATH or KAFKA_HOME.
set -euo pipefail

##############################################################################
# Configuration — override via environment variables
##############################################################################
KAFKA_BOOTSTRAP_SERVERS="${KAFKA_BOOTSTRAP_SERVERS:-localhost:9092}"
KAFKA_HOME="${KAFKA_HOME:-/opt/kafka}"
REPLICATION_FACTOR="${REPLICATION_FACTOR:-3}"

# Derive kafka-topics.sh binary path
KAFKA_TOPICS_BIN="kafka-topics.sh"
if [[ -x "${KAFKA_HOME}/bin/kafka-topics.sh" ]]; then
  KAFKA_TOPICS_BIN="${KAFKA_HOME}/bin/kafka-topics.sh"
fi

##############################################################################
# Helpers
##############################################################################
log()  { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [INFO]  $*"; }
err()  { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [ERROR] $*" >&2; }

##############################################################################
# Topic definitions
# Format: "topic-name:partitions:retention-ms"
##############################################################################
declare -a TOPICS=(
  "trialo.events.data:12:604800000"
  "trialo.events.agents:6:2592000000"
  "trialo.events.study:6:2592000000"
  "trialo.events.system:3:604800000"
  "trialo.events.apps:6:2592000000"
  "trialo.events.workflows:6:2592000000"
  "trialo.events.forms:6:2592000000"
)

##############################################################################
# Wait for Kafka to be ready
##############################################################################
wait_for_kafka() {
  local max_attempts=30
  local attempt=0
  local wait_seconds=5

  log "Waiting for Kafka at ${KAFKA_BOOTSTRAP_SERVERS}..."

  until "${KAFKA_TOPICS_BIN}" \
    --bootstrap-server "${KAFKA_BOOTSTRAP_SERVERS}" \
    --list \
    &>/dev/null; do
    attempt=$(( attempt + 1 ))
    if [[ "${attempt}" -ge "${max_attempts}" ]]; then
      err "Kafka did not become ready after $((max_attempts * wait_seconds)) seconds. Aborting."
      exit 1
    fi
    log "Kafka not ready yet (attempt ${attempt}/${max_attempts}). Retrying in ${wait_seconds}s..."
    sleep "${wait_seconds}"
  done

  log "Kafka is ready."
}

##############################################################################
# Create a single topic
##############################################################################
create_topic() {
  local topic_name="$1"
  local partitions="$2"
  local retention_ms="$3"

  # Check if topic already exists
  if "${KAFKA_TOPICS_BIN}" \
    --bootstrap-server "${KAFKA_BOOTSTRAP_SERVERS}" \
    --list \
    2>/dev/null | grep -qx "${topic_name}"; then
    log "Topic '${topic_name}' already exists — skipping creation."

    # Update config if needed (idempotent)
    log "Verifying configuration for '${topic_name}'..."
    "${KAFKA_TOPICS_BIN}" \
      --bootstrap-server "${KAFKA_BOOTSTRAP_SERVERS}" \
      --alter \
      --topic "${topic_name}" \
      --config "retention.ms=${retention_ms}" \
      --config "min.insync.replicas=2" \
      --config "compression.type=lz4" \
      2>/dev/null || true
    return 0
  fi

  log "Creating topic '${topic_name}' (partitions=${partitions}, replicas=${REPLICATION_FACTOR}, retention=${retention_ms}ms)..."
  "${KAFKA_TOPICS_BIN}" \
    --bootstrap-server "${KAFKA_BOOTSTRAP_SERVERS}" \
    --create \
    --topic "${topic_name}" \
    --partitions "${partitions}" \
    --replication-factor "${REPLICATION_FACTOR}" \
    --config "retention.ms=${retention_ms}" \
    --config "min.insync.replicas=2" \
    --config "compression.type=lz4" \
    --config "cleanup.policy=delete"

  log "Topic '${topic_name}' created successfully."
}

##############################################################################
# Main
##############################################################################
main() {
  log "TrialOS Kafka topic seeder starting..."
  log "Bootstrap servers: ${KAFKA_BOOTSTRAP_SERVERS}"
  log "Replication factor: ${REPLICATION_FACTOR}"

  wait_for_kafka

  for topic_def in "${TOPICS[@]}"; do
    IFS=':' read -r topic_name partitions retention_ms <<< "${topic_def}"
    create_topic "${topic_name}" "${partitions}" "${retention_ms}"
  done

  log "All Kafka topics have been seeded."
  log ""
  log "Current topic list:"
  "${KAFKA_TOPICS_BIN}" \
    --bootstrap-server "${KAFKA_BOOTSTRAP_SERVERS}" \
    --list
}

main "$@"
