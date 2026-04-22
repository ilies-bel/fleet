#!/bin/bash
BACKEND_PORT="${BACKEND_PORT:-8080}"
BACKEND_WAIT_TIMEOUT="${BACKEND_WAIT_TIMEOUT:-120}"
URL="http://localhost:${BACKEND_PORT}/actuator/health/readiness"
echo "[wait-for-backend] Waiting for backend at ${URL} (timeout ${BACKEND_WAIT_TIMEOUT}s)..."
elapsed=0
until curl -sf "${URL}" > /dev/null 2>&1; do
  if [ "${elapsed}" -ge "${BACKEND_WAIT_TIMEOUT}" ]; then
    echo "[wait-for-backend] Timeout after ${BACKEND_WAIT_TIMEOUT}s — starting frontend anyway"
    break
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done
echo "[wait-for-backend] Backend ready (or timeout). Proceeding."
