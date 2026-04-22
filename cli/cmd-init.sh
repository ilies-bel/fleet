#!/bin/bash
set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export FLEET_ROOT

# Source shared library (color helpers, info/warn/error, apply_stack_template)
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

# Guard: no positional arguments accepted
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: fleet init"
  echo ""
  echo "  Initialize fleet for the project in the current directory."
  echo "  Reads .fleet/fleet.toml if present; otherwise starts an interactive wizard."
  echo ""
  exit 0
fi

if [ $# -gt 0 ]; then
  error "fleet init takes no arguments. See: fleet init --help"
fi

# ─── Constants ───────────────────────────────────────────────────────────────
# fleet init is a per-project bootstrap: write .fleet/ into the project working
# directory (PWD), not into the CLI install directory (FLEET_ROOT).
FLEET_DIR="${PWD}/.fleet"
FLEET_TOML="${FLEET_DIR}/fleet.toml"

# ─── Helpers ─────────────────────────────────────────────────────────────────

# _PROMPT_RESULT: global used by ask()
_PROMPT_RESULT=""

# ask LABEL DEFAULT — reads a value from /dev/tty, stores in _PROMPT_RESULT.
ask() {
  local label="$1" default="${2:-}"
  if [ -n "$default" ]; then
    printf "  %-38s [%s]: " "${label}" "${default}"
  else
    printf "  %-38s: " "${label}"
  fi
  read -r _PROMPT_RESULT </dev/tty
  _PROMPT_RESULT="${_PROMPT_RESULT:-${default}}"
}

# ask_yn LABEL — reads Y/n; returns 0 for yes, 1 for no.
ask_yn() {
  local label="$1" ans
  printf "  %s [Y/n]: " "${label}"
  if [ -t 0 ]; then
    read -r ans </dev/tty
  else
    ans="y"
    echo "y (no tty — defaulting yes)"
  fi
  case "${ans:-y}" in
    [Nn]*) return 1 ;;
    *)     return 0 ;;
  esac
}

# pick_port DEFAULT — prints a free port, prompting on collision.
pick_port() {
  local default="$1"
  if command -v lsof >/dev/null 2>&1 \
     && lsof -iTCP:"${default}" -sTCP:LISTEN -nP >/dev/null 2>&1; then
    warn "Port ${default} is already in use on the host"
    printf "  Enter alternative port [%s]: " "${default}"
    if [ -t 0 ]; then
      read -r _PROMPT_RESULT </dev/tty
      _PROMPT_RESULT="${_PROMPT_RESULT:-${default}}"
    else
      _PROMPT_RESULT="${default}"
      echo "${default} (no tty — keeping default)"
    fi
  else
    _PROMPT_RESULT="${default}"
  fi
  printf '%s' "${_PROMPT_RESULT}"
}

# ─── Stack inference ─────────────────────────────────────────────────────────

# infer_stack SERVICE_DIR — prints the detected stack type.
# Detection order: next → vite → spring → gradle → go → node → unknown
infer_stack() {
  local dir="$1"
  # 1. Next.js
  if [ -f "${dir}/next.config.js" ] || [ -f "${dir}/next.config.mjs" ] \
  || [ -f "${dir}/next.config.ts" ]; then
    echo "next"; return
  fi
  # 2. Vite
  if [ -f "${dir}/vite.config.js" ] || [ -f "${dir}/vite.config.ts" ] \
  || [ -f "${dir}/vite.config.mjs" ]; then
    echo "vite"; return
  fi
  # 3. Spring (Maven)
  if [ -f "${dir}/pom.xml" ]; then
    echo "spring"; return
  fi
  # 4. Gradle
  if [ -f "${dir}/build.gradle" ] || [ -f "${dir}/build.gradle.kts" ]; then
    echo "gradle"; return
  fi
  # 5. Go
  if [ -f "${dir}/go.mod" ]; then
    echo "go"; return
  fi
  # 6. Node (bare package.json, no framework markers above)
  if [ -f "${dir}/package.json" ]; then
    echo "node"; return
  fi
  echo "unknown"
}

# ─── Hot-reload advisory ─────────────────────────────────────────────────────

# check_hot_reload SVC_DIR STACK — warns about missing hot-reload config.
check_hot_reload() {
  local svc_dir="$1" stack="$2"
  case "${stack}" in
    spring)
      if ! grep -q 'spring-boot-devtools' "${svc_dir}/pom.xml" 2>/dev/null; then
        warn "spring-boot-devtools not found in pom.xml — hot reload disabled"
      fi
      ;;
    go)
      if [ ! -f "${svc_dir}/.air.toml" ]; then
        warn "Air (hot reload for Go) not configured in ${svc_dir}"
        if ask_yn "Generate .air.toml in ${svc_dir##*/}?"; then
          cat > "${svc_dir}/.air.toml" <<'AIRCONF'
root = "."
tmp_dir = "tmp"

[build]
  bin = "./tmp/main"
  cmd = "go build -o ./tmp/main ."
  delay = 1000
  exclude_dir = ["assets", "tmp", "vendor", "testdata"]
  include_ext = ["go", "tpl", "tmpl", "html"]
  stop_on_error = false

[log]
  main_only = false
  time = false
AIRCONF
          info "Generated .air.toml"
        fi
      else
        info "Air config: already present"
      fi
      ;;
  esac
}

# ─── Discover untracked .env files → fleet.toml [[shared]] blocks ────────────

discover_env_files() {
  local proj_root="$1"
  local toml_file="${FLEET_DIR}/fleet.toml"
  local legacy_file="${FLEET_DIR}/shared.env"
  local marker_start="# --- auto-discovered by fleet init ---"
  local marker_end="# --- end auto-discovered ---"

  local -a found=()
  local candidate fname rel_path

  while IFS= read -r candidate; do
    fname="$(basename "${candidate}")"
    case "${fname}" in
      .env.production*|.env.example|.env.sample|.env.template) continue ;;
    esac
    case "${fname}" in
      .env|.env.local|.env.development|.env.development.local|.env.*.local) ;;
      *) continue ;;
    esac
    rel_path="${candidate#${proj_root}/}"
    # Skip git-tracked files
    if git -C "$(dirname "${candidate}")" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      if git -C "$(dirname "${candidate}")" ls-files --error-unmatch "${candidate}" >/dev/null 2>&1; then
        continue
      fi
    fi
    found+=("${rel_path}")
  done < <(find "${proj_root}" -maxdepth 3 -name '.env*' -type f \
             \( -not -path '*/node_modules/*' -not -path '*/.git/*' \
                -not -path '*/target/*' -not -path '*/dist/*' \) 2>/dev/null)

  # Emit the auto-discovered block between markers in fleet.toml.
  # Idempotency: on re-run, replace the existing block in place; never touch
  # user-added [[shared]] entries outside the markers.
  [ -f "${toml_file}" ] || error "discover_env_files: ${toml_file} not found (write_fleet_toml should have run first)"

  local tmp; tmp="$(mktemp)"
  local inside_block=0 block_written=0
  while IFS= read -r line || [ -n "${line}" ]; do
    if [ "${line}" = "${marker_start}" ]; then
      inside_block=1
      echo "${marker_start}" >> "${tmp}"
      local p
      for p in "${found[@]+"${found[@]}"}"; do
        printf '[[shared]]\npath = "%s"\n\n' "${p}" >> "${tmp}"
      done
      block_written=1
      continue
    fi
    if [ "${line}" = "${marker_end}" ]; then
      inside_block=0
      echo "${marker_end}" >> "${tmp}"
      continue
    fi
    [ "${inside_block}" -eq 1 ] && continue
    echo "${line}" >> "${tmp}"
  done < "${toml_file}"

  if [ "${block_written}" -eq 0 ]; then
    {
      echo ""
      echo "${marker_start}"
      local p
      for p in "${found[@]+"${found[@]}"}"; do
        printf '[[shared]]\npath = "%s"\n\n' "${p}"
      done
      echo "${marker_end}"
    } >> "${tmp}"
  fi
  mv "${tmp}" "${toml_file}"

  # Deprecate the legacy file: stop writing it, annotate if it exists so users
  # who still have it around understand the new location.
  if [ -f "${legacy_file}" ]; then
    local dep_line="# DEPRECATED — moved to .fleet/fleet.toml [[shared]] blocks."
    if ! head -n1 "${legacy_file}" | grep -q "^# DEPRECATED"; then
      local ltmp; ltmp="$(mktemp)"
      echo "${dep_line}" > "${ltmp}"
      cat "${legacy_file}" >> "${ltmp}"
      mv "${ltmp}" "${legacy_file}"
    fi
  fi

  info "Discovered ${#found[@]} .env file(s) → ${toml_file} [[shared]] blocks"
}

# ─── Service detection wizard ─────────────────────────────────────────────────

# Populated by detect_services():
SVC_NAMES=()
SVC_DIRS=()
SVC_STACKS=()
SVC_PORTS=()
SVC_BUILDS=()
SVC_RUNS=()

detect_services() {
  local proj_root="$1"
  local svc_dir dname stack

  echo ""
  info "Scanning ${proj_root} for service directories..."
  echo ""

  for svc_dir in "${proj_root}"/*/; do
    [ -d "${svc_dir}" ] || continue
    dname="$(basename "${svc_dir}")"
    case "${dname}" in
      .* | node_modules | target | dist | out | build | .fleet | .git) continue ;;
    esac

    stack=$(infer_stack "${svc_dir}")
    [ "${stack}" = "unknown" ] && continue

    local ans
    printf "  Include '%s' as a service? (stack: %s) [Y/n]: " "${dname}" "${stack}"
    if [ -t 0 ]; then
      read -r ans </dev/tty
    else
      ans="y"
      echo "y (no tty)"
    fi
    case "${ans:-y}" in [Nn]*) continue ;; esac

    local default_port="3000" default_build="" default_run=""
    case "${stack}" in
      spring)  default_port="8081"; default_build="mvn package -DskipTests -q"; default_run="java -jar /home/developer/${dname}.jar" ;;
      gradle)  default_port="8081"; default_build="gradle build -x test";       default_run="java -jar /home/developer/${dname}.jar" ;;
      go)      default_port="8080"; default_build="go build -o server .";       default_run="/app/${dname}/server" ;;
      node)    default_port="3000"; default_build="npm run build";              default_run="node dist/index.js" ;;
      next)    default_port="3000"; default_build="npm run build";              default_run="npm run dev" ;;
      vite)    default_port="5173"; default_build="npm run build";              default_run="npm run dev" ;;
    esac

    ask "  Port for ${dname}" "${default_port}"; local svc_port="${_PROMPT_RESULT}"
    ask "  Build command"     "${default_build}"; local svc_build="${_PROMPT_RESULT}"
    ask "  Run command"       "${default_run}";   local svc_run="${_PROMPT_RESULT}"

    SVC_NAMES+=("${dname}")
    SVC_DIRS+=("${dname}")
    SVC_STACKS+=("${stack}")
    SVC_PORTS+=("${svc_port}")
    SVC_BUILDS+=("${svc_build}")
    SVC_RUNS+=("${svc_run}")

    info "Added service: ${dname} (${stack})"
  done

  if [ "${#SVC_NAMES[@]}" -eq 0 ]; then
    error "No services detected or selected in ${proj_root}. Ensure service directories contain pom.xml, go.mod, package.json, etc."
  fi
}

# ─── Write canonical fleet.toml ──────────────────────────────────────────────

write_fleet_toml() {
  local proj_root="$1" proj_name="$2" proxy_port="$3" admin_port="$4" db_port="$5" worktree_tmpl="${6:-}"
  local i stack

  mkdir -p "${FLEET_DIR}"

  {
    echo "# fleet.toml — generated by fleet init on $(date '+%Y-%m-%d')"
    echo ""
    echo "[project]"
    echo "name = \"${proj_name}\""
    echo "root = \"${proj_root}\""
    echo "worktree_template = \"${worktree_tmpl}\""
    echo ""
    echo "[ports]"
    echo "proxy = ${proxy_port}"
    echo "admin = ${admin_port}"
    echo "db    = ${db_port}"
    echo ""

    for i in "${!SVC_NAMES[@]}"; do
      echo "[[services]]"
      echo "name  = \"${SVC_NAMES[$i]}\""
      echo "dir   = \"${SVC_DIRS[$i]}\""
      echo "stack = \"${SVC_STACKS[$i]}\""
      echo "port  = ${SVC_PORTS[$i]}"
      echo "build = \"${SVC_BUILDS[$i]}\""
      echo "run   = \"${SVC_RUNS[$i]}\""
      echo ""
    done
  } > "${FLEET_TOML}"

  info "Written: ${FLEET_TOML}"
}

# ─── Write .fleet/.gitignore ─────────────────────────────────────────────────
# Ignores fleet's per-project generated files. Idempotent: won't overwrite
# an existing .gitignore (user may have customized it).
write_fleet_gitignore() {
  local gi="${FLEET_DIR}/.gitignore"
  if [ -f "${gi}" ]; then
    info ".fleet/.gitignore already exists — leaving untouched"
    return
  fi
  cat > "${gi}" <<'GITIGNORE'
# Auto-generated by `fleet init` — fleet's per-project config.
# These are regenerable or machine-specific; do not commit.
fleet.toml
shared.env
host-runner.pid
GITIGNORE
  info "Written: ${gi}"
}

# ─── Prerequisites ───────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || error "docker is not installed"

# ─── Config flow ─────────────────────────────────────────────────────────────
mkdir -p "${FLEET_DIR}"

PROJECT_ROOT=""
PROJECT_NAME=""
PROXY_PORT="3000"
ADMIN_PORT="4000"
DB_PORT="5432"
WORKTREE_TEMPLATE=".worktrees/{name}"

if [ -f "${FLEET_TOML}" ]; then
  info "Found existing ${FLEET_TOML} — reconfiguring idempotently"
  load_fleet_toml

  PROJECT_ROOT="${FLEET_PROJECT_ROOT}"
  PROJECT_NAME="${FLEET_PROJECT_NAME}"
  PROXY_PORT="${FLEET_PORT_PROXY:-3000}"
  ADMIN_PORT="${FLEET_PORT_ADMIN:-4000}"
  DB_PORT="${FLEET_PORT_DB:-5432}"
  # Preserve existing worktree_template if set; otherwise keep the default.
  # NB: can't use ${VAR:-.worktrees/{name}} — bash parameter-expansion braces
  # don't nest, so the first `}` closes the expansion and the second `}` is
  # appended literally, corrupting the template on every re-run.
  if [ -n "${FLEET_WORKTREE_TEMPLATE:-}" ]; then
    WORKTREE_TEMPLATE="${FLEET_WORKTREE_TEMPLATE}"
  else
    WORKTREE_TEMPLATE=".worktrees/{name}"
  fi
  export PROXY_PORT ADMIN_PORT DB_PORT

  # Rebuild SVC_* arrays from loaded TOML using python
  local_pybin=$(_find_python_with_tomllib)
  eval "$(
    "$local_pybin" - "${FLEET_TOML}" <<'PY'
import sys, json
try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib

with open(sys.argv[1], "rb") as fh:
    data = tomllib.load(fh)

services = data.get("services", [])
names  = [s.get("name","")  for s in services]
dirs   = [s.get("dir","")   for s in services]
stacks = [s.get("stack","") for s in services]
ports  = [str(s.get("port","")) for s in services]
builds = [s.get("build","") for s in services]
runs   = [s.get("run","")   for s in services]

def arr(varname, items):
    quoted = " ".join('"{}"'.format(v.replace('"', '\\"')) for v in items)
    print('{}=({})'.format(varname, quoted))

arr("SVC_NAMES",  names)
arr("SVC_DIRS",   dirs)
arr("SVC_STACKS", stacks)
arr("SVC_PORTS",  ports)
arr("SVC_BUILDS", builds)
arr("SVC_RUNS",   runs)
PY
  )"

else
  # Interactive wizard
  if [ ! -t 1 ] && [ ! -t 0 ]; then
    error ".fleet/fleet.toml not found and no terminal available for interactive setup.
  Copy ${FLEET_ROOT}/.fleet/fleet.toml.example to ${FLEET_TOML} and fill it in."
  fi

  echo ""
  echo -e "${GREEN}── Fleet: first-time project setup ──────────────────────────────${RESET}"
  echo ""

  PROJECT_ROOT="$(pwd)"
  info "Project root: ${PROJECT_ROOT}"

  local_default_name=$(basename "${PROJECT_ROOT}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g')
  ask "Project name" "${local_default_name}"; PROJECT_NAME="${_PROMPT_RESULT}"

  PROXY_PORT=$(pick_port "3000"); export PROXY_PORT
  ADMIN_PORT=$(pick_port "4000"); export ADMIN_PORT
  DB_PORT="5432"; export DB_PORT

  ask "Worktree template (use {name} as placeholder)" ".worktrees/{name}"
  WORKTREE_TEMPLATE="${_PROMPT_RESULT}"

  detect_services "${PROJECT_ROOT}"

  write_fleet_toml "${PROJECT_ROOT}" "${PROJECT_NAME}" "${PROXY_PORT}" "${ADMIN_PORT}" "${DB_PORT}" "${WORKTREE_TEMPLATE}"
fi

# ─── Hot-reload advisory (runs without Dockerfile generation now) ─────────────
idx=0
while [ "${idx}" -lt "${#SVC_NAMES[@]}" ]; do
  check_hot_reload "${PROJECT_ROOT}/${SVC_DIRS[$idx]}" "${SVC_STACKS[$idx]}"
  idx=$((idx + 1))
done

# ─── Re-emit canonical fleet.toml (normalize format on idempotent runs) ──────
write_fleet_toml "${PROJECT_ROOT}" "${PROJECT_NAME}" "${PROXY_PORT}" "${ADMIN_PORT}" "${DB_PORT}" "${WORKTREE_TEMPLATE}"

# ─── Seed .fleet/.gitignore (idempotent) ─────────────────────────────────────
write_fleet_gitignore

# ─── Discover .env files → .fleet/shared.env ─────────────────────────────────
discover_env_files "${PROJECT_ROOT}"

# ─── Build unified base image ─────────────────────────────────────────────────
# All stacks share a single fleet-feature-base image (Ubuntu 24.04 + Java 21 +
# Node 20 + PostgreSQL 16 + nginx + supervisord + WireMock jar).
#
# If the project ships its own .fleet/Dockerfile.feature-base, build a
# project-scoped image tagged fleet-feature-base-<project> so that custom
# toolchains do not collide with the global image used by other projects.
# The build context always stays FLEET_ROOT so that fleet-owned config files
# (nginx.conf.tmpl, supervisord.conf, entrypoint.sh) remain COPYable.
FEATURE_BASE_DOCKERFILE="${FLEET_ROOT}/.fleet/Dockerfile.feature-base"
if [ ! -f "${FEATURE_BASE_DOCKERFILE}" ]; then
  error "Unified Dockerfile not found at ${FEATURE_BASE_DOCKERFILE}. Re-clone or reinstall qa-fleet."
fi
PROJECT_LOCAL_DOCKERFILE="${PWD}/.fleet/Dockerfile.feature-base"
if [ -f "${PROJECT_LOCAL_DOCKERFILE}" ]; then
  FEATURE_BASE_IMAGE="fleet-feature-base-${PROJECT_NAME}"
  info "Building project-local base image ${FEATURE_BASE_IMAGE} (from ${PROJECT_LOCAL_DOCKERFILE})..."
  docker build --load -t "${FEATURE_BASE_IMAGE}" -f "${PROJECT_LOCAL_DOCKERFILE}" "${FLEET_ROOT}"
else
  FEATURE_BASE_IMAGE="fleet-feature-base"
  info "Building fleet-feature-base image (done once, reused for all features)..."
  docker build --load -t "${FEATURE_BASE_IMAGE}" -f "${FEATURE_BASE_DOCKERFILE}" "${FLEET_ROOT}"
fi

# ─── Infra bootstrap ─────────────────────────────────────────────────────────

# Host runner
info "Starting host runner..."
bash "${FLEET_ROOT}/scripts/fleet-host-runner.sh" &
echo "$!" > "${FLEET_DIR}/host-runner.pid" 2>/dev/null || true

# Docker network
if docker network inspect fleet-net >/dev/null 2>&1; then
  warn "Network 'fleet-net' already exists — skipping"
else
  info "Creating Docker network 'fleet-net'..."
  docker network create fleet-net
fi

# Build gateway image
info "Building gateway image..."
docker build \
  --load \
  -f "${FLEET_ROOT}/gateway/Dockerfile" \
  -t fleet-gateway \
  "${FLEET_ROOT}"

# Stop existing gateway container
if docker inspect fleet-gateway >/dev/null 2>&1; then
  warn "Stopping existing gateway container..."
  docker rm -f fleet-gateway
fi

# Start gateway
info "Starting gateway container..."
docker run -d \
  --name fleet-gateway \
  --network fleet-net \
  -e PROXY_PORT="${PROXY_PORT}" \
  -e ADMIN_PORT="${ADMIN_PORT}" \
  -e BACKEND_PORT="${BACKEND_PORT:-8080}" \
  -p "${PROXY_PORT}:${PROXY_PORT}" \
  -p "${ADMIN_PORT}:${ADMIN_PORT}" \
  -p "${BACKEND_PORT:-8080}:${BACKEND_PORT:-8080}" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --security-opt label=disable \
  --restart unless-stopped \
  fleet-gateway

# Wait for gateway
info "Waiting for gateway to be ready..."
gw_attempts=0
until curl -sf "http://localhost:${ADMIN_PORT}/_fleet/api/status" >/dev/null 2>&1; do
  gw_attempts=$((gw_attempts + 1))
  [ "${gw_attempts}" -ge 30 ] && error "Gateway did not start within 30s"
  sleep 1
done
info "Gateway is up."

# ─── Install fleet CLI ────────────────────────────────────────────────────────
fleet_bin="${FLEET_ROOT}/fleet"
install_target="/usr/local/bin/fleet"
chmod +x "${fleet_bin}"
if ln -sf "${fleet_bin}" "${install_target}" 2>/dev/null; then
  info "Installed: fleet → ${install_target}"
else
  warn "Could not symlink to /usr/local/bin (permission denied). Run manually:"
  warn "  sudo ln -sf ${fleet_bin} ${install_target}"
fi

# ─── Install /configure-fleet-startup slash command ──────────────────────────
cmd_src="${FLEET_ROOT}/cli/templates/configure-fleet-startup.md"
cmd_dst="${PROJECT_ROOT}/.claude/commands/configure-fleet-startup.md"
if [ -f "${cmd_src}" ]; then
  mkdir -p "$(dirname "${cmd_dst}")"
  cp "${cmd_src}" "${cmd_dst}"
  info "Installed slash command: .claude/commands/configure-fleet-startup.md"
fi

# ─── Success banner ───────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}┌──────────────────────────────────────────────┐${RESET}"
echo -e "${GREEN}│  Fleet ready                                 │${RESET}"
echo -e "${GREEN}│  Dashboard  → http://localhost:${ADMIN_PORT}          │${RESET}"
echo -e "${GREEN}│  Proxy      → http://localhost:${PROXY_PORT}          │${RESET}"
echo -e "${GREEN}│  Backend    → http://localhost:${BACKEND_PORT:-8080}          │${RESET}"
echo -e "${GREEN}└──────────────────────────────────────────────┘${RESET}"
echo ""
echo -e "${GREEN}Tip:${RESET} open ${PROJECT_ROOT} in Claude Code and run ${GREEN}/configure-fleet-startup${RESET}"
echo "     to verify service health and tune build/run commands."
