#!/bin/bash
set -euo pipefail

# ─── Resolve repo root ──────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_BIN="${SCRIPT_DIR}/fleet"

if [ ! -f "${FLEET_BIN}" ]; then
  echo "Error: fleet binary not found at ${FLEET_BIN}" >&2
  exit 1
fi

LINK_TARGET="/usr/local/bin/fleet"

# ─── Check existing installation ────────────────────────────────────────────
if [ -L "${LINK_TARGET}" ]; then
  CURRENT="$(readlink "${LINK_TARGET}")"
  if [ "${CURRENT}" = "${FLEET_BIN}" ]; then
    echo "fleet is already installed at ${LINK_TARGET} -> ${FLEET_BIN}"
    fleet --help
    exit 0
  fi
  echo "Existing symlink: ${LINK_TARGET} -> ${CURRENT}"
  echo "Will replace with: ${LINK_TARGET} -> ${FLEET_BIN}"
elif [ -e "${LINK_TARGET}" ]; then
  echo "Warning: ${LINK_TARGET} exists and is not a symlink. Overwriting."
fi

# ─── Install ─────────────────────────────────────────────────────────────────
echo "Linking fleet to ${LINK_TARGET} (requires sudo)..."
sudo ln -sf "${FLEET_BIN}" "${LINK_TARGET}"

echo ""
echo "Done. Verify:"
echo "  which fleet   -> ${LINK_TARGET}"
echo "  fleet help"
echo ""
fleet --help
