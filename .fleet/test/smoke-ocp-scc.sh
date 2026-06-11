#!/usr/bin/env bash
# .fleet/test/smoke-ocp-scc.sh
#
# Smoke test: verify fleet-feature-base runs under the OpenShift
# restricted-SCC model — an arbitrary non-root UID with primary GID 0.
#
# Tests both nginx and PostgreSQL startup under --user 9876:0.
#
# Usage:
#   bash .fleet/test/smoke-ocp-scc.sh [image-tag]
#
# The image must already be built before running this script:
#   docker build -t fleet-feature-base -f .fleet/Dockerfile.feature-base .
#
# Default image tag: fleet-feature-base
# Exit 0 on success, 1 on any failure.

set -euo pipefail

IMAGE="${1:-fleet-feature-base}"
CONTAINER="fleet-scc-smoke-$$"
HOST_PORT=18080

cleanup() {
  docker rm -f "${CONTAINER}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[smoke] ── OpenShift restricted-SCC smoke test ──────────────────────────"
echo "[smoke] Image:     ${IMAGE}"
echo "[smoke] Run as:    --user 9876:0"
echo "[smoke] NGINX port: ${HOST_PORT} → 8080"

# ── Start container ────────────────────────────────────────────────────────────
# FLEET_SERVICES_JSON with a spring entry triggers PostgreSQL initialisation.
# The dummy service just sleeps so the container stays running.
docker run -d --name "${CONTAINER}" \
  --user 9876:0 \
  -e FLEET_SERVICES_JSON='[{"name":"smoke","stack":"spring","port":9999,"run":"sleep infinity"}]' \
  -e NGINX_PORT=8080 \
  -p "127.0.0.1:${HOST_PORT}:8080" \
  "${IMAGE}"

echo "[smoke] Container started: ${CONTAINER}"

# ── Wait for PostgreSQL ────────────────────────────────────────────────────────
echo "[smoke] Waiting for PostgreSQL (up to 90s)..."
PG_UP=""
for i in $(seq 1 90); do
  if docker exec "${CONTAINER}" /usr/lib/postgresql/16/bin/pg_ctl status -D /var/lib/postgresql/16/main/pgdata 2>/dev/null | grep -q "server is running"; then
    echo "[smoke] PostgreSQL ready (attempt ${i})"
    PG_UP=1
    break
  fi
  sleep 1
done

if [ -z "${PG_UP}" ]; then
  echo "[smoke] FAIL: PostgreSQL did not start within 90s"
  echo "[smoke] Container logs:"
  docker logs "${CONTAINER}" 2>&1 | tail -60
  exit 1
fi

# ── Verify postgres accepts connections ────────────────────────────────────────
if ! docker exec "${CONTAINER}" psql -h /tmp -U "$(docker exec "${CONTAINER}" id -un 2>/dev/null || echo postgres)" -c "SELECT 1;" postgres 2>/dev/null; then
  # Try without -U (uses current UID's username, which may not exist in /etc/passwd)
  # Fall back to checking via pg_isready on TCP
  if ! docker exec "${CONTAINER}" pg_isready -h 127.0.0.1 -p 5432 -q; then
    echo "[smoke] FAIL: PostgreSQL not accepting connections"
    docker logs "${CONTAINER}" 2>&1 | tail -30
    exit 1
  fi
fi
echo "[smoke] PostgreSQL: accepting connections ✓"

# ── Wait for nginx ─────────────────────────────────────────────────────────────
echo "[smoke] Waiting for nginx on port ${HOST_PORT} (up to 30s)..."
NGINX_UP=""
for i in $(seq 1 30); do
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 2 "http://127.0.0.1:${HOST_PORT}/" 2>/dev/null || true)
  if [ -n "${HTTP_STATUS}" ] && [ "${HTTP_STATUS}" != "000" ]; then
    echo "[smoke] nginx responded: HTTP ${HTTP_STATUS} (attempt ${i})"
    NGINX_UP=1
    break
  fi
  sleep 1
done

if [ -z "${NGINX_UP}" ]; then
  echo "[smoke] FAIL: nginx did not respond within 30s"
  echo "[smoke] Container logs:"
  docker logs "${CONTAINER}" 2>&1 | tail -30
  exit 1
fi

echo "[smoke] nginx: serving requests ✓"
echo "[smoke] ── PASS: fleet-feature-base works under --user 9876:0 ───────────"
