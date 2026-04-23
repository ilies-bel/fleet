#!/bin/bash
set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export FLEET_ROOT

# Source shared library
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

NAME="${1:-}"
if [ "${NAME}" = "--help" ] || [ "${NAME}" = "-h" ]; then
  echo ""
  echo -e "${GREEN}fleet restart${RESET} — restart a feature container"
  echo ""
  echo "Usage: fleet restart <name>"
  echo ""
  echo "Arguments:"
  echo -e "  ${BLUE}<name>${RESET}   Feature name (as shown in the dashboard)"
  echo ""
  echo "  Runs 'docker restart fleet-<name>' and reports the health status"
  echo "  from the gateway after a brief settle period."
  echo ""
  echo "Examples:"
  echo "  fleet restart my-feature"
  echo "  fleet restart qa-main"
  echo ""
  exit 0
fi
if [ -z "$NAME" ]; then
  echo "Usage: fleet restart <name>"
  exit 1
fi

validate_feature_name "$NAME"
load_qa_config

info "Restarting container fleet-${NAME}..."
docker restart "fleet-${NAME}"

# Quick health confirmation
sleep 2
STATUS=$(curl -sf "${GATEWAY_URL}/_fleet/api/features/${NAME}/health" 2>/dev/null | python3 -m json.tool 2>/dev/null || echo '{"status":"unknown"}')
info "Restarted. Health: $STATUS"
