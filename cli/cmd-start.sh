#!/bin/bash
set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export FLEET_ROOT

# Source shared library
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

# ─── Help ────────────────────────────────────────────────────────────────────
_start_help() {
  local exit_code="${1:-0}"
  echo ""
  echo -e "${GREEN}fleet start${RESET} — resume a stopped feature container without rebuilding"
  echo ""
  echo "Usage: fleet start <name>|--all"
  echo ""
  echo "Arguments:"
  echo -e "  ${BLUE}<name>${RESET}   Feature name (as shown in the dashboard)"
  echo -e "  ${BLUE}--all${RESET}    Start all stopped feature containers"
  echo ""
  echo "  Resumes a container previously stopped with 'fleet stop'. The container"
  echo "  must already exist — if it does not, run 'fleet add <name>' instead."
  echo "  No image rebuild is performed."
  echo ""
  echo "Examples:"
  echo "  fleet start my-feature"
  echo "  fleet start --all"
  echo ""
  exit "${exit_code}"
}

# ─── Arg parsing ─────────────────────────────────────────────────────────────
ARG="${1:-}"

if [ "${ARG}" = "--help" ] || [ "${ARG}" = "-h" ]; then
  _start_help 0
fi

if [ -z "${ARG}" ]; then
  echo "Usage: fleet start <name>|--all" >&2
  exit 1
fi

# ─── Core action ─────────────────────────────────────────────────────────────
_start_one() {
  local name="${1:-}"
  local fatal="${2:-true}"
  local container="fleet-${FLEET_PROJECT_NAME}-${name}"
  local key="${FLEET_PROJECT_NAME}-${name}"

  if ! docker inspect "${container}" >/dev/null 2>&1; then
    if [ "${fatal}" = "true" ]; then
      error "Container '${container}' does not exist. Run: fleet add ${name}"
    else
      warn "Container '${container}' does not exist — skipping. Run: fleet add ${name}"
      return 0
    fi
  fi

  info "Starting ${container}..."
  docker start "${container}" >/dev/null
  sleep 2
  STATUS=$(curl -sf -X POST "${GATEWAY_URL}/_fleet/api/features/${key}/reconcile" 2>/dev/null \
    | python3 -m json.tool 2>/dev/null || echo '{"status":"unknown"}')
  info "Started ${name}. Reconcile: ${STATUS}"
}

# ─── Dispatch ────────────────────────────────────────────────────────────────
if [ "${ARG}" = "--all" ]; then
  load_fleet_toml
  shopt -s nullglob
  for info_toml in "${FLEET_CONFIG_ROOT}/.fleet/"*/info.toml; do
    local_name=$(basename "$(dirname "${info_toml}")")
    _start_one "${local_name}" "false"
  done
  shopt -u nullglob
  info "All feature containers started."
else
  validate_feature_name "${ARG}"
  load_fleet_toml
  _start_one "${ARG}" "true"
fi
