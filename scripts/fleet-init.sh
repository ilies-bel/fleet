#!/bin/bash
set -e

# ─── Color helpers ──────────────────────────────────────────────────────────
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  RED='\033[0;31m'
  RESET='\033[0m'
else
  GREEN='' YELLOW='' RED='' RESET=''
fi

info()  { echo -e "${GREEN}[fleet-init]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[fleet-init]${RESET} $*"; }
error() { echo -e "${RED}[fleet-init] ERROR:${RESET} $*" >&2; exit 1; }

# ─── Args ────────────────────────────────────────────────────────────────────
if [ -z "${1:-}" ] || [ -z "${2:-}" ]; then
  echo "Usage: $0 <app-root-folder> <branch>"
  echo ""
  echo "  app-root-folder — path to your project root"
  echo "  branch          — first feature branch to spin up"
  echo ""
  echo "Example:"
  echo "  $0 /path/to/my/project feature/my-branch"
  echo ""
  echo "If fleet.conf does not exist in the project root, the script will"
  echo "scan the project and walk you through creating one."
  exit 1
fi

APP_ROOT_ARG="$1"
BRANCH="$2"

# ─── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$FLEET_ROOT"

APP_ROOT="$(cd "${APP_ROOT_ARG}" && pwd)" \
  || error "Folder '${APP_ROOT_ARG}' does not exist"

FLEET_CONF="${APP_ROOT}/fleet.conf"

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

# ─── Interactive config wizard ────────────────────────────────────────────────
setup_fleet_conf() {
  # Derive a slug from the project folder name for use as default DB/JWT names.
  local project_slug
  project_slug=$(basename "${APP_ROOT}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/_/g')

  echo ""
  echo -e "${GREEN}── Fleet: first-time project setup ─────────────────────────────${RESET}"
  echo "   Project root : ${APP_ROOT}"
  echo "   Scanning for frontend and backend directories..."
  echo ""

  # ── Auto-detect frontend ──────────────────────────────────────────────────
  local det_frontend="" det_out="dist"
  for dir in "${APP_ROOT}"/*/; do
    [ -d "$dir" ] || continue
    local dname; dname=$(basename "$dir")
    if has_build_script "$dir"; then
      # Prefer dirs that look like a frontend (next/vite config present)
      if ls "${dir}"next.config.* >/dev/null 2>&1; then
        det_frontend="$dname"; det_out="out"; break
      elif ls "${dir}"vite.config.* >/dev/null 2>&1; then
        det_frontend="$dname"; det_out="dist"; break
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

  # ── Write fleet.conf ─────────────────────────────────────────────────────
  echo ""
  cat > "${FLEET_CONF}" <<CONF
# Fleet project configuration
# Generated by fleet-init.sh on $(date '+%Y-%m-%d')

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
CONF

  info "Written: ${FLEET_CONF}"
  echo ""
}

# ─── Load or create fleet.conf ───────────────────────────────────────────────
if [ ! -f "${FLEET_CONF}" ]; then
  if [ ! -t 0 ] && [ ! -t 1 ]; then
    error "fleet.conf not found in ${APP_ROOT} and no terminal available for interactive setup.
  Copy ${FLEET_ROOT}/fleet.conf.example to ${APP_ROOT}/fleet.conf and fill it in."
  fi
  setup_fleet_conf
else
  info "Found existing ${FLEET_CONF}"
fi

# shellcheck source=/dev/null
source "${FLEET_CONF}"

# ─── Validate config ──────────────────────────────────────────────────────────
[ -n "${FRONTEND_DIR:-}" ] \
  || error "FRONTEND_DIR is not set in fleet.conf"
[ -d "${APP_ROOT}/${FRONTEND_DIR}" ] \
  || error "'${FRONTEND_DIR}' directory not found in ${APP_ROOT} (check FRONTEND_DIR in fleet.conf)"

if [ -n "${BACKEND_DIR:-}" ]; then
  [ -d "${APP_ROOT}/${BACKEND_DIR}" ] \
    || error "'${BACKEND_DIR}' directory not found in ${APP_ROOT} (check BACKEND_DIR in fleet.conf)"
fi

# ─── Prerequisites ───────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || error "docker is not installed"

# ─── Persist APP_ROOT ────────────────────────────────────────────────────────
printf 'APP_ROOT=%s\n' "${APP_ROOT}" > "${FLEET_ROOT}/.fleet-config"
info "Saved APP_ROOT=${APP_ROOT} to .fleet-config"

# ─── Create worktrees directory ───────────────────────────────────────────────
mkdir -p "${APP_ROOT}/.fleet-worktrees"
info "Created ${APP_ROOT}/.fleet-worktrees"

# ─── Create .fleet-shared template if not present ────────────────────────────
SHARED_EXAMPLE="${FLEET_ROOT}/.fleet-shared.example"
if [ ! -f "${APP_ROOT}/.fleet-shared" ] && [ -f "${SHARED_EXAMPLE}" ]; then
  cp "${SHARED_EXAMPLE}" "${APP_ROOT}/.fleet-shared"
  info "Created ${APP_ROOT}/.fleet-shared — edit to list non-tracked files to share with containers"
fi

# ─── Network ─────────────────────────────────────────────────────────────────
if docker network inspect fleet-net >/dev/null 2>&1; then
  warn "Network 'fleet-net' already exists — skipping"
else
  info "Creating Docker network 'fleet-net'..."
  docker network create fleet-net
fi

# ─── Build gateway image ─────────────────────────────────────────────────────
info "Building gateway image (includes dashboard)..."
docker build \
  --load \
  -f gateway/Dockerfile \
  -t fleet-gateway \
  .

# ─── Build feature base image ─────────────────────────────────────────────────
info "Building fleet-feature-base image (done once, reused for all features)..."
docker build \
  --load \
  -f Dockerfile.feature-base \
  -t fleet-feature-base \
  .

# ─── Stop existing gateway container if present ──────────────────────────────
if docker inspect fleet-gateway >/dev/null 2>&1; then
  warn "Stopping existing gateway container..."
  docker rm -f fleet-gateway
fi

# ─── Start gateway ───────────────────────────────────────────────────────────
# Persist active-feature selection across restarts.
# ~/.fleet is bind-mounted into the container at /var/lib/fleet.
# chmod 0777 lets the container's non-root developer (uid 1001) write there
# without requiring a chown step or a separate init container — the simplest
# approach on macOS Docker Desktop where uid mapping is transparent.
FLEET_STATE_DIR="$HOME/.fleet"
mkdir -p "$FLEET_STATE_DIR"
chmod 0777 "$FLEET_STATE_DIR"

info "Starting gateway container..."
docker run -d \
  --name fleet-gateway \
  --network fleet-net \
  -p 3000:3000 \
  -p 4000:4000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$FLEET_STATE_DIR":/var/lib/fleet \
  --security-opt label=disable \
  --restart unless-stopped \
  fleet-gateway

# ─── Wait for gateway to respond ─────────────────────────────────────────────
info "Waiting for gateway to be ready..."
ATTEMPTS=0
MAX=30
until curl -sf http://localhost:4000/_fleet/api/status >/dev/null 2>&1; do
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
bash "${SCRIPT_DIR}/fleet-add.sh" "${NAME}" "${BRANCH}"

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
echo -e "${GREEN}│  Fleet ready                                 │${RESET}"
echo -e "${GREEN}│  Dashboard  → http://localhost:4000          │${RESET}"
echo -e "${GREEN}│  Proxy      → http://localhost:3000          │${RESET}"
echo -e "${GREEN}│  Active     → ${NAME} (${BRANCH})${RESET}"
echo -e "${GREEN}└──────────────────────────────────────────────┘${RESET}"
