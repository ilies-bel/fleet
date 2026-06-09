#!/usr/bin/env bash
# .fleet/test/smoke-vite-tracer.sh
#
# Smoke test: initialise a throwaway Vite fixture project, run fleet init
# (generates railpack.json and builds the per-vite base image), add a tracer
# feature, assert the Vite dev server responds with HTML, exercise fleet sync
# and fleet sync --rebuild, then clean up.
#
# Proves the user-visible init → add → sync → rebuild loop end-to-end on the
# Vite-specific code path without touching any other stack's path.
#
# Requirements: Docker daemon running, fleet CLI callable via ./fleet
# Usage:   bash .fleet/test/smoke-vite-tracer.sh
# Exit 0 on success, non-zero on any failure.

set -euo pipefail

# ── Path resolution ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FLEET_CMD="${FLEET_ROOT}/fleet"

# Source shared logging helpers (info / warn / error).
# shellcheck source=../../cli/common.sh
source "${FLEET_ROOT}/cli/common.sh"

# ── Constants ─────────────────────────────────────────────────────────────────
FEATURE_NAME="tracer"
SERVICE_NAME="web"

# ── Fixture project directory ─────────────────────────────────────────────────
# Use a named subdirectory so fleet init can derive the project name from it.
TMPPARENT="$(mktemp -d)"
PROJECT_NAME="smoke-vite"
PROJECT_DIR="${TMPPARENT}/${PROJECT_NAME}"
mkdir -p "${PROJECT_DIR}"

info "[smoke-vite] ── Vite tracer smoke test ──────────────────────────────────"
info "[smoke-vite] Fixture:  ${PROJECT_DIR}"

# ── Cleanup — runs on both success and failure paths ─────────────────────────
cleanup() {
  info "[smoke-vite] Cleaning up..."
  (cd "${PROJECT_DIR}" && "${FLEET_CMD}" rm "${FEATURE_NAME}") 2>/dev/null || true
  docker image rm --force "fleet-feature-base-${PROJECT_NAME}-${SERVICE_NAME}" \
    2>/dev/null || true
  rm -rf "${TMPPARENT}"
}
trap cleanup EXIT

# ── Scaffold minimal Vite project ─────────────────────────────────────────────
# Files live under web/ so that fleet init names the detected service "web".
mkdir -p "${PROJECT_DIR}/${SERVICE_NAME}"

cat > "${PROJECT_DIR}/${SERVICE_NAME}/package.json" << 'EOF'
{
  "scripts": { "dev": "vite" },
  "devDependencies": { "vite": "^5" }
}
EOF

# Empty config — vite requires the file to exist for stack detection.
: > "${PROJECT_DIR}/${SERVICE_NAME}/vite.config.js"

cat > "${PROJECT_DIR}/${SERVICE_NAME}/index.html" << 'EOF'
<!DOCTYPE html>
<html>
<body>
<div id="root"></div>
</body>
</html>
EOF

# Fleet requires a git repo so worktree operations succeed.
git -C "${PROJECT_DIR}" init -q
git -C "${PROJECT_DIR}" add -A
git -C "${PROJECT_DIR}" \
  -c user.email="smoke@example.com" -c user.name="Smoke" \
  commit -qm "init fixture"

info "[smoke-vite] Scaffolded Vite project (${SERVICE_NAME}/)"

# ── fleet init ────────────────────────────────────────────────────────────────
info "[smoke-vite] Running fleet init --override..."
# Pipe newlines to accept all interactive defaults (project name, ports, etc.).
(cd "${PROJECT_DIR}" && printf '\n\n\n\n\n\n\n\n\n\n' | "${FLEET_CMD}" init --override)

# Read ports directly from the generated fleet.toml without re-sourcing common.sh.
_read_toml_port() {
  local toml_file="$1" key="$2"
  awk '/^\[ports\]/,/^\[/' "${toml_file}" \
    | awk -v k="${key}" '$1 == k { gsub(/[^0-9]/, "", $3); print $3; exit }'
}
PROXY_PORT="$(_read_toml_port "${PROJECT_DIR}/.fleet/fleet.toml" "proxy")"
ADMIN_PORT="$(_read_toml_port "${PROJECT_DIR}/.fleet/fleet.toml" "admin")"
export GATEWAY_URL="http://localhost:${ADMIN_PORT}"

info "[smoke-vite] Ports — proxy=${PROXY_PORT}  admin=${ADMIN_PORT}"

# ── Assert railpack.json was generated ───────────────────────────────────────
RAILPACK="${PROJECT_DIR}/.fleet/${SERVICE_NAME}/railpack.json"
if [ ! -f "${RAILPACK}" ]; then
  echo "[smoke-vite] FAIL: ${RAILPACK} not found after fleet init" >&2
  exit 1
fi
info "[smoke-vite] .fleet/${SERVICE_NAME}/railpack.json ✓"

# ── Assert per-vite base image was built ─────────────────────────────────────
BASE_IMAGE="fleet-feature-base-${PROJECT_NAME}-${SERVICE_NAME}"
if ! docker image inspect "${BASE_IMAGE}" > /dev/null 2>&1; then
  echo "[smoke-vite] FAIL: docker image ${BASE_IMAGE} not found" >&2
  exit 1
fi
info "[smoke-vite] Base image ${BASE_IMAGE} ✓"

# ── fleet add tracer ──────────────────────────────────────────────────────────
# --direct binds the source directory into the container so that file edits
# are reflected without needing a remote git push + pull.
info "[smoke-vite] Running fleet add ${FEATURE_NAME} --direct..."
(cd "${PROJECT_DIR}" && "${FLEET_CMD}" add "${FEATURE_NAME}" --direct)

FEATURE_KEY="${PROJECT_NAME}-${FEATURE_NAME}"

# ── Poll health endpoint ──────────────────────────────────────────────────────
info "[smoke-vite] Polling /_fleet/api/features/${FEATURE_KEY}/health (up to 60s)..."
HEALTH_OK=""
for i in $(seq 1 60); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 \
    "${GATEWAY_URL}/_fleet/api/features/${FEATURE_KEY}/health" 2>/dev/null || true)
  if [ "${STATUS}" = "200" ]; then
    info "[smoke-vite] Feature healthy (attempt ${i}) ✓"
    HEALTH_OK=1
    break
  fi
  sleep 1
done
if [ -z "${HEALTH_OK}" ]; then
  echo "[smoke-vite] FAIL: ${FEATURE_KEY} not healthy after 60s" >&2
  exit 1
fi

# ── Assert Vite dev server serves HTML with <div id="root"> ──────────────────
info "[smoke-vite] Curling Vite dev URL http://localhost:${PROXY_PORT}/..."
BODY=$(curl -sf --max-time 10 "http://localhost:${PROXY_PORT}/" 2>/dev/null) || {
  echo "[smoke-vite] FAIL: no response from http://localhost:${PROXY_PORT}/" >&2
  exit 1
}
if ! echo "${BODY}" | grep -q '<div id="root">'; then
  echo "[smoke-vite] FAIL: response does not contain <div id=\"root\">" >&2
  echo "${BODY}" | head -30
  exit 1
fi
info "[smoke-vite] Vite dev server serves <div id=\"root\"> ✓"

# ── Edit source file + fleet sync ─────────────────────────────────────────────
EDIT_MARKER="smoke-edit-$$"
info "[smoke-vite] Appending edit marker to index.html..."
printf '\n<!-- %s -->\n' "${EDIT_MARKER}" >> "${PROJECT_DIR}/${SERVICE_NAME}/index.html"

info "[smoke-vite] Running fleet sync ${FEATURE_NAME}..."
(cd "${PROJECT_DIR}" && "${FLEET_CMD}" sync "${FEATURE_NAME}")

info "[smoke-vite] Waiting for edit to be visible (up to 30s)..."
EDIT_VISIBLE=""
for i in $(seq 1 30); do
  BODY=$(curl -sf --max-time 5 "http://localhost:${PROXY_PORT}/" 2>/dev/null) || true
  if echo "${BODY}" | grep -qF "<!-- ${EDIT_MARKER} -->"; then
    info "[smoke-vite] Edit visible after sync (attempt ${i}) ✓"
    EDIT_VISIBLE=1
    break
  fi
  sleep 1
done
if [ -z "${EDIT_VISIBLE}" ]; then
  echo "[smoke-vite] FAIL: edit marker '<!-- ${EDIT_MARKER} -->' not visible after sync" >&2
  exit 1
fi

# ── fleet sync --rebuild ──────────────────────────────────────────────────────
info "[smoke-vite] Running fleet sync ${FEATURE_NAME} --rebuild..."
(cd "${PROJECT_DIR}" && "${FLEET_CMD}" sync "${FEATURE_NAME}" --rebuild)

info "[smoke-vite] Waiting for dev URL to respond after rebuild (up to 120s)..."
REBUILD_UP=""
for i in $(seq 1 60); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
    "http://localhost:${PROXY_PORT}/" 2>/dev/null || true)
  if [ "${STATUS}" = "200" ]; then
    info "[smoke-vite] Dev URL responds after rebuild (attempt ${i}) ✓"
    REBUILD_UP=1
    break
  fi
  sleep 2
done
if [ -z "${REBUILD_UP}" ]; then
  echo "[smoke-vite] FAIL: dev URL did not respond within 120s after rebuild" >&2
  exit 1
fi

info "[smoke-vite] ── PASS: fleet init + add + sync + rebuild end-to-end ─────"
