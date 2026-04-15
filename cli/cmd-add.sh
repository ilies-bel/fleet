#!/bin/bash
set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export FLEET_ROOT

# Source shared library
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

# ─── Args ────────────────────────────────────────────────────────────────────
if [ -z "${1:-}" ] || [ -z "${2:-}" ]; then
  echo "Usage: fleet add <name> <branch> [--direct]"
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

validate_feature_name "${NAME}"

QA_FLEET_ROOT="${FLEET_ROOT}"

# ─── Load config ─────────────────────────────────────────────────────────────
load_qa_config
load_fleet_conf

# ─── Defaults for port / path knobs (also applied in cmd-init.sh) ────────────
# Older fleet.conf files lack these keys — fall back to the same baseline
# cmd-init.sh uses, so the feature container and gateway agree on ports.
: "${PROXY_PORT:=3000}"
: "${ADMIN_PORT:=4000}"
: "${DB_PORT:=5432}"
: "${BACKEND_ARTIFACT_PATH:=/home/developer/backend.jar}"
export PROXY_PORT ADMIN_PORT DB_PORT BACKEND_ARTIFACT_PATH

WORKTREES_DIR="${APP_ROOT}/.fleet-worktrees"
WORKTREE_PATH="${WORKTREES_DIR}/${NAME}"
INFO_FILE="${QA_FLEET_ROOT}/.fleet/${NAME}/info"
COMPOSE_FILE="${QA_FLEET_ROOT}/.fleet/${NAME}/docker-compose.yml"

# ─── Guard: container must not already exist ─────────────────────────────────
if docker inspect "fleet-${NAME}" >/dev/null 2>&1; then
  error "Container 'fleet-${NAME}' already exists. Run: fleet rm ${NAME}"
fi

# ─── Guard: base image must exist ────────────────────────────────────────────
docker inspect fleet-feature-base >/dev/null 2>&1 \
  || error "fleet-feature-base image not found. Run: fleet init first."

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
mkdir -p "${QA_FLEET_ROOT}/.fleet/${NAME}"

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
      - BACKEND_ARTIFACT_PATH=${BACKEND_ARTIFACT_PATH}
      - DB_NAME=${DB_NAME}
      - DB_USER=${DB_USER}
      - DB_PASSWORD=${DB_PASSWORD}
      - DB_HOST=127.0.0.1
      - DB_PORT=5432
      - PROXY_PORT=${PROXY_PORT}
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
HTTP_STATUS=$(gateway_post "register-feature" \
  "{\"name\":\"${NAME}\",\"branch\":\"${BRANCH}\",\"worktreePath\":\"${WORKTREE_PATH}\",\"project\":\"${PROJECT_NAME}\"}")

if [ "$HTTP_STATUS" != "200" ]; then
  warn "Gateway registration returned HTTP ${HTTP_STATUS} (is the gateway running?)"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}┌──────────────────────────────────────────────────────────────┐${RESET}"
echo -e "${GREEN}│  ${NAME} container started (building internally...)           ${RESET}"
echo -e "${GREEN}│  Logs    → docker logs -f fleet-${NAME}                       ${RESET}"
echo -e "${GREEN}│  Branch  → ${BRANCH}                                          ${RESET}"
echo -e "${GREEN}│  Proxy   → http://localhost:${PROXY_PORT}  (auto-activated if first)   ${RESET}"
echo -e "${GREEN}└──────────────────────────────────────────────────────────────┘${RESET}"
