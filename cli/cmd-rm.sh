#!/bin/bash
set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export FLEET_ROOT

# Source shared library
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

# ─── remove_feature <name> ────────────────────────────────────────────────────
remove_feature() {
  local name="$1"
  local feature_dir="${FLEET_ROOT}/.fleet/${name}"
  local compose_file="${feature_dir}/docker-compose.yml"
  local info_toml="${feature_dir}/info.toml"

  # Read project name from info.toml to build the composite container/gateway key.
  # Falls back gracefully if info.toml is absent (e.g. partial-add cleanup).
  local project=""
  local _toml_row
  _toml_row=$(_read_info_toml "${info_toml}" 2>/dev/null) || true
  if [ -n "${_toml_row}" ]; then
    project="${_toml_row%%|*}"
  fi

  # Composite container name: fleet-<project>-<name> when project is known,
  # else legacy fleet-<name> (orphan cleanup path).
  local container_name
  if [ -n "${project}" ]; then
    container_name="fleet-${project}-${name}"
  else
    container_name="fleet-${name}"
    warn "Could not read project from info.toml — attempting legacy container name '${container_name}'"
  fi

  # Composite gateway key: <project>-<name> when project is known, else bare name.
  local gateway_key
  if [ -n "${project}" ]; then
    gateway_key="${project}-${name}"
  else
    gateway_key="${name}"
  fi

  info "Removing feature: ${name} (container: ${container_name})"

  # Deregister from gateway (best-effort)
  curl -sf -X DELETE "${GATEWAY_URL}/register-feature/${gateway_key}" >/dev/null 2>&1 \
    || warn "Could not notify gateway (is it running?)"

  # Stop the single feature container (mono-container architecture)
  docker rm -f "${container_name}" 2>/dev/null \
    || warn "Container '${container_name}' not found (already removed?)"

  # Bring down compose stack (removes any lingering compose-managed resources)
  if [ -f "${compose_file}" ]; then
    docker compose -f "${compose_file}" down -v 2>/dev/null || true
  fi

  # Remove .fleet/<name>/ directory
  rm -rf "${feature_dir}"

  info "Removed '${name}'"
}

# ─── Help ────────────────────────────────────────────────────────────────────
_rm_help() {
  local exit_code="${1:-0}"
  echo ""
  echo -e "${GREEN}fleet rm${RESET} — remove feature containers"
  echo ""
  echo "Usage: fleet rm <name>|--all|--nuke"
  echo ""
  echo "Arguments:"
  echo -e "  ${BLUE}<name>${RESET}   Feature name to remove (containers + .fleet/<name>/ directory)"
  echo ""
  echo "Flags:"
  echo -e "  ${BLUE}--all${RESET}    Remove all features; keep gateway and network running"
  echo -e "  ${BLUE}--nuke${RESET}   Remove everything: all features, gateway, network, and base images"
  echo ""
  echo "Examples:"
  echo "  fleet rm my-feature"
  echo "  fleet rm --all"
  echo "  fleet rm --nuke"
  echo ""
  exit "${exit_code}"
}

# ─── Main ────────────────────────────────────────────────────────────────────
MODE="${1:-}"

if [ "${MODE}" = "--help" ] || [ "${MODE}" = "-h" ]; then
  _rm_help 0
fi

if [ -z "$MODE" ]; then
  _rm_help 1
fi

case "$MODE" in
  --all)
    info "Removing all feature containers..."
    shopt -s nullglob
    for info_toml in "${FLEET_ROOT}/.fleet/"*/info.toml; do
      local_name=$(basename "$(dirname "${info_toml}")")
      remove_feature "${local_name}"
    done
    shopt -u nullglob
    info "All features removed. Gateway still running."
    ;;

  --nuke)
    info "Nuking everything..."

    shopt -s nullglob
    for info_toml in "${FLEET_ROOT}/.fleet/"*/info.toml; do
      local_name=$(basename "$(dirname "${info_toml}")")
      remove_feature "${local_name}" 2>/dev/null || true
    done
    shopt -u nullglob

    docker rm -f fleet-gateway 2>/dev/null && info "Gateway removed" \
      || warn "Gateway not found"
    docker rmi fleet-gateway 2>/dev/null || true

    # Remove the unified fleet-feature-base image
    docker rmi fleet-feature-base 2>/dev/null \
      && info "Image 'fleet-feature-base' removed" \
      || warn "Image 'fleet-feature-base' not found or in use"

    docker network rm fleet-net 2>/dev/null && info "Network 'fleet-net' removed" \
      || warn "Network not found"

    info "Nuke complete."
    ;;

  *)
    NAME="$MODE"
    validate_feature_name "${NAME}"
    INFO_TOML="${FLEET_ROOT}/.fleet/${NAME}/info.toml"

    # Without info.toml we cannot know the composite container name, so we can
    # only check for the info.toml itself. If it is missing, the feature was
    # never fully added (or was already removed).
    if [ ! -f "${INFO_TOML}" ]; then
      error "Feature '${NAME}' not found (.fleet/${NAME}/info.toml missing). Run: fleet ls"
    fi

    remove_feature "${NAME}"
    ;;
esac
