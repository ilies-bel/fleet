#!/bin/bash
set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export FLEET_ROOT

# Source shared library (info/warn/error helpers, fleet_preflight, ensure_fleet_builder)
# shellcheck source=./common.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

# ─── Argument handling ───────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h)
      echo "Usage: fleet doctor"
      echo ""
      echo "  Check that all fleet prerequisites are met:"
      echo ""
      echo "    1. Docker daemon is running"
      echo "    2. railpack binary is on PATH"
      echo "    3. fleet-railpack buildx builder exists (auto-created if absent)"
      echo ""
      echo "  Exits 0 if all checks pass; exits 1 on the first failing check."
      echo "  The builder check is idempotent — running 'fleet doctor' may create"
      echo "  the builder as a side effect, but never removes or modifies it."
      echo ""
      exit 0
      ;;
    *)
      error "Unknown argument: $1. See: fleet doctor --help"
      ;;
  esac
done

# ─── Doctor checks ────────────────────────────────────────────────────────────

PASS="${GREEN}✓${RESET}"
FAIL="${RED}✗${RESET}"
WARN="${YELLOW}!${RESET}"

all_ok=0

echo ""
echo -e "${GREEN}fleet doctor${RESET} — prerequisite check"
echo ""

# ── 1. Docker daemon ──────────────────────────────────────────────────────────
printf "  Checking Docker daemon…  "
if docker info >/dev/null 2>&1; then
  echo -e "${PASS} Docker is running"
else
  echo -e "${FAIL} Docker is NOT running or not installed"
  echo "" >&2
  echo "  Start Docker Desktop (or your Docker daemon) and re-run fleet." >&2
  echo "" >&2
  all_ok=1
fi

# ── 2. railpack binary ────────────────────────────────────────────────────────
printf "  Checking railpack…       "
if command -v railpack >/dev/null 2>&1; then
  _railpack_ver="$(railpack --version 2>/dev/null || echo "unknown")"
  echo -e "${PASS} railpack found (${_railpack_ver})"
else
  echo -e "${FAIL} railpack is NOT installed"
  echo "" >&2
  echo "  Install it with:" >&2
  echo "    curl -sSL https://railpack.com/install.sh | sh" >&2
  echo "" >&2
  echo "  Or visit https://railpack.com for alternative install methods." >&2
  echo "" >&2
  all_ok=1
fi

# ── 3. fleet-railpack buildx builder ─────────────────────────────────────────
printf "  Checking buildx builder… "
if docker buildx inspect fleet-railpack >/dev/null 2>&1; then
  echo -e "${PASS} builder 'fleet-railpack' exists"
else
  echo -e "${WARN} builder 'fleet-railpack' not found — creating…"
  if docker buildx create --driver docker-container --name fleet-railpack >/dev/null 2>&1; then
    echo -e "        ${PASS} builder 'fleet-railpack' created"
  else
    echo -e "        ${FAIL} failed to create builder 'fleet-railpack'" >&2
    all_ok=1
  fi
fi

# ── 4. fleet-gateway container ────────────────────────────────────────────────
printf "  Checking fleet-gateway…  "
if ! docker container inspect fleet-gateway >/dev/null 2>&1; then
  echo -e "${FAIL} gateway container 'fleet-gateway' is NOT running"
  echo "" >&2
  echo "  Start it with: fleet ui start" >&2
  echo "" >&2
  all_ok=1
else
  _gw_running=$(docker container inspect -f '{{.State.Running}}' fleet-gateway 2>/dev/null || echo false)
  if [ "${_gw_running}" != "true" ]; then
    echo -e "${FAIL} gateway container 'fleet-gateway' exists but is NOT running"
    echo "" >&2
    echo "  Start it with: fleet ui start" >&2
    echo "" >&2
    all_ok=1
  else
    # Check required env vars are set inside the gateway container.
    _gw_env=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' fleet-gateway 2>/dev/null || echo "")
    _gw_project_root=$(printf '%s\n' "${_gw_env}" | grep '^FLEET_PROJECT_ROOT=' | cut -d= -f2-)
    _gw_fleet_root=$(printf '%s\n' "${_gw_env}" | grep '^FLEET_ROOT=' | cut -d= -f2-)
    _gw_ok=true
    if [ -z "${_gw_project_root}" ]; then
      echo -e "${FAIL} FLEET_PROJECT_ROOT not set in fleet-gateway container env"
      echo "" >&2
      echo "  Recreate the gateway: fleet ui restart" >&2
      echo "  (requires fleet CLI ≥2.1.1 which passes FLEET_PROJECT_ROOT at docker run)" >&2
      echo "" >&2
      all_ok=1
      _gw_ok=false
    fi
    if [ -z "${_gw_fleet_root}" ]; then
      echo -e "${FAIL} FLEET_ROOT not set in fleet-gateway container env"
      echo "" >&2
      echo "  Recreate the gateway: fleet ui restart" >&2
      echo "  (requires fleet CLI ≥2.1.1 which passes FLEET_ROOT at docker run)" >&2
      echo "" >&2
      all_ok=1
      _gw_ok=false
    fi
    if [ "${_gw_ok}" = true ]; then
      echo -e "${PASS} gateway running; FLEET_PROJECT_ROOT and FLEET_ROOT are set"
    fi
  fi
fi

echo ""

if [ "${all_ok}" -eq 0 ]; then
  echo -e "  ${PASS} All checks passed — fleet is ready."
else
  echo -e "  ${FAIL} One or more checks failed. Fix the issues above and re-run 'fleet doctor'."
fi
echo ""

exit "${all_ok}"
