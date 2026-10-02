#!/bin/bash
# Measures a genuine rebuild-and-redeploy cycle for the sentinel-proxy
# container, as a real comparison point against the PaC hot-reload path.
# This simulates what a hard-coded (non-PaC) rule change would require:
# a code edit, container rebuild, and redeploy before the change is live.

set -e

echo "Starting hard-coded redeploy timing measurement..."
START=$(date +%s%N)

docker compose build sentinel-proxy
docker compose up -d sentinel-proxy

echo "Waiting for gateway to become healthy..."
MAX_WAIT=60
WAITED=0
until curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/healthz 2>/dev/null | grep -q "200"; do
  sleep 0.2
  WAITED=$((WAITED + 1))
  if [ $WAITED -gt $((MAX_WAIT * 5)) ]; then
    echo "TIMEOUT waiting for gateway health check after ${MAX_WAIT}s"
    exit 1
  fi
done

END=$(date +%s%N)
ELAPSED_MS=$(( (END - START) / 1000000 ))
ELAPSED_S=$(echo "scale=2; $ELAPSED_MS / 1000" | bc)

echo ""
echo "=================================================="
echo "Hard-coded redeploy cycle: ${ELAPSED_MS}ms (${ELAPSED_S}s)"
echo "=================================================="
