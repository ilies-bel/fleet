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
_stop_help() {
  local exit_code="${1:-0}"
  echo ""
  echo -e "${GREEN}fleet stop${RESET} — pause a feature container without destroying it"
  echo ""
  echo "Usage: fleet stop <name>|--all"
  echo ""
  echo "Arguments:"
  echo -e "  ${BLUE}<name>${RESET}   Feature name (as shown in the dashboard)"
  echo -e "  ${BLUE}--all${RESET}    Stop all feature containers"
  echo ""
  echo "  Non-destructive: the worktree, registry entry (.fleet/<name>/), and"
  echo "  container are preserved. Resume later with: fleet start <name>"
  echo ""
  echo "Examples:"
  echo "  fleet stop my-feature"
  echo "  fleet stop --all"
  echo ""
  exit "${exit_code}"
}

# ─── Arg parsing ─────────────────────────────────────────────────────────────
ARG="${1:-}"

if [ "${ARG}" = "--help" ] || [ "${ARG}" = "-h" ]; then
  _stop_help 0
fi

if [ -z "${ARG}" ]; then
  echo "Usage: fleet stop <name>|--all" >&2
  exit 1
fi

# ─── Core action ─────────────────────────────────────────────────────────────
_stop_one() {
  local name="${1:-}"
  local container="fleet-${FLEET_PROJECT_NAME}-${name}"
  local key="${FLEET_PROJECT_NAME}-${name}"

  info "Stopping ${container}..."
  docker stop "${container}" >/dev/null 2>&1 || warn "Container '${container}' not running"
  curl -sf -X POST "${GATEWAY_URL}/_fleet/api/features/${key}/reconcile" >/dev/null 2>&1 || true
  info "Stopped ${name}"
}

# ─── Dispatch ────────────────────────────────────────────────────────────────
if [ "${ARG}" = "--all" ]; then
  load_fleet_toml
  shopt -s nullglob
  for info_toml in "${FLEET_CONFIG_ROOT}/.fleet/"*/info.toml; do
    local_name=$(basename "$(dirname "${info_toml}")")
    _stop_one "${local_name}"
  done
  shopt -u nullglob
  info "All feature containers stopped."
else
  validate_feature_name "${ARG}"
  load_fleet_toml
  _stop_one "${ARG}"
fi
