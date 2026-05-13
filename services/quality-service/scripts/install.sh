#!/usr/bin/env bash
# install.sh — set up the Quality Service for first-time use
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(dirname "$SCRIPT_DIR")"

cd "$SERVICE_DIR"

# ── Prerequisites ──────────────────────────────────────────────────────────────

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: '$1' is required but not installed." >&2
    exit 1
  fi
}

check_cmd docker
check_cmd docker-compose

DOCKER_VERSION=$(docker --version | grep -oE '[0-9]+\.[0-9]+' | head -1)
echo "✓ Docker $DOCKER_VERSION"
echo "✓ docker-compose $(docker-compose --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"

# ── Environment file ───────────────────────────────────────────────────────────

if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "✓ Created .env from .env.example"
  echo "  Edit .env if you need to change the database URL or port."
else
  echo "✓ .env already exists (skipped)"
fi

# ── Build image ────────────────────────────────────────────────────────────────

echo ""
echo "Building Docker image..."
docker-compose build --no-cache
echo "✓ Image built"

echo ""
echo "Installation complete."
echo ""
echo "Next steps:"
echo "  ./scripts/start.sh        — start the service"
echo "  ./scripts/healthcheck.sh  — wait until ready, then verify"
echo "  open http://localhost:8016/docs for the Swagger UI"
