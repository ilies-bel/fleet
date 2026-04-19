#!/bin/bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export FLEET_ROOT

# Source shared library
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

# ─── Usage ───────────────────────────────────────────────────────────────────
usage() {
  echo "Usage: fleet add <name>"
  echo ""
  echo "  name    Feature name (lowercase letters, numbers, hyphens, dots)"
  echo ""
  echo "  Starts a single container fleet-<name> that runs every [[services]]"
  echo "  and [[peers]] entry from .fleet/fleet.toml under supervisord."
  echo ""
  echo "Examples:"
  echo "  fleet add my-feature"
  exit 1
}

# ─── Args ────────────────────────────────────────────────────────────────────
if [ -z "${1:-}" ]; then
  usage
fi

NAME="$1"
shift

validate_feature_name "${NAME}"

if [ $# -gt 0 ]; then
  error "fleet add no longer accepts extra arguments. All services run in one container."
fi

# ─── Load fleet.toml ─────────────────────────────────────────────────────────
load_fleet_toml

_PYBIN=$(_find_python_with_tomllib) \
  || error "No python3 with tomllib/tomli found. Install python >=3.11 or: pip3 install tomli"

# ─── Guard: duplicate feature ────────────────────────────────────────────────
FEATURE_DIR="${FLEET_ROOT}/.fleet/${NAME}"
INFO_TOML="${FEATURE_DIR}/info.toml"

if [ -f "${INFO_TOML}" ]; then
  error "Feature '${NAME}' already exists (.fleet/${NAME}/info.toml). Run: fleet rm ${NAME}"
fi

# ─── Validate + enumerate services ───────────────────────────────────────────
svc_count=$("${_PYBIN}" -c "import sys,json; print(len(json.loads(sys.argv[1])))" "${FLEET_SERVICES_JSON}")
if [ "${svc_count}" -eq 0 ]; then
  error "No [[services]] defined in .fleet/fleet.toml. Run: fleet init"
fi

declare -a SVC_NAMES=()
declare -a SVC_ABS_PATHS=()
declare -a SVC_STACKS=()
declare -a SVC_RUNS=()
declare -a SVC_PORTS=()
declare -a SVC_BRANCHES=()

for idx in $(seq 0 $((svc_count - 1))); do
  _at() { "${_PYBIN}" -c "import sys,json; a=json.loads(sys.argv[1]); print(a[int(sys.argv[2])].get(sys.argv[3],''))" "${FLEET_SERVICES_JSON}" "$idx" "$1"; }

  svc_name=$(_at name)
  svc_dir=$(  _at dir)
  svc_stack=$(_at stack)
  svc_run=$(  _at run)
  svc_port=$( _at port)

  svc_abs_path="${FLEET_PROJECT_ROOT}/${svc_dir}"
  [ -d "${svc_abs_path}" ] \
    || error "Service '${svc_name}': '${svc_abs_path}' does not exist. Check project.root in .fleet/fleet.toml."

  branch=$(git -C "${svc_abs_path}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
  [ "${branch}" = "HEAD" ] && branch="main"

  SVC_NAMES+=("${svc_name}")
  SVC_ABS_PATHS+=("${svc_abs_path}")
  SVC_STACKS+=("${svc_stack}")
  SVC_RUNS+=("${svc_run}")
  SVC_PORTS+=("${svc_port}")
  SVC_BRANCHES+=("${branch}")
done

# ─── Enumerate peers ─────────────────────────────────────────────────────────
peer_count=$("${_PYBIN}" -c "import sys,json; print(len(json.loads(sys.argv[1])))" "${FLEET_PEERS_JSON}")

declare -a PEER_NAMES=()
declare -a PEER_TYPES=()
declare -a PEER_PORTS=()
declare -a PEER_MAPPINGS_ABS=()
declare -a PEER_FILES_ABS=()

if [ "${peer_count}" -gt 0 ]; then
  for idx in $(seq 0 $((peer_count - 1))); do
    _pat() { "${_PYBIN}" -c "import sys,json; a=json.loads(sys.argv[1]); print(a[int(sys.argv[2])].get(sys.argv[3],''))" "${FLEET_PEERS_JSON}" "$idx" "$1"; }

    peer_name=$(_pat name)
    peer_type=$(_pat type)
    peer_port=$(_pat port)
    peer_mappings=$(_pat mappings)
    peer_files=$(_pat files)

    PEER_NAMES+=("${peer_name}")
    PEER_TYPES+=("${peer_type}")
    PEER_PORTS+=("${peer_port}")
    [ -n "${peer_mappings}" ] && PEER_MAPPINGS_ABS+=("${FLEET_PROJECT_ROOT}/${peer_mappings}") || PEER_MAPPINGS_ABS+=("")
    [ -n "${peer_files}" ]    && PEER_FILES_ABS+=("${FLEET_PROJECT_ROOT}/${peer_files}")       || PEER_FILES_ABS+=("")
  done
fi

# ─── Determine if postgres is needed (spring/gradle services) ────────────────
NEEDS_DB=false
for stack in "${SVC_STACKS[@]}"; do
  case "${stack}" in spring|gradle) NEEDS_DB=true ;; esac
done

SIDECAR_DB_NAME="${DB_NAME:-${FLEET_PROJECT_NAME}}"
SIDECAR_DB_USER="${DB_USER:-${FLEET_PROJECT_NAME}}"
SIDECAR_DB_PASSWORD="${DB_PASSWORD:-${FLEET_PROJECT_NAME}}"

# ─── Representative branch (first service) ───────────────────────────────────
FIRST_BRANCH="${SVC_BRANCHES[0]}"

# ─── Create feature dir ───────────────────────────────────────────────────────
mkdir -p "${FEATURE_DIR}"

# ─── Write feature.env (holds JSON payloads; avoids YAML quoting hazards) ────
# Docker Compose env_file= reads KEY=VALUE lines. JSON values are safe here
# because the file is parsed as raw text before being passed to the container.
ENV_FILE="${FEATURE_DIR}/feature.env"
{
  printf 'APP_NAME=%s\n'              "${NAME}"
  printf 'BRANCH=%s\n'               "${FIRST_BRANCH}"
  printf 'PROJECT_NAME=%s\n'         "${FLEET_PROJECT_NAME}"
  printf 'FLEET_SERVICES_JSON=%s\n'  "${FLEET_SERVICES_JSON}"
  printf 'FLEET_PEERS_JSON=%s\n'     "${FLEET_PEERS_JSON}"
  if [ "${NEEDS_DB}" = true ]; then
    printf 'DB_NAME=%s\n'                    "${SIDECAR_DB_NAME}"
    printf 'DB_USER=%s\n'                    "${SIDECAR_DB_USER}"
    printf 'DB_PASSWORD=%s\n'               "${SIDECAR_DB_PASSWORD}"
    printf 'SPRING_DATASOURCE_URL=%s\n'      "jdbc:postgresql://127.0.0.1:5432/${SIDECAR_DB_NAME}"
    printf 'SPRING_DATASOURCE_USERNAME=%s\n' "${SIDECAR_DB_USER}"
    printf 'SPRING_DATASOURCE_PASSWORD=%s\n' "${SIDECAR_DB_PASSWORD}"
    printf 'SPRING_LIQUIBASE_URL=%s\n'       "jdbc:postgresql://127.0.0.1:5432/${SIDECAR_DB_NAME}"
    printf 'SPRING_LIQUIBASE_USER=%s\n'      "${SIDECAR_DB_USER}"
    printf 'SPRING_LIQUIBASE_PASSWORD=%s\n'  "${SIDECAR_DB_PASSWORD}"
    printf 'TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal\n'
  fi
  [ -n "${JWT_SECRET:-}" ] && printf 'JWT_SECRET=%s\n' "${JWT_SECRET}"
  [ -n "${JWT_ISSUER:-}" ] && printf 'JWT_ISSUER=%s\n'  "${JWT_ISSUER}"
} > "${ENV_FILE}"

# ─── Generate docker-compose.yml (ONE service per feature) ───────────────────
info "Generating .fleet/${NAME}/docker-compose.yml..."
COMPOSE_FILE="${FEATURE_DIR}/docker-compose.yml"

{
  echo "services:"
  echo "  ${NAME}:"
  echo "    image: fleet-feature-base"
  echo "    container_name: fleet-${NAME}"
  echo "    env_file:"
  echo "      - feature.env"
  echo "    volumes:"
  # Each service source tree → /app/<svc_name>
  for i in "${!SVC_NAMES[@]}"; do
    echo "      - ${SVC_ABS_PATHS[$i]}:/app/${SVC_NAMES[$i]}:cached"
  done
  # Wiremock peers: bind mappings → /app/<peer_name>/mappings
  #                               → /app/<peer_name>/__files
  # static-http peers: bind root dir → /app/<peer_name>
  for i in "${!PEER_NAMES[@]}"; do
    peer_nm="${PEER_NAMES[$i]}"
    peer_tp="${PEER_TYPES[$i]}"
    peer_map="${PEER_MAPPINGS_ABS[$i]}"
    peer_fil="${PEER_FILES_ABS[$i]}"
    if [ "${peer_tp}" = "wiremock" ]; then
      [ -n "${peer_map}" ] && echo "      - ${peer_map}:/app/${peer_nm}/mappings:ro"
      [ -n "${peer_fil}" ] && echo "      - ${peer_fil}:/app/${peer_nm}/__files:ro"
    elif [ "${peer_tp}" = "static-http" ]; then
      [ -n "${peer_map}" ] && echo "      - ${peer_map}:/app/${peer_nm}:ro"
    fi
  done
  # Docker socket for Testcontainers (spring/gradle stacks only)
  _needs_sock=false
  for stack in "${SVC_STACKS[@]}"; do
    case "${stack}" in spring|gradle) _needs_sock=true ;; esac
  done
  if [ "${_needs_sock}" = true ]; then
    echo "      - /var/run/docker.sock:/var/run/docker.sock"
  fi
  echo "    networks:"
  echo "      - fleet-net"
  # label:disable only needed when docker.sock is mounted
  if [ "${_needs_sock}" = true ]; then
    echo "    security_opt:"
    echo "      - label:disable"
  fi
  echo ""
  echo "networks:"
  echo "  fleet-net:"
  echo "    external: true"
} > "${COMPOSE_FILE}"

# ─── Write .fleet/<name>/info.toml ───────────────────────────────────────────
info "Writing .fleet/${NAME}/info.toml..."

{
  echo "[feature]"
  echo "name    = \"${NAME}\""
  echo "project = \"${FLEET_PROJECT_NAME}\""
  echo ""
  for i in "${!SVC_NAMES[@]}"; do
    echo "[[services]]"
    echo "name   = \"${SVC_NAMES[$i]}\""
    echo "dir    = \"${SVC_ABS_PATHS[$i]}\""
    echo "branch = \"${SVC_BRANCHES[$i]}\""
    [ -n "${SVC_STACKS[$i]}" ] && echo "stack  = \"${SVC_STACKS[$i]}\""
    [ -n "${SVC_PORTS[$i]}" ]  && echo "port   = ${SVC_PORTS[$i]}"
    echo ""
  done
  for i in "${!PEER_NAMES[@]}"; do
    echo "[[peers]]"
    echo "name = \"${PEER_NAMES[$i]}\""
    echo "type = \"${PEER_TYPES[$i]}\""
    [ -n "${PEER_PORTS[$i]}" ] && echo "port = ${PEER_PORTS[$i]}"
    echo ""
  done
} > "${INFO_TOML}"

# ─── Bring up the single feature container ───────────────────────────────────
info "Starting container fleet-${NAME}..."
docker compose -f "${COMPOSE_FILE}" up -d

# ─── Register with gateway ───────────────────────────────────────────────────
# Payload: {name, branch, worktreePath, project, services:[{name,port}]}
# Peers are internal-only — not included in the gateway registration payload.
services_json=$("${_PYBIN}" -c "
import sys, json
svcs = json.loads(sys.argv[1])
out = [{'name': s['name'], 'port': int(s['port'])} for s in svcs if s.get('port')]
print(json.dumps(out))
" "${FLEET_SERVICES_JSON}")

info "Registering '${NAME}' with gateway..."
HTTP_STATUS=$(gateway_post "register-feature" \
  "{\"name\":\"${NAME}\",\"branch\":\"${FIRST_BRANCH}\",\"worktreePath\":\"${FLEET_PROJECT_ROOT}\",\"project\":\"${FLEET_PROJECT_NAME}\",\"services\":${services_json}}")

if [ "${HTTP_STATUS}" != "200" ]; then
  warn "Gateway registration returned HTTP ${HTTP_STATUS} (is the gateway running?)"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}┌──────────────────────────────────────────────────────────────┐${RESET}"
echo -e "${GREEN}│  '${NAME}' started                                           ${RESET}"
echo -e "${GREEN}│    container : fleet-${NAME}                                 ${RESET}"
echo -e "${GREEN}│    services  : ${svc_count}                                  ${RESET}"
if [ "${peer_count}" -gt 0 ]; then
  echo -e "${GREEN}│    peers     : ${peer_count} (internal)                    ${RESET}"
fi
echo -e "${GREEN}│  Proxy  → http://localhost:${FLEET_PORT_PROXY}               ${RESET}"
echo -e "${GREEN}│  Logs   → docker logs -f fleet-${NAME}                       ${RESET}"
echo -e "${GREEN}│  Status → docker exec fleet-${NAME} supervisorctl status     ${RESET}"
echo -e "${GREEN}└──────────────────────────────────────────────────────────────┘${RESET}"
