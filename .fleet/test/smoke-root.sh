#!/usr/bin/env bash
# .fleet/test/smoke-root.sh
#
# Smoke test: verify fleet-feature-base initialises PostgreSQL correctly when
# the container runs as root (the default — no USER directive in the generated
# Dockerfile.feature-base, so Docker uses UID 0 unless overridden by
# docker-compose / --user).
#
# This is the complement to smoke-ocp-scc.sh, which covers the OpenShift
# restricted-SCC non-root path.
#
# Usage:
#   bash .fleet/test/smoke-root.sh [image-tag]
#
# The image must already be built before running this script:
#   docker build -t fleet-feature-base -f .fleet/Dockerfile.feature-base .
#
# Default image tag: fleet-feature-base
# Exit 0 on success, 1 on any failure.

set -euo pipefail

IMAGE="${1:-fleet-feature-base}"
CONTAINER="fleet-root-smoke-$$"
HOST_PORT=18081

cleanup() {
  docker rm -f "${CONTAINER}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[smoke] ── Root-user PostgreSQL init smoke test ──────────────────────────"
echo "[smoke] Image:     ${IMAGE}"
echo "[smoke] Run as:    root (no --user flag)"
echo "[smoke] NGINX port: ${HOST_PORT} → 8080"

# ── Start container as root (default) ─────────────────────────────────────────
# FLEET_SERVICES_JSON with a spring entry triggers PostgreSQL initialisation.
# The dummy run command keeps the container alive long enough to check PG.
docker run -d --name "${CONTAINER}" \
  -e FLEET_SERVICES_JSON='[{"name":"smoke","stack":"spring","port":9999,"run":"sleep infinity"}]' \
  -e NGINX_PORT=8080 \
  -p "127.0.0.1:${HOST_PORT}:8080" \
  "${IMAGE}"

echo "[smoke] Container started: ${CONTAINER}"

# ── Check for initdb root error immediately ────────────────────────────────────
# Give the entrypoint a moment to reach the initdb call, then inspect logs.
sleep 5
if docker logs "${CONTAINER}" 2>&1 | grep -q "initdb: error: cannot be run as root"; then
  echo "[smoke] FAIL: 'initdb: cannot be run as root' found in logs"
  echo "[smoke] Container logs:"
  docker logs "${CONTAINER}" 2>&1 | tail -30
  exit 1
fi
echo "[smoke] initdb root-error check: clean ✓"

# ── Wait for PostgreSQL ────────────────────────────────────────────────────────
# Use pg_isready (TCP probe, no root restriction) rather than pg_ctl status
# (pg_ctl refuses UID 0 for ALL subcommands, not just start).
echo "[smoke] Waiting for PostgreSQL on 127.0.0.1:5432 (up to 90s)..."
PG_UP=""
for i in $(seq 1 90); do
  if docker exec "${CONTAINER}" pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null; then
    echo "[smoke] PostgreSQL ready (attempt ${i})"
    PG_UP=1
    break
  fi
  # Bail early if the container has already exited
  if ! docker inspect --format '{{.State.Running}}' "${CONTAINER}" 2>/dev/null | grep -q "true"; then
    echo "[smoke] FAIL: container exited before PostgreSQL came up"
    echo "[smoke] Container logs:"
    docker logs "${CONTAINER}" 2>&1 | tail -40
    exit 1
  fi
  sleep 1
done

if [ -z "${PG_UP}" ]; then
  echo "[smoke] FAIL: PostgreSQL did not start within 90s"
  echo "[smoke] Container logs:"
  docker logs "${CONTAINER}" 2>&1 | tail -60
  exit 1
fi

# ── Verify postgres accepts TCP connections ────────────────────────────────────
if ! docker exec "${CONTAINER}" pg_isready -h 127.0.0.1 -p 5432 -q; then
  echo "[smoke] FAIL: PostgreSQL not accepting TCP connections on 127.0.0.1:5432"
  docker logs "${CONTAINER}" 2>&1 | tail -30
  exit 1
fi
echo "[smoke] PostgreSQL: accepting TCP connections ✓"

echo "[smoke] ── PASS: fleet-feature-base initialises PostgreSQL correctly as root ──"
