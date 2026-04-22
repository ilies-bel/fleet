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

# load_fleet_toml — parse fleet.toml and export env vars:
#
#   FLEET_PROJECT_NAME      — project.name
#   FLEET_PROJECT_ROOT      — project.root
#   FLEET_WORKTREE_TEMPLATE — project.worktree_template (may be empty if key absent)
#   FLEET_PORT_PROXY        — ports.proxy
#   FLEET_PORT_ADMIN        — ports.admin
#   FLEET_PORT_DB           — ports.db
#   FLEET_STACKS_JSON       — [[stacks]] as a JSON array of {type,dockerfile,shared_paths}
#   FLEET_SERVICES_JSON     — [[services]] as a JSON array of {name,dir,stack,port,build,run,env,env_files}
#   FLEET_PEERS_JSON        — [[peers]] as a JSON array of {name,type,port,mappings,files}
#
# Peer type whitelist: wiremock, static-http, shell.
# Unknown peer type → error "Unknown peer type 'X'. Allowed: wiremock, static-http, shell"
#
# Resolution order (first file that exists wins):
#   1. ${PWD}/.fleet/fleet.toml      — project-level config (source of truth)
#   2. ${FLEET_ROOT}/.fleet/fleet.toml — CLI install fallback (backwards compat)
#
# Errors clearly if neither file is found or if no suitable python3 is found.
load_fleet_toml() {
  local toml_file

  # Precedence: project-local first, CLI install as fallback.
  if [ -f "${PWD}/.fleet/fleet.toml" ]; then
    toml_file="${PWD}/.fleet/fleet.toml"
  elif [ -f "${FLEET_ROOT}/.fleet/fleet.toml" ]; then
    # Fallback for backwards compatibility — running fleet outside a project dir
    toml_file="${FLEET_ROOT}/.fleet/fleet.toml"
  else
    error ".fleet/fleet.toml not found. Checked: ${PWD}/.fleet/fleet.toml and ${FLEET_ROOT}/.fleet/fleet.toml. Run: fleet init"
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
    "worktree_template":   project.get("worktree_template", ""),
    "port_proxy":          str(ports.get("proxy", "")),
    "port_admin":          str(ports.get("admin", "")),
    "port_db":             str(ports.get("db", "")),
    "stacks_json":    json.dumps([
        {"type": s.get("type",""), "dockerfile": s.get("dockerfile",""), "shared_paths": s.get("shared_paths", [])}
        for s in stacks
    ]),
    "services_json":  json.dumps([
        {
            "name":  sv.get("name",""),
            "dir":   sv.get("dir",""),
            "stack": sv.get("stack",""),
            "port":  str(sv.get("port","")),
            "build": sv.get("build",""),
            "run":       sv.get("run",""),
            "env":       sv.get("env", {}),
            "env_files": sv.get("env_files", []),
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

  FLEET_PROJECT_NAME=$(_get project_name)
  FLEET_PROJECT_ROOT=$(_get project_root)
  FLEET_WORKTREE_TEMPLATE=$(_get worktree_template)
  FLEET_PORT_PROXY=$(_get port_proxy)
  FLEET_PORT_ADMIN=$(_get port_admin)
  FLEET_PORT_DB=$(_get port_db)
  FLEET_STACKS_JSON=$(_get stacks_json)
  FLEET_SERVICES_JSON=$(_get services_json)
  FLEET_PEERS_JSON=$(_get peers_json)
  FLEET_SHARED_JSON=$(_get shared_json)

  export FLEET_PROJECT_NAME FLEET_PROJECT_ROOT FLEET_WORKTREE_TEMPLATE \
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

# fleet_resolve_worktree <name> — resolve the worktree template for a feature name.
#
# Substitutes {name} in FLEET_WORKTREE_TEMPLATE with the argument.
# If the result is relative, it is resolved against FLEET_PROJECT_ROOT.
# Echoes the absolute path.
#
# Requires load_fleet_toml to have been called first (exports FLEET_WORKTREE_TEMPLATE
# and FLEET_PROJECT_ROOT).
fleet_resolve_worktree() {
  local name="${1:-}"
  [ -n "${name}" ] || error "fleet_resolve_worktree: feature name required"

  local template="${FLEET_WORKTREE_TEMPLATE:-}"
  [ -n "${template}" ] \
    || error "fleet_resolve_worktree: FLEET_WORKTREE_TEMPLATE is not set. Add 'worktree_template' under [project] in .fleet/fleet.toml."

  # Substitute {name} placeholder
  local resolved="${template//\{name\}/${name}}"

  # If relative, join with project root
  case "${resolved}" in
    /*) ;;
    *)  resolved="${FLEET_PROJECT_ROOT}/${resolved}" ;;
  esac

  printf '%s\n' "${resolved}"
}

export -f load_fleet_toml fleet_services_json fleet_peers_json fleet_stack_for_service fleet_stack_shared_paths fleet_project_root fleet_resolve_worktree

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

  case "$http_code" in
    2??) ;;
    *)   warn "Gateway status PATCH for '${name}' → HTTP ${http_code} (continuing)" ;;
  esac
  return 0
}
export -f gateway_patch_status

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
  echo -e "  ${BLUE}add${RESET}     <name> [--service s=p:i ...]  Start a multi-service feature"
  echo -e "  ${BLUE}rm${RESET}      <name>|--all|--nuke          Remove feature(s) or everything"
  echo -e "  ${BLUE}restart${RESET} <name>                       Restart a feature container"
  echo -e "  ${BLUE}push${RESET}    <name>                       Push service branches to remote"
  echo -e "  ${BLUE}sync${RESET}    <name> [--regenerate-sources] Pull latest code and rebuild"
  echo -e "  ${BLUE}install-claude${RESET} [--local|--global] [--force]  Install Claude Code assets (agents, skills, commands)"
  echo -e "  ${BLUE}install-claude${RESET} [--local|--global] [--force]  Install Claude Code assets (agents, skills, commands)"
  echo -e "  ${BLUE}help${RESET}                                 Show this help"
  echo ""
  echo "Environment:"
  echo "  FLEET_GATEWAY   Gateway base URL (default: http://localhost:4000)"
  echo ""
}
