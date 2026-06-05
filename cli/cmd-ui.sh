#!/bin/bash
set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export FLEET_ROOT

# Source shared library
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

# ─── Help ────────────────────────────────────────────────────────────────────
_ui_help() {
  local exit_code="${1:-0}"
  echo ""
  echo -e "${GREEN}fleet ui${RESET} — manage the Fleet dashboard UI"
  echo ""
  echo "Usage: fleet ui <action> [--dev]"
  echo ""
  echo "Actions:"
  echo -e "  ${BLUE}start${RESET}    Build dashboard and (re)start the gateway container (prod)"
  echo -e "  ${BLUE}restart${RESET}  Rebuild dashboard and recreate the gateway container (prod)"
  echo -e "  ${BLUE}stop${RESET}     Stop the gateway container (prod)"
  echo ""
  echo "Flags:"
  echo -e "  ${BLUE}--dev${RESET}    Run Vite hot-reload dev server in the foreground (start/restart only)"
  echo ""
  echo "Prod mode (default):"
  echo "  Rebuilds the dashboard into gateway/public, then rebuilds and recreates"
  echo "  the fleet-gateway Docker container."
  echo ""
  echo "Dev mode (--dev):"
  echo "  Runs 'npm run dev' in dashboard/ in the foreground."
  echo "  Vite proxies /_fleet/ to the gateway. Press Ctrl-C to stop."
  echo ""
  echo "Examples:"
  echo "  fleet ui start               # prod: rebuild dashboard + (re)start gateway"
  echo "  fleet ui start --dev         # dev:  foreground Vite hot-reload"
  echo "  fleet ui restart             # prod: rebuild dashboard + recreate gateway"
  echo "  fleet ui stop                # prod: stop gateway container"
  echo ""
  exit "${exit_code}"
}

# ─── Arg parsing ─────────────────────────────────────────────────────────────
ACTION=""
DEV=false

for _arg in "$@"; do
  case "${_arg}" in
    --help|-h)          _ui_help 0 ;;
    --dev)              DEV=true ;;
    start|restart|stop) ACTION="${_arg}" ;;
    *)
      echo -e "${RED}[fleet] ERROR:${RESET} Unknown argument: ${_arg}" >&2
      _ui_help 1
      ;;
  esac
done

if [ -z "${ACTION}" ]; then
  echo "Usage: fleet ui <start|restart|stop> [--dev]" >&2
  exit 1
fi

# ─── Dev mode ────────────────────────────────────────────────────────────────
if [ "${DEV}" = true ]; then
  if [ "${ACTION}" = "stop" ]; then
    info "Dev server runs in the foreground — press Ctrl-C in its terminal to stop it."
    exit 0
  fi
  # start or restart — run Vite in the foreground; exec so signals pass through
  info "Starting Vite dev server (dashboard/)..."
  (cd "${FLEET_ROOT}/dashboard" && npm install --silent >/dev/null 2>&1; exec npm run dev)
  exit 0
fi

# ─── Prod mode ───────────────────────────────────────────────────────────────
load_fleet_toml

PROXY_PORT="${FLEET_PORT_PROXY}"
ADMIN_PORT="${FLEET_PORT_ADMIN}"
BACKEND_PORT="${BACKEND_PORT:-8080}"

if [ "${ACTION}" = "stop" ]; then
  info "Stopping fleet-gateway container..."
  docker stop fleet-gateway >/dev/null 2>&1 || warn "Gateway not running"
  info "Dashboard stopped."
  exit 0
fi

# start or restart: build dashboard, then rebuild + recreate gateway container

info "Building dashboard..."
(
  cd "${FLEET_ROOT}/dashboard"
  npm install --silent >/dev/null 2>&1
  npm run build
)

info "Building gateway image..."
docker build \
  -f "${FLEET_ROOT}/gateway/Dockerfile" \
  -t fleet-gateway \
  "${FLEET_ROOT}"

# Remove existing container if present
if docker inspect fleet-gateway >/dev/null 2>&1; then
  warn "Removing existing gateway container..."
  docker rm -f fleet-gateway
fi

info "Starting gateway container..."
docker run -d \
  --name fleet-gateway \
  --network fleet-net \
  -e PROXY_PORT="${PROXY_PORT}" \
  -e ADMIN_PORT="${ADMIN_PORT}" \
  -e BACKEND_PORT="${BACKEND_PORT}" \
  -p "${PROXY_PORT}:${PROXY_PORT}" \
  -p "${ADMIN_PORT}:${ADMIN_PORT}" \
  -p "${BACKEND_PORT}:${BACKEND_PORT}" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --security-opt label=disable \
  --restart unless-stopped \
  fleet-gateway

# Wait for gateway to be ready
info "Waiting for gateway to be ready..."
gw_attempts=0
until curl -sf "http://localhost:${ADMIN_PORT}/_fleet/api/status" >/dev/null 2>&1; do
  gw_attempts=$((gw_attempts + 1))
  [ "${gw_attempts}" -ge 30 ] && error "Gateway did not start within 30s"
  sleep 1
done

info "Dashboard is up at ${BLUE}http://localhost:${ADMIN_PORT}${RESET}"
