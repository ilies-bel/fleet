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
  echo "Usage: fleet add <name> --title <title> [--direct]"
  echo ""
  echo "  name     Feature name (lowercase letters, numbers, hyphens, dots)"
  echo "  --title  Human-readable title shown in the dashboard (required)"
  echo "  --direct Bind-mount the primary project checkout instead of a worktree."
  echo "           Live-tracks the working copy (including uncommitted changes)."
  echo "           The container's branch label reflects the primary checkout's HEAD."
  echo ""
  echo "  Starts a single container fleet-<name> that runs every [[services]]"
  echo "  and [[peers]] entry from .fleet/fleet.toml under supervisord."
  echo ""
  echo "  By default, requires a git worktree at the path resolved by"
  echo "  [project].worktree_template. Create one first:"
  echo "    git worktree add .worktrees/<name> <branch>"
  echo ""
  echo "Examples:"
  echo "  fleet add my-feature"
  echo "  fleet add my-feature --title 'My feature title'"
  echo "  fleet add qa-main --direct"
  exit 1
}

# ─── Args ────────────────────────────────────────────────────────────────────
if [ -z "${1:-}" ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
fi

NAME="$1"
shift

validate_feature_name "${NAME}"

# Parse remaining args: --title, --direct
FEATURE_TITLE=""
DIRECT=false
while [ $# -gt 0 ]; do
  case "$1" in
    --title)
      [ -n "${2:-}" ] || error "fleet add: --title requires a value"
      FEATURE_TITLE="$2"
      shift 2
      ;;
    --direct)
      DIRECT=true
      shift
      ;;
    *)
      error "fleet add: unknown argument '$1'. See: fleet add --help"
      ;;
  esac
done

# ─── Load fleet.toml ─────────────────────────────────────────────────────────
load_fleet_toml

_PYBIN=$(_find_python_with_tomllib) \
  || error "No python3 with tomllib/tomli found. Install python >=3.11 or: pip3 install tomli"

# ─── Resolve source path (worktree by default, project root in --direct mode) ─
# In --direct mode, skip worktree and bind-mount the primary checkout live.
if [ "${DIRECT}" = true ]; then
  WORKTREE_PATH="${FLEET_PROJECT_ROOT}"
  info "Direct mode — mounting primary checkout at ${WORKTREE_PATH}"
else
  # worktree_template must be set in fleet.toml [project] section.
  if [ -z "${FLEET_WORKTREE_TEMPLATE:-}" ]; then
    error "fleet add: [project].worktree_template is not set in .fleet/fleet.toml.
  Add it under [project]:
    worktree_template = \".worktrees/{name}\"
  Then run: fleet init (to regenerate) or edit .fleet/fleet.toml manually.
  (Or pass --direct to bind-mount the primary checkout without a worktree.)"
  fi

  WORKTREE_PATH=$(fleet_resolve_worktree "${NAME}")

  # Verify the resolved path is an active git worktree (not just any directory)
  if ! git -C "${WORKTREE_PATH}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    error "fleet add: worktree '${WORKTREE_PATH}' does not exist.
  Create it first:
    git worktree add ${WORKTREE_PATH} <branch>
  Or pass --direct to bind-mount the primary checkout without a worktree."
  fi
fi

# ─── Resolve the feature title ────────────────────────────────────────────────
# --title flag takes precedence; interactive prompt if tty (no default, loops
# until non-empty); non-interactive without --title is a hard error.
if [ -z "${FEATURE_TITLE}" ]; then
  if [ -t 0 ]; then
    while [ -z "${FEATURE_TITLE}" ]; do
      printf "  Feature title (shown in dashboard): "
      read -r FEATURE_TITLE </dev/tty
      if [ -z "${FEATURE_TITLE}" ]; then
        printf "  Title cannot be empty.\n"
      fi
    done
  else
    error "fleet add: --title is required (no TTY for interactive prompt)"
  fi
fi

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

  # Mount from the worktree, not the primary checkout
  svc_abs_path="${WORKTREE_PATH}/${svc_dir}"
  [ -d "${svc_abs_path}" ] \
    || error "Service '${svc_name}': '${svc_abs_path}' does not exist in worktree.
  Expected: ${WORKTREE_PATH}/${svc_dir}
  Check that the worktree branch has the service directory and that 'dir' in .fleet/fleet.toml is correct."

  # Read the real branch from the worktree itself
  branch=$(git -C "${WORKTREE_PATH}" branch --show-current 2>/dev/null || echo "")
  if [ -z "${branch}" ]; then
    branch=$(git -C "${WORKTREE_PATH}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
  fi
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

# ─── Representative branch (read from the worktree itself) ───────────────────
# SVC_BRANCHES[0] already reflects the worktree's real branch (set above).
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

# ─── Per-service env vars (from fleet.toml services[].env) ───────────────────
# Collect all env entries across services, warn on key collision, last-write-wins.
"${_PYBIN}" - "${FLEET_SERVICES_JSON}" "${ENV_FILE}" <<'PYEOF'
import sys, json

services_json = sys.argv[1]
env_file      = sys.argv[2]

services = json.loads(services_json)

seen = {}   # key -> service name that first declared it
lines = []  # (key, value) pairs in emit order

for svc in services:
    svc_name = svc.get("name", "")
    env      = svc.get("env", {})
    if not isinstance(env, dict):
        continue
    for k, v in env.items():
        if k in seen:
            print(
                f"[fleet] WARN: env key '{k}' declared in service '{seen[k]}'"
                f" overridden by service '{svc_name}'",
                file=sys.stderr,
            )
            # Replace the earlier entry (last-write-wins)
            lines = [(lk, lv) for lk, lv in lines if lk != k]
        seen[k] = svc_name
        lines.append((k, str(v)))

if lines:
    with open(env_file, "a") as fh:
        for k, v in lines:
            fh.write(f"{k}={v}\n")
PYEOF

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
  # For shared_paths: node_modules gets a per-(project,service,arch) named docker
  # volume (arch-correct native binaries, shared across features, survives rm/add).
  # Other shared_paths keep the legacy host bind-mount.
  CONTAINER_ARCH=$(docker version -f '{{.Server.Arch}}' 2>/dev/null || echo unknown)
  declare -a NODEMOD_VOLS=()   # named volumes we need to declare at the bottom
  for i in "${!SVC_NAMES[@]}"; do
    echo "      - ${SVC_ABS_PATHS[$i]}:/app/${SVC_NAMES[$i]}:cached"
    svc_stack_type="${SVC_STACKS[$i]}"
    svc_dir_rel="${SVC_ABS_PATHS[$i]#${WORKTREE_PATH}/}"  # strip worktree prefix → relative dir
    while IFS= read -r shared_path; do
      [ -z "${shared_path}" ] && continue
      TARGET="/app/${SVC_NAMES[$i]}/${shared_path}"
      if [ "${shared_path}" = "node_modules" ]; then
        # Named volume: fleet-nodemod-<project>-<service>-<arch>
        vol_name="fleet-nodemod-${FLEET_PROJECT_NAME}-${SVC_NAMES[$i]}-${CONTAINER_ARCH}"
        docker volume inspect "${vol_name}" >/dev/null 2>&1 \
          || docker volume create "${vol_name}" >/dev/null \
          || error "Failed to create named volume '${vol_name}'."
        echo "      - ${vol_name}:${TARGET}"
        NODEMOD_VOLS+=("${vol_name}")
      else
        SOURCE="${FLEET_PROJECT_ROOT}/${svc_dir_rel}/${shared_path}"
        [ -d "${SOURCE}" ] \
          || error "Shared path source missing: ${SOURCE}. Populate it first."
        echo "      - ${SOURCE}:${TARGET}:cached"
      fi
    done < <(fleet_stack_shared_paths "${svc_stack_type}" 2>/dev/null || true)
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
  # Declare any node_modules named volumes used above (external — pre-created).
  if [ "${#NODEMOD_VOLS[@]}" -gt 0 ]; then
    echo ""
    echo "volumes:"
    for vol in "${NODEMOD_VOLS[@]}"; do
      echo "  ${vol}:"
      echo "    external: true"
    done
  fi
} > "${COMPOSE_FILE}"

# ─── Write .fleet/<name>/info.toml ───────────────────────────────────────────
info "Writing .fleet/${NAME}/info.toml..."

{
  echo "[feature]"
  echo "name    = \"${NAME}\""
  echo "title   = \"${FEATURE_TITLE}\""
  echo "project = \"${FLEET_PROJECT_NAME}\""
  echo "worktree = \"${WORKTREE_PATH}\""
  echo "direct  = ${DIRECT}"
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
  "{\"name\":\"${NAME}\",\"branch\":\"${FIRST_BRANCH}\",\"worktreePath\":\"${WORKTREE_PATH}\",\"project\":\"${FLEET_PROJECT_NAME}\",\"services\":${services_json}}")

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
