#!/usr/bin/env bash
# .fleet/test/smoke-fleet-boot-wait.sh
#
# Pod-shaped smoke test: verify FLEET_BOOT=wait idle-wait entrypoint mode.
#
# Simulates the cluster pod lifecycle:
#   1. Container starts with FLEET_BOOT=wait — supervisord must NOT start yet.
#   2. An HTML file is "rsync'd" into the container via docker cp.
#   3. Sentinel /app/.fleet-ready is touched to signal payload complete.
#   4. Entrypoint unblocks → supervisord starts → nginx serves the file.
#
# Usage:
#   bash .fleet/test/smoke-fleet-boot-wait.sh [image-tag]
#
# Build the image first:
#   docker build -t fleet-feature-base -f .fleet/Dockerfile.feature-base .
#
# Exit 0 on success, 1 on any failure.

set -euo pipefail

IMAGE="${1:-fleet-feature-base}"
CONTAINER="fleet-boot-wait-smoke-$$"
HOST_PORT=18082
TMPFILE="/tmp/fleet-test-$$.html"

cleanup() {
  docker rm -f "${CONTAINER}" 2>/dev/null || true
  rm -f "${TMPFILE}"
}
trap cleanup EXIT INT TERM

echo "[smoke] ── FLEET_BOOT=wait smoke test ──────────────────────────────────"
echo "[smoke] Image:      ${IMAGE}"
echo "[smoke] NGINX port: ${HOST_PORT} → 8080"

# ── 1. Start container in wait mode ───────────────────────────────────────────
docker run -d --name "${CONTAINER}" \
  -e FLEET_BOOT=wait \
  -e FLEET_SERVICES_JSON='[]' \
  -e NGINX_PORT=8080 \
  -p "127.0.0.1:${HOST_PORT}:8080" \
  "${IMAGE}"

echo "[smoke] Container started: ${CONTAINER}"

# ── 2. Verify the container is blocking (nginx must NOT be up yet) ─────────────
echo "[smoke] Waiting 5s to confirm entrypoint is blocked..."
sleep 5

EARLY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  --max-time 2 "http://127.0.0.1:${HOST_PORT}/" 2>/dev/null || echo "000")
if [ "${EARLY_STATUS}" != "000" ] && [ "${EARLY_STATUS}" != "502" ]; then
  echo "[smoke] FAIL: nginx responded (HTTP ${EARLY_STATUS}) before sentinel was touched"
  docker logs "${CONTAINER}" 2>&1 | tail -20
  exit 1
fi
echo "[smoke] Confirmed: nginx not yet serving (status=${EARLY_STATUS}) ✓"

# ── 3. Simulate rsync: copy a test file, then touch the sentinel ───────────────
echo "[smoke] Simulating rsync: copying test HTML to /var/www/html/fleet-test.html..."
printf '<html><body>fleet-boot-wait-ok</body></html>\n' > "${TMPFILE}"
docker cp "${TMPFILE}" "${CONTAINER}:/var/www/html/fleet-test.html"

echo "[smoke] Touching sentinel /app/.fleet-ready..."
docker exec "${CONTAINER}" touch /app/.fleet-ready

# ── 4. Wait for nginx to start ─────────────────────────────────────────────────
echo "[smoke] Waiting for nginx (up to 30s)..."
NGINX_UP=""
for i in $(seq 1 30); do
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 2 "http://127.0.0.1:${HOST_PORT}/" 2>/dev/null || echo "000")
  if [ -n "${HTTP_STATUS}" ] && [ "${HTTP_STATUS}" != "000" ]; then
    echo "[smoke] nginx responded: HTTP ${HTTP_STATUS} (attempt ${i})"
    NGINX_UP=1
    break
  fi
  sleep 1
done

if [ -z "${NGINX_UP}" ]; then
  echo "[smoke] FAIL: nginx did not respond within 30s after sentinel was touched"
  echo "[smoke] Container logs:"
  docker logs "${CONTAINER}" 2>&1 | tail -40
  exit 1
fi

# ── 5. Verify the rsync'd file is served ──────────────────────────────────────
echo "[smoke] Verifying rsync'd content is served..."
CONTENT=$(curl -s --max-time 5 "http://127.0.0.1:${HOST_PORT}/fleet-test.html" 2>/dev/null || true)
if ! echo "${CONTENT}" | grep -q "fleet-boot-wait-ok"; then
  echo "[smoke] FAIL: expected 'fleet-boot-wait-ok' in response body"
  echo "[smoke] Got: ${CONTENT}"
  docker logs "${CONTAINER}" 2>&1 | tail -20
  exit 1
fi
echo "[smoke] nginx serving rsync'd content ✓"

echo "[smoke] ── PASS: FLEET_BOOT=wait lifecycle works as expected ─────────────"
