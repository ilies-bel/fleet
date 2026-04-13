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

# ─── Parse -c flag ───────────────────────────────────────────────────────────
CREATE_MODE=false
NAME=""
BRANCH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c) CREATE_MODE=true; NAME="${2:-}"; shift 2 ;;
    *) [ -z "$BRANCH" ] && BRANCH="$1" || true; shift ;;
  esac
done

if [ "$CREATE_MODE" = false ] || [ -z "$NAME" ]; then
  echo "Usage: fleet feature -c <name> [<branch>]"
  echo "  -c <name>   Feature/container name to create (not started)"
  echo "  <branch>    Branch to check out (default: current branch)"
  exit 1
fi

validate_feature_name "$NAME"
load_qa_config
load_fleet_conf

# ─── Default branch to current if not specified ───────────────────────────────
if [ -z "$BRANCH" ]; then
  BRANCH=$(git -C "${APP_ROOT}/${FRONTEND_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null \
    || git -C "${APP_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null \
    || error "Could not detect current branch")
  info "Using current branch: $BRANCH"
fi

# ─── Guard: already exists? ───────────────────────────────────────────────────
if [ -f "${QA_FLEET_ROOT}/.qa/${NAME}/info" ]; then
  error "Feature '${NAME}' already exists. Run: fleet rm ${NAME}"
fi

WORKTREES_DIR="${APP_ROOT}/.qa-worktrees"
WORKTREE_PATH="${WORKTREES_DIR}/${NAME}"

# ─── Create worktrees ─────────────────────────────────────────────────────────
info "Creating worktrees for '${NAME}' (branch: ${BRANCH})..."
mkdir -p "${WORKTREE_PATH}"

SUBDIRS=("${FRONTEND_DIR}")
[ -n "${BACKEND_DIR:-}" ] && SUBDIRS+=("${BACKEND_DIR}")

for sub in "${SUBDIRS[@]}"; do
  [ -d "${APP_ROOT}/${sub}" ] || { warn "  ${sub} not found — skipping"; continue; }
  info "  worktree: ${sub}..."
  git -C "${APP_ROOT}/${sub}" worktree add "${WORKTREE_PATH}/${sub}" "${BRANCH}" 2>/dev/null \
    || git -C "${APP_ROOT}/${sub}" worktree add -b "${BRANCH}" "${WORKTREE_PATH}/${sub}" "origin/${BRANCH}" 2>/dev/null \
    || { warn "  Branch '${BRANCH}' not in ${sub} — using HEAD"; git -C "${APP_ROOT}/${sub}" worktree add "${WORKTREE_PATH}/${sub}"; }
done

# ─── Build compose (no docker compose up) ────────────────────────────────────
info "Generating docker-compose.yml..."
mkdir -p "${QA_FLEET_ROOT}/.qa/${NAME}"
COMPOSE_FILE="${QA_FLEET_ROOT}/.qa/${NAME}/docker-compose.yml"
INFO_FILE="${QA_FLEET_ROOT}/.qa/${NAME}/info"

BACKEND_VOLUME=""
BACKEND_VOLUMES_DECL=""
if [ -n "${BACKEND_DIR:-}" ]; then
  BACKEND_VOLUME="      - qa-${NAME}-target:/app/${BACKEND_DIR}/target"
  BACKEND_VOLUMES_DECL="  qa-${NAME}-target:"
fi

# Build EXTRA_MOUNTS from .qa-shared
SHARED_FILE="${APP_ROOT}/.qa-shared"
EXTRA_MOUNTS=""
if [ -f "${SHARED_FILE}" ]; then
  while IFS= read -r path; do
    [ -z "$path" ] && continue; [[ "$path" == \#* ]] && continue
    src="${APP_ROOT}/${path}"
    [ -e "$src" ] && EXTRA_MOUNTS="${EXTRA_MOUNTS}      - ${src}:/app/${path}:ro\n" \
      || warn "  .qa-shared: '$path' not found, skipping"
  done < "${SHARED_FILE}"
fi

# Get PROJECT_NAME (already set by load_fleet_conf)
if [ -z "${PROJECT_NAME:-}" ]; then
  _app_basename="$(basename "${APP_ROOT}")"
  [ "${_app_basename}" = "app" ] && PROJECT_NAME="$(basename "$(dirname "${APP_ROOT}")")" || PROJECT_NAME="${_app_basename}"
fi

cat > "${COMPOSE_FILE}" <<COMPOSE
services:
  ${NAME}:
    image: qa-feature-base
    container_name: qa-${NAME}
    networks:
      - qa-net
    environment:
      - APP_NAME=${NAME}
      - BRANCH=${BRANCH}
      - PROJECT_NAME=${PROJECT_NAME}
      - FRONTEND_DIR=${FRONTEND_DIR}
      - FRONTEND_OUT_DIR=${FRONTEND_OUT_DIR:-out}
      - BACKEND_DIR=${BACKEND_DIR:-}
      - BACKEND_BUILD_CMD=${BACKEND_BUILD_CMD:-}
      - BACKEND_RUN_CMD=${BACKEND_RUN_CMD:-java -jar /home/developer/backend.jar}
      - BACKEND_PORT=${BACKEND_PORT:-8081}
      - DB_NAME=${DB_NAME:-}
      - DB_USER=${DB_USER:-}
      - DB_PASSWORD=${DB_PASSWORD:-}
      - JWT_SECRET=${JWT_SECRET:-}
      - JWT_ISSUER=${JWT_ISSUER:-myapp}
    volumes:
      - ${WORKTREE_PATH}:/app
      - ${APP_ROOT}/${FRONTEND_DIR}/node_modules:/app-nm-seed:ro
      - qa-${NAME}-nm:/app/${FRONTEND_DIR}/node_modules
${BACKEND_VOLUME}
$(echo -e "${EXTRA_MOUNTS}")
volumes:
  qa-${NAME}-nm:
${BACKEND_VOLUMES_DECL}

networks:
  qa-net:
    external: true
COMPOSE

# ─── Save info file with STATUS=not_started ───────────────────────────────────
printf 'NAME=%s\nBRANCH=%s\nWORKTREE_PATH=%s\nDIRECT=false\nFRONTEND_DIR=%s\nBACKEND_DIR=%s\nSTATUS=not_started\n' \
  "${NAME}" "${BRANCH}" "${WORKTREE_PATH}" "${FRONTEND_DIR}" "${BACKEND_DIR:-}" \
  > "${INFO_FILE}"

# ─── Register with gateway as not_started ────────────────────────────────────
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:4000/register-feature \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"${NAME}\",\"branch\":\"${BRANCH}\",\"worktreePath\":\"${WORKTREE_PATH}\",\"project\":\"${PROJECT_NAME}\",\"status\":\"not_started\"}" 2>/dev/null || echo "000")

[ "${HTTP_STATUS}" = "200" ] && info "Registered with gateway (status: not_started)" \
  || warn "Gateway registration returned HTTP ${HTTP_STATUS} (is gateway running?)"

echo ""
echo -e "${GREEN}┌──────────────────────────────────────────────────────────────┐${RESET}"
echo -e "${GREEN}│  Feature '${NAME}' created (NOT STARTED)                      ${RESET}"
echo -e "${GREEN}│  Branch  → ${BRANCH}                                          ${RESET}"
echo -e "${GREEN}│  Start   → fleet add ${NAME} ${BRANCH}                        ${RESET}"
echo -e "${GREEN}└──────────────────────────────────────────────────────────────┘${RESET}"
