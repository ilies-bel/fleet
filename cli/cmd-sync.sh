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
if [ -z "$name" ]; then
  echo "Usage: fleet sync <name> [--regenerate-sources]"
  echo "  name                 Feature name (as shown in dashboard)"
  echo "  --regenerate-sources Also regenerate jOOQ DSL (needed after Liquibase migrations)"
  exit 1
fi

regen=false
for arg in "${@:2}"; do
  [ "$arg" = "--regenerate-sources" ] && regen=true
done

url="${GATEWAY_URL}/_fleet/api/features/${name}/sync"
[ "$regen" = true ] && url="${url}?regenerateSources=true"

info "Syncing '${name}'$([ "$regen" = true ] && echo ' (with source regen)' || true)..."
curl -sf -X POST "$url" | python3 -m json.tool
info "Sync started — open logs in dashboard to follow progress"
