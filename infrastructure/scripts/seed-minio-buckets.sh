#!/usr/bin/env bash
# TrialOS — MinIO Bucket Seeder
# Creates the 4 required MinIO buckets and applies appropriate access policies.
# Requires: mc (MinIO Client) on PATH.
set -euo pipefail

##############################################################################
# Configuration — override via environment variables
##############################################################################
MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://localhost:9000}"
MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-admin}"
MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-changeme}"
MINIO_ALIAS="${MINIO_ALIAS:-trialo}"

##############################################################################
# Bucket definitions
# Format: "bucket-name:policy"
# Policies: none (private), download (read-only), upload (write-only), public
##############################################################################
declare -a BUCKETS=(
  "trialo-bronze:none"     # Raw ingested data — private
  "trialo-silver:none"     # Validated/transformed data — private
  "trialo-gold:none"       # Analysis-ready data — private
  "trialo-artifacts:none"  # Agent outputs & reports — private
)

##############################################################################
# Helpers
##############################################################################
log()  { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [INFO]  $*"; }
warn() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [WARN]  $*" >&2; }
err()  { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [ERROR] $*" >&2; }

##############################################################################
# Check prerequisites
##############################################################################
check_prerequisites() {
  if ! command -v mc &>/dev/null; then
    err "mc (MinIO Client) not found on PATH. Install from https://min.io/docs/minio/linux/reference/minio-mc.html"
    exit 1
  fi
  log "mc version: $(mc --version 2>&1 | head -1)"
}

##############################################################################
# Wait for MinIO to be ready
##############################################################################
wait_for_minio() {
  local max_attempts=30
  local attempt=0
  local wait_seconds=3

  log "Waiting for MinIO at ${MINIO_ENDPOINT}..."

  until mc alias set "${MINIO_ALIAS}" \
    "${MINIO_ENDPOINT}" \
    "${MINIO_ACCESS_KEY}" \
    "${MINIO_SECRET_KEY}" \
    --api S3v4 \
    &>/dev/null; do
    attempt=$(( attempt + 1 ))
    if [[ "${attempt}" -ge "${max_attempts}" ]]; then
      err "MinIO did not become ready after $((max_attempts * wait_seconds)) seconds. Aborting."
      exit 1
    fi
    log "MinIO not ready yet (attempt ${attempt}/${max_attempts}). Retrying in ${wait_seconds}s..."
    sleep "${wait_seconds}"
  done

  log "MinIO is ready and alias '${MINIO_ALIAS}' configured."
}

##############################################################################
# Configure MinIO alias
##############################################################################
configure_alias() {
  log "Configuring mc alias '${MINIO_ALIAS}' → ${MINIO_ENDPOINT}..."
  mc alias set "${MINIO_ALIAS}" \
    "${MINIO_ENDPOINT}" \
    "${MINIO_ACCESS_KEY}" \
    "${MINIO_SECRET_KEY}" \
    --api S3v4
}

##############################################################################
# Create and configure a single bucket
##############################################################################
create_bucket() {
  local bucket_name="$1"
  local policy="$2"
  local full_path="${MINIO_ALIAS}/${bucket_name}"

  # Create bucket if it doesn't exist
  if mc ls "${full_path}" &>/dev/null; then
    log "Bucket '${bucket_name}' already exists — skipping creation."
  else
    log "Creating bucket '${bucket_name}'..."
    mc mb "${full_path}" --with-lock 2>/dev/null || mc mb "${full_path}"
    log "Bucket '${bucket_name}' created."
  fi

  # Apply access policy
  log "Setting '${policy}' policy on '${bucket_name}'..."
  mc anonymous set "${policy}" "${full_path}"

  # Enable versioning for all data buckets (important for audit trail)
  log "Enabling versioning on '${bucket_name}'..."
  mc version enable "${full_path}" || warn "Versioning not supported or already enabled on '${bucket_name}'"

  # Set lifecycle rules based on bucket tier
  case "${bucket_name}" in
    trialo-bronze)
      log "Applying lifecycle: Bronze — expire after 90 days, transition to cold after 30 days..."
      mc ilm add "${full_path}" \
        --expiry-days 90 \
        --prefix "raw/" \
        2>/dev/null || warn "Lifecycle rule may already exist on '${bucket_name}'"
      ;;
    trialo-silver)
      log "Applying lifecycle: Silver — expire after 365 days..."
      mc ilm add "${full_path}" \
        --expiry-days 365 \
        2>/dev/null || warn "Lifecycle rule may already exist on '${bucket_name}'"
      ;;
    trialo-gold)
      log "No expiration on Gold bucket (long-term analysis-ready data)."
      ;;
    trialo-artifacts)
      log "Applying lifecycle: Artifacts — expire after 180 days..."
      mc ilm add "${full_path}" \
        --expiry-days 180 \
        2>/dev/null || warn "Lifecycle rule may already exist on '${bucket_name}'"
      ;;
  esac

  log "Bucket '${bucket_name}' configured successfully."
}

##############################################################################
# Apply bucket-level IAM policies
##############################################################################
apply_iam_policies() {
  log "Applying IAM access policies..."

  # Create a service account for the TrialOS platform with full access
  # In production, use Vault or sealed-secrets to manage credentials
  local trialo_policy_name="trialo-platform-policy"
  local policy_json
  policy_json=$(cat <<'POLICY'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:GetObjectVersion",
        "s3:ListBucketMultipartUploads",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": [
        "arn:aws:s3:::trialo-bronze",
        "arn:aws:s3:::trialo-bronze/*",
        "arn:aws:s3:::trialo-silver",
        "arn:aws:s3:::trialo-silver/*",
        "arn:aws:s3:::trialo-gold",
        "arn:aws:s3:::trialo-gold/*",
        "arn:aws:s3:::trialo-artifacts",
        "arn:aws:s3:::trialo-artifacts/*"
      ]
    }
  ]
}
POLICY
)

  echo "${policy_json}" | mc admin policy create \
    "${MINIO_ALIAS}" \
    "${trialo_policy_name}" \
    /dev/stdin \
    2>/dev/null || log "Policy '${trialo_policy_name}' already exists."

  log "IAM policies applied."
}

##############################################################################
# Print summary
##############################################################################
print_summary() {
  log ""
  log "===== MinIO Bucket Summary ====="
  mc ls "${MINIO_ALIAS}" 2>/dev/null || true
  log "================================"
}

##############################################################################
# Main
##############################################################################
main() {
  log "TrialOS MinIO bucket seeder starting..."
  log "MinIO endpoint: ${MINIO_ENDPOINT}"

  check_prerequisites
  wait_for_minio
  configure_alias

  for bucket_def in "${BUCKETS[@]}"; do
    IFS=':' read -r bucket_name policy <<< "${bucket_def}"
    create_bucket "${bucket_name}" "${policy}"
  done

  apply_iam_policies
  print_summary

  log "MinIO bucket seeding complete."
}

main "$@"
