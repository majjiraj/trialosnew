#!/usr/bin/env bash
# healthcheck.sh — poll /health until the service is ready (max 60 s)
set -euo pipefail

PORT="${SERVICE_PORT:-8016}"
URL="http://localhost:${PORT}/health"
MAX_ATTEMPTS=30
INTERVAL=2

echo "Checking $URL ..."

for i in $(seq 1 $MAX_ATTEMPTS); do
  if curl -sf "$URL" >/dev/null 2>&1; then
    RESPONSE=$(curl -sf "$URL")
    echo "✓ Quality Service is healthy: $RESPONSE"
    exit 0
  fi
  echo "  Attempt $i/$MAX_ATTEMPTS — not ready yet, retrying in ${INTERVAL}s..."
  sleep "$INTERVAL"
done

echo "ERROR: Service did not become healthy after $((MAX_ATTEMPTS * INTERVAL))s" >&2
echo "Check logs with: docker-compose logs quality-service" >&2
exit 1
