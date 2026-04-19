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

# load_fleet_toml — parse ${FLEET_ROOT}/.fleet/fleet.toml and export env vars:
#
#   FLEET_PROJECT_NAME   — project.name
#   FLEET_PROJECT_ROOT   — project.root
#   FLEET_PORT_PROXY     — ports.proxy
#   FLEET_PORT_ADMIN     — ports.admin
#   FLEET_PORT_DB        — ports.db
#   FLEET_STACKS_JSON    — [[stacks]] as a JSON array of {type,dockerfile}
#   FLEET_SERVICES_JSON  — [[services]] as a JSON array of {name,dir,stack,port,build,run}
#   FLEET_PEERS_JSON     — [[peers]] as a JSON array of {name,type,port,mappings,files}
#
# Peer type whitelist: wiremock, static-http, shell.
# Unknown peer type → error "Unknown peer type 'X'. Allowed: wiremock, static-http, shell"
#
# Errors clearly if the file is missing or if no suitable python3 is found.
load_fleet_toml() {
  local toml_file="${FLEET_ROOT}/.fleet/fleet.toml"

  if [ ! -f "${toml_file}" ]; then
    error ".fleet/fleet.toml not found in ${FLEET_ROOT}. Run: fleet init"
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
    "project_name":   project.get("name", ""),
    "project_root":   project.get("root", ""),
    "port_proxy":     str(ports.get("proxy", "")),
    "port_admin":     str(ports.get("admin", "")),
    "port_db":        str(ports.get("db", "")),
    "stacks_json":    json.dumps([
        {"type": s.get("type",""), "dockerfile": s.get("dockerfile","")}
        for s in stacks
    ]),
    "services_json":  json.dumps([
        {
            "name":  sv.get("name",""),
            "dir":   sv.get("dir",""),
            "stack": sv.get("stack",""),
            "port":  str(sv.get("port","")),
            "build": sv.get("build",""),
            "run":   sv.get("run",""),
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
}
print(json.dumps(out))
PYEOF
  ) || error "Failed to parse .fleet/fleet.toml — check syntax and python3 installation"

  # Extract fields from the JSON blob using python itself (no jq dependency)
  local _get
  _get() { "$pybin" -c "import sys,json; d=json.loads(sys.argv[1]); print(d.get(sys.argv[2],''))" "$parsed" "$1"; }

  FLEET_PROJECT_NAME=$(_get project_name)
  FLEET_PROJECT_ROOT=$(_get project_root)
  FLEET_PORT_PROXY=$(_get port_proxy)
  FLEET_PORT_ADMIN=$(_get port_admin)
  FLEET_PORT_DB=$(_get port_db)
  FLEET_STACKS_JSON=$(_get stacks_json)
  FLEET_SERVICES_JSON=$(_get services_json)
  FLEET_PEERS_JSON=$(_get peers_json)

  export FLEET_PROJECT_NAME FLEET_PROJECT_ROOT \
         FLEET_PORT_PROXY FLEET_PORT_ADMIN FLEET_PORT_DB \
         FLEET_STACKS_JSON FLEET_SERVICES_JSON FLEET_PEERS_JSON
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

# fleet_project_root — print FLEET_PROJECT_ROOT
fleet_project_root() {
  printf '%s\n' "${FLEET_PROJECT_ROOT}"
}

export -f load_fleet_toml fleet_services_json fleet_peers_json fleet_stack_for_service fleet_project_root

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

# gateway_delete PATH — returns HTTP status code
gateway_delete() {
  curl -s -o /dev/null -w "%{http_code}" -X DELETE "${GATEWAY_URL}/$1"
}

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
