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
_migrate_names_help() {
  local exit_code="${1:-0}"
  echo ""
  echo -e "${GREEN}fleet migrate-names${RESET} — identify and remove pre-migration bare-named containers"
  echo ""
  echo "Usage: fleet migrate-names"
  echo ""
  echo "Description:"
  echo "  Scans all fleet-* Docker containers (skipping fleet-gateway)."
  echo "  For each container:"
  echo ""
  echo "  - If PROJECT_NAME env is ABSENT: the container predates composite naming."
  echo "    Prints its name, image, and status, then prompts 'Stop & remove? [y/N]'."
  echo "    On 'y': stops and removes the container. On anything else: skips."
  echo ""
  echo "  - If PROJECT_NAME env is PRESENT but the container name does not match"
  echo "    'fleet-<PROJECT_NAME>-<FEATURE_NAME>': prints a warning with the expected"
  echo "    vs actual name. No action is taken — rename manually if needed."
  echo ""
  echo "  No inference and no auto-rename are performed."
  echo ""
  echo "Flags:"
  echo -e "  ${BLUE}-h, --help${RESET}   Show this help"
  echo ""
  echo "Examples:"
  echo "  fleet migrate-names          # interactive scan and cleanup"
  echo ""
  exit "${exit_code}"
}

# ─── Argument parsing ────────────────────────────────────────────────────────
for arg in "$@"; do
  case "${arg}" in
    -h|--help) _migrate_names_help 0 ;;
    *)
      error "fleet migrate-names: unknown argument '${arg}'\nRun 'fleet migrate-names --help' for usage."
      ;;
  esac
done

# ─── Require Docker ──────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  error "docker not found on PATH — fleet migrate-names requires Docker"
fi

# ─── List fleet-* containers (skip fleet-gateway) ───────────────────────────
mapfile -t CONTAINERS < <(
  docker ps -a --format '{{.Names}}' 2>/dev/null \
    | grep -E '^fleet-' \
    | grep -v '^fleet-gateway$' \
    || true
)

if [ "${#CONTAINERS[@]}" -eq 0 ]; then
  info "No fleet-* containers found (other than fleet-gateway)."
  exit 0
fi

echo ""
info "Scanning ${#CONTAINERS[@]} fleet-* container(s) for pre-migration bare names..."
echo ""

FOUND_LEGACY=0
FOUND_MISMATCH=0

for cname in "${CONTAINERS[@]}"; do
  # Inspect: read status and all env vars
  inspect_json=$(docker inspect --format '{{json .}}' "${cname}" 2>/dev/null) || {
    warn "Could not inspect '${cname}' — skipping"
    continue
  }

  container_status=$(printf '%s' "${inspect_json}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['State']['Status'])" 2>/dev/null || echo "unknown")
  container_image=$(printf '%s' "${inspect_json}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Config']['Image'])" 2>/dev/null || echo "unknown")

  # Extract env vars into a dict
  env_vars=$(printf '%s' "${inspect_json}" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
env_list = d.get('Config', {}).get('Env') or []
env = {}
for e in env_list:
    if '=' in e:
        k, v = e.split('=', 1)
        env[k] = v
print(json.dumps(env))
" 2>/dev/null || echo "{}")

  project_name=$(printf '%s' "${env_vars}" \
    | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('PROJECT_NAME',''))" 2>/dev/null || echo "")
  feature_name=$(printf '%s' "${env_vars}" \
    | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('FEATURE_NAME',''))" 2>/dev/null || echo "")

  if [ -z "${project_name}" ]; then
    # ── Pre-migration container: PROJECT_NAME absent ──────────────────────
    FOUND_LEGACY=$(( FOUND_LEGACY + 1 ))
    echo -e "  ${YELLOW}[legacy]${RESET} ${cname}"
    echo -e "    Image:  ${container_image}"
    echo -e "    Status: ${container_status}"
    echo ""

    read -r -p "    Stop & remove '${cname}'? [y/N]: " answer </dev/tty || answer="n"
    echo ""

    case "${answer}" in
      y|Y)
        if [ "${container_status}" = "running" ]; then
          info "Stopping ${cname}..."
          docker stop "${cname}" >/dev/null
        fi
        info "Removing ${cname}..."
        docker rm "${cname}" >/dev/null
        info "Removed ${cname}."
        ;;
      *)
        info "Skipped ${cname}."
        ;;
    esac
  else
    # ── Container has PROJECT_NAME — check naming convention ─────────────
    if [ -n "${feature_name}" ]; then
      expected_name="fleet-${project_name}-${feature_name}"
      if [ "${cname}" != "${expected_name}" ]; then
        FOUND_MISMATCH=$(( FOUND_MISMATCH + 1 ))
        echo -e "  ${YELLOW}[name-mismatch]${RESET} ${cname}"
        echo -e "    Expected: ${expected_name}"
        echo -e "    Actual:   ${cname}"
        warn "No auto-rename performed — rename manually if needed."
        echo ""
      fi
    fi
  fi
done

if [ "${FOUND_LEGACY}" -eq 0 ] && [ "${FOUND_MISMATCH}" -eq 0 ]; then
  info "All fleet-* containers use composite naming. Nothing to migrate."
fi
