#!/usr/bin/env bash
# lint-no-direct-docker.sh
#
# Fail if any file under gateway/src/ (except container-dispatch.js) contains
# an inline spawn/exec call with 'docker' as the binary argument.
#
# Pattern: word-boundary spawn|exec followed by 'docker' or "docker" on the
# same line — e.g. spawn('docker', ...) or exec("docker build ...").
#
# All docker calls must route through gateway/src/container-dispatch.js.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
GATEWAY_SRC="${REPO_ROOT}/gateway/src"

# Double-quote the pattern to allow \b and handle the ['"] character class.
PATTERN="\b(spawn|exec)\b.*['\"]docker['\"]"

hits=$(rg --no-heading -n \
  --glob '*.js' \
  --glob '!container-dispatch.js' \
  -e "$PATTERN" \
  "$GATEWAY_SRC" 2>/dev/null || true)

if [ -n "$hits" ]; then
  printf '❌  Direct docker spawn/exec found outside container-dispatch.js.\n'
  printf '    Route all docker calls through gateway/src/container-dispatch.js.\n\n'
  printf '%s\n' "$hits"
  exit 1
fi

echo "✓  No direct docker spawn/exec outside gateway/src/container-dispatch.js"
