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
  local exit_code="${1:-1}"
  echo ""
  echo -e "${GREEN}fleet add${RESET} — start a multi-service feature container"
  echo ""
  echo "Usage: fleet add <name> [--title <title>] [--direct] [--host <cluster/namespace>]"
  echo ""
  echo "Arguments:"
  echo -e "  ${BLUE}<name>${RESET}                        Feature name (lowercase letters, numbers, hyphens, dots)"
  echo ""
  echo "Flags:"
  echo -e "  ${BLUE}--title <title>${RESET}               Human-readable title shown in the dashboard (optional)"
  echo -e "  ${BLUE}--direct${RESET}                      Bind-mount the primary project checkout instead of a worktree."
  echo "                                Live-tracks the working copy (including uncommitted changes)."
  echo -e "  ${BLUE}--host <cluster/namespace>${RESET}    Run on a managed OpenShift cluster instead of local Docker."
  echo "                                Both cluster and namespace are required."
  echo "                                Omit entirely to keep the default local-Docker path."
  echo ""
  echo "  Starts a single container fleet-<name> that runs every [[services]]"
  echo "  and [[peers]] entry from .fleet/fleet.toml under supervisord."
  echo ""
  echo "  By default, requires a git worktree at the path resolved by"
  echo "  [project].path. Create one first:"
  echo "    git worktree add .worktrees/<name> <branch>"
  echo ""
  echo "Examples:"
  echo "  fleet add my-feature"
  echo "  fleet add my-feature --title 'My feature title'"
  echo "  fleet add qa-main --direct"
  echo "  fleet add my-feature --host ocp-prod/preview-ns"
  echo ""
  exit "${exit_code}"
}

# ─── Args ────────────────────────────────────────────────────────────────────
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage 0
fi
if [ -z "${1:-}" ]; then
  usage 1
fi

NAME="$1"
shift

validate_feature_name "${NAME}"

# Parse remaining args: --title, --direct, --host
FEATURE_TITLE=""
DIRECT=false
FEATURE_HOST_CLUSTER=""
FEATURE_HOST_NAMESPACE=""
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
    --host)
      [ -n "${2:-}" ] || error "fleet add: --host requires a value (format: cluster/namespace)"
      _host_val="$2"
      FEATURE_HOST_CLUSTER="${_host_val%%/*}"
      # If there is no '/' separator, the whole value equals the cluster part — namespace is missing.
      if [ "${_host_val}" = "${FEATURE_HOST_CLUSTER}" ]; then
        error "fleet add: --host '${_host_val}': namespace is missing. Format: cluster/namespace (e.g. ocp-prod/preview-ns)"
      fi
      FEATURE_HOST_NAMESPACE="${_host_val#*/}"
      [ -z "${FEATURE_HOST_CLUSTER}" ] && error "fleet add: --host '${_host_val}': cluster name cannot be empty. Format: cluster/namespace"
      [ -z "${FEATURE_HOST_NAMESPACE}" ] && error "fleet add: --host '${_host_val}': namespace cannot be empty. Format: cluster/namespace"
      shift 2
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

# ─── Start sidecars (lazy; project-scope idempotent, feature-scope per-add) ──
# Sidecars run on fleet-net alongside feature containers. Project-scope sidecars
# are reused across features (no-op if already running); feature-scope sidecars
# get a fresh container bound to this feature. Must run BEFORE feature compose
# so network aliases are resolvable when the feature container starts.
_SIDECAR_COUNT=$("${_PYBIN}" -c "import sys,json; print(len(json.loads(sys.argv[1])))" "${FLEET_SIDECARS_JSON:-[]}")
if [ "${_SIDECAR_COUNT}" -gt 0 ]; then
  # Topological order — Python computes it from the validated graph.
  _SIDECARS_ORDERED=$("${_PYBIN}" - "${FLEET_SIDECARS_JSON}" <<'PYEOF'
import sys, json
sidecars = json.loads(sys.argv[1])
by_name  = {sc["name"]: sc for sc in sidecars}
order, seen = [], set()
def visit(n):
    if n in seen: return
    for dep in by_name[n].get("depends_on", []) or []:
        visit(dep)
    seen.add(n)
    order.append(n)
for sc in sidecars:
    visit(sc["name"])
print(json.dumps(order))
PYEOF
)

  # Ensure fleet-net exists (init usually creates it, but be defensive).
  docker network inspect fleet-net >/dev/null 2>&1 \
    || docker network create fleet-net >/dev/null \
    || error "Failed to create network 'fleet-net'."

  # Iterate over the ordered list and (re)start each sidecar.
  _SIDECAR_NAMES_ORDER=$("${_PYBIN}" -c "import sys,json; print(' '.join(json.loads(sys.argv[1])))" "${_SIDECARS_ORDERED}")
  for _sc_name in ${_SIDECAR_NAMES_ORDER}; do
    # Pull all fields for this sidecar in one shot.
    _sc_blob=$("${_PYBIN}" -c "
import sys, json
sidecars = json.loads(sys.argv[1])
name     = sys.argv[2]
sc = next((s for s in sidecars if s['name'] == name), None)
if not sc:
    sys.exit(1)
print(json.dumps(sc))
" "${FLEET_SIDECARS_JSON}" "${_sc_name}")
    _sc_image=$("${_PYBIN}" -c "import sys,json; print(json.loads(sys.argv[1])['image'])" "${_sc_blob}")
    _sc_scope=$("${_PYBIN}" -c "import sys,json; print(json.loads(sys.argv[1])['scope'])" "${_sc_blob}")

    # Compute container name + network alias per scope.
    if [ "${_sc_scope}" = "feature" ]; then
      _sc_container="fleet-sidecar-${FLEET_PROJECT_NAME}-${NAME}-${_sc_name}"
      _sc_alias="fleet-${NAME}-${_sc_name}"
    else
      _sc_container="fleet-sidecar-${FLEET_PROJECT_NAME}-${_sc_name}"
      _sc_alias="fleet-${_sc_name}"
    fi

    # Project-scope: idempotent. If the container exists, leave it alone
    # (start if stopped). No image-drift detection in v1.
    if [ "${_sc_scope}" = "project" ]; then
      if docker container inspect "${_sc_container}" >/dev/null 2>&1; then
        _sc_running=$(docker container inspect -f '{{.State.Running}}' "${_sc_container}" 2>/dev/null || echo false)
        if [ "${_sc_running}" = "true" ]; then
          info "Sidecar '${_sc_name}' (scope=project): already running as ${_sc_container}"
          continue
        fi
        docker start "${_sc_container}" >/dev/null \
          || error "Sidecar '${_sc_name}': failed to start existing container ${_sc_container}"
        info "Sidecar '${_sc_name}' (scope=project): resumed stopped container ${_sc_container}"
        continue
      fi
    else
      # Feature-scope: always a fresh container. A stale one from a partial
      # previous add would clash on name — force-remove first.
      docker rm -f "${_sc_container}" >/dev/null 2>&1 || true
    fi

    # Build docker run args. -e from env (sorted for determinism), -v from volumes.
    _sc_run_args=()
    while IFS=$'\t' read -r _ek _ev; do
      [ -z "${_ek}" ] && continue
      _sc_run_args+=(-e "${_ek}=${_ev}")
    done < <("${_PYBIN}" -c "
import sys, json
sc = json.loads(sys.argv[1])
for k, v in sorted((sc.get('env') or {}).items()):
    print(str(k) + '\t' + str(v))
" "${_sc_blob}")

    # Volumes: mode=volume → docker volume (created on demand); mode=bind →
    # host path (relative → resolved against FLEET_PROJECT_ROOT, absolute used
    # as-is). copy is rejected at parse time.
    while IFS=$'\t' read -r _vmode _vpath _vtarget; do
      [ -z "${_vpath}" ] && continue
      _vt="${_vtarget:-/${_vpath}}"
      case "${_vmode}" in
        volume)
          # Slug the path to keep volume names predictable + filesystem-safe.
          _vslug=$(printf '%s' "${_vpath}" | tr -c 'A-Za-z0-9' '-')
          if [ "${_sc_scope}" = "feature" ]; then
            _vname="fleet-sidecar-${FLEET_PROJECT_NAME}-${NAME}-${_sc_name}-${_vslug}"
          else
            _vname="fleet-sidecar-${FLEET_PROJECT_NAME}-${_sc_name}-${_vslug}"
          fi
          docker volume inspect "${_vname}" >/dev/null 2>&1 \
            || docker volume create "${_vname}" >/dev/null \
            || error "Sidecar '${_sc_name}': failed to create volume ${_vname}"
          _sc_run_args+=(-v "${_vname}:${_vt}")
          ;;
        bind)
          # Expand leading '~'; absolute paths used as-is.
          [ "${_vpath#\~}" != "${_vpath}" ] && _vpath="${HOME}${_vpath#\~}"
          if [ "${_vpath#/}" = "${_vpath}" ]; then
            _src="${FLEET_PROJECT_ROOT}/${_vpath}"
          else
            _src="${_vpath}"
          fi
          [ -e "${_src}" ] \
            || error "Sidecar '${_sc_name}': bind source missing on host: ${_src}"
          _sc_run_args+=(-v "${_src}:${_vt}")
          ;;
        *)
          error "Internal: sidecar '${_sc_name}' has unexpected volume mode '${_vmode}' (parser should have rejected this)."
          ;;
      esac
    done < <("${_PYBIN}" -c "
import sys, json
sc = json.loads(sys.argv[1])
for v in sc.get('volumes', []) or []:
    print(v.get('mode','') + '\t' + v.get('path','') + '\t' + v.get('target',''))
" "${_sc_blob}")

    # Optional cmd override (image CMD if empty).
    _sc_cmd_args=()
    while IFS= read -r _cmd_arg; do
      [ -z "${_cmd_arg}" ] && continue
      _sc_cmd_args+=("${_cmd_arg}")
    done < <("${_PYBIN}" -c "
import sys, json
sc = json.loads(sys.argv[1])
for a in sc.get('cmd', []) or []:
    print(a)
" "${_sc_blob}")

    docker run -d \
      --name "${_sc_container}" \
      --network fleet-net \
      --network-alias "${_sc_alias}" \
      --restart unless-stopped \
      "${_sc_run_args[@]}" \
      "${_sc_image}" \
      "${_sc_cmd_args[@]}" >/dev/null \
      || error "Sidecar '${_sc_name}': docker run failed (image=${_sc_image})"

    info "Sidecar '${_sc_name}' (scope=${_sc_scope}): started as ${_sc_container} (alias ${_sc_alias})"
  done
fi

# ─── Resolve source path (worktree by default, project root in --direct mode) ─
# In --direct mode, skip worktree and bind-mount the primary checkout live.
if [ "${DIRECT}" = true ]; then
  PROJECT_WORKTREE_PATH="${FLEET_PROJECT_ROOT}"
  info "Direct mode — mounting primary checkout at ${PROJECT_WORKTREE_PATH}"
else
  # Resolve the project-level worktree path when path is set.
  # Only validate it as a git worktree if at least one service lacks a per-service
  # path override (services with overrides manage their own paths).
  PROJECT_WORKTREE_PATH=""
  if [ -n "${FLEET_WORKTREE_PATH:-}" ]; then
    PROJECT_WORKTREE_PATH=$(fleet_resolve_worktree "${NAME}")
  fi

  # Check whether ALL services have a per-service path set.
  # If any service is missing one, the project-level path is required.
  _ALL_SVC_HAVE_WT=$("${_PYBIN}" -c "
import sys, json
services = json.loads(sys.argv[1])
if not services:
    print('false')
else:
    all_have = all(bool(sv.get('worktree_path','')) for sv in services)
    print('true' if all_have else 'false')
" "${FLEET_SERVICES_JSON}")

  if [ "${_ALL_SVC_HAVE_WT}" = "false" ]; then
    # Project-level path is required for at least one service.
    if [ -z "${FLEET_WORKTREE_PATH:-}" ]; then
      error "fleet add: [project].path is not set in .fleet/fleet.toml.
  Add it under [project]:
    path = \".worktrees/{name}\"
  Then run: fleet init (to regenerate) or edit .fleet/fleet.toml manually.
  (Or pass --direct to bind-mount the primary checkout without a worktree.)"
    fi

    # Verify the resolved path is an active git worktree (not just any directory)
    if ! git -C "${PROJECT_WORKTREE_PATH}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      error "fleet add: worktree '${PROJECT_WORKTREE_PATH}' does not exist.
  Create it first:
    git worktree add ${PROJECT_WORKTREE_PATH} <branch>
  Or pass --direct to bind-mount the primary checkout without a worktree."
    fi
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
FEATURE_DIR="${FLEET_CONFIG_ROOT}/.fleet/${NAME}"
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
declare -a SVC_WT_ROOTS=()
declare -a SVC_DIRS=()       # configured relative dir from fleet.toml (e.g. "frontend")
declare -a SVC_STACKS=()
declare -a SVC_RUNS=()
declare -a SVC_PORTS=()
declare -a SVC_HOST_PORTS=()
declare -a SVC_BRANCHES=()

for idx in $(seq 0 $((svc_count - 1))); do
  _at() { "${_PYBIN}" -c "import sys,json; a=json.loads(sys.argv[1]); print(a[int(sys.argv[2])].get(sys.argv[3],''))" "${FLEET_SERVICES_JSON}" "$idx" "$1"; }

  svc_name=$(_at name)
  svc_dir=$(  _at dir)
  svc_stack=$(_at stack)
  svc_run=$(  _at run)
  svc_port=$( _at port)
  svc_host_port=$(_at host_port)

  svc_wt_path=$(_at worktree_path)

  if [ "${DIRECT}" = true ]; then
    # --direct: bind-mount the primary checkout; skip worktree resolution and validation.
    svc_abs_path="${FLEET_PROJECT_ROOT}/${svc_dir}"
    svc_wt_root="${svc_abs_path}"
  else
    svc_abs_path=$(fleet_resolve_service_worktree "${NAME}" "${svc_dir}" "${svc_wt_path}")

    # Determine the worktree root for this service (used for branch + shared path resolution)
    if [ -n "${svc_wt_path}" ]; then
      svc_wt_root="${svc_abs_path}"   # the override IS the root
    else
      svc_wt_root="${PROJECT_WORKTREE_PATH}"
    fi

    [ -d "${svc_abs_path}" ] \
      || error "Service '${svc_name}': '${svc_abs_path}' does not exist.
Create the worktree first:
  git -C ${FLEET_PROJECT_ROOT}/${svc_dir} worktree add ${svc_abs_path} <branch>
Or set a project-level path and create: git worktree add ${PROJECT_WORKTREE_PATH} <branch>"

    if ! git -C "${svc_abs_path}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      error "Service '${svc_name}': '${svc_abs_path}' is not an active git worktree.
Run: git -C ${FLEET_PROJECT_ROOT}/${svc_dir} worktree add ${svc_abs_path} <branch>"
    fi
  fi

  # Read branch from THIS service's worktree root (works for both worktree and primary checkout)
  branch=$(git -C "${svc_abs_path}" branch --show-current 2>/dev/null || echo "")
  [ -z "${branch}" ] && branch=$(git -C "${svc_abs_path}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
  [ "${branch}" = "HEAD" ] && branch="main"

  SVC_NAMES+=("${svc_name}")
  SVC_ABS_PATHS+=("${svc_abs_path}")
  SVC_WT_ROOTS+=("${svc_wt_root}")
  SVC_DIRS+=("${svc_dir}")
  SVC_STACKS+=("${svc_stack}")
  SVC_RUNS+=("${svc_run}")
  SVC_PORTS+=("${svc_port}")
  SVC_HOST_PORTS+=("${svc_host_port}")
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

# ─── Export hook context vars (used by run_hook and available to hook scripts) ─
export FLEET_FEATURE_NAME="${NAME}"
export FLEET_BRANCH="${FIRST_BRANCH}"
export FLEET_DIRECT="${DIRECT}"
# FLEET_PROJECT_NAME and FLEET_WORKTREE_PATH already exported by load_fleet_toml.
# Override FLEET_WORKTREE_PATH with the resolved value for this invocation.
export FLEET_WORKTREE_PATH="${PROJECT_WORKTREE_PATH}"

# ─── pre_add hook ─────────────────────────────────────────────────────────────
run_hook pre_add

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

# Build the optional host JSON fragment (null when --host was not passed).
# Python handles proper JSON escaping of cluster/namespace values.
_HOST_JSON="null"
if [ -n "${FEATURE_HOST_CLUSTER}" ]; then
  _HOST_JSON=$("${_PYBIN}" -c \
    "import sys,json; print(json.dumps({'cluster':sys.argv[1],'namespace':sys.argv[2]}))" \
    "${FEATURE_HOST_CLUSTER}" "${FEATURE_HOST_NAMESPACE}")
fi

# ─── Create feature dir ───────────────────────────────────────────────────────
mkdir -p "${FEATURE_DIR}"
write_state "${FEATURE_DIR}" created

# ─── Register EARLY with status='building' ───────────────────────────────────
# If this initial registration fails, we exit loudly (preserves yn2's intent:
# the user needs to know when the gateway is unreachable — silently proceeding
# with docker compose up gives a running container that nothing can route to).
write_state "${FEATURE_DIR}" building
info "Registering '${NAME}' with gateway (status=building)..."
_GW_RESULT=$(gateway_post_full "register-feature" \
  "{\"name\":\"${NAME}\",\"branch\":\"${FIRST_BRANCH}\",\"worktreePath\":\"${PROJECT_WORKTREE_PATH}\",\"project\":\"${FLEET_PROJECT_NAME}\",\"title\":${title_json},\"services\":${services_json},\"status\":\"building\",\"host\":${_HOST_JSON}}")
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
    Abandon   → docker stop fleet-${FLEET_PROJECT_NAME}-${NAME}
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
  write_state "${FEATURE_DIR}" failed "${ctx}" || true
  gateway_patch_status "${FLEET_PROJECT_NAME}-${NAME}" "failed" "${ctx}" || true
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
# services[].env_files entries — each ef is {path, mode, target}
for svc in services:
    name = svc.get('name','')
    for ef in svc.get('env_files', []):
        out.append(ef.get('target') or ('/app/' + name + '/' + ef.get('path','')))
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
  echo "    container_name: fleet-${FLEET_PROJECT_NAME}-${NAME}"
  echo "    env_file:"
  echo "      - feature.env"
  echo "    volumes:"
  # Each service source tree → /app/<svc_name> (worktree is bind-mounted live, so any
  # file committed in the worktree is already visible — shared_paths/env_files only
  # handle things NOT in the worktree: gitignored files + node_modules).
  #
  # Mount mode per shared_paths entry (declared in fleet.toml, validated by the parser):
  #   volume : per-(project,service,arch) named docker volume (e.g. node_modules — arch-
  #            correct native binaries, shared across features, survives rm/add, no
  #            macOS bind-mount perf hit).
  #   bind   : bind-mount from the primary checkout (FLEET_PROJECT_ROOT). Single source
  #            of truth; relative paths resolve under the service's root dir, absolute /
  #            '~' paths are host paths used as-is (npm cache, ~/.npmrc).
  #   copy   : materialize a real copy from the primary checkout into this worktree at
  #            add-time, then bind-mount the worktree copy (true per-feature isolation).
  CONTAINER_ARCH=$(docker version -f '{{.Server.Arch}}' 2>/dev/null || echo unknown)
  declare -a NODEMOD_VOLS=()   # named volumes we need to declare at the bottom
  for i in "${!SVC_NAMES[@]}"; do
    echo "      - ${SVC_ABS_PATHS[$i]}:/app/${SVC_NAMES[$i]}:cached"
    svc_stack_type="${SVC_STACKS[$i]}"
    # Per-service root dir in the primary checkout (source of truth for bind/copy).
    svc_root_dir="${FLEET_PROJECT_ROOT}/${SVC_DIRS[$i]}"
    while IFS= read -r _shared_line; do
      [ -z "${_shared_line}" ] && continue
      # Split on tab WITHOUT IFS-whitespace collapse: a bare `IFS=$'\t' read`
      # merges consecutive tabs, eating empty interior fields (e.g. an empty
      # target between path and scope), which would shift scope into target.
      # Parse positionally instead so empty fields are preserved.
      mode="${_shared_line%%$'\t'*}"
      _rest="${_shared_line#*$'\t'}"
      path_part="${_rest%%$'\t'*}"
      _rest="${_rest#*$'\t'}"
      target_part="${_rest%%$'\t'*}"
      scope_part="${_rest#*$'\t'}"
      [ -z "${path_part}" ] && continue
      # scope: project (default, shared across features) | feature (per-instance).
      [ -z "${scope_part}" ] && scope_part="project"
      case "${mode}" in
        volume)
          # Named volume name. Project scope → one volume reused across all
          # features (e.g. node_modules installed once). Feature scope → a
          # per-feature volume (suffixed with the feature NAME) so a branch
          # that mutates the volume (dependency add/removal) does not fight
          # other running features over a shared tree.
          if [ "${scope_part}" = "feature" ]; then
            _scope_suffix="-${NAME}"
          else
            _scope_suffix=""
          fi
          TARGET="${target_part:-/app/${SVC_NAMES[$i]}/${path_part}}"
          if [ "${path_part}" = "node_modules" ]; then
            vol_name="fleet-nodemod-${FLEET_PROJECT_NAME}-${SVC_NAMES[$i]}${_scope_suffix}-${CONTAINER_ARCH}"
          else
            _vol_slug=$(printf '%s' "${path_part}" | tr -c 'A-Za-z0-9' '-')
            vol_name="fleet-vol-${FLEET_PROJECT_NAME}-${SVC_NAMES[$i]}-${_vol_slug}${_scope_suffix}-${CONTAINER_ARCH}"
          fi
          docker volume inspect "${vol_name}" >/dev/null 2>&1 \
            || docker volume create "${vol_name}" >/dev/null \
            || error "Failed to create named volume '${vol_name}'."
          echo "      - ${vol_name}:${TARGET}"
          NODEMOD_VOLS+=("${vol_name}")
          ;;
        bind)
          # Expand leading '~' to $HOME
          [ "${path_part#\~}" != "${path_part}" ] && path_part="${HOME}${path_part#\~}"
          if [ "${path_part#/}" != "${path_part}" ]; then
            # Absolute / host path (npm cache, ~/.npmrc) — used as-is.
            SOURCE="${path_part}"
            TARGET="${target_part:-/app/${SVC_NAMES[$i]}/$(basename "${path_part}")}"
            [ -e "${SOURCE}" ] \
              || error "Shared path '${SOURCE}' does not exist on the host."
          else
            # Relative path — bind from the PRIMARY CHECKOUT (source of truth).
            SOURCE="${svc_root_dir}/${path_part}"
            TARGET="${target_part:-/app/${SVC_NAMES[$i]}/${path_part}}"
            [ -e "${SOURCE}" ] \
              || error "Shared path source missing in primary checkout: ${SOURCE}
Create it in ${FLEET_PROJECT_ROOT}/${SVC_DIRS[$i]} and re-run fleet add."
          fi
          echo "      - ${SOURCE}:${TARGET}:cached"
          ;;
        copy)
          # Materialize a copy from the primary checkout into THIS worktree, then mount it.
          SOURCE_ROOT="${svc_root_dir}/${path_part}"
          DEST="${SVC_ABS_PATHS[$i]}/${path_part}"
          TARGET="${target_part:-/app/${SVC_NAMES[$i]}/${path_part}}"
          if [ ! -e "${DEST}" ]; then
            [ -e "${SOURCE_ROOT}" ] \
              || error "copy mode: source missing in primary checkout: ${SOURCE_ROOT}
Create it in ${FLEET_PROJECT_ROOT}/${SVC_DIRS[$i]} and re-run fleet add."
            mkdir -p "$(dirname "${DEST}")"
            cp -R "${SOURCE_ROOT}" "${DEST}" \
              || error "copy mode: failed to copy ${SOURCE_ROOT} → ${DEST}"
            info "Copied ${path_part} into worktree for service '${SVC_NAMES[$i]}'"
          fi
          echo "      - ${DEST}:${TARGET}:cached"
          ;;
        *)
          error "Internal: unknown mount mode '${mode}' for shared path '${path_part}' (service '${SVC_NAMES[$i]}'). The parser should have rejected this."
          ;;
      esac
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
  # Always mount from FLEET_PROJECT_ROOT (primary checkout) so a single source
  # of truth is shared across all feature containers without copying into worktrees.
  while IFS=$'\t' read -r shared_path shared_target; do
    [ -z "${shared_path}" ] && continue
    [ -n "${FLEET_PROJECT_ROOT:-}" ] \
      || error "[[shared]] files require [project].root to be set in fleet.toml."
    src="${FLEET_PROJECT_ROOT}/${shared_path}"
    [ -f "${src}" ] \
      || error "Shared file missing: ${src}
Create the file in the primary checkout and re-run fleet add:
  touch ${FLEET_PROJECT_ROOT}/${shared_path}"
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
  # services[].env_files: mounted read-only into the matching service only.
  # env_files (e.g. .env) are gitignored and therefore NOT in the worktree, so the
  # primary checkout (FLEET_PROJECT_ROOT) is always the source of truth:
  #   bind : bind-mount the file from the primary checkout (single source of truth).
  #   copy : copy it from the primary checkout into this worktree, then mount the copy.
  # (volume is not meaningful for a single env file and is rejected here.)
  while IFS=$'\t' read -r svc_name mode env_file_rel env_target; do
    [ -z "${svc_name}" ] && continue
    # Find the index for this service name to look up its abs path + relative dir
    svc_idx=0
    for _si in "${!SVC_NAMES[@]}"; do
      [ "${SVC_NAMES[$_si]}" = "${svc_name}" ] && { svc_idx=$_si; break; }
    done
    root_src="${FLEET_PROJECT_ROOT}/${SVC_DIRS[$svc_idx]}/${env_file_rel}"
    tgt="${env_target:-/app/${svc_name}/${env_file_rel}}"
    case "${mode}" in
      bind)
        [ -f "${root_src}" ] \
          || error "Service env file missing in primary checkout: ${root_src}
Create it (env files are gitignored, so they live only in the primary checkout):
  cp ${root_src}.example ${root_src}   # then fill in real values"
        echo "      - ${root_src}:${tgt}:ro"
        ;;
      copy)
        wt_dest="${SVC_ABS_PATHS[$svc_idx]}/${env_file_rel}"
        if [ ! -f "${wt_dest}" ]; then
          [ -f "${root_src}" ] \
            || error "copy mode: env file missing in primary checkout: ${root_src}"
          mkdir -p "$(dirname "${wt_dest}")"
          cp "${root_src}" "${wt_dest}" \
            || error "copy mode: failed to copy ${root_src} → ${wt_dest}"
          info "Copied env file ${env_file_rel} into worktree for service '${svc_name}'"
        fi
        echo "      - ${wt_dest}:${tgt}:ro"
        ;;
      volume)
        error "env_files do not support mode='volume' (service '${svc_name}', path '${env_file_rel}'). Use 'bind' or 'copy'."
        ;;
      *)
        error "Internal: unknown env_file mode '${mode}' (service '${svc_name}'). The parser should have rejected this."
        ;;
    esac
  done < <("${_PYBIN}" -c "
import sys, json
services = json.loads(sys.argv[1])
for svc in services:
    name = svc.get('name','')
    for ef in svc.get('env_files', []):
        print(name + '\t' + ef.get('mode','') + '\t' + ef.get('path','') + '\t' + ef.get('target',''))
" "${FLEET_SERVICES_JSON}")
  # Docker socket for Testcontainers (spring/gradle stacks only)
  _needs_sock=false
  for stack in "${SVC_STACKS[@]}"; do
    case "${stack}" in spring|gradle) _needs_sock=true ;; esac
  done
  if [ "${_needs_sock}" = true ]; then
    echo "      - /var/run/docker.sock:/var/run/docker.sock"
  fi
  echo "    healthcheck:"
  echo "      test: [\"CMD\", \"curl\", \"-sf\", \"http://127.0.0.1:80/\"]"
  echo "      interval: 10s"
  echo "      timeout: 5s"
  echo "      retries: 30"
  echo "      start_period: 30s"
  echo "    networks:"
  echo "      - fleet-net"
  # Emit host port mappings for services that declare host_port
  _has_host_ports=false
  for hp in "${SVC_HOST_PORTS[@]}"; do
    [ -n "${hp}" ] && { _has_host_ports=true; break; }
  done
  if [ "${_has_host_ports}" = true ]; then
    echo "    ports:"
    for hp in "${SVC_HOST_PORTS[@]}"; do
      [ -n "${hp}" ] && echo "      - \"${hp}:${hp}\""
    done
  fi
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
  echo "worktree = \"${PROJECT_WORKTREE_PATH}\""
  echo "direct  = ${DIRECT}"
  echo ""
  for i in "${!SVC_NAMES[@]}"; do
    echo "[[services]]"
    echo "name   = \"${SVC_NAMES[$i]}\""
    echo "dir    = \"${SVC_ABS_PATHS[$i]}\""
    echo "branch = \"${SVC_BRANCHES[$i]}\""
    echo "worktree = \"${SVC_WT_ROOTS[$i]}\""
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
info "Starting container fleet-${FLEET_PROJECT_NAME}-${NAME}..."
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
      "${GATEWAY_URL}/_fleet/api/features/${FLEET_PROJECT_NAME}-${NAME}/build-log" >/dev/null 2>&1 || true
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
write_state "${FEATURE_DIR}" starting
gateway_patch_status "${FLEET_PROJECT_NAME}-${NAME}" "starting"

# ─── Wait for container health ───────────────────────────────────────────────
# Uses the gateway's existing /features/:name/health endpoint (HEADs nginx on
# port 80 inside the container). Times out after 180s → trap fires 'failed'.
info "Waiting for fleet-${FLEET_PROJECT_NAME}-${NAME} to become healthy..."
# Gradle bootJar typically takes 90-120s on first run; 180s gives headroom.
_HEALTH_MAX_WAIT=180
_HEALTH_ELAPSED=0
_HEALTHY=false
while [ ${_HEALTH_ELAPSED} -lt ${_HEALTH_MAX_WAIT} ]; do
  _HEALTH_BODY=$(curl -s "${GATEWAY_URL}/_fleet/api/features/${FLEET_PROJECT_NAME}-${NAME}/health" 2>/dev/null || echo '')
  case "${_HEALTH_BODY}" in
    *'"status":"up"'*) _HEALTHY=true; break ;;
  esac
  # Post health-check progress to build log so dashboard shows status
  curl -s -X POST \
    -H "Content-Type: text/plain" \
    --data-binary "Waiting for health... (${_HEALTH_ELAPSED}s/${_HEALTH_MAX_WAIT}s)" \
    "${GATEWAY_URL}/_fleet/api/features/${FLEET_PROJECT_NAME}-${NAME}/build-log" >/dev/null 2>&1 || true
  sleep 2
  _HEALTH_ELAPSED=$((_HEALTH_ELAPSED + 2))
done

if [ "${_HEALTHY}" != true ]; then
  echo "Health wait timed out after ${_HEALTH_MAX_WAIT}s — last health response: ${_HEALTH_BODY:-<empty>}" \
    >> "${_FLEET_FAIL_LOG}"
  false
fi

# ─── Transition: starting → running ──────────────────────────────────────────
write_state "${FEATURE_DIR}" up
gateway_patch_status "${FLEET_PROJECT_NAME}-${NAME}" "running"

# Happy path reached — tear down the ERR trap so post-summary activity doesn't
# re-trigger 'failed' if, say, the terminal close causes a SIGPIPE.
trap - ERR
rm -f "${_FLEET_FAIL_LOG}"

# ─── post_add hook ────────────────────────────────────────────────────────────
# Runs after container is healthy. Non-zero exit is a warning only (container
# is already up; run_hook handles the soft-fail semantics for post_* hooks).
run_hook post_add

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}┌──────────────────────────────────────────────────────────────┐${RESET}"
echo -e "${GREEN}│  '${NAME}' started                                           ${RESET}"
echo -e "${GREEN}│    container : fleet-${FLEET_PROJECT_NAME}-${NAME}           ${RESET}"
echo -e "${GREEN}│    services  : ${svc_count}                                  ${RESET}"
if [ "${peer_count}" -gt 0 ]; then
  echo -e "${GREEN}│    peers     : ${peer_count} (internal)                    ${RESET}"
fi
echo -e "${GREEN}│  Proxy  → http://localhost:${FLEET_PORT_PROXY}               ${RESET}"
echo -e "${GREEN}│  Logs   → docker logs -f fleet-${FLEET_PROJECT_NAME}-${NAME} ${RESET}"
echo -e "${GREEN}│  Status → docker exec fleet-${FLEET_PROJECT_NAME}-${NAME} supervisorctl status ${RESET}"
echo -e "${GREEN}└──────────────────────────────────────────────────────────────┘${RESET}"
