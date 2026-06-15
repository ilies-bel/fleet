#!/usr/bin/env bats
# Tests for cli/cmd-logs.sh — fleet logs command.
#
# Verifies:
#   - --help prints usage and exits 0
#   - --trace without a name exits non-zero with a clear error
#   - -f/--follow without --trace exits non-zero
#   - unknown flags exit non-zero
#   - all-scan with no features prints informational message
#   - all-scan with healthy containers prints "no unhealthy instances"
#   - all-scan with a crash-looping container surfaces the crash-loop line
#   - single-view healthy container prints "no errors detected" + trace hint
#   - single-view with a historical-only restart surfaces "recovered" in output
#   - single-view crash-looping container prints crash-loop line + trace hint
#   - single-view non-existent container prints "(not created)"
#   - single-view container exited unexpectedly prints "exited unexpectedly"

WORKTREE_ROOT="$(cd "$(dirname "${BATS_TEST_FILENAME}")/../.." && pwd)"
LOGS_SCRIPT="${WORKTREE_ROOT}/cli/cmd-logs.sh"

# ─── Setup / teardown ────────────────────────────────────────────────────────

setup() {
  PROJ_DIR="$(mktemp -d)"
  STUB_BIN="$(mktemp -d)"
  mkdir -p "${PROJ_DIR}/.fleet"
}

teardown() {
  rm -rf "${PROJ_DIR}" "${STUB_BIN}"
}

# ─── Helpers ─────────────────────────────────────────────────────────────────

_make_fleet_toml() {
  local proj_name="${1:-test-project}"
  cat > "${PROJ_DIR}/.fleet/fleet.toml" <<TOML
[project]
name = "${proj_name}"
root = "${PROJ_DIR}"
path = ".worktrees/{name}"

[ports]
proxy = 3000
admin = 4000
db    = 5432
TOML
}

_make_info_toml() {
  local project="${1}"
  local feature="${2}"
  mkdir -p "${PROJ_DIR}/.fleet/${feature}"
  cat > "${PROJ_DIR}/.fleet/${feature}/info.toml" <<TOML
[feature]
project  = "${project}"
name     = "${feature}"
branch   = "feature/${feature}"
title    = "Test Feature ${feature}"
added_at = "2026-06-15T00:00:00Z"
TOML
}

# Docker stub — behaviour driven by exported FAKE_* env vars:
#   FAKE_INSPECT_MISSING=1  → inspect exits 1 (container not found)
#   FAKE_INSPECT            → inspect --format output  (default: "0|running|none|0")
#   FAKE_LOGS               → docker logs output       (default: "")
_make_docker_stub() {
  cat > "${STUB_BIN}/docker" <<'STUB'
#!/bin/bash
cmd="${1:-}"
shift || true
case "${cmd}" in
  inspect)
    if [ "${FAKE_INSPECT_MISSING:-0}" = "1" ]; then
      echo "Error: No such container" >&2
      exit 1
    fi
    case "$*" in
      *--format*)
        echo "${FAKE_INSPECT:-0|running|none|0}"
        ;;
    esac
    exit 0
    ;;
  logs)
    printf '%s\n' "${FAKE_LOGS:-}"
    ;;
  *)
    exit 0
    ;;
esac
STUB
  chmod +x "${STUB_BIN}/docker"
}

# Supervisord log lines with a timestamp within the last 10 minutes (uses now)
_recent_ts() {
  date "+%Y-%m-%d %H:%M:%S"
}

# Supervisord log lines with an old timestamp (clearly outside 10m window)
_stale_ts() {
  echo "2024-01-01 00:00:00"
}

# Produce FAKE_LOGS with N recent unexpected backend exits + an app error line
_crash_loop_logs() {
  local n="${1:-2}"
  local ts
  ts=$(_recent_ts)
  local out=""
  for i in $(seq 1 "${n}"); do
    out="${out}${ts},000 INFO spawned: 'backend' with pid ${i}
${ts},000 WARN exited: backend (exit status 1; not expected)
"
  done
  out="${out}Error: Cannot connect to database at localhost:5432"
  printf '%s' "${out}"
}

# Produce FAKE_LOGS with one stale unexpected exit and current running state
_stale_exit_logs() {
  local ts
  ts=$(_stale_ts)
  printf '%s,000 WARN exited: backend (exit status 1; not expected)\n' "${ts}"
  printf '%s,000 INFO success: backend entered RUNNING state ...\n' "$(date '+%Y-%m-%d %H:%M:%S')"
}

# ─── --help ──────────────────────────────────────────────────────────────────

@test "fleet logs --help: prints usage and exits 0" {
  run bash "${LOGS_SCRIPT}" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"fleet logs"* ]]
  [[ "$output" == *"--trace"* ]]
  [[ "$output" == *"--tail"* ]]
}

@test "fleet logs -h: also shows help" {
  run bash "${LOGS_SCRIPT}" -h
  [ "$status" -eq 0 ]
  [[ "$output" == *"fleet logs"* ]]
}

# ─── Argument validation ─────────────────────────────────────────────────────

@test "fleet logs --trace without name: exits non-zero with clear error" {
  # --trace alone (no name) should error immediately, before any docker call
  _make_fleet_toml
  run bash "${LOGS_SCRIPT}" --trace
  [ "$status" -ne 0 ]
  [[ "$output" == *"--trace requires a feature"* ]]
}

@test "fleet logs -f without --trace: exits non-zero" {
  _make_fleet_toml
  run bash "${LOGS_SCRIPT}" -f
  [ "$status" -ne 0 ]
  [[ "$output" == *"--follow"* ]]
}

@test "fleet logs --follow without name: exits non-zero" {
  _make_fleet_toml
  run bash "${LOGS_SCRIPT}" --follow
  [ "$status" -ne 0 ]
  [[ "$output" == *"--follow"* ]]
}

@test "fleet logs unknown flag: exits non-zero with usage hint" {
  _make_fleet_toml
  run bash -c "cd '${PROJ_DIR}' && bash '${LOGS_SCRIPT}' --bogus-flag"
  [ "$status" -ne 0 ]
  [[ "$output" == *"unknown flag"* ]]
}

# ─── All-scan: no features ───────────────────────────────────────────────────

@test "fleet logs all-scan with no features: prints informational message" {
  _make_fleet_toml
  run bash -c "cd '${PROJ_DIR}' && bash '${LOGS_SCRIPT}'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"No features"* ]]
}

# ─── All-scan: healthy ────────────────────────────────────────────────────────

@test "fleet logs all-scan healthy container: prints 'no unhealthy instances'" {
  _make_fleet_toml "myproj"
  _make_info_toml "myproj" "qa-main"
  _make_docker_stub

  export FAKE_INSPECT="0|running|none|0"
  export FAKE_LOGS
  FAKE_LOGS="$(printf '2026-06-15 00:00:01,000 INFO success: backend entered RUNNING state ...')"

  run env \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${LOGS_SCRIPT}'"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no unhealthy instances"* ]]
}

@test "fleet logs all-scan: healthy container does NOT get an individual OK line" {
  # The spec: do NOT print a per-feature OK line for every feature in the all-scan view
  _make_fleet_toml "myproj"
  _make_info_toml "myproj" "qa-main"
  _make_docker_stub

  export FAKE_INSPECT="0|running|none|0"
  export FAKE_LOGS=""

  run env \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${LOGS_SCRIPT}'"

  [ "$status" -eq 0 ]
  # Only the summary line, no per-feature OK
  [[ "$output" != *"no errors detected"* ]]
  [[ "$output" == *"no unhealthy instances"* ]]
}

# ─── All-scan: crash-looping ─────────────────────────────────────────────────

@test "fleet logs all-scan crash-looping container: surfaces crash-loop cause line" {
  _make_fleet_toml "myproj"
  _make_info_toml "myproj" "broken-feature"
  _make_docker_stub

  export FAKE_INSPECT="0|running|none|0"
  export FAKE_LOGS
  FAKE_LOGS="$(_crash_loop_logs 3)"

  run env \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${LOGS_SCRIPT}'"

  [ "$status" -eq 0 ]
  # Must show the crash-loop line
  [[ "$output" == *"crash-looping"* ]]
  # Must NOT show "no unhealthy instances" since we have a problem
  [[ "$output" != *"no unhealthy instances"* ]]
}

@test "fleet logs all-scan crash-looping: cause line includes service name and exit count" {
  _make_fleet_toml "myproj"
  _make_info_toml "myproj" "broken-feature"
  _make_docker_stub

  export FAKE_INSPECT="0|running|none|0"
  export FAKE_LOGS
  FAKE_LOGS="$(_crash_loop_logs 4)"

  run env \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${LOGS_SCRIPT}'"

  [ "$status" -eq 0 ]
  [[ "$output" == *"backend"* ]]
  [[ "$output" == *"4"* ]]
}

# ─── All-scan: stale/historical exits do NOT trigger crash-looping ────────────

@test "fleet logs all-scan: single stale unexpected exit on running container is healthy" {
  # Verifies the time-bounding rule: fleet-gustave-qa-main scenario — 1 historical
  # backend exit from hours ago, container currently running → classified as healthy.
  _make_fleet_toml "myproj"
  _make_info_toml "myproj" "qa-main"
  _make_docker_stub

  export FAKE_INSPECT="0|running|none|0"
  export FAKE_LOGS
  FAKE_LOGS="$(_stale_exit_logs)"

  run env \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${LOGS_SCRIPT}'"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no unhealthy instances"* ]]
  [[ "$output" != *"crash-looping"* ]]
}

# ─── All-scan: non-existent container ────────────────────────────────────────

@test "fleet logs all-scan: non-existent container prints dim note, does not abort" {
  _make_fleet_toml "myproj"
  _make_info_toml "myproj" "missing-feature"
  _make_docker_stub

  export FAKE_INSPECT_MISSING=1

  run env \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${LOGS_SCRIPT}'"

  [ "$status" -eq 0 ]
  [[ "$output" == *"not created"* ]]
}

# ─── Single-view: healthy ────────────────────────────────────────────────────

@test "fleet logs single-view healthy: prints 'no errors detected' and trace hint" {
  _make_fleet_toml "myproj"
  _make_info_toml "myproj" "qa-main"
  _make_docker_stub

  export FAKE_INSPECT="0|running|none|0"
  export FAKE_LOGS
  FAKE_LOGS="$(printf '2026-06-15 00:00:01,000 INFO success: backend entered RUNNING state ...')"

  run env \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${LOGS_SCRIPT}' qa-main"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no errors detected"* ]]
  [[ "$output" == *"--trace"* ]]
}

# ─── Single-view: historical restart (recovered) ─────────────────────────────

@test "fleet logs single-view: historical-only restart surfaces 'recovered' hint" {
  # One stale unexpected exit + container currently running → healthy but shows
  # recovered note in single-view
  _make_fleet_toml "myproj"
  _make_info_toml "myproj" "qa-main"
  _make_docker_stub

  export FAKE_INSPECT="0|running|none|0"
  export FAKE_LOGS
  FAKE_LOGS="$(_stale_exit_logs)"

  run env \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${LOGS_SCRIPT}' qa-main"

  [ "$status" -eq 0 ]
  # Single-view healthy with historical restart shows no-errors + recovered note
  [[ "$output" == *"no errors detected"* ]]
  [[ "$output" == *"restarted"* ]] || [[ "$output" == *"now running"* ]]
}

# ─── Single-view: crash-looping ──────────────────────────────────────────────

@test "fleet logs single-view crash-looping: prints crash-loop line and trace hint" {
  _make_fleet_toml "myproj"
  _make_info_toml "myproj" "broken-feature"
  _make_docker_stub

  export FAKE_INSPECT="0|running|none|0"
  export FAKE_LOGS
  FAKE_LOGS="$(_crash_loop_logs 5)"

  run env \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${LOGS_SCRIPT}' broken-feature"

  [ "$status" -eq 0 ]
  [[ "$output" == *"crash-looping"* ]]
  [[ "$output" == *"--trace"* ]]
}

@test "fleet logs single-view crash-looping: includes extracted cause from logs" {
  _make_fleet_toml "myproj"
  _make_info_toml "myproj" "broken-feature"
  _make_docker_stub

  export FAKE_INSPECT="0|running|none|0"
  export FAKE_LOGS
  FAKE_LOGS="$(_crash_loop_logs 2)"

  run env \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${LOGS_SCRIPT}' broken-feature"

  [ "$status" -eq 0 ]
  # The crash-loop logs include "Error: Cannot connect to database" as a cause line
  [[ "$output" == *"Cannot connect to database"* ]] || [[ "$output" == *"Error"* ]]
}

# ─── Single-view: not created ────────────────────────────────────────────────

@test "fleet logs single-view: non-existent container prints '(not created)'" {
  _make_fleet_toml "myproj"
  _make_docker_stub

  export FAKE_INSPECT_MISSING=1

  run env \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${LOGS_SCRIPT}' qa-main"

  [ "$status" -eq 0 ]
  [[ "$output" == *"not created"* ]]
}

# ─── Single-view: container exited unexpectedly ───────────────────────────────

@test "fleet logs single-view: exited non-zero container shows 'exited unexpectedly'" {
  _make_fleet_toml "myproj"
  _make_info_toml "myproj" "down-feature"
  _make_docker_stub

  export FAKE_INSPECT="0|exited|none|1"
  export FAKE_LOGS
  FAKE_LOGS="$(printf 'Error: startup failed\n')"

  run env \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${LOGS_SCRIPT}' down-feature"

  [ "$status" -eq 0 ]
  [[ "$output" == *"exited unexpectedly"* ]]
}

# ─── Single-view: stopped cleanly ────────────────────────────────────────────

@test "fleet logs single-view: container exited 0 shows 'stopped (clean exit 0)'" {
  _make_fleet_toml "myproj"
  _make_info_toml "myproj" "stopped-feature"
  _make_docker_stub

  export FAKE_INSPECT="0|exited|none|0"
  export FAKE_LOGS=""

  run env \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${LOGS_SCRIPT}' stopped-feature"

  [ "$status" -eq 0 ]
  [[ "$output" == *"stopped"* ]]
  [[ "$output" == *"clean"* ]]
}
