#!/bin/bash
set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export FLEET_ROOT

# Source shared library (provides color helpers, info/warn/error)
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

# ─── Args ────────────────────────────────────────────────────────────────────
if [ -z "${1:-}" ]; then
  echo "Usage: fleet init <app-root-folder> [branch]"
  echo ""
  echo "  app-root-folder — path to your project root"
  echo "  branch          — first feature branch to spin up (default: main)"
  echo ""
  echo "Example:"
  echo "  fleet init /path/to/my/project feature/my-branch"
  echo ""
  echo "If qa-fleet.conf does not exist in the project root, the script will"
  echo "scan the project and walk you through creating one."
  exit 1
fi

APP_ROOT_ARG="$1"
BRANCH="${2:-main}"

cd "${FLEET_ROOT}"

APP_ROOT="$(cd "${APP_ROOT_ARG}" && pwd)" \
  || error "Folder '${APP_ROOT_ARG}' does not exist"
export APP_ROOT

FLEET_CONF="${APP_ROOT}/qa-fleet.conf"

# ─── Helpers for interactive setup ───────────────────────────────────────────

# Prompt the user for a value. Reads from /dev/tty so it works even when
# stdin is piped. Result lands in the global $_PROMPT_RESULT.
_PROMPT_RESULT=""
ask() {
  local label="$1" default="$2"
  if [ -n "$default" ]; then
    printf "  %-38s [%s]: " "${label}" "${default}"
  else
    printf "  %-38s: " "${label}"
  fi
  read -r _PROMPT_RESULT </dev/tty
  _PROMPT_RESULT="${_PROMPT_RESULT:-${default}}"
}

# Generate a random 48-char hex secret, no external tools required.
gen_secret() {
  python3 -c "import secrets; print(secrets.token_hex(24))" 2>/dev/null \
    || LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom 2>/dev/null | head -c 48 \
    || echo "changeme-replace-with-a-256-bit-secret-1234567890ab"
}

# Detect if a directory looks like a frontend (has package.json with build script).
has_build_script() {
  local pkg="${1}/package.json"
  [ -f "$pkg" ] && grep -q '"build"' "$pkg" 2>/dev/null
}

# Check whether a TCP port is in use on the host. Returns 0 if in use, 1 if free.
# Silent if lsof is unavailable (also returns 1 so callers skip the collision path).
port_in_use() {
  local port="$1"
  command -v lsof >/dev/null 2>&1 || return 1
  lsof -iTCP:"${port}" -sTCP:LISTEN -nP >/dev/null 2>&1
}

# Prompt for an alternative port when the default is bound. TTY-safe (commit cada935):
# if no tty, silently fall back to the default rather than blocking automation.
# Writes the chosen value to $_PROMPT_RESULT.
prompt_alt_port() {
  local label="$1" default="$2"
  if port_in_use "${default}"; then
    warn "Port ${default} (${label}) is already in use on the host"
    printf "  Enter alternative %s port [%s]: " "${label}" "${default}"
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
}

# ─── Interactive config wizard ────────────────────────────────────────────────
setup_fleet_conf() {
  # Derive a slug from the project folder name for use as default DB/JWT names.
  local project_slug
  project_slug=$(basename "${APP_ROOT}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/_/g')

  echo ""
  echo -e "${GREEN}── QA Fleet: first-time project setup ──────────────────────────${RESET}"
  echo "   Project root : ${APP_ROOT}"
  echo "   Scanning for frontend and backend directories..."
  echo ""

  # ── Auto-detect frontend ──────────────────────────────────────────────────
  local det_frontend="" det_out="dist" det_frontend_port="3000"
  for dir in "${APP_ROOT}"/*/; do
    [ -d "$dir" ] || continue
    local dname; dname=$(basename "$dir")
    if has_build_script "$dir"; then
      # Prefer dirs that look like a frontend (next/vite config present)
      if ls "${dir}"next.config.* >/dev/null 2>&1; then
        det_frontend="$dname"; det_out="out"; det_frontend_port="3000"; break
      elif ls "${dir}"vite.config.* >/dev/null 2>&1; then
        det_frontend="$dname"; det_out="dist"; det_frontend_port="5173"; break
      else
        # Take the first one with a build script as fallback
        [ -z "$det_frontend" ] && det_frontend="$dname"
      fi
    fi
  done

  # ── Auto-detect backend ───────────────────────────────────────────────────
  local det_backend="" det_build="" det_run="" det_port="8081"
  for dir in "${APP_ROOT}"/*/; do
    [ -d "$dir" ] || continue
    local dname; dname=$(basename "$dir")
    [ "$dname" = "$det_frontend" ] && continue   # skip the frontend dir
    if [ -f "${dir}pom.xml" ]; then
      det_backend="$dname"
      det_build="mvn package -DskipTests -q"
      det_run="java -jar /home/developer/backend.jar"
      break
    elif [ -f "${dir}go.mod" ]; then
      det_backend="$dname"
      det_build="go build -o server ."
      det_run="/app/${dname}/server"
      break
    elif has_build_script "$dir"; then
      # Node backend: only pick up if we already found the frontend elsewhere
      [ -n "$det_frontend" ] && [ "$dname" != "$det_frontend" ] || continue
      det_backend="$dname"
      det_build="npm run build"
      det_run="node /app/${dname}/dist/index.js"
      break
    fi
  done

  # ── Print detection summary ───────────────────────────────────────────────
  if [ -n "$det_frontend" ]; then
    echo -e "   ${GREEN}✓${RESET} Frontend detected : ${det_frontend} (output dir: ${det_out})"
  else
    echo -e "   ${YELLOW}?${RESET} No frontend detected automatically"
  fi
  if [ -n "$det_backend" ]; then
    echo -e "   ${GREEN}✓${RESET} Backend detected  : ${det_backend}"
  else
    echo -e "   ${YELLOW}-${RESET} No backend detected (frontend-only mode)"
  fi
  echo ""
  echo -e "   ${YELLOW}Answer each question — press Enter to accept the detected value.${RESET}"
  echo ""

  # ── Frontend prompts ──────────────────────────────────────────────────────
  local v_frontend v_out
  echo -e "   ${GREEN}── Frontend${RESET}"
  ask "Frontend directory" "$det_frontend";  v_frontend="$_PROMPT_RESULT"
  ask "Build output directory" "$det_out";   v_out="$_PROMPT_RESULT"
  [ -n "$v_frontend" ] || error "FRONTEND_DIR cannot be empty"

  # ── Backend prompts ───────────────────────────────────────────────────────
  local v_backend v_build v_run v_port
  echo ""
  echo -e "   ${GREEN}── Backend${RESET}  (press Enter on directory to skip — frontend-only)"
  ask "Backend directory" "$det_backend"; v_backend="$_PROMPT_RESULT"

  if [ -n "$v_backend" ]; then
    ask "Backend build command"    "$det_build"; v_build="$_PROMPT_RESULT"
    ask "Backend run command"      "$det_run";   v_run="$_PROMPT_RESULT"
    ask "Backend port"             "$det_port";  v_port="$_PROMPT_RESULT"
  else
    v_build="" v_run="" v_port=""
  fi

  # ── Database prompts ──────────────────────────────────────────────────────
  local v_db_name v_db_user v_db_password
  echo ""
  echo -e "   ${GREEN}── Database${RESET}  (press Enter on name to skip PostgreSQL)"
  ask "Database name" "${project_slug}_db"; v_db_name="$_PROMPT_RESULT"

  if [ -n "$v_db_name" ]; then
    ask "Database user"     "${project_slug}_user"; v_db_user="$_PROMPT_RESULT"
    ask "Database password" "changeme";             v_db_password="$_PROMPT_RESULT"
  else
    v_db_user="" v_db_password=""
  fi

  # ── Runtime env prompts ───────────────────────────────────────────────────
  local v_jwt_secret v_jwt_issuer
  echo ""
  echo -e "   ${GREEN}── Backend runtime environment${RESET}"
  local default_secret; default_secret=$(gen_secret)
  ask "JWT secret"  "$default_secret";   v_jwt_secret="$_PROMPT_RESULT"
  ask "JWT issuer"  "$project_slug";     v_jwt_issuer="$_PROMPT_RESULT"

  # ── Gateway port collision check ──────────────────────────────────────────
  # Only prompt if the default port is already bound AND lsof is available.
  # Otherwise keep the default silently so CI/non-interactive runs are unaffected.
  local v_proxy_port v_admin_port
  prompt_alt_port "gateway proxy"  "3000"; v_proxy_port="$_PROMPT_RESULT"
  prompt_alt_port "gateway admin"  "4000"; v_admin_port="$_PROMPT_RESULT"

  # ── Write qa-fleet.conf ───────────────────────────────────────────────────
  echo ""
  cat > "${FLEET_CONF}" <<CONF
# QA Fleet project configuration
# Generated by fleet init on $(date '+%Y-%m-%d')

# ── Frontend ─────────────────────────────────────────────────────────────────
FRONTEND_DIR="${v_frontend}"
FRONTEND_OUT_DIR="${v_out}"

# ── Backend ───────────────────────────────────────────────────────────────────
BACKEND_DIR="${v_backend}"
BACKEND_BUILD_CMD="${v_build}"
BACKEND_RUN_CMD="${v_run}"
BACKEND_PORT="${v_port:-8081}"

# ── Database ──────────────────────────────────────────────────────────────────
DB_NAME="${v_db_name}"
DB_USER="${v_db_user}"
DB_PASSWORD="${v_db_password}"

# ── Backend runtime environment ───────────────────────────────────────────────
JWT_SECRET="${v_jwt_secret}"
JWT_ISSUER="${v_jwt_issuer}"

# ── Ports (host-side) ─────────────────────────────────────────────────────────
# Change these if the defaults collide with something already running locally.
PROXY_PORT="${v_proxy_port}"
ADMIN_PORT="${v_admin_port}"
FRONTEND_PORT="${det_frontend_port}"
DB_PORT="5432"

# ── Toolchain versions ────────────────────────────────────────────────────────
# Baked into the stack Dockerfiles at build time. Bump carefully.
POSTGRES_VERSION="16"
NODE_VERSION="20"
JAVA_VERSION="21"
GO_VERSION="1.22"

# ── Paths (inside feature containers) ─────────────────────────────────────────
BACKEND_ARTIFACT_PATH="/home/developer/backend.jar"
CONF

  info "Written: ${FLEET_CONF}"
  echo ""
}

# ─── Load or create qa-fleet.conf ────────────────────────────────────────────
if [ ! -f "${FLEET_CONF}" ]; then
  if [ ! -t 0 ] && [ ! -t 1 ]; then
    error "qa-fleet.conf not found in ${APP_ROOT} and no terminal available for interactive setup.
  Copy ${FLEET_ROOT}/qa-fleet.conf.example to ${APP_ROOT}/qa-fleet.conf and fill it in."
  fi
  setup_fleet_conf
else
  info "Found existing ${FLEET_CONF}"
fi

# shellcheck source=/dev/null
source "${FLEET_CONF}"

# ─── Validate config ──────────────────────────────────────────────────────────
[ -n "${FRONTEND_DIR:-}" ] \
  || error "FRONTEND_DIR is not set in qa-fleet.conf"
[ -d "${APP_ROOT}/${FRONTEND_DIR}" ] \
  || error "'${FRONTEND_DIR}' directory not found in ${APP_ROOT} (check FRONTEND_DIR in qa-fleet.conf)"

if [ -n "${BACKEND_DIR:-}" ]; then
  [ -d "${APP_ROOT}/${BACKEND_DIR}" ] \
    || error "'${BACKEND_DIR}' directory not found in ${APP_ROOT} (check BACKEND_DIR in qa-fleet.conf)"
fi

# Apply defaults for optional fields (same as load_fleet_conf)
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

# ── Defaults for port / version / path knobs ─────────────────────────────────
# Existing qa-fleet.conf files written before these keys existed still work:
# :=-style defaults apply in-place and are exported for downstream subshells.
: "${PROXY_PORT:=3000}"
: "${ADMIN_PORT:=4000}"
# FRONTEND_PORT default depends on the frontend stack, but STACK_FRONTEND isn't
# detected yet (see detect_and_configure_stack below). Use 3000 as a safe
# baseline here; the stack detector adjusts it once STACK_FRONTEND is known.
: "${FRONTEND_PORT:=3000}"
: "${DB_PORT:=5432}"
: "${POSTGRES_VERSION:=16}"
: "${NODE_VERSION:=20}"
: "${JAVA_VERSION:=21}"
: "${GO_VERSION:=1.22}"
: "${BACKEND_ARTIFACT_PATH:=/home/developer/backend.jar}"
export PROXY_PORT ADMIN_PORT FRONTEND_PORT DB_PORT
export POSTGRES_VERSION NODE_VERSION JAVA_VERSION GO_VERSION
export BACKEND_ARTIFACT_PATH

# ─── Stack detection ──────────────────────────────────────────────────────────
detect_and_configure_stack() {
  STACK_BACKEND="none"
  STACK_FRONTEND="none"

  # Backend detection (check in BACKEND_DIR if set, else APP_ROOT)
  local backend_check_dir="${APP_ROOT}"
  [ -n "${BACKEND_DIR:-}" ] && backend_check_dir="${APP_ROOT}/${BACKEND_DIR}"

  if [ -f "${backend_check_dir}/pom.xml" ]; then
    STACK_BACKEND="spring"
  elif [ -f "${backend_check_dir}/build.gradle" ] || [ -f "${backend_check_dir}/build.gradle.kts" ]; then
    STACK_BACKEND="gradle"
  elif [ -f "${backend_check_dir}/go.mod" ]; then
    STACK_BACKEND="go"
  elif [ -f "${backend_check_dir}/package.json" ]; then
    STACK_BACKEND="node"
  fi

  # Frontend detection (check in FRONTEND_DIR)
  local frontend_dir="${APP_ROOT}/${FRONTEND_DIR}"
  if ls "${frontend_dir}"/next.config.* >/dev/null 2>&1; then
    STACK_FRONTEND="next"
  elif ls "${frontend_dir}"/vite.config.* >/dev/null 2>&1; then
    STACK_FRONTEND="vite"
  elif [ -f "${frontend_dir}/package.json" ]; then
    STACK_FRONTEND="node"
  fi

  info "Stack detected: backend=${STACK_BACKEND}, frontend=${STACK_FRONTEND}"
  export STACK_BACKEND STACK_FRONTEND

  # Refine FRONTEND_PORT default now that STACK_FRONTEND is known.
  # Only adjust if the user hasn't explicitly set a non-default value: we
  # detect "default" by checking against the baseline 3000 applied earlier.
  # If the conf file specifies a non-3000 value we leave it alone.
  if [ "${FRONTEND_PORT}" = "3000" ] && [ "${STACK_FRONTEND}" = "vite" ]; then
    FRONTEND_PORT="5173"
    export FRONTEND_PORT
  fi

  # Copy matching Dockerfile template into FLEET_ROOT (used by docker build -f Dockerfile.feature-base)
  local src_dockerfile="" dest_dockerfile="${FLEET_ROOT}/Dockerfile.feature-base"
  case "${STACK_BACKEND}" in
    spring)  src_dockerfile="${FLEET_ROOT}/cli/stacks/Dockerfile.spring" ;;
    gradle)  src_dockerfile="${FLEET_ROOT}/cli/stacks/Dockerfile.spring" ;;
    go)      src_dockerfile="${FLEET_ROOT}/cli/stacks/Dockerfile.go" ;;
    node)    src_dockerfile="${FLEET_ROOT}/cli/stacks/Dockerfile.node" ;;
    none)
      # Frontend-only
      case "${STACK_FRONTEND}" in
        next)   src_dockerfile="${FLEET_ROOT}/cli/stacks/Dockerfile.next" ;;
        vite)   src_dockerfile="${FLEET_ROOT}/cli/stacks/Dockerfile.vite" ;;
      esac
      ;;
  esac

  if [ -n "${src_dockerfile}" ] && [ -f "${src_dockerfile}" ]; then
    if [ -f "${dest_dockerfile}" ]; then
      printf "  Dockerfile.feature-base already exists. Overwrite with %s template? [y/N]: " \
        "$(basename "${src_dockerfile}")"
      [ -t 0 ] && read -r _ans </dev/tty || { _ans="n"; echo "n (no tty)"; }
      if [[ "${_ans}" =~ ^[Yy]$ ]]; then
        apply_stack_template "${src_dockerfile}" "${dest_dockerfile}"
        info "Copied $(basename "${src_dockerfile}") → Dockerfile.feature-base"
      else
        info "Keeping existing Dockerfile.feature-base"
      fi
    else
      apply_stack_template "${src_dockerfile}" "${dest_dockerfile}"
      info "Copied $(basename "${src_dockerfile}") → Dockerfile.feature-base"
    fi
  fi
}

# ─── Hot-reload detection ─────────────────────────────────────────────────────
detect_hot_reload() {
  # Spring Boot
  if [ "${STACK_BACKEND}" = "spring" ] && [ -n "${BACKEND_DIR:-}" ]; then
    if ! grep -q 'spring-boot-devtools' "${APP_ROOT}/${BACKEND_DIR}/pom.xml" 2>/dev/null; then
      warn "spring-boot-devtools not found in pom.xml — hot reload disabled"
      printf "  Add spring-boot-devtools dependency to pom.xml? [y/N]: "
      [ -t 0 ] && read -r ans </dev/tty || { ans="n"; echo "n (no tty)"; }
      if [[ "$ans" =~ ^[Yy]$ ]]; then
        # Insert devtools dependency before </dependencies> (first occurrence)
        sed -i '' 's|</dependencies>|    <dependency>\n        <groupId>org.springframework.boot</groupId>\n        <artifactId>spring-boot-devtools</artifactId>\n        <scope>provided</scope>\n        <optional>true</optional>\n    </dependency>\n</dependencies>|' "${APP_ROOT}/${BACKEND_DIR}/pom.xml"
        info "Added spring-boot-devtools to pom.xml"
      fi
    else
      info "spring-boot-devtools: already present ✓"
    fi
  fi

  # Next.js
  if [ "${STACK_FRONTEND}" = "next" ]; then
    local next_conf="${APP_ROOT}/${FRONTEND_DIR}/next.config.js"
    [ -f "${APP_ROOT}/${FRONTEND_DIR}/next.config.mjs" ] && next_conf="${APP_ROOT}/${FRONTEND_DIR}/next.config.mjs"
    [ -f "${APP_ROOT}/${FRONTEND_DIR}/next.config.ts" ] && next_conf="${APP_ROOT}/${FRONTEND_DIR}/next.config.ts"
    if [ -f "${next_conf}" ] && grep -q "output.*export" "${next_conf}" 2>/dev/null; then
      warn "next.config has output:'export' — HMR requires dev mode, static export mode detected"
    fi
  fi

  # Go
  if [ "${STACK_BACKEND}" = "go" ] && [ -n "${BACKEND_DIR:-}" ]; then
    if [ ! -f "${APP_ROOT}/${BACKEND_DIR}/.air.toml" ] && [ ! -f "${APP_ROOT}/.air.toml" ]; then
      warn "Air (hot reload for Go) not configured"
      printf "  Generate .air.toml in backend directory? [y/N]: "
      [ -t 0 ] && read -r ans </dev/tty || { ans="n"; echo "n (no tty)"; }
      if [[ "$ans" =~ ^[Yy]$ ]]; then
        cat > "${APP_ROOT}/${BACKEND_DIR}/.air.toml" <<'AIRCONF'
root = "."
testdata_dir = "testdata"
tmp_dir = "tmp"

[build]
  args_bin = []
  bin = "./tmp/main"
  cmd = "go build -o ./tmp/main ."
  delay = 1000
  exclude_dir = ["assets", "tmp", "vendor", "testdata"]
  exclude_file = []
  exclude_regex = ["_test.go"]
  exclude_unchanged = false
  follow_symlink = false
  full_bin = ""
  include_dir = []
  include_ext = ["go", "tpl", "tmpl", "html"]
  include_file = []
  kill_delay = "0s"
  log = "build-errors.log"
  poll = false
  poll_interval = 0
  post_cmd = []
  pre_cmd = []
  rerun = false
  rerun_delay = 500
  send_interrupt = false
  stop_on_error = false

[color]
  app = ""
  build = "yellow"
  main = "magenta"
  runner = "green"
  watcher = "cyan"

[log]
  main_only = false
  time = false

[misc]
  clean_on_exit = false

[proxy]
  app_port = 0
  enabled = false
  proxy_port = 0

[screen]
  clear_on_rebuild = false
  keep_scroll = true
AIRCONF
        info "Generated .air.toml in ${APP_ROOT}/${BACKEND_DIR}/"
      fi
    else
      info "Air config: already present ✓"
    fi
  fi
}

# ─── Orchestrator detection ───────────────────────────────────────────────────
detect_orchestrator() {
  local compose_file=""
  for f in "docker-compose.yml" "compose.yml" "docker-compose.yaml" "docker-compose.override.yml"; do
    if [ -f "${APP_ROOT}/$f" ]; then
      compose_file="${APP_ROOT}/$f"
      break
    fi
  done

  if [ -n "${compose_file}" ]; then
    info "Docker Compose file detected: ${compose_file}"
    printf "  Integrate fleet gateway into this compose file? [y/N]: "
    [ -t 0 ] && read -r ans </dev/tty || { ans="n"; echo "n (no tty)"; }
    if [[ "$ans" =~ ^[Yy]$ ]]; then
      # Append fleet gateway service if not already present
      if ! grep -q 'qa-gateway' "${compose_file}" 2>/dev/null; then
        cat >> "${compose_file}" <<COMPOSE_SNIPPET

  # QA Fleet gateway — added by fleet init
  qa-gateway:
    image: qa-gateway
    container_name: qa-gateway-container
    environment:
      PROXY_PORT: "${PROXY_PORT}"
      ADMIN_PORT: "${ADMIN_PORT}"
    ports:
      - "${PROXY_PORT}:${PROXY_PORT}"
      - "${ADMIN_PORT}:${ADMIN_PORT}"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - qa-net
    restart: unless-stopped

networks:
  qa-net:
    external: true
COMPOSE_SNIPPET
        info "Added fleet gateway service to ${compose_file}"
      else
        warn "qa-gateway already present in ${compose_file} — skipping"
      fi
    fi
  fi
}

# ─── Prerequisites ───────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || error "docker is not installed"

# ─── Persist APP_ROOT ────────────────────────────────────────────────────────
printf 'APP_ROOT=%s\n' "${APP_ROOT}" > "${FLEET_ROOT}/.qa-config"
info "Saved APP_ROOT=${APP_ROOT} to .qa-config"

# ─── Run stack/hot-reload/orchestrator detection ──────────────────────────────
detect_and_configure_stack
detect_hot_reload
detect_orchestrator

# ─── Render nginx.conf from template (port substitution) ─────────────────────
NGINX_TMPL="${FLEET_ROOT}/config/nginx.conf.tmpl"
NGINX_OUT="${FLEET_ROOT}/config/nginx.conf"
if [ -f "${NGINX_TMPL}" ]; then
  if command -v envsubst >/dev/null 2>&1; then
    PROXY_PORT="${PROXY_PORT}" BACKEND_PORT="${BACKEND_PORT}" \
      envsubst '${PROXY_PORT} ${BACKEND_PORT}' < "${NGINX_TMPL}" > "${NGINX_OUT}"
  else
    # Fallback: sed-based substitution keeps init self-contained without gettext.
    sed -e "s|\${PROXY_PORT}|${PROXY_PORT}|g" \
        -e "s|\${BACKEND_PORT}|${BACKEND_PORT}|g" \
        "${NGINX_TMPL}" > "${NGINX_OUT}"
  fi
  info "Rendered config/nginx.conf (listen ${PROXY_PORT}, backend ${BACKEND_PORT})"
fi

# ─── Create worktrees directory ───────────────────────────────────────────────
mkdir -p "${APP_ROOT}/.qa-worktrees"
info "Created ${APP_ROOT}/.qa-worktrees"

# ─── Auto-discover .env files and write/update .qa-shared ────────────────────

# discover_env_files — scans APP_ROOT (and subdirs for FRONTEND_DIR/BACKEND_DIR)
# depth-1 for .env files that match the allowed glob patterns, skips git-tracked
# files, and writes results into the idempotent marker block in .qa-shared.
#
# Globals read:  APP_ROOT, FRONTEND_DIR, BACKEND_DIR (may be empty)
# No prompts — safe for non-interactive / CI runs.
discover_env_files() {
  local shared_file="${APP_ROOT}/.qa-shared"

  # Dirs to scan: root, then frontend, then backend (if set and not equal to root).
  local scan_dirs=("${APP_ROOT}")
  if [ -n "${FRONTEND_DIR:-}" ] && [ -d "${APP_ROOT}/${FRONTEND_DIR}" ]; then
    scan_dirs+=("${APP_ROOT}/${FRONTEND_DIR}")
  fi
  if [ -n "${BACKEND_DIR:-}" ] && [ -d "${APP_ROOT}/${BACKEND_DIR}" ]; then
    scan_dirs+=("${APP_ROOT}/${BACKEND_DIR}")
  fi

  # Basenames to skip (exact match).
  local -a EXCLUDE_NAMES=(".env.example" ".env.sample" ".env.template")

  # Collect discovered relative paths into an array.
  local -a found=()

  local scan_dir fname rel_path candidate
  for scan_dir in "${scan_dirs[@]}"; do
    # Skip known non-source dirs if they somehow end up in the scan list.
    local dir_base; dir_base="$(basename "${scan_dir}")"
    case "${dir_base}" in
      node_modules|.git|target|dist|build|out) continue ;;
    esac

    # Use find -maxdepth 1 to avoid glob failures when no dot-files exist.
    # -name '.env*' limits output; we refine further below.
    while IFS= read -r candidate; do
      fname="$(basename "${candidate}")"

      # Exclude production variants.
      case "${fname}" in
        .env.production*) continue ;;
      esac

      # Exclude exact names: .env.example, .env.sample, .env.template
      local skip=0
      local excl
      for excl in "${EXCLUDE_NAMES[@]}"; do
        [ "${fname}" = "${excl}" ] && skip=1 && break
      done
      [ "${skip}" -eq 1 ] && continue

      # Only accept the allowed patterns:
      #   .env  .env.local  .env.development  .env.development.local  .env.*.local
      case "${fname}" in
        .env|.env.local|.env.development|.env.development.local|.env.*.local) ;;
        *) continue ;;
      esac

      # Build relative path from APP_ROOT.
      rel_path="${candidate#${APP_ROOT}/}"
      # Safety: if the candidate path did not start with APP_ROOT/ (shouldn't
      # happen, but guard anyway), fall back to the filename.
      [ "${rel_path}" = "${candidate}" ] && rel_path="${fname}"

      # Skip git-tracked files. If the directory is not a git repo the command
      # exits non-zero and we fall through (include the file — no git, no filter).
      if git -C "${scan_dir}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        # git ls-files --error-unmatch exits 0 when the file IS tracked.
        if git -C "${scan_dir}" ls-files --error-unmatch "${candidate}" >/dev/null 2>&1; then
          continue  # tracked — skip it
        fi
      fi

      found+=("${rel_path}")
    done < <(find "${scan_dir}" -maxdepth 1 -name '.env*' -type f 2>/dev/null)
  done

  local count="${#found[@]}"

  # ── Create or update .qa-shared ───────────────────────────────────────────

  local marker_start="# --- auto-discovered by fleet init ---"
  local marker_end="# --- end auto-discovered ---"

  if [ ! -f "${shared_file}" ]; then
    # Create fresh with header + marker block.
    {
      echo "# .qa-shared — list non-tracked files to mount read-only into QA containers"
      echo "# Paths are relative to your project root (APP_ROOT)."
      echo "# Lines starting with # are comments; blank lines are ignored."
      echo "#"
      echo "# fleet init auto-populates the block below with discovered .env files."
      echo "# You can add further entries outside the marker block; they are never"
      echo "# touched by subsequent fleet init runs."
      echo "#"
      echo "# Example entries:"
      echo "# d2r2-frontend/.env.local"
      echo "# d2r2-frontend/.npmrc"
      echo "# d2r2-backend/.env"
      echo "# .env"
      echo ""
      echo "${marker_start}"
      local p
      for p in "${found[@]}"; do
        echo "${p}"
      done
      echo "${marker_end}"
    } > "${shared_file}"
  else
    # File exists — replace just the marker block content; leave everything else.
    local tmp_file; tmp_file="$(mktemp)"

    local inside_block=0
    local block_written=0

    while IFS= read -r line || [ -n "${line}" ]; do
      if [ "${line}" = "${marker_start}" ]; then
        inside_block=1
        # Write the start marker + fresh discovered entries.
        echo "${marker_start}" >> "${tmp_file}"
        local p
        for p in "${found[@]}"; do
          echo "${p}" >> "${tmp_file}"
        done
        block_written=1
        continue
      fi
      if [ "${line}" = "${marker_end}" ]; then
        inside_block=0
        echo "${marker_end}" >> "${tmp_file}"
        continue
      fi
      # Suppress lines that were inside the old block (we already rewrote it).
      [ "${inside_block}" -eq 1 ] && continue
      echo "${line}" >> "${tmp_file}"
    done < "${shared_file}"

    # If no existing marker block was found, append one.
    if [ "${block_written}" -eq 0 ]; then
      echo "" >> "${tmp_file}"
      echo "${marker_start}" >> "${tmp_file}"
      local p
      for p in "${found[@]}"; do
        echo "${p}" >> "${tmp_file}"
      done
      echo "${marker_end}" >> "${tmp_file}"
    fi

    mv "${tmp_file}" "${shared_file}"
  fi

  info "Discovered ${count} .env file(s) → mounted RO"
}

discover_env_files

# ─── Start host runner (AppleScript relay) ───────────────────────────────────
info "Starting host runner (osascript relay on port 4001)..."
bash "${FLEET_ROOT}/scripts/qa-host-runner.sh"

# ─── Network ─────────────────────────────────────────────────────────────────
if docker network inspect qa-net >/dev/null 2>&1; then
  warn "Network 'qa-net' already exists — skipping"
else
  info "Creating Docker network 'qa-net'..."
  docker network create qa-net
fi

# ─── Build gateway image ─────────────────────────────────────────────────────
info "Building gateway image (includes dashboard)..."
docker build \
  --load \
  -f gateway/Dockerfile \
  -t qa-gateway \
  .

# ─── Build feature base image ─────────────────────────────────────────────────
info "Building qa-feature-base image (done once, reused for all features)..."
docker build \
  --load \
  -f Dockerfile.feature-base \
  -t qa-feature-base \
  .

# ─── Stop existing gateway container if present ──────────────────────────────
if docker inspect qa-gateway-container >/dev/null 2>&1; then
  warn "Stopping existing gateway container..."
  docker rm -f qa-gateway-container
fi

# ─── Start gateway ───────────────────────────────────────────────────────────
info "Starting gateway container..."
docker run -d \
  --name qa-gateway-container \
  --network qa-net \
  -e PROXY_PORT="${PROXY_PORT}" \
  -e ADMIN_PORT="${ADMIN_PORT}" \
  -p "${PROXY_PORT}:${PROXY_PORT}" \
  -p "${ADMIN_PORT}:${ADMIN_PORT}" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --security-opt label=disable \
  --restart unless-stopped \
  qa-gateway

# ─── Wait for gateway to respond ─────────────────────────────────────────────
info "Waiting for gateway to be ready..."
ATTEMPTS=0
MAX=30
until curl -sf "http://localhost:${ADMIN_PORT}/_qa/api/status" >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge "$MAX" ]; then
    error "Gateway did not start within ${MAX}s"
  fi
  sleep 1
done
info "Gateway is up."

# ─── Spin up first feature ────────────────────────────────────────────────────
# Derive a safe container name from the branch (slashes → hyphens, strip unsafe chars)
NAME="${BRANCH//\//-}"
NAME="${NAME//[^a-z0-9-]/}"
NAME="${NAME:0:30}"
NAME="${NAME#-}"   # ensure it starts with a letter or digit

if [ -z "$NAME" ]; then
  error "Could not derive a valid container name from branch '${BRANCH}'"
fi

info "Spinning up first feature: ${NAME} (branch: ${BRANCH})..."
bash "${FLEET_ROOT}/cli/cmd-add.sh" "${NAME}" "${BRANCH}"

# ─── Install fleet CLI ───────────────────────────────────────────────────────
FLEET_BIN="${FLEET_ROOT}/fleet"
INSTALL_DIR="/usr/local/bin"
INSTALL_TARGET="${INSTALL_DIR}/fleet"
chmod +x "${FLEET_BIN}"
if ln -sf "${FLEET_BIN}" "${INSTALL_TARGET}" 2>/dev/null; then
  info "Installed: fleet → ${INSTALL_TARGET}"
else
  warn "Could not symlink to ${INSTALL_DIR} (permission denied). Run manually:"
  warn "  sudo ln -sf ${FLEET_BIN} ${INSTALL_TARGET}"
fi

# ─── Success banner ──────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}┌──────────────────────────────────────────────┐${RESET}"
echo -e "${GREEN}│  QA Fleet ready                              │${RESET}"
echo -e "${GREEN}│  Dashboard  → http://localhost:${ADMIN_PORT}          │${RESET}"
echo -e "${GREEN}│  Proxy      → http://localhost:${PROXY_PORT}          │${RESET}"
echo -e "${GREEN}│  Active     → ${NAME} (${BRANCH})${RESET}"
echo -e "${GREEN}└──────────────────────────────────────────────┘${RESET}"
