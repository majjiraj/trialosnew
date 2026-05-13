#!/usr/bin/env bash
# start.sh — start the Quality Service (detached)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$SCRIPT_DIR")"

echo "Starting Quality Service..."
docker-compose up -d

echo ""
echo "Waiting for service to become healthy..."
"$(dirname "$0")/healthcheck.sh"
