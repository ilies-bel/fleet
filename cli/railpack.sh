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

  # ── Gradle/jOOQ: skip codegen at image-build time ──────────────────────────
  # The railpack builder (ghcr.io/railwayapp/railpack-builder) runs as root
  # (uid 0).  Zonky embedded-postgres invokes initdb, which hard-refuses to
  # run as root — so the :generateJooq task always fails in the build sandbox.
  # There is no database at image-build time anyway; jOOQ codegen belongs at
  # container-start time (config/entrypoint.sh provisions a local PG and the
  # -PjooqUseLocalDb build property wires the generateJooq task to it).
  #
  # When the Gradle build file declares the nu.studer.jooq plugin or references
  # the generateJooq task, patch the "build" step command in the generated plan
  # to append -x generateJooq, preventing initdb from being invoked during the
  # root image build.
  local _jooq_build_file=""
  for _f in "${subproject_dir}/build.gradle.kts" "${subproject_dir}/build.gradle"; do
    [ -f "${_f}" ] && { _jooq_build_file="${_f}"; break; }
  done
  if [ -n "${_jooq_build_file}" ] && \
     grep -qE '(nu\.studer\.jooq|generateJooq)' "${_jooq_build_file}" 2>/dev/null; then
    info "jOOQ detected in '${_jooq_build_file}' — patching railpack plan to skip generateJooq at image-build time"
    if command -v jq >/dev/null 2>&1; then
      jq '
        (.steps[] | select(.name == "build") | .commands[] |
         select(.cmd? and (.cmd | test("gradlew")))).cmd |= . + " -x generateJooq"
      ' "${out_path}" > "${out_path}.tmp" \
        && mv "${out_path}.tmp" "${out_path}" \
        || { rm -f "${out_path}.tmp"
             warn "jOOQ railpack plan patch failed — plan left unmodified; image build may fail as root"; }
    else
      warn "jq not on PATH — cannot patch generateJooq out of railpack plan; image build will fail as root"
    fi
  fi

  info "Build plan written to '${out_path}'"
}
