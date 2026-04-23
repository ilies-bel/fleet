#!/bin/bash
set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export FLEET_ROOT

# Source shared library
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

name="${1:-}"
if [ "${name}" = "--help" ] || [ "${name}" = "-h" ]; then
  echo ""
  echo -e "${GREEN}fleet sync${RESET} — pull latest code and rebuild a feature container"
  echo ""
  echo "Usage: fleet sync <name> [--regenerate-sources] [--rebuild]"
  echo ""
  echo "Arguments:"
  echo -e "  ${BLUE}<name>${RESET}                   Feature name (as shown in dashboard)"
  echo ""
  echo "Flags:"
  echo -e "  ${BLUE}--regenerate-sources${RESET}     Also regenerate jOOQ DSL (needed after Liquibase migrations)"
  echo -e "  ${BLUE}--rebuild${RESET}                Rebuild the Docker base image and recreate the container"
  echo ""
  echo "Examples:"
  echo "  fleet sync my-feature"
  echo "  fleet sync my-feature --regenerate-sources"
  echo "  fleet sync my-feature --rebuild"
  echo ""
  exit 0
fi
if [ -z "$name" ]; then
  echo "Usage: fleet sync <name> [--regenerate-sources] [--rebuild]"
  echo "  name                 Feature name (as shown in dashboard)"
  echo "  --regenerate-sources Also regenerate jOOQ DSL (needed after Liquibase migrations)"
  echo "  --rebuild            Rebuild the Docker base image and recreate the container"
  exit 1
fi

regen=false
rebuild=false
for arg in "${@:2}"; do
  [ "$arg" = "--regenerate-sources" ] && regen=true
  [ "$arg" = "--rebuild" ] && rebuild=true
done

if [ "$rebuild" = true ]; then
  url="${GATEWAY_URL}/_fleet/api/features/${name}/rebuild"
  info "Rebuilding image for '${name}'..."
  curl -sf -X POST "$url" | python3 -m json.tool
  info "Rebuild started — open logs in dashboard to follow progress"
else
  url="${GATEWAY_URL}/_fleet/api/features/${name}/sync"
  [ "$regen" = true ] && url="${url}?regenerateSources=true"
  info "Syncing '${name}'$([ "$regen" = true ] && echo ' (with source regen)' || true)..."
  curl -sf -X POST "$url" | python3 -m json.tool
  info "Sync started — open logs in dashboard to follow progress"
fi
