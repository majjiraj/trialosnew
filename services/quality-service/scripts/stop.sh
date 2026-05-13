#!/usr/bin/env bash
# stop.sh — stop the Quality Service
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$SCRIPT_DIR")"

docker-compose down
echo "Quality Service stopped."
