#!/bin/bash
set -euo pipefail

# ─── Color helpers ──────────────────────────────────────────────────────────
if [ -t 1 ]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; RESET=''
fi
info()  { echo -e "${GREEN}[fleet-add]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[fleet-add]${RESET} $*"; }
error() { echo -e "${RED}[fleet-add] ERROR:${RESET} $*" >&2; exit 1; }

# ─── Args ────────────────────────────────────────────────────────────────────
if [ -z "${1:-}" ] || [ -z "${2:-}" ]; then
  echo "Usage: $0 <name> <branch>"
  echo "  name   — lowercase letters, numbers, hyphens only"
  echo "  branch — git branch name"
  exit 1
fi

NAME="$1"
BRANCH="$2"

DIRECT=false
for arg in "${@:3}"; do
  [ "$arg" = "--direct" ] && DIRECT=true
done

if ! echo "$NAME" | grep -qE '^[a-z0-9-]+$'; then
  error "Feature name '$NAME' is invalid — only lowercase letters, numbers, hyphens."
fi

# ─── Paths ───────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ─── Load APP_ROOT from .fleet-config ────────────────────────────────────────
CONFIG_FILE="${FLEET_ROOT}/.fleet-config"
[ -f "${CONFIG_FILE}" ] || error ".fleet-config not found. Run fleet-init.sh first."
# shellcheck source=/dev/null
source "${CONFIG_FILE}"
[ -d "${APP_ROOT:-}" ] || error "APP_ROOT '${APP_ROOT:-}' does not exist (check .fleet-config)."

# ─── Load project config from fleet.conf ─────────────────────────────────────
FLEET_CONF="${APP_ROOT}/fleet.conf"
[ -f "${FLEET_CONF}" ] || error "fleet.conf not found in ${APP_ROOT}. Run fleet-init.sh first."
# shellcheck source=/dev/null
source "${FLEET_CONF}"

[ -n "${FRONTEND_DIR:-}" ] || error "FRONTEND_DIR is not set in fleet.conf"

# Derive project name from APP_ROOT if not set in fleet.conf
if [ -z "${PROJECT_NAME:-}" ]; then
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

WORKTREES_DIR="${APP_ROOT}/.fleet-worktrees"
WORKTREE_PATH="${WORKTREES_DIR}/${NAME}"
INFO_FILE="${FLEET_ROOT}/.fleet/${NAME}/info"
COMPOSE_FILE="${FLEET_ROOT}/.fleet/${NAME}/docker-compose.yml"

# ─── Guard: container must not already exist ─────────────────────────────────
if docker inspect "fleet-${NAME}" >/dev/null 2>&1; then
  error "Container 'fleet-${NAME}' already exists. Run: ./scripts/fleet-teardown.sh ${NAME}"
fi

# ─── Guard: base image must exist ────────────────────────────────────────────
docker inspect fleet-feature-base >/dev/null 2>&1 \
  || error "fleet-feature-base image not found. Run fleet-init.sh first."

# ─── Branch pre-flight check (skipped in direct mode) ────────────────────────
if [ "${DIRECT}" = "false" ]; then
  info "Verifying branch '${BRANCH}' exists in ${FRONTEND_DIR}..."
  git -C "${APP_ROOT}/${FRONTEND_DIR}" rev-parse --verify "${BRANCH}" >/dev/null 2>&1 \
    || git -C "${APP_ROOT}/${FRONTEND_DIR}" ls-remote --exit-code --heads origin "${BRANCH}" >/dev/null 2>&1 \
    || error "Branch '${BRANCH}' not found in ${FRONTEND_DIR} (local or remote)"
fi

# ─── Create worktrees (skipped in direct mode) ───────────────────────────────
if [ "${DIRECT}" = "true" ]; then
  WORKTREE_PATH="${APP_ROOT}"
  info "Direct mode — mounting real directories at ${APP_ROOT}"
else
  info "Creating worktrees for '${NAME}' (branch: ${BRANCH})..."
  mkdir -p "${WORKTREE_PATH}"

  # Build list of sub-directories to create worktrees for
  SUBDIRS=("${FRONTEND_DIR}")
  [ -n "${BACKEND_DIR}" ] && SUBDIRS+=("${BACKEND_DIR}")

  for sub in "${SUBDIRS[@]}"; do
    if [ ! -d "${APP_ROOT}/${sub}" ]; then
      warn "  ${sub} not found in APP_ROOT — skipping"
      continue
    fi
    info "  worktree: ${sub}..."
    git -C "${APP_ROOT}/${sub}" worktree add "${WORKTREE_PATH}/${sub}" "${BRANCH}" 2>/dev/null \
      || git -C "${APP_ROOT}/${sub}" worktree add -b "${BRANCH}" \
             "${WORKTREE_PATH}/${sub}" "origin/${BRANCH}" 2>/dev/null \
      || { warn "  Branch '${BRANCH}' not in ${sub} — using default HEAD"; \
           git -C "${APP_ROOT}/${sub}" worktree add "${WORKTREE_PATH}/${sub}"; }
  done
fi

# ─── Build extra mounts from .fleet-shared ───────────────────────────────────
SHARED_FILE="${APP_ROOT}/.fleet-shared"
EXTRA_MOUNTS=""
if [ -f "${SHARED_FILE}" ]; then
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    [[ "$path" == \#* ]] && continue
    src="${APP_ROOT}/${path}"
    if [ -e "$src" ]; then
      EXTRA_MOUNTS="${EXTRA_MOUNTS}      - ${src}:/app/${path}:ro\n"
    else
      warn "  .fleet-shared: '${path}' not found, skipping"
    fi
  done < "${SHARED_FILE}"
fi

# ─── Build conditional volume entries ────────────────────────────────────────
BACKEND_VOLUME=""
BACKEND_VOLUMES_DECL=""
if [ -n "${BACKEND_DIR}" ]; then
  BACKEND_VOLUME="      - fleet-${NAME}-target:/app/${BACKEND_DIR}/target"
  BACKEND_VOLUMES_DECL="  fleet-${NAME}-target:"
fi

# ─── Generate docker-compose.yml ─────────────────────────────────────────────
info "Generating docker-compose.yml..."
mkdir -p "${FLEET_ROOT}/.fleet/${NAME}"

cat > "${COMPOSE_FILE}" <<COMPOSE
services:
  ${NAME}:
    image: fleet-feature-base
    container_name: fleet-${NAME}
    networks:
      - fleet-net
    environment:
      - APP_NAME=${NAME}
      - BRANCH=${BRANCH}
      - PROJECT_NAME=${PROJECT_NAME}
      - FRONTEND_DIR=${FRONTEND_DIR}
      - FRONTEND_OUT_DIR=${FRONTEND_OUT_DIR}
      - BACKEND_DIR=${BACKEND_DIR}
      - BACKEND_BUILD_CMD=${BACKEND_BUILD_CMD}
      - BACKEND_RUN_CMD=${BACKEND_RUN_CMD}
      - BACKEND_PORT=${BACKEND_PORT}
      - DB_NAME=${DB_NAME}
      - DB_USER=${DB_USER}
      - DB_PASSWORD=${DB_PASSWORD}
      - JWT_SECRET=${JWT_SECRET}
      - JWT_ISSUER=${JWT_ISSUER}
    volumes:
      - ${WORKTREE_PATH}:/app
      - ${APP_ROOT}/${FRONTEND_DIR}/node_modules:/app-nm-seed:ro
      - fleet-${NAME}-nm:/app/${FRONTEND_DIR}/node_modules
${BACKEND_VOLUME}
$(echo -e "${EXTRA_MOUNTS}")
volumes:
  fleet-${NAME}-nm:
${BACKEND_VOLUMES_DECL}

networks:
  fleet-net:
    external: true
COMPOSE

# ─── Start container ─────────────────────────────────────────────────────────
info "Starting container fleet-${NAME} (branch: ${BRANCH})..."
info "The container will build the project internally — follow with:"
info "  docker logs -f fleet-${NAME}"

docker compose -f "${COMPOSE_FILE}" up -d

# ─── Persist feature metadata ─────────────────────────────────────────────────
printf 'NAME=%s\nBRANCH=%s\nWORKTREE_PATH=%s\nDIRECT=%s\nFRONTEND_DIR=%s\nBACKEND_DIR=%s\n' \
  "${NAME}" "${BRANCH}" "${WORKTREE_PATH}" "${DIRECT}" "${FRONTEND_DIR}" "${BACKEND_DIR}" \
  > "${INFO_FILE}"

# ─── Register with gateway ────────────────────────────────────────────────────
info "Registering '${NAME}' with gateway..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:4000/register-feature \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"${NAME}\",\"branch\":\"${BRANCH}\",\"worktreePath\":\"${WORKTREE_PATH}\",\"project\":\"${PROJECT_NAME}\"}")

if [ "$HTTP_STATUS" != "200" ]; then
  warn "Gateway registration returned HTTP ${HTTP_STATUS} (is the gateway running?)"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}┌──────────────────────────────────────────────────────────────┐${RESET}"
echo -e "${GREEN}│  ${NAME} container started (building internally...)           ${RESET}"
echo -e "${GREEN}│  Logs    → docker logs -f fleet-${NAME}                       ${RESET}"
echo -e "${GREEN}│  Branch  → ${BRANCH}                                          ${RESET}"
echo -e "${GREEN}│  Proxy   → http://localhost:3000  (auto-activated if first)   ${RESET}"
echo -e "${GREEN}└──────────────────────────────────────────────────────────────┘${RESET}"
