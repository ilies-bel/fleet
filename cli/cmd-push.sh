#!/bin/bash
set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export FLEET_ROOT

# Source shared library
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

QA_FLEET_ROOT="${FLEET_ROOT}"

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "Usage: fleet push <feature-name>"
  exit 1
fi

load_qa_config

INFO_FILE="${QA_FLEET_ROOT}/.qa/${NAME}/info"
[ -f "${INFO_FILE}" ] || error "Feature '${NAME}' not found (no .qa/${NAME}/info)"

# shellcheck source=/dev/null
source "${INFO_FILE}"

if [ "${DIRECT:-false}" = "true" ]; then
  info "Direct mode — pushing from APP_ROOT..."
  git -C "${APP_ROOT}" push
  info "Pushed."
else
  # Worktree mode
  PUSHED=0
  for sub in "${FRONTEND_DIR:-}" "${BACKEND_DIR:-}"; do
    [ -z "$sub" ] && continue
    wt="${WORKTREE_PATH}/${sub}"
    [ -d "${wt}" ] || { warn "  Worktree ${wt} not found — skipping"; continue; }

    # Check if this is a real git repo (not a gitfile pointer only)
    if git -C "${wt}" rev-parse --git-dir >/dev/null 2>&1; then
      remote_branch=$(git -C "${wt}" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo "")
      if [ -n "${remote_branch}" ]; then
        info "Pushing ${sub} (branch: ${BRANCH})..."
        git -C "${wt}" push
      else
        info "Pushing ${sub} (branch: ${BRANCH}, setting upstream)..."
        git -C "${wt}" push --set-upstream origin "${BRANCH}"
      fi
      PUSHED=$((PUSHED + 1))
    fi
  done

  if [ "${PUSHED}" -eq 0 ]; then
    error "No worktrees found to push"
  fi
  info "Push complete (${PUSHED} repo(s))."
fi
