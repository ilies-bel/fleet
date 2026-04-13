#!/bin/bash
# common.sh — Shared library for all fleet CLI commands
# Source this file from every cmd-*.sh:
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# ─── Fleet root (auto-detected from BASH_SOURCE location) ────────────────────
# FLEET_ROOT is exported so sub-processes inherit it.
if [ -z "${FLEET_ROOT:-}" ]; then
  FLEET_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  export FLEET_ROOT
fi

# ─── Color helpers (tty-aware) ────────────────────────────────────────────────
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  RED='\033[0;31m'
  BLUE='\033[0;34m'
  RESET='\033[0m'
else
  GREEN='' YELLOW='' RED='' BLUE='' RESET=''
fi
export GREEN YELLOW RED BLUE RESET

# ─── Logging helpers ──────────────────────────────────────────────────────────
info()  { echo -e "${GREEN}[fleet]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[fleet]${RESET} $*"; }
error() { echo -e "${RED}[fleet] ERROR:${RESET} $*" >&2; exit 1; }
export -f info warn error

# ─── Gateway URL ─────────────────────────────────────────────────────────────
GATEWAY_URL="${FLEET_GATEWAY:-http://localhost:4000}"
export GATEWAY_URL

# ─── Config loaders ───────────────────────────────────────────────────────────

# load_qa_config — sources .qa-config, exports APP_ROOT
# Errors if missing or APP_ROOT doesn't exist.
load_qa_config() {
  local config_file="${FLEET_ROOT}/.qa-config"
  [ -f "${config_file}" ] || error ".qa-config not found. Run: fleet init <app-root> <branch>"
  # shellcheck source=/dev/null
  source "${config_file}"
  [ -d "${APP_ROOT:-}" ] || error "APP_ROOT '${APP_ROOT:-}' does not exist (check .qa-config)"
  # Also expose QA_FLEET_ROOT as alias for FLEET_ROOT for legacy compatibility
  QA_FLEET_ROOT="${FLEET_ROOT}"
  export APP_ROOT QA_FLEET_ROOT
}

# load_fleet_conf — sources $APP_ROOT/qa-fleet.conf, applies all defaults
# Must call load_qa_config first.
load_fleet_conf() {
  local fleet_conf="${APP_ROOT}/qa-fleet.conf"
  [ -f "${fleet_conf}" ] || error "qa-fleet.conf not found in ${APP_ROOT}. Run: fleet init first."
  # shellcheck source=/dev/null
  source "${fleet_conf}"

  [ -n "${FRONTEND_DIR:-}" ] || error "FRONTEND_DIR is not set in qa-fleet.conf"

  # Derive project name from APP_ROOT if not set
  if [ -z "${PROJECT_NAME:-}" ]; then
    local _app_basename
    _app_basename="$(basename "${APP_ROOT}")"
    if [ "${_app_basename}" = "app" ]; then
      PROJECT_NAME="$(basename "$(dirname "${APP_ROOT}")")"
    else
      PROJECT_NAME="${_app_basename}"
    fi
  fi

  # Apply defaults for optional fields
  FRONTEND_OUT_DIR="${FRONTEND_OUT_DIR:-out}"
  BACKEND_DIR="${BACKEND_DIR:-}"
  BACKEND_BUILD_CMD="${BACKEND_BUILD_CMD:-}"
  BACKEND_RUN_CMD="${BACKEND_RUN_CMD:-java -jar /home/developer/backend.jar}"
  BACKEND_PORT="${BACKEND_PORT:-8081}"
  DB_NAME="${DB_NAME:-}"
  DB_USER="${DB_USER:-}"
  DB_PASSWORD="${DB_PASSWORD:-}"
  JWT_SECRET="${JWT_SECRET:-}"
  JWT_ISSUER="${JWT_ISSUER:-myapp}"

  export FRONTEND_DIR FRONTEND_OUT_DIR BACKEND_DIR BACKEND_BUILD_CMD BACKEND_RUN_CMD \
         BACKEND_PORT DB_NAME DB_USER DB_PASSWORD JWT_SECRET JWT_ISSUER PROJECT_NAME
}

# ─── Multi-repo detection ─────────────────────────────────────────────────────
# is_multirepo — returns 0 (true) if FRONTEND_DIR and BACKEND_DIR have different
# git roots, returns 1 if same repo or no backend.
is_multirepo() {
  [ -n "${BACKEND_DIR:-}" ] || return 1
  [ -d "${APP_ROOT}/${FRONTEND_DIR}" ] || return 1
  [ -d "${APP_ROOT}/${BACKEND_DIR}" ] || return 1

  local front_root back_root
  front_root=$(git -C "${APP_ROOT}/${FRONTEND_DIR}" rev-parse --show-toplevel 2>/dev/null) || return 1
  back_root=$(git -C "${APP_ROOT}/${BACKEND_DIR}" rev-parse --show-toplevel 2>/dev/null) || return 1

  [ "${front_root}" != "${back_root}" ]
}

# ─── Validation ───────────────────────────────────────────────────────────────
# validate_feature_name — errors if name doesn't match ^[a-z0-9-]+$
validate_feature_name() {
  local name="${1:-}"
  if ! echo "${name}" | grep -qE '^[a-z0-9-]+$'; then
    error "Feature name '${name}' is invalid — only lowercase letters, numbers, hyphens."
  fi
}

# ─── HTTP helpers ─────────────────────────────────────────────────────────────
# gateway_post PATH JSON_BODY — returns HTTP status code
gateway_post() {
  curl -s -o /dev/null -w "%{http_code}" -X POST "${GATEWAY_URL}/$1" \
    -H "Content-Type: application/json" -d "$2"
}

# gateway_delete PATH — returns HTTP status code
gateway_delete() {
  curl -s -o /dev/null -w "%{http_code}" -X DELETE "${GATEWAY_URL}/$1"
}

# ─── Stack Dockerfile templating ─────────────────────────────────────────────
# apply_stack_template SRC DEST
# Copy a stack Dockerfile template, substituting whitelisted qa-fleet.conf vars.
# The explicit whitelist is critical: a bare `envsubst` would eat ${PATH},
# ${HOME}, etc. in RUN steps. Only the listed vars are substituted; everything
# else passes through verbatim.
#
# Falls back to plain `cp` with a warning when `envsubst` (from gettext) is
# missing — callers still get a working Dockerfile with hardcoded defaults.
apply_stack_template() {
  local src="$1" dest="$2"
  if command -v envsubst >/dev/null 2>&1; then
    envsubst '${POSTGRES_VERSION} ${NODE_VERSION} ${JAVA_VERSION} ${GO_VERSION} ${BACKEND_PORT} ${FRONTEND_PORT} ${PROXY_PORT}' < "$src" > "$dest"
  else
    warn "envsubst not found (install 'gettext') — copying ${src##*/} without variable substitution"
    cp "$src" "$dest"
  fi
}
export -f apply_stack_template

# ─── Help ─────────────────────────────────────────────────────────────────────
show_help() {
  echo ""
  echo -e "${GREEN}fleet${RESET} — QA Fleet CLI"
  echo ""
  echo "Usage: fleet <command> [options]"
  echo ""
  echo "Commands:"
  echo -e "  ${BLUE}init${RESET}    <app-root> <branch>          Initialize fleet for a project"
  echo -e "  ${BLUE}add${RESET}     <name> <branch> [--direct]   Start a QA feature container"
  echo -e "  ${BLUE}rm${RESET}      <name>|--all|--nuke          Remove feature(s) or everything"
  echo -e "  ${BLUE}restart${RESET} <name>                       Restart a feature container"
  echo -e "  ${BLUE}feature${RESET} -c <name> [<branch>]         Create worktree+compose without starting"
  echo -e "  ${BLUE}push${RESET}    <name>                       Push worktree branch(es) to remote"
  echo -e "  ${BLUE}sync${RESET}    <name> [--regenerate-sources] Pull latest code and rebuild"
  echo -e "  ${BLUE}help${RESET}                                 Show this help"
  echo ""
  echo "Environment:"
  echo "  FLEET_GATEWAY   Gateway base URL (default: http://localhost:4000)"
  echo ""
}
