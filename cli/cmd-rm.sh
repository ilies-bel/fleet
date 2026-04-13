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

# ─── Load APP_ROOT (needed for worktree cleanup) ─────────────────────────────
CONFIG_FILE="${QA_FLEET_ROOT}/.qa-config"
APP_ROOT=""
if [ -f "${CONFIG_FILE}" ]; then
  # shellcheck source=/dev/null
  source "${CONFIG_FILE}"
fi

# ─── Remove one feature ──────────────────────────────────────────────────────
remove_feature() {
  local name="$1"
  local compose_file="${QA_FLEET_ROOT}/.qa/${name}/docker-compose.yml"
  local info_file="${QA_FLEET_ROOT}/.qa/${name}/info"

  info "Removing feature: ${name}"

  # Notify gateway (port 4000 is the admin port)
  curl -sf -X DELETE "http://localhost:4000/register-feature/${name}" >/dev/null 2>&1 \
    || warn "Could not notify gateway (is it running?)"

  # Stop container and remove named volumes
  if [ -f "${compose_file}" ]; then
    docker compose -f "${compose_file}" down -v 2>/dev/null || true
  else
    docker rm -f "qa-${name}" 2>/dev/null || warn "Container 'qa-${name}' not found"
  fi

  # Read FRONTEND_DIR and BACKEND_DIR recorded at add time
  local frontend_dir=""
  local backend_dir=""
  local feature_direct=false
  if [ -f "${info_file}" ]; then
    frontend_dir=$(grep '^FRONTEND_DIR=' "${info_file}" | cut -d= -f2 || true)
    backend_dir=$(grep  '^BACKEND_DIR='  "${info_file}" | cut -d= -f2 || true)
    local _d
    _d=$(grep '^DIRECT=' "${info_file}" | cut -d= -f2 || true)
    [ "${_d}" = "true" ] && feature_direct=true || true
  fi

  # Remove worktrees (skipped for direct-mounted features)
  if [ "${feature_direct}" = "false" ] && [ -n "${APP_ROOT:-}" ]; then
    local worktrees_dir="${APP_ROOT}/.qa-worktrees"

    # Build list of subdirs to clean up from what was recorded in info
    local subdirs=()
    [ -n "${frontend_dir}" ] && subdirs+=("${frontend_dir}")
    [ -n "${backend_dir}"  ] && subdirs+=("${backend_dir}")

    if (( ${#subdirs[@]} > 0 )); then
      for sub in "${subdirs[@]}"; do
        local wt="${worktrees_dir}/${name}/${sub}"
        if [ -d "$wt" ]; then
          git -C "${APP_ROOT}/${sub}" worktree remove --force "$wt" 2>/dev/null \
            || warn "Could not remove worktree ${wt}"
        fi
      done
    fi
    rm -rf "${worktrees_dir}/${name}"
  fi

  # Remove build context and metadata
  rm -rf "${QA_FLEET_ROOT}/.qa/${name}"

  info "Removed '${name}'"
}

# ─── Main ────────────────────────────────────────────────────────────────────
MODE="${1:-}"

if [ -z "$MODE" ]; then
  echo "Usage:"
  echo "  fleet rm <name>      — remove one feature (container + volumes + worktree)"
  echo "  fleet rm --all       — remove all features, keep gateway running"
  echo "  fleet rm --nuke      — remove everything including gateway and network"
  exit 1
fi

case "$MODE" in
  --all)
    info "Removing all feature containers..."
    for dir in "${QA_FLEET_ROOT}/.qa"/*/; do
      local_name=$(basename "$dir")
      [ -d "$dir" ] && [ -f "${dir}info" ] || continue
      remove_feature "$local_name"
    done
    info "All features removed. Gateway still running."
    ;;

  --nuke)
    info "Nuking everything..."

    for dir in "${QA_FLEET_ROOT}/.qa"/*/; do
      local_name=$(basename "$dir")
      [ -d "$dir" ] && [ -f "${dir}info" ] || continue
      remove_feature "$local_name" 2>/dev/null || true
    done

    docker rm -f qa-gateway-container 2>/dev/null && info "Gateway removed" || warn "Gateway not found"
    docker rmi qa-gateway 2>/dev/null || true
    docker rmi qa-feature-base 2>/dev/null || true
    docker network rm qa-net 2>/dev/null && info "Network 'qa-net' removed" || warn "Network not found"

    RUNNER_PID_FILE="${QA_FLEET_ROOT}/.qa-runner.pid"
    if [ -f "${RUNNER_PID_FILE}" ]; then
      RUNNER_PID=$(cat "${RUNNER_PID_FILE}")
      kill "${RUNNER_PID}" 2>/dev/null && info "Host runner stopped (PID ${RUNNER_PID})" || warn "Host runner not running"
      rm -f "${RUNNER_PID_FILE}"
    fi

    rm -f "${QA_FLEET_ROOT}/.qa-config"
    info "Nuke complete."
    ;;

  *)
    NAME="$MODE"
    INFO_FILE="${QA_FLEET_ROOT}/.qa/${NAME}/info"

    if [ ! -f "${INFO_FILE}" ] && ! docker inspect "qa-${NAME}" >/dev/null 2>&1; then
      error "Feature '${NAME}' not found"
    fi

    remove_feature "$NAME"
    ;;
esac
