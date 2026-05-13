#!/bin/bash
set -e

echo "=== Killing any processes on stack ports ==="
PORTS=(5432 9000 9001 9092 6379 8181 8001 8002 7474 7687 27017 8003 8004 8007 8005 8006 4000 3100 9200 26500 9600 8080 8008 8009 8010 8011 8012 8013 8014 8015 3000)
for port in "${PORTS[@]}"; do
  pids=$(lsof -ti tcp:$port 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "  Killing port $port: $pids"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
done

echo "=== Waiting for Docker daemon ==="
for i in $(seq 1 60); do
  if docker ps &>/dev/null; then
    echo "  Docker ready (attempt $i)"
    break
  fi
  sleep 2
  echo "  Waiting... ($i/60)"
done

if ! docker ps &>/dev/null; then
  echo "ERROR: Docker daemon not available after 120s. Please open Docker Desktop manually."
  exit 1
fi

echo "=== Stopping all existing containers ==="
docker compose -f /Users/rajeshmajji/trialo/docker-compose.dev.yml down --remove-orphans 2>&1 || true

echo "=== Pruning unused networks to clear ghost port allocations ==="
docker network prune -f 2>&1 || true

echo "=== Starting all services ==="
docker compose -f /Users/rajeshmajji/trialo/docker-compose.dev.yml up -d 2>&1

echo "=== Container status ==="
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>&1
