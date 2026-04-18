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

# ─── Install fleet binary ───────────────────────────────────────────────────
NEEDS_BIN_LINK=1
if [ -L "${LINK_TARGET}" ]; then
  CURRENT="$(readlink "${LINK_TARGET}")"
  if [ "${CURRENT}" = "${FLEET_BIN}" ]; then
    echo "fleet is already installed at ${LINK_TARGET} -> ${FLEET_BIN}"
    NEEDS_BIN_LINK=0
  else
    echo "Existing symlink: ${LINK_TARGET} -> ${CURRENT}"
    echo "Will replace with: ${LINK_TARGET} -> ${FLEET_BIN}"
  fi
elif [ -e "${LINK_TARGET}" ]; then
  echo "Warning: ${LINK_TARGET} exists and is not a symlink. Overwriting."
fi

if [ "${NEEDS_BIN_LINK}" = "1" ]; then
  echo "Linking fleet to ${LINK_TARGET} (requires sudo)..."
  sudo ln -sf "${FLEET_BIN}" "${LINK_TARGET}"
fi

# ─── Link Claude Code assets ────────────────────────────────────────────────
# Exposes the repo's slash commands, fleet-* skills, and agents at the user
# level so they are discoverable from any working directory.

REPO_CLAUDE="${SCRIPT_DIR}/.claude"
USER_CLAUDE="${HOME}/.claude"

link_one() {
  # link_one <source> <dest>
  local src="$1" dest="$2"
  mkdir -p "$(dirname "${dest}")"
  if [ -L "${dest}" ]; then
    local current
    current="$(readlink "${dest}")"
    if [ "${current}" = "${src}" ]; then
      return 0
    fi
    echo "  replacing stale symlink: ${dest} -> ${current}"
    ln -sf "${src}" "${dest}"
  elif [ -e "${dest}" ]; then
    echo "  overwriting existing: ${dest}"
    rm -rf "${dest}"
    ln -s "${src}" "${dest}"
  else
    ln -s "${src}" "${dest}"
  fi
  echo "  linked ${dest} -> ${src}"
}

link_glob() {
  # link_glob <src_dir> <dest_dir> <glob>
  local src_dir="$1" dest_dir="$2" pattern="$3"
  shopt -s nullglob
  for src in "${src_dir}"/${pattern}; do
    [ -e "${src}" ] || continue
    link_one "${src}" "${dest_dir}/$(basename "${src}")"
  done
  shopt -u nullglob
}

echo ""
echo "Linking Claude Code assets into ${USER_CLAUDE}..."

# Slash commands: every file under .claude/commands/fleet/
link_glob "${REPO_CLAUDE}/commands/fleet" "${USER_CLAUDE}/commands/fleet" "*"

# Skills: every skill under .claude/skills/
link_glob "${REPO_CLAUDE}/skills" "${USER_CLAUDE}/skills" "*"

# Agents: every file under .claude/agents/
link_glob "${REPO_CLAUDE}/agents" "${USER_CLAUDE}/agents" "*"

# Hooks: every file under .claude/hooks/ (wire into settings.json separately)
link_glob "${REPO_CLAUDE}/hooks" "${USER_CLAUDE}/hooks" "*"

echo ""
echo "Done. Verify:"
echo "  which fleet   -> ${LINK_TARGET}"
echo "  fleet help"
echo "  /fleet:init   (available in any Claude Code session)"
echo ""
fleet --help
