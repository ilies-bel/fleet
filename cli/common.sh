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

# ─── TOML loader ─────────────────────────────────────────────────────────────

# _find_python_with_tomllib — prints the path of the first python3 interpreter
# that has tomllib (stdlib ≥3.11) or tomli (third-party) available.
# Prints nothing and returns 1 if none found.
_find_python_with_tomllib() {
  local py candidates
  # Ordered preference: well-known newer binaries first, then $PATH python3
  candidates=(
    python3.13 python3.12 python3.11
    /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11
    /usr/local/bin/python3.13 /usr/local/bin/python3.12 /usr/local/bin/python3.11
    "${HOME}/.local/bin/python3.13" "${HOME}/.local/bin/python3.12" "${HOME}/.local/bin/python3.11"
    python3
  )
  for py in "${candidates[@]}"; do
    if command -v "$py" >/dev/null 2>&1; then
      if "$py" -c "import tomllib" 2>/dev/null \
         || "$py" -c "import tomli as tomllib" 2>/dev/null; then
        echo "$py"
        return 0
      fi
    fi
  done
  return 1
}

# _find_fleet_toml_upwards [start_dir] — walk parent directories until a
# .fleet/fleet.toml is found. Prints the first match and returns 0, or returns 1
# without output if nothing is found.
_find_fleet_toml_upwards() {
  local dir="${1:-${PWD}}"
  local candidate

  while :; do
    candidate="${dir}/.fleet/fleet.toml"
    if [ -f "${candidate}" ]; then
      printf '%s\n' "${candidate}"
      return 0
    fi

    if [ "${dir}" = "/" ]; then
      return 1
    fi

    dir="$(dirname "${dir}")"
  done
}

# load_fleet_toml — parse fleet.toml and export env vars:
#
#   FLEET_CONFIG_ROOT       — directory containing the resolved project .fleet/
#   FLEET_PROJECT_NAME      — project.name
#   FLEET_PROJECT_ROOT      — project.root
#   FLEET_WORKTREE_PATH     — project.path (may be empty if key absent)
#   FLEET_PORT_PROXY        — ports.proxy
#   FLEET_PORT_ADMIN        — ports.admin
#   FLEET_PORT_DB           — ports.db
#   FLEET_STACKS_JSON       — [[stacks]] as a JSON array of {type,dockerfile,shared_paths}
#   FLEET_SERVICES_JSON     — [[services]] as a JSON array of {name,dir,stack,port,host_port,build,run,env,env_files}
#   FLEET_PEERS_JSON        — [[peers]] as a JSON array of {name,type,port,mappings,files}
#
# Peer type whitelist: wiremock, static-http, shell.
# Unknown peer type → error "Unknown peer type 'X'. Allowed: wiremock, static-http, shell"
#
# Resolution order (first file that exists wins):
#   1. Nearest ancestor .fleet/fleet.toml from ${PWD} — project-level config
#   2. ${FLEET_ROOT}/.fleet/fleet.toml — CLI install fallback (backwards compat)
#
# Errors clearly if neither file is found or if no suitable python3 is found.
load_fleet_toml() {
  local toml_file
  local project_toml

  # Precedence: nearest project config first, CLI install as fallback.
  if project_toml="$(_find_fleet_toml_upwards "${PWD}")"; then
    toml_file="${project_toml}"
    FLEET_CONFIG_ROOT="$(cd "$(dirname "${toml_file}")/.." && pwd)"
  elif [ -f "${FLEET_ROOT}/.fleet/fleet.toml" ]; then
    # Fallback for backwards compatibility — running fleet outside a project dir
    toml_file="${FLEET_ROOT}/.fleet/fleet.toml"
    FLEET_CONFIG_ROOT="${FLEET_ROOT}"
  else
    error ".fleet/fleet.toml not found. Checked ${PWD} and its parents, then ${FLEET_ROOT}/.fleet/fleet.toml. Run: fleet init"
  fi

  local pybin
  pybin=$(_find_python_with_tomllib) \
    || error "No python3 with tomllib/tomli found. Install python >=3.11 or: pip3 install tomli"

  local parsed
  parsed=$("$pybin" - "${toml_file}" <<'PYEOF'
import sys, json

# Try tomllib (stdlib ≥3.11), fall back to tomli (third-party)
try:
    import tomllib
except ModuleNotFoundError:
    try:
        import tomli as tomllib
    except ModuleNotFoundError:
        print("ERROR: tomllib/tomli not available", file=sys.stderr)
        sys.exit(1)

ALLOWED_PEER_TYPES = {"wiremock", "static-http", "shell"}

toml_path = sys.argv[1]
with open(toml_path, "rb") as fh:
    data = tomllib.load(fh)

project  = data.get("project", {})
ports    = data.get("ports", {})
stacks   = data.get("stacks", [])
services = data.get("services", [])
peers    = data.get("peers", [])
shared   = data.get("shared", [])

# Detect legacy 'worktree_template' key — hard error, no alias
legacy_keys = []
if "worktree_template" in project:
    legacy_keys.append("[project].worktree_template")
for sv in services:
    if "worktree_template" in sv:
        legacy_keys.append(f"[[services]] name={sv.get('name','?')}: worktree_template")
if legacy_keys:
    print(
        "fleet.toml uses the legacy key 'worktree_template'. It was renamed to 'path' (no alias).\n"
        "Edit .fleet/fleet.toml to replace every 'worktree_template = ...' with 'path = ...', or regenerate with: fleet init\n"
        "Affected keys: " + ", ".join(legacy_keys),
        file=sys.stderr,
    )
    sys.exit(2)

# Validate peer types before emitting any output
for p in peers:
    peer_type = p.get("type", "")
    if peer_type not in ALLOWED_PEER_TYPES:
        print(
            f"Unknown peer type '{peer_type}'. Allowed: wiremock, static-http, shell",
            file=sys.stderr,
        )
        sys.exit(2)

out = {
    "project_name":        project.get("name", ""),
    "project_root":        project.get("root", ""),
    "worktree_path":       project.get("path", ""),
    "port_proxy":          str(ports.get("proxy", "")),
    "port_admin":          str(ports.get("admin", "")),
    "port_db":             str(ports.get("db", "")),
    "stacks_json":    json.dumps([
        {"type": s.get("type",""), "dockerfile": s.get("dockerfile",""), "shared_paths": s.get("shared_paths", [])}
        for s in stacks
    ]),
    "services_json":  json.dumps([
        {
            "name":              sv.get("name",""),
            "dir":               sv.get("dir",""),
            "stack":             sv.get("stack",""),
            "port":              str(sv.get("port","")),
            "host_port":         str(sv.get("host_port","")),
            "build":             sv.get("build",""),
            "run":               sv.get("run",""),
            "env":               sv.get("env", {}),
            "env_files":         sv.get("env_files", []),
            "worktree_path":     sv.get("path",""),
        }
        for sv in services
    ]),
    "peers_json":     json.dumps([
        {
            "name":     p.get("name",""),
            "type":     p.get("type",""),
            "port":     str(p.get("port","")),
            "mappings": p.get("mappings",""),
            "files":    p.get("files",""),
            "cmd":      p.get("cmd",""),
        }
        for p in peers
    ]),
    "shared_json":    json.dumps([
        {
            "path":   s.get("path",""),
            "target": s.get("target",""),
        }
        for s in shared
        if s.get("path")
    ]),
}
print(json.dumps(out))
PYEOF
  ) || error "Failed to parse .fleet/fleet.toml — check syntax and python3 installation"

  # Extract fields from the JSON blob using python itself (no jq dependency)
  local _get
  _get() { "$pybin" -c "import sys,json; d=json.loads(sys.argv[1]); print(d.get(sys.argv[2],''))" "$parsed" "$1"; }

  export FLEET_CONFIG_ROOT
  FLEET_PROJECT_NAME=$(_get project_name)
  FLEET_PROJECT_ROOT=$(_get project_root)
  FLEET_WORKTREE_PATH=$(_get worktree_path)
  FLEET_PORT_PROXY=$(_get port_proxy)
  FLEET_PORT_ADMIN=$(_get port_admin)
  FLEET_PORT_DB=$(_get port_db)
  FLEET_STACKS_JSON=$(_get stacks_json)
  FLEET_SERVICES_JSON=$(_get services_json)
  FLEET_PEERS_JSON=$(_get peers_json)
  FLEET_SHARED_JSON=$(_get shared_json)

  export FLEET_PROJECT_NAME FLEET_PROJECT_ROOT FLEET_WORKTREE_PATH \
         FLEET_PORT_PROXY FLEET_PORT_ADMIN FLEET_PORT_DB \
         FLEET_STACKS_JSON FLEET_SERVICES_JSON FLEET_PEERS_JSON FLEET_SHARED_JSON
}

# fleet_services_json — print FLEET_SERVICES_JSON
fleet_services_json() {
  printf '%s\n' "${FLEET_SERVICES_JSON}"
}

# fleet_peers_json — print FLEET_PEERS_JSON
fleet_peers_json() {
  printf '%s\n' "${FLEET_PEERS_JSON}"
}

# fleet_stack_for_service <svc_name> — print the stack type for a named service
fleet_stack_for_service() {
  local svc_name="${1:-}"
  [ -n "$svc_name" ] || error "fleet_stack_for_service: service name required"
  local pybin
  pybin=$(_find_python_with_tomllib) \
    || error "No python3 with tomllib/tomli found"
  "$pybin" -c "
import sys, json
services = json.loads(sys.argv[1])
name     = sys.argv[2]
for s in services:
    if s.get('name') == name:
        print(s.get('stack', ''))
        sys.exit(0)
sys.exit(1)
" "${FLEET_SERVICES_JSON}" "$svc_name" \
    || error "fleet_stack_for_service: no service named '${svc_name}' in FLEET_SERVICES_JSON"
}

# fleet_stack_shared_paths <stack_type> — print newline-separated shared_paths for a stack.
# Prints nothing if the stack is not found or has no shared_paths declared.
fleet_stack_shared_paths() {
  local stack_type="${1:-}"
  [ -n "$stack_type" ] || error "fleet_stack_shared_paths: stack type required"
  local pybin
  pybin=$(_find_python_with_tomllib) \
    || error "No python3 with tomllib/tomli found"
  "$pybin" -c "
import sys, json
stacks     = json.loads(sys.argv[1])
stack_type = sys.argv[2]
for s in stacks:
    if s.get('type') == stack_type:
        for p in s.get('shared_paths', []):
            print(p)
        sys.exit(0)
" "${FLEET_STACKS_JSON}" "$stack_type"
}

# fleet_project_root — print FLEET_PROJECT_ROOT
fleet_project_root() {
  printf '%s\n' "${FLEET_PROJECT_ROOT}"
}

# fleet_resolve_worktree <name> — resolve the worktree path for a feature name.
#
# Substitutes {name} in FLEET_WORKTREE_PATH with the argument.
# If the result is relative, it is resolved against FLEET_PROJECT_ROOT.
# Echoes the absolute path.
#
# Requires load_fleet_toml to have been called first (exports FLEET_WORKTREE_PATH
# and FLEET_PROJECT_ROOT).
fleet_resolve_worktree() {
  local name="${1:-}"
  [ -n "${name}" ] || error "fleet_resolve_worktree: feature name required"

  local template="${FLEET_WORKTREE_PATH:-}"
  [ -n "${template}" ] \
    || error "fleet_resolve_worktree: FLEET_WORKTREE_PATH is not set. Add 'path' under [project] in .fleet/fleet.toml."

  # Substitute {name} placeholder
  local resolved="${template//\{name\}/${name}}"

  # If relative, join with project root
  case "${resolved}" in
    /*) ;;
    *)  resolved="${FLEET_PROJECT_ROOT}/${resolved}" ;;
  esac

  printf '%s\n' "${resolved}"
}

# fleet_resolve_service_worktree <name> <svc_dir> <svc_wt_path>
# Returns the absolute path to this service's worktree source.
# When svc_wt_path is non-empty: substitute {name}, resolve relative to FLEET_PROJECT_ROOT.
# Otherwise: fleet_resolve_worktree(name) + "/" + svc_dir.
fleet_resolve_service_worktree() {
  local name="${1:-}" svc_dir="${2:-}" svc_wt_path="${3:-}"
  if [ -n "${svc_wt_path}" ]; then
    local resolved="${svc_wt_path//\{name\}/${name}}"
    case "${resolved}" in
      /*) ;;
      *)  resolved="${FLEET_PROJECT_ROOT}/${resolved}" ;;
    esac
    printf '%s\n' "${resolved}"
  else
    printf '%s\n' "$(fleet_resolve_worktree "${name}")/${svc_dir}"
  fi
}

export -f load_fleet_toml fleet_services_json fleet_peers_json fleet_stack_for_service fleet_stack_shared_paths fleet_project_root fleet_resolve_worktree fleet_resolve_service_worktree

# ─── Config loaders (legacy shims) ───────────────────────────────────────────
# These kept for backward compatibility while cmd-*.sh scripts are migrated.
# They call load_fleet_toml and map the new variables into the old names.

# load_qa_config — DEPRECATED shim; calls load_fleet_toml and sets APP_ROOT.
load_qa_config() {
  load_fleet_toml
  APP_ROOT="${FLEET_PROJECT_ROOT}"
  export APP_ROOT
  [ -d "${APP_ROOT:-}" ] || error "project.root '${APP_ROOT:-}' does not exist (check .fleet/fleet.toml)"
}

# load_fleet_conf — DEPRECATED shim; calls load_fleet_toml and back-fills legacy vars.
# Must call load_qa_config (or load_fleet_toml) first, OR can be called standalone.
load_fleet_conf() {
  # Ensure TOML is loaded — idempotent if already exported
  if [ -z "${FLEET_PROJECT_NAME:-}" ]; then
    load_fleet_toml
  fi

  APP_ROOT="${FLEET_PROJECT_ROOT}"
  PROJECT_NAME="${FLEET_PROJECT_NAME}"
  PROXY_PORT="${FLEET_PORT_PROXY}"
  ADMIN_PORT="${FLEET_PORT_ADMIN}"
  DB_PORT="${FLEET_PORT_DB}"

  # Back-fill frontend/backend vars from services named "frontend"/"backend"
  local pybin
  pybin=$(_find_python_with_tomllib) \
    || error "No python3 with tomllib/tomli found"

  local _svc_field
  _svc_field() {
    "$pybin" -c "
import sys, json
services = json.loads(sys.argv[1])
svc_name = sys.argv[2]
field    = sys.argv[3]
for s in services:
    if s.get('name') == svc_name:
        print(s.get(field, ''))
        sys.exit(0)
print('')
" "${FLEET_SERVICES_JSON}" "$1" "$2"
  }

  FRONTEND_DIR=$(_svc_field frontend dir)
  FRONTEND_PORT=$(_svc_field frontend port)
  BACKEND_DIR=$(_svc_field backend dir)
  BACKEND_PORT=$(_svc_field backend port)
  BACKEND_BUILD_CMD=$(_svc_field backend build)
  BACKEND_RUN_CMD=$(_svc_field backend run)

  # Apply legacy defaults for optional fields
  FRONTEND_OUT_DIR="${FRONTEND_OUT_DIR:-out}"
  BACKEND_RUN_CMD="${BACKEND_RUN_CMD:-java -jar /home/developer/backend.jar}"
  BACKEND_PORT="${BACKEND_PORT:-8081}"

  # Legacy fields sourced from fleet.conf that have no TOML equivalent —
  # keep empty unless already set in environment.
  DB_NAME="${DB_NAME:-}"
  DB_USER="${DB_USER:-}"
  DB_PASSWORD="${DB_PASSWORD:-}"
  JWT_SECRET="${JWT_SECRET:-}"
  JWT_ISSUER="${JWT_ISSUER:-myapp}"

  export APP_ROOT PROJECT_NAME PROXY_PORT ADMIN_PORT DB_PORT \
         FRONTEND_DIR FRONTEND_OUT_DIR FRONTEND_PORT \
         BACKEND_DIR BACKEND_BUILD_CMD BACKEND_RUN_CMD BACKEND_PORT \
         DB_NAME DB_USER DB_PASSWORD JWT_SECRET JWT_ISSUER
}

export -f load_qa_config load_fleet_conf

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
# validate_feature_name — errors if name doesn't match ^[a-z0-9]([a-z0-9-]*(\.[a-z0-9-]+)*)?$
validate_feature_name() {
  local name="${1:-}"
  if ! echo "${name}" | grep -qE '^[a-z0-9]([a-z0-9-]*(\.[a-z0-9-]+)*)?$'; then
    error "Feature name '${name}' is invalid — lowercase alphanumerics, dots, hyphens only; no leading, trailing, or consecutive dots."
  fi
}

# ─── HTTP helpers ─────────────────────────────────────────────────────────────
# gateway_post PATH JSON_BODY — returns HTTP status code
gateway_post() {
  curl -s -o /dev/null -w "%{http_code}" -X POST "${GATEWAY_URL}/$1" \
    -H "Content-Type: application/json" -d "$2"
}

# gateway_post_full PATH JSON_BODY — returns "HTTP_CODE|BODY_FILE_PATH" on stdout.
# The response body is written to a mktemp file. The caller must remove it after use:
#   result=$(gateway_post_full "path" "$body")
#   http_code="${result%|*}"; body_file="${result#*|}"
#   ... use body_file ...
#   rm -f "$body_file"
gateway_post_full() {
  local body_file
  body_file=$(mktemp)
  local http_code
  http_code=$(curl -s -o "${body_file}" -w "%{http_code}" -X POST "${GATEWAY_URL}/$1" \
    -H "Content-Type: application/json" -d "$2")
  printf '%s|%s\n' "${http_code}" "${body_file}"
}

# gateway_delete PATH — returns HTTP status code
gateway_delete() {
  curl -s -o /dev/null -w "%{http_code}" -X DELETE "${GATEWAY_URL}/$1"
}

# gateway_patch_status NAME STATUS [ERROR] — PATCH a feature's lifecycle status.
# Non-fatal: a non-2xx response is warned about but does not exit. Status drift
# is recoverable; forcing the whole `fleet add` to fail on a PATCH race would
# regress the intent of yn2 (fail loudly only on the initial registration).
#
# On 404: the gateway may have restarted between the initial POST /register-feature
# and this PATCH (in-memory registry lost). Re-register from the caller's exported
# variables (NAME, FLEET_PROJECT_NAME, FIRST_BRANCH, PROJECT_WORKTREE_PATH,
# FEATURE_TITLE, FLEET_SERVICES_JSON) then retry the PATCH once.
gateway_patch_status() {
  local name="${1:-}" status="${2:-}" error_msg="${3:-}"
  [ -n "$name" ] && [ -n "$status" ] || {
    warn "gateway_patch_status: name and status are required"
    return 0
  }

  local body
  if [ -n "$error_msg" ]; then
    local pybin
    pybin=$(_find_python_with_tomllib 2>/dev/null || command -v python3)
    local err_json
    err_json=$("$pybin" -c 'import sys, json; print(json.dumps(sys.argv[1]))' "$error_msg" 2>/dev/null) \
      || err_json='""'
    body="{\"status\":\"${status}\",\"error\":${err_json}}"
  else
    body="{\"status\":\"${status}\"}"
  fi

  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH \
    "${GATEWAY_URL}/_fleet/api/features/${name}/status" \
    -H "Content-Type: application/json" -d "${body}" 2>/dev/null || echo "000")

  if [ "${http_code}" = "404" ]; then
    # Gateway restarted and lost in-memory state — re-register then retry PATCH.
    warn "Gateway status PATCH for '${name}' → HTTP 404; gateway may have restarted. Re-registering..."
    local _re_pybin _services_json _title_json _re_status
    _re_pybin=$(_find_python_with_tomllib 2>/dev/null || command -v python3)
    _services_json=$("${_re_pybin}" -c "
import sys, json
svcs = json.loads(sys.argv[1])
out = [{'name': s['name'], 'port': int(s['port'])} for s in svcs if s.get('port')]
print(json.dumps(out))
" "${FLEET_SERVICES_JSON:-[]}" 2>/dev/null || echo "[]")
    _title_json=$("${_re_pybin}" -c "import sys, json; print(json.dumps(sys.argv[1]))" "${FEATURE_TITLE:-${NAME:-}}" 2>/dev/null || echo '""')
    curl -s -o /dev/null -X POST "${GATEWAY_URL}/register-feature" \
      -H "Content-Type: application/json" \
      -d "{\"name\":\"${NAME:-}\",\"branch\":\"${FIRST_BRANCH:-unknown}\",\"worktreePath\":\"${PROJECT_WORKTREE_PATH:-}\",\"project\":\"${FLEET_PROJECT_NAME:-}\",\"title\":${_title_json},\"services\":${_services_json},\"status\":\"${status}\"}" \
      2>/dev/null || true
    # Retry PATCH after re-registration
    http_code=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH \
      "${GATEWAY_URL}/_fleet/api/features/${name}/status" \
      -H "Content-Type: application/json" -d "${body}" 2>/dev/null || echo "000")
  fi

  case "$http_code" in
    2??) ;;
    *)   warn "Gateway status PATCH for '${name}' → HTTP ${http_code} (continuing)" ;;
  esac
  return 0
}
export -f gateway_patch_status

# ─── info.toml reader ────────────────────────────────────────────────────────
# _read_info_toml <path>
# Echoes pipe-delimited fields: project|name|branch|title|added_at|svc1:port1,svc2:port2
# Prints an empty string on missing file or parse failure. Never exits non-zero.
_read_info_toml() {
  local info_toml="$1"
  [ -f "${info_toml}" ] || { echo ""; return 0; }
  local pybin
  pybin=$(_find_python_with_tomllib) || { echo ""; return 0; }
  "$pybin" - "${info_toml}" <<'PYEOF'
import sys
try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib

with open(sys.argv[1], "rb") as fh:
    d = tomllib.load(fh)

f = d.get("feature", {}) or {}
svcs = ",".join(
    "{}:{}".format(s.get("name", ""), s.get("port", ""))
    for s in (d.get("services") or [])
    if s.get("name")
)
print("|".join([
    f.get("project", ""),
    f.get("name", ""),
    f.get("branch", ""),
    f.get("title", "") or "",
    str(f.get("added_at", "") or ""),
    svcs,
]))
PYEOF
}
export -f _read_info_toml

# ─── Stack Dockerfile templating ─────────────────────────────────────────────
# apply_stack_template SRC DEST
# Copy a stack Dockerfile template, substituting whitelisted fleet.conf vars.
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
  echo -e "  ${BLUE}init${RESET}                                 Initialize fleet for a project (no args)"
  echo -e "  ${BLUE}add${RESET}     <name> [--title <t>] [--direct]  Start a multi-service feature"
  echo -e "  ${BLUE}ls${RESET}      [--json]                     List feature containers and status"
  echo -e "  ${BLUE}rm${RESET}      <name>|--all|--nuke          Remove feature(s) or everything"
  echo -e "  ${BLUE}restart${RESET} <name>                       Restart a feature container"
  echo -e "  ${BLUE}push${RESET}    <name>                       Push service branches to remote"
  echo -e "  ${BLUE}sync${RESET}    <name> [--regenerate-sources] [--rebuild]  Pull latest code and rebuild"
  echo -e "  ${BLUE}install-claude${RESET} [--local|--global] [--force]  Install Claude Code assets"
  echo -e "  ${BLUE}help${RESET}    [<command>]                  Show this help, or help for <command>"
  echo ""
  echo "Top-level flags:"
  echo -e "  ${BLUE}--write-examples${RESET} [--dir <path>] [--force]"
  echo "                   Copy fleet.toml.example and shared.env.example into <dir>"
  echo "                   (default: ./.fleet/). Useful for bootstrapping a new project."
  echo ""
  echo "Environment:"
  echo "  FLEET_GATEWAY   Gateway base URL (default: http://localhost:4000)"
  echo ""
  echo "Examples:"
  echo "  fleet init                          # set up fleet for the current project"
  echo "  fleet add my-feature                # start a feature container"
  echo "  fleet help add                      # show full help for 'fleet add'"
  echo "  fleet --write-examples              # seed .fleet/ with example config files"
  echo "  fleet --write-examples --dir ~/tmp  # seed a custom directory"
  echo ""
}

# ─── write_examples ───────────────────────────────────────────────────────────
# write_examples [--dir <path>] [--force]
# Copies $FLEET_ROOT/.fleet/fleet.toml.example and shared.env.example into
# the target directory (default: ./.fleet/).  Refuses to overwrite unless
# --force is passed.  Prints each written path.  Creates the directory if
# it is missing.
write_examples() {
  local target_dir="./.fleet"
  local force=false
  local arg

  while [ $# -gt 0 ]; do
    arg="$1"
    case "${arg}" in
      --dir)
        [ -n "${2:-}" ] || { echo -e "${RED}[fleet] ERROR:${RESET} --dir requires a path argument" >&2; exit 1; }
        target_dir="$2"
        shift 2
        ;;
      --force)
        force=true
        shift
        ;;
      *)
        echo -e "${RED}[fleet] ERROR:${RESET} --write-examples: unknown argument '${arg}'" >&2
        echo "Usage: fleet --write-examples [--dir <path>] [--force]" >&2
        exit 1
        ;;
    esac
  done

  mkdir -p "${target_dir}"

  local src_toml="${FLEET_ROOT}/.fleet/fleet.toml.example"
  local src_env="${FLEET_ROOT}/.fleet/shared.env.example"
  local dst_toml="${target_dir}/fleet.toml.example"
  local dst_env="${target_dir}/shared.env.example"

  [ -f "${src_toml}" ] || { echo -e "${RED}[fleet] ERROR:${RESET} source not found: ${src_toml}" >&2; exit 1; }
  [ -f "${src_env}"  ] || { echo -e "${RED}[fleet] ERROR:${RESET} source not found: ${src_env}" >&2; exit 1; }

  local wrote=0 errors=0

  for pair in "${dst_toml}:${src_toml}" "${dst_env}:${src_env}"; do
    local dst="${pair%%:*}"
    local src="${pair#*:}"
    if [ -f "${dst}" ] && [ "${force}" = false ]; then
      echo -e "${YELLOW}[fleet]${RESET} already exists (use --force to overwrite): ${dst}" >&2
      errors=$((errors + 1))
    else
      cp "${src}" "${dst}"
      echo -e "${GREEN}[fleet]${RESET} written: ${dst}"
      wrote=$((wrote + 1))
    fi
  done

  if [ "${errors}" -gt 0 ] && [ "${wrote}" -eq 0 ]; then
    exit 1
  fi
  if [ "${errors}" -gt 0 ]; then
    exit 1
  fi
}
export -f write_examples

# ─── write_state ──────────────────────────────────────────────────────────────
# write_state <feature-dir> <status> [error]
#
# Writes (or updates) <feature-dir>/state.json with the current lifecycle
# status and appends a transitions entry. The write is atomic (tmp → mv).
#
# Status vocabulary: created | building | starting | up | failed | stopped
#
# Variables consumed from the caller's environment (all exported by cmd-add.sh):
#   NAME                  — feature name
#   FLEET_PROJECT_NAME    — project name
#   FIRST_BRANCH          — feature branch
#   PROJECT_WORKTREE_PATH — abs path to worktree
#   FEATURE_TITLE         — human-readable title
#   FLEET_SERVICES_JSON   — [[services]] JSON array
#
# Fails loud (exits non-zero) on any write error.
write_state() {
  local feature_dir="${1:-}"
  local new_status="${2:-}"
  local error_msg="${3:-}"

  [ -n "${feature_dir}" ] || { echo "[fleet] write_state: feature-dir is required" >&2; return 1; }
  [ -n "${new_status}"  ] || { echo "[fleet] write_state: status is required" >&2; return 1; }

  local pybin
  pybin=$(_find_python_with_tomllib 2>/dev/null) \
    || pybin=$(command -v python3 2>/dev/null) \
    || { echo "[fleet] write_state: no python3 found" >&2; return 1; }

  local state_file="${feature_dir}/state.json"
  local tmp_file="${feature_dir}/.state.json.tmp"

  # Collect caller-side variables (may be unset before feature dir creation)
  local _name="${NAME:-}"
  local _project="${FLEET_PROJECT_NAME:-}"
  local _branch="${FIRST_BRANCH:-}"
  local _wt_path="${PROJECT_WORKTREE_PATH:-}"
  local _title="${FEATURE_TITLE:-}"
  local _services_json="${FLEET_SERVICES_JSON:-[]}"

  "$pybin" - \
    "${state_file}" \
    "${tmp_file}" \
    "${new_status}" \
    "${error_msg}" \
    "${_name}" \
    "${_project}" \
    "${_branch}" \
    "${_wt_path}" \
    "${_title}" \
    "${_services_json}" \
  <<'PYEOF' || { echo "[fleet] write_state: python script failed" >&2; return 1; }
import sys, json, os
from datetime import datetime, timezone

state_file   = sys.argv[1]
tmp_file     = sys.argv[2]
new_status   = sys.argv[3]
error_msg    = sys.argv[4] or None
name         = sys.argv[5]
project      = sys.argv[6]
branch       = sys.argv[7]
wt_path      = sys.argv[8]
title        = sys.argv[9]
services_raw = sys.argv[10]

now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

# Parse services for the compact {name, port} representation
try:
    raw_svcs = json.loads(services_raw) if services_raw else []
    services = [{"name": s["name"], "port": int(s["port"])} for s in raw_svcs if s.get("port")]
except Exception:
    services = []

# Load existing state if present; otherwise build from scratch
if os.path.isfile(state_file):
    try:
        with open(state_file, "r") as fh:
            state = json.load(fh)
    except Exception:
        state = {}
else:
    state = {}

# Populate static fields (only set them if absent so re-runs are idempotent)
state.setdefault("schemaVersion", 1)
state.setdefault("key",           f"{project}-{name}" if project and name else name)
state.setdefault("project",       project)
state.setdefault("name",          name)
state.setdefault("branch",        branch)
state.setdefault("worktreePath",  wt_path)
state.setdefault("title",         title)
state.setdefault("containerName", f"fleet-{project}-{name}" if project and name else f"fleet-{name}")
state.setdefault("services",      services)
state.setdefault("transitions",   [])

# Append transition (idempotent — skip if last entry has same status)
transitions = state["transitions"]
if not transitions or transitions[-1].get("status") != new_status:
    transitions.append({"status": new_status, "at": now_iso})

# Update top-level mutable fields
state["status"]    = new_status
state["error"]     = error_msg
state["updatedAt"] = now_iso

# Atomic write
with open(tmp_file, "w") as fh:
    json.dump(state, fh, indent=2)
    fh.write("\n")

os.replace(tmp_file, state_file)
PYEOF
}
