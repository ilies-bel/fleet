#!/bin/bash
set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export FLEET_ROOT

# Source shared library (info/warn/error helpers)
# shellcheck source=./common.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

# ─── railpack_emit_plan ───────────────────────────────────────────────────────
# Usage: railpack_emit_plan SUBPROJECT_DIR OUT_PATH
#
# Runs `railpack plan <SUBPROJECT_DIR>` and writes the resulting JSON build-plan
# to OUT_PATH.  Fails with a clear error message if:
#   - the railpack binary is not on PATH
#   - SUBPROJECT_DIR does not exist or is not a directory
#   - railpack emits empty output
railpack_emit_plan() {
  local subproject_dir="${1:-}"
  local out_path="${2:-}"

  if [ -z "${subproject_dir}" ] || [ -z "${out_path}" ]; then
    error "railpack_emit_plan: usage: railpack_emit_plan SUBPROJECT_DIR OUT_PATH"
  fi

  if ! [ -e "${subproject_dir}" ]; then
    error "railpack_emit_plan: '${subproject_dir}' does not exist"
  fi

  if ! [ -d "${subproject_dir}" ]; then
    error "railpack_emit_plan: '${subproject_dir}' is not a directory"
  fi

  if ! command -v railpack >/dev/null 2>&1; then
    error "railpack CLI not on PATH — install from https://railpack.com"
  fi

  info "Running railpack plan on '${subproject_dir}' …"
  railpack plan "${subproject_dir}" >"${out_path}" \
    || error "railpack plan failed for '${subproject_dir}' — aborting fleet init"

  if ! [ -s "${out_path}" ]; then
    error "railpack emitted empty plan for '${subproject_dir}'"
  fi

  info "Build plan written to '${out_path}'"
}
