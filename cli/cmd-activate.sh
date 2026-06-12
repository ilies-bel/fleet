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
_activate_help() {
  local exit_code="${1:-0}"
  echo ""
  echo -e "${GREEN}fleet activate${RESET} — set the active preview feature served by the gateway proxy"
  echo ""
  echo "Usage: fleet activate <name>"
  echo ""
  echo "Arguments:"
  echo -e "  ${BLUE}<name>${RESET}   Feature name (as shown in the dashboard)"
  echo ""
  echo "  Sets which feature preview the gateway's transparent proxy serves."
  echo "  The dashboard reflects the change within ~5s (its poll interval)."
  echo ""
  echo "Examples:"
  echo "  fleet activate my-feature"
  echo ""
  exit "${exit_code}"
}

# ─── Arg parsing ─────────────────────────────────────────────────────────────
ARG="${1:-}"

if [ "${ARG}" = "--help" ] || [ "${ARG}" = "-h" ]; then
  _activate_help 0
fi

if [ -z "${ARG}" ]; then
  echo "Usage: fleet activate <name>" >&2
  exit 1
fi

# ─── Core action ─────────────────────────────────────────────────────────────
validate_feature_name "${ARG}"
load_fleet_toml

key="${FLEET_PROJECT_NAME}-${ARG}"

result=$(gateway_post_full "_fleet/api/features/${key}/activate" '{}')
http_code="${result%|*}"
body_file="${result#*|}"

if [[ "${http_code}" =~ ^2 ]]; then
  rm -f "${body_file}"
  info "Activated ${ARG}"
elif [ "${http_code}" = "404" ]; then
  rm -f "${body_file}"
  error "Feature '${ARG}' is not registered with the gateway. Run 'fleet ls' to see registered features."
else
  body=$(cat "${body_file}")
  rm -f "${body_file}"
  error "Activate failed (HTTP ${http_code}): ${body}"
fi
