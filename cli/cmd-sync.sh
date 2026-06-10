#!/bin/bash
set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export FLEET_ROOT

# Source shared library
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

name="${1:-}"
if [ "${name}" = "--help" ] || [ "${name}" = "-h" ]; then
  echo ""
  echo -e "${GREEN}fleet sync${RESET} — pull latest code and rebuild a feature container"
  echo ""
  echo "Usage: fleet sync <name> [--regenerate-sources] [--rebuild]"
  echo ""
  echo "Arguments:"
  echo -e "  ${BLUE}<name>${RESET}                   Feature name (as shown in dashboard)"
  echo ""
  echo "Flags:"
  echo -e "  ${BLUE}--regenerate-sources${RESET}     Also regenerate jOOQ DSL (needed after Liquibase migrations)"
  echo -e "  ${BLUE}--rebuild${RESET}                Rebuild the Docker base image and recreate the container"
  echo ""
  echo "Examples:"
  echo "  fleet sync my-feature"
  echo "  fleet sync my-feature --regenerate-sources"
  echo "  fleet sync my-feature --rebuild"
  echo ""
  exit 0
fi
if [ -z "$name" ]; then
  echo "Usage: fleet sync <name> [--regenerate-sources] [--rebuild]"
  echo "  name                 Feature name (as shown in dashboard)"
  echo "  --regenerate-sources Also regenerate jOOQ DSL (needed after Liquibase migrations)"
  echo "  --rebuild            Rebuild the Docker base image and recreate the container"
  exit 1
fi

load_fleet_toml

# Composite key used for gateway API calls: <project>-<feature>
feature_key="${FLEET_PROJECT_NAME}-${name}"
container="fleet-${FLEET_PROJECT_NAME}-${name}"

regen=false
rebuild=false
for arg in "${@:2}"; do
  [ "$arg" = "--regenerate-sources" ] && regen=true
  [ "$arg" = "--rebuild" ] && rebuild=true
done

# ─── Plan-aware in-container rebuild ─────────────────────────────────────────
# For each subproject initialised with a railpack plan:
#   • Normal sync (default): rebuild the artifact in-container, then restart the
#     server.
#       1. Run BUILD_CMD (e.g. "npm run build") to regenerate the build artifact
#          from the bind-mounted source files inside the running container.
#       2. If a RUN_CMD (e.g. "caddy run …") is also present, restart the server:
#          send SIGTERM to the existing process and launch a fresh copy in the
#          background (nohup + &) so docker exec returns without a port conflict.
#          Server restart is skipped when the build step fails.
#   • --rebuild: build a fresh Docker image from current sources and recreate the
#     container from it.  This is a full image rebuild via buildx, not just an
#     in-container re-run.
# A non-zero exit from docker exec is logged as a warning; the container is
# kept running regardless (no docker kill).  When at least one plan branch ran,
# skip the fragment-based gateway path.
_plan_sync_done=false
_plan_rebuild_needed=false
shopt -s nullglob
for _plan in "${FLEET_CONFIG_ROOT}/.fleet/"*/railpack-plan.json; do
  sub="$(basename "$(dirname "${_plan}")")"

  if [[ "${rebuild}" = true ]]; then
    # --rebuild path: build a fresh image; container is recreated after the loop.
    info "Rebuilding image for '${name}' (${sub})..."
    fleet_preflight
    _image_tag="fleet-feature-base-${FLEET_PROJECT_NAME}-${sub}"
    # Determine the service source directory from fleet.toml services JSON.
    # Falls back to the subproject name when no matching service entry is found.
    _ctx_dir=$(python3 -c "
import sys, json
try:
    svcs = json.loads(sys.argv[1])
    sub  = sys.argv[2]
    for s in svcs:
        if s.get('name') == sub:
            print(s.get('dir', sub))
            sys.exit(0)
except Exception:
    pass
print(sys.argv[2])
" "${FLEET_SERVICES_JSON:-[]}" "${sub}" 2>/dev/null || echo "${sub}")
    _ctx_dir="${_ctx_dir:-${sub}}"
    build_feature_image "${sub}" "${_image_tag}" "${FLEET_PROJECT_ROOT}/${_ctx_dir}"
    _plan_rebuild_needed=true
    _plan_sync_done=true
  else
    renv="${FLEET_CONFIG_ROOT}/.fleet/${sub}/run.env"
    if [[ -f "${renv}" ]]; then
      # shellcheck source=/dev/null
      source "${renv}"
      _build_cmd="${BUILD_CMD:-}"
      _run_cmd="${RUN_CMD:-}"
      unset BUILD_CMD RUN_CMD  # reset for the next iteration

      if [[ -z "${_build_cmd}" && -z "${_run_cmd}" ]]; then
        warn "run.env for '${sub}' has no BUILD_CMD or RUN_CMD — skipping in-container sync"
        continue
      fi

      info "Syncing '${name}' (${sub}) in container '${container}'..."

      # Step 1: Rebuild the artifact from bind-mounted source files.
      _build_ok=true
      if [[ -n "${_build_cmd}" ]]; then
        if ! docker exec "${container}" bash -c "${_build_cmd}"; then
          warn "Build for '${sub}' failed — container '${container}' kept running"
          _build_ok=false
        else
          info "Build for '${sub}' complete"
        fi
      fi

      # Step 2: Restart the server (only when build succeeded, or there was no
      # build step).  Send SIGTERM to the existing server process and start a
      # new one in the background to avoid the "port already in use" conflict
      # that arises when docker exec spawns a duplicate server process.
      if [[ "${_build_ok}" = true && -n "${_run_cmd}" ]]; then
        _proc="${_run_cmd%% *}"  # first word = process binary name (e.g. "caddy")
        if ! docker exec "${container}" bash -c \
          "pkill -TERM '${_proc}' 2>/dev/null || true; sleep 0.3; nohup ${_run_cmd} >/dev/null 2>&1 &"; then
          warn "Server restart for '${sub}' failed — container '${container}' kept running"
        else
          info "Server restarted for '${sub}'"
        fi
      fi

      _plan_sync_done=true
    fi
  fi
done
shopt -u nullglob

# After all images are rebuilt, recreate the container once so the new image
# is picked up without disrupting other running features.
if [[ "${_plan_rebuild_needed}" = true ]]; then
  _compose_file="${FLEET_CONFIG_ROOT}/.fleet/${name}/docker-compose.yml"
  info "Recreating container '${container}' from rebuilt image..."
  docker compose -f "${_compose_file}" up -d --force-recreate
  info "Rebuild and container recreate complete for '${name}'"
fi

if [[ "${_plan_sync_done}" = true ]]; then
  exit 0
fi

# ─── Fragment-based path (gateway API — unchanged) ────────────────────────────
if [ "$rebuild" = true ]; then
  url="${GATEWAY_URL}/_fleet/api/features/${feature_key}/rebuild"
  info "Rebuilding image for '${name}'..."
  curl -sf -X POST "$url" | python3 -m json.tool
  info "Rebuild started — open logs in dashboard to follow progress"
else
  url="${GATEWAY_URL}/_fleet/api/features/${feature_key}/sync"
  [ "$regen" = true ] && url="${url}?regenerateSources=true"
  info "Syncing '${name}'$([ "$regen" = true ] && echo ' (with source regen)' || true)..."
  curl -sf -X POST "$url" | python3 -m json.tool
  info "Sync started — open logs in dashboard to follow progress"
fi
