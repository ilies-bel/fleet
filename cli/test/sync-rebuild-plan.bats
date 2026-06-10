#!/usr/bin/env bats
# Integration-style tests for cmd-sync.sh plan-aware dispatch.
#
# Verifies that:
#   • When a railpack plan exists, cmd-sync.sh runs RUN_CMD via docker exec
#     (no gateway API call).
#   • When no plan exists, the gateway API is called (fragment behaviour
#     unchanged — no docker exec).
#   • A failed docker exec leaves the container running (no docker kill).
#
# All Docker and curl calls are stubbed; observable behaviour is asserted
# through exit codes, stub log files, and any files the stubs write.

WORKTREE_ROOT="$(cd "$(dirname "${BATS_TEST_FILENAME}")/../.." && pwd)"
CMD_SYNC="${WORKTREE_ROOT}/cli/cmd-sync.sh"

# ── Helpers ───────────────────────────────────────────────────────────────────

_write_fleet_toml() {
  mkdir -p "${PROJ_DIR}/.fleet"
  cat > "${PROJ_DIR}/.fleet/fleet.toml" <<TOML
[project]
name = "testproj"
root = "."
path = ".worktrees/{name}"

[ports]
proxy = 3000
admin = 4000
db    = 5432
TOML
}

_write_vite_plan() {
  mkdir -p "${PROJ_DIR}/.fleet/frontend"
  echo '{"schema":1}' > "${PROJ_DIR}/.fleet/frontend/railpack-plan.json"
  printf 'RUN_CMD=%q\n' "npm run build" > "${PROJ_DIR}/.fleet/frontend/run.env"
}

# ── Setup / Teardown ──────────────────────────────────────────────────────────

setup() {
  PROJ_DIR="$(mktemp -d)"
  STUB_BIN="$(mktemp -d)"
  DOCKER_LOG="${PROJ_DIR}/docker.log"
  CURL_LOG="${PROJ_DIR}/curl.log"
  BUNDLE_DIR="$(mktemp -d)"

  _write_fleet_toml

  # Default docker stub: records every invocation; exec succeeds and writes a
  # bundle marker so the "new bundle is served" assertion has something to check.
  cat > "${STUB_BIN}/docker" <<STUB
#!/bin/bash
echo "\$@" >> "${DOCKER_LOG}"
if [[ "\${1:-}" == "exec" ]]; then
  echo "built" > "${BUNDLE_DIR}/bundle.js"
fi
exit 0
STUB
  chmod +x "${STUB_BIN}/docker"

  # curl stub: records invocations and emits minimal JSON for python3 -m json.tool
  cat > "${STUB_BIN}/curl" <<STUB
#!/bin/bash
echo "\$@" >> "${CURL_LOG}"
echo '{"status":"ok"}'
exit 0
STUB
  chmod +x "${STUB_BIN}/curl"

  # python3 stub: pass stdin through (json.tool no-op)
  cat > "${STUB_BIN}/python3" <<'STUB'
#!/bin/bash
cat
exit 0
STUB
  chmod +x "${STUB_BIN}/python3"

  # railpack stub: needed for fleet_preflight's `command -v railpack` check
  cat > "${STUB_BIN}/railpack" <<'STUB'
#!/bin/bash
exit 0
STUB
  chmod +x "${STUB_BIN}/railpack"
}

teardown() {
  rm -rf "${PROJ_DIR}" "${STUB_BIN}" "${BUNDLE_DIR}"
}

# ── Plan-present branch ───────────────────────────────────────────────────────

@test "cmd-sync: plan present → docker exec is called with RUN_CMD" {
  _write_vite_plan

  run env \
    FLEET_GATEWAY="http://localhost:9999" \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${CMD_SYNC}' my-feature"

  [ "$status" -eq 0 ]
  # docker exec must have been called
  grep -q "^exec " "${DOCKER_LOG}"
  # RUN_CMD (npm run build) must appear in the exec invocation
  grep -q "npm run build" "${DOCKER_LOG}"
}

@test "cmd-sync: plan present → new bundle is produced after exec (integration path)" {
  # Simulates: edit source → run cmd-sync.sh → bundle rebuilt inside container.
  # The docker exec stub writes bundle.js to BUNDLE_DIR to model the rebuild.
  _write_vite_plan

  run env \
    FLEET_GATEWAY="http://localhost:9999" \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${CMD_SYNC}' my-feature"

  [ "$status" -eq 0 ]
  [ -f "${BUNDLE_DIR}/bundle.js" ]
}

@test "cmd-sync: plan present → gateway curl is NOT called" {
  _write_vite_plan

  run env \
    FLEET_GATEWAY="http://localhost:9999" \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${CMD_SYNC}' my-feature"

  [ "$status" -eq 0 ]
  # curl log must be empty — plan branch bypasses the gateway API
  [ ! -s "${CURL_LOG}" ]
}

# ── Fragment-based branch (behaviour unchanged) ───────────────────────────────

@test "cmd-sync: plan absent → gateway curl is called with sync URL" {
  # No plan file — pure fragment-based project

  run env \
    FLEET_GATEWAY="http://localhost:9999" \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${CMD_SYNC}' my-feature"

  [ "$status" -eq 0 ]
  grep -q "testproj-my-feature/sync" "${CURL_LOG}"
}

@test "cmd-sync: plan absent → docker exec is NOT called" {
  # No plan file

  run env \
    FLEET_GATEWAY="http://localhost:9999" \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${CMD_SYNC}' my-feature"

  [ "$status" -eq 0 ]
  # exec must not have been invoked
  ! grep -q "^exec " "${DOCKER_LOG}"
}

@test "cmd-sync: plan absent with --rebuild → gateway rebuild URL is called" {
  # Fragment-based project: --rebuild must still route to the rebuild API

  run env \
    FLEET_GATEWAY="http://localhost:9999" \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${CMD_SYNC}' my-feature --rebuild"

  [ "$status" -eq 0 ]
  grep -q "testproj-my-feature/rebuild" "${CURL_LOG}"
}

# ── Failed rebuild guard ──────────────────────────────────────────────────────

@test "cmd-sync: docker exec failure → script exits 0 and container is NOT killed" {
  _write_vite_plan

  # Override docker stub: exec fails; any kill call would be recorded
  cat > "${STUB_BIN}/docker" <<STUB
#!/bin/bash
echo "\$@" >> "${DOCKER_LOG}"
if [[ "\${1:-}" == "exec" ]]; then
  exit 1
fi
exit 0
STUB
  chmod +x "${STUB_BIN}/docker"

  run env \
    FLEET_GATEWAY="http://localhost:9999" \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${CMD_SYNC}' my-feature"

  # Script must not propagate the exec failure
  [ "$status" -eq 0 ]
  # docker kill must NOT have been invoked
  ! grep -q "^kill " "${DOCKER_LOG}"
}

# ── Plan-present with --rebuild ───────────────────────────────────────────────
# These tests verify that fleet sync --rebuild respects the plan-based path:
# rather than exec-ing into the running container, it rebuilds the Docker image
# and recreates the container from the new image.

@test "cmd-sync: plan present with --rebuild → docker buildx build is called, NOT docker exec" {
  _write_vite_plan

  run env \
    FLEET_GATEWAY="http://localhost:9999" \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${CMD_SYNC}' my-feature --rebuild"

  [ "$status" -eq 0 ]
  # Image rebuild must have been triggered via buildx
  grep -q "buildx build" "${DOCKER_LOG}"
  # docker exec must NOT have been called — rebuild replaces in-container run
  ! grep -q "^exec " "${DOCKER_LOG}"
}

@test "cmd-sync: plan present with --rebuild → container recreated via compose up --force-recreate" {
  _write_vite_plan

  run env \
    FLEET_GATEWAY="http://localhost:9999" \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${CMD_SYNC}' my-feature --rebuild"

  [ "$status" -eq 0 ]
  # Container must be recreated (not just restarted) so the new image is picked up
  grep -q "force-recreate" "${DOCKER_LOG}"
}

@test "cmd-sync: plan present with --rebuild → gateway curl is NOT called" {
  _write_vite_plan

  run env \
    FLEET_GATEWAY="http://localhost:9999" \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd '${PROJ_DIR}' && bash '${CMD_SYNC}' my-feature --rebuild"

  [ "$status" -eq 0 ]
  # Rebuild via plan bypasses the gateway API entirely
  [ ! -s "${CURL_LOG}" ]
}
