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
  echo "Usage: fleet add <name> [--title <title>] [--direct]"
  echo ""
  echo "  name     Feature name (lowercase letters, numbers, hyphens, dots)"
  echo "  --title  Human-readable title shown in the dashboard (optional)"
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
# --title flag takes precedence; interactive prompt if tty; fallback to NAME.
if [ -z "${FEATURE_TITLE}" ]; then
  if [ -t 0 ]; then
    printf "  Feature title (shown in dashboard) [%s]: " "${NAME}"
    read -r FEATURE_TITLE </dev/tty
    FEATURE_TITLE="${FEATURE_TITLE:-${NAME}}"
  else
    FEATURE_TITLE="${NAME}"
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

# ─── Determine if embedded postgres is needed (spring/gradle services) ────────
EMBEDDED_DB=false
for stack in "${SVC_STACKS[@]}"; do
  case "${stack}" in spring|gradle) EMBEDDED_DB=true ;; esac
done

# ─── Representative branch (read from the worktree itself) ───────────────────
# SVC_BRANCHES[0] already reflects the worktree's real branch (set above).
FIRST_BRANCH="${SVC_BRANCHES[0]}"

# ─── Compute gateway registration payload early ──────────────────────────────
# We register BEFORE docker compose up so the dashboard can show a 'building'
# chip during the slowest phase of the add flow (image build + compose up).
# The payload needs services_json and title_json — both derive only from
# FLEET_SERVICES_JSON and FEATURE_TITLE, which are already finalised above.
services_json=$("${_PYBIN}" -c "
import sys, json
svcs = json.loads(sys.argv[1])
out = [{'name': s['name'], 'port': int(s['port'])} for s in svcs if s.get('port')]
print(json.dumps(out))
" "${FLEET_SERVICES_JSON}")

title_json=$("${_PYBIN}" -c "import sys, json; print(json.dumps(sys.argv[1]))" "${FEATURE_TITLE}")

# ─── Create feature dir ───────────────────────────────────────────────────────
mkdir -p "${FEATURE_DIR}"

# ─── Register EARLY with status='building' ───────────────────────────────────
# If this initial registration fails, we exit loudly (preserves yn2's intent:
# the user needs to know when the gateway is unreachable — silently proceeding
# with docker compose up gives a running container that nothing can route to).
info "Registering '${NAME}' with gateway (status=building)..."
_GW_RESULT=$(gateway_post_full "register-feature" \
  "{\"name\":\"${NAME}\",\"branch\":\"${FIRST_BRANCH}\",\"worktreePath\":\"${WORKTREE_PATH}\",\"project\":\"${FLEET_PROJECT_NAME}\",\"title\":${title_json},\"services\":${services_json},\"status\":\"building\"}")
HTTP_STATUS="${_GW_RESULT%|*}"
_GW_BODY_FILE="${_GW_RESULT#*|}"
_GW_BODY=$(cat "${_GW_BODY_FILE}" 2>/dev/null || true)
rm -f "${_GW_BODY_FILE}"

if [ "${HTTP_STATUS}" != "200" ]; then
  _GW_BODY_HINT=""
  [ -n "${_GW_BODY}" ] && _GW_BODY_HINT="\n  response  : ${_GW_BODY}"
  error "Gateway registration failed.
  HTTP status: ${HTTP_STATUS}
  endpoint   : ${GATEWAY_URL}/register-feature
  feature    : ${NAME}${_GW_BODY_HINT}

  Remediation:
    Inspect   → curl -sS ${GATEWAY_URL}/_fleet/api/features
    Abandon   → docker stop fleet-${NAME}
    Retry     → re-run: fleet add ${NAME} --title '${FEATURE_TITLE}'"
fi

# ─── Failure handler: on any fatal error past this point, PATCH 'failed' ──────
# The ERR trap captures the last command's failure context. We best-effort
# extract a stderr tail into the error message so the dashboard can render
# something more actionable than 'something went wrong'. Trap exits 1 itself
# so CLI callers (and yn2's contract) still see a non-zero exit.
_FLEET_FAIL_LOG=$(mktemp)
_on_failure() {
  local rc=$?
  local ctx="fleet add failed (exit ${rc})"
  if [ -s "${_FLEET_FAIL_LOG}" ]; then
    local tail_err
    tail_err=$(tail -c 500 "${_FLEET_FAIL_LOG}" 2>/dev/null || true)
    [ -n "${tail_err}" ] && ctx="${ctx}: ${tail_err}"
  fi
  gateway_patch_status "${NAME}" "failed" "${ctx}" || true
  rm -f "${_FLEET_FAIL_LOG}"
  exit "${rc}"
}
trap _on_failure ERR

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
  printf 'FLEET_SHARED_JSON=%s\n'    "${FLEET_SHARED_JSON:-[]}"
  # FLEET_SHARED_ENV_FILES: colon-separated container paths for entrypoints to
  # source. Derived from [[shared]] targets (falling back to /app/<path>) plus
  # per-service env_files mounted at /app/<svc_name>/<rel>.
  _SHARED_TARGETS=$("${_PYBIN}" -c "
import sys, json
shared   = json.loads(sys.argv[1] or '[]')
services = json.loads(sys.argv[2] or '[]')
out = []
# [[shared]] entries
for s in shared:
    p = s.get('path','')
    if not p:
        continue
    out.append(s.get('target') or '/app/' + p)
# services[].env_files entries
for svc in services:
    name = svc.get('name','')
    svc_dir = svc.get('dir','')
    for ef in svc.get('env_files', []):
        out.append('/app/' + name + '/' + ef)
print(':'.join(out))
" "${FLEET_SHARED_JSON:-[]}" "${FLEET_SERVICES_JSON}")
  [ -n "${_SHARED_TARGETS}" ] && printf 'FLEET_SHARED_ENV_FILES=%s\n' "${_SHARED_TARGETS}"
  if [ "${EMBEDDED_DB}" = true ]; then
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

# ─── Resolve base image tag ──────────────────────────────────────────────────
if [ -f "${FLEET_PROJECT_ROOT}/.fleet/Dockerfile.feature-base" ]; then
  FEATURE_BASE_IMAGE="fleet-feature-base-${FLEET_PROJECT_NAME}"
  if ! docker image inspect "${FEATURE_BASE_IMAGE}" >/dev/null 2>&1; then
    error "Project-local base image '${FEATURE_BASE_IMAGE}' not found. Run 'fleet init' to build it."
  fi
  info "[fleet] Using project-local base image: ${FEATURE_BASE_IMAGE}"
else
  FEATURE_BASE_IMAGE="fleet-feature-base"
fi

# ─── Generate docker-compose.yml (ONE service per feature) ───────────────────
info "Generating .fleet/${NAME}/docker-compose.yml..."
COMPOSE_FILE="${FEATURE_DIR}/docker-compose.yml"

{
  echo "services:"
  echo "  ${NAME}:"
  echo "    image: ${FEATURE_BASE_IMAGE}"
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
        SOURCE="${WORKTREE_PATH}/${svc_dir_rel}/${shared_path}"
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
  # [[shared]] files from fleet.toml: bind-mount read-only into every container.
  # Always mount from WORKTREE_PATH — hard fail if the file is missing.
  # Worktrees must be fully set up before fleet add.
  while IFS=$'\t' read -r shared_path shared_target; do
    [ -z "${shared_path}" ] && continue
    src="${WORKTREE_PATH}/${shared_path}"
    [ -f "${src}" ] \
      || error "Shared file missing: ${src}
The worktree must contain all [[shared]] files declared in fleet.toml.
Copy it from the primary checkout or generate it:
  cp ${FLEET_PROJECT_ROOT}/${shared_path} ${src}"
    tgt="${shared_target:-/app/${shared_path}}"
    echo "      - ${src}:${tgt}:ro"
  done < <("${_PYBIN}" -c "
import sys, json
for s in json.loads(sys.argv[1] or '[]'):
    p = s.get('path','')
    if not p:
        continue
    print(p + '\t' + (s.get('target') or ''))
" "${FLEET_SHARED_JSON:-[]}")
  # services[].env_files: bind-mount read-only into the matching service only.
  # Source path is relative to the service dir inside the worktree.
  while IFS=$'\t' read -r svc_name svc_dir env_file_rel; do
    [ -z "${svc_name}" ] && continue
    src="${WORKTREE_PATH}/${svc_dir}/${env_file_rel}"
    [ -f "${src}" ] \
      || error "Service env file missing: ${src}
The worktree must contain all env_files declared in fleet.toml for service '${svc_name}'.
Copy it: cp ${FLEET_PROJECT_ROOT}/${svc_dir}/${env_file_rel} ${src}"
    tgt="/app/${svc_name}/${env_file_rel}"
    echo "      - ${src}:${tgt}:ro"
  done < <("${_PYBIN}" -c "
import sys, json
services = json.loads(sys.argv[1])
for svc in services:
    name    = svc.get('name','')
    svc_dir = svc.get('dir','')
    for ef in svc.get('env_files', []):
        print(name + '\t' + svc_dir + '\t' + ef)
" "${FLEET_SERVICES_JSON}")
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
# Capture build/compose output into _FLEET_FAIL_LOG AND stream to the gateway
# build-log endpoint so the dashboard can show live progress.
# The log streaming is non-fatal: if curl or the FIFO fails, docker compose up
# must still proceed normally. All || true / background logic ensures this.

_FLEET_BUILD_LOG_FIFO=$(mktemp -u).fleet-build-log
mkfifo "${_FLEET_BUILD_LOG_FIFO}" 2>/dev/null || true

# Background process: read lines from FIFO and POST to gateway in a loop.
# We post line-by-line so the dashboard sees progress as it happens rather than
# waiting for the entire build to finish.
(
  while IFS= read -r _bl_line; do
    printf '%s\n' "${_bl_line}" | curl -s -X POST \
      -H "Content-Type: text/plain" \
      --data-binary @- \
      "${GATEWAY_URL}/_fleet/api/features/${NAME}/build-log" >/dev/null 2>&1 || true
  done < "${_FLEET_BUILD_LOG_FIFO}"
) &
_LOG_STREAMER_PID=$!

# Run docker compose, tee combined stdout+stderr to fail log AND to FIFO.
# We must write the FIFO last in the tee chain so that a broken pipe to curl
# doesn't affect _FLEET_FAIL_LOG which the ERR trap depends on.
if ! docker compose -f "${COMPOSE_FILE}" up -d 2>&1 \
    | tee -a "${_FLEET_FAIL_LOG}" \
    | tee "${_FLEET_BUILD_LOG_FIFO}" >/dev/null; then
  # Close and remove FIFO, wait for streamer before returning failure.
  exec 3>"${_FLEET_BUILD_LOG_FIFO}" 2>/dev/null && exec 3>&- 2>/dev/null || true
  rm -f "${_FLEET_BUILD_LOG_FIFO}"
  wait "${_LOG_STREAMER_PID}" 2>/dev/null || true
  # docker compose already captured into fail log; ERR trap picks it up.
  false
fi

# Happy path: close FIFO by opening + closing a write-side fd, then wait for streamer.
exec 3>"${_FLEET_BUILD_LOG_FIFO}" 2>/dev/null && exec 3>&- 2>/dev/null || true
rm -f "${_FLEET_BUILD_LOG_FIFO}"
wait "${_LOG_STREAMER_PID}" 2>/dev/null || true

# ─── Transition: building → starting ─────────────────────────────────────────
gateway_patch_status "${NAME}" "starting"

# ─── Wait for container health ───────────────────────────────────────────────
# Uses the gateway's existing /features/:name/health endpoint (HEADs nginx on
# port 80 inside the container). Times out after 60s → trap fires 'failed'.
info "Waiting for fleet-${NAME} to become healthy..."
_HEALTH_MAX_WAIT=60
_HEALTH_ELAPSED=0
_HEALTHY=false
while [ ${_HEALTH_ELAPSED} -lt ${_HEALTH_MAX_WAIT} ]; do
  _HEALTH_BODY=$(curl -s "${GATEWAY_URL}/_fleet/api/features/${NAME}/health" 2>/dev/null || echo '')
  case "${_HEALTH_BODY}" in
    *'"status":"up"'*) _HEALTHY=true; break ;;
  esac
  # Post health-check progress to build log so dashboard shows status
  curl -s -X POST \
    -H "Content-Type: text/plain" \
    --data-binary "Waiting for health... (${_HEALTH_ELAPSED}s/${_HEALTH_MAX_WAIT}s)" \
    "${GATEWAY_URL}/_fleet/api/features/${NAME}/build-log" >/dev/null 2>&1 || true
  sleep 2
  _HEALTH_ELAPSED=$((_HEALTH_ELAPSED + 2))
done

if [ "${_HEALTHY}" != true ]; then
  echo "Health wait timed out after ${_HEALTH_MAX_WAIT}s — last health response: ${_HEALTH_BODY:-<empty>}" \
    >> "${_FLEET_FAIL_LOG}"
  false
fi

# ─── Transition: starting → running ──────────────────────────────────────────
gateway_patch_status "${NAME}" "running"

# Happy path reached — tear down the ERR trap so post-summary activity doesn't
# re-trigger 'failed' if, say, the terminal close causes a SIGPIPE.
trap - ERR
rm -f "${_FLEET_FAIL_LOG}"

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
