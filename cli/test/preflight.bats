#!/usr/bin/env bats
# Tests for fleet_preflight and related checks.
#
# Verifies:
#   - fleet init blocks (exits non-zero) when railpack is not on PATH
#   - fleet doctor blocks when railpack is not on PATH
#   - fleet init blocks when Docker is not running
#   - fleet doctor blocks when Docker is not running
#   - build_feature_image passes --builder fleet-railpack to docker buildx

WORKTREE_ROOT="$(cd "$(dirname "${BATS_TEST_FILENAME}")/../.." && pwd)"
COMMON_SH="${WORKTREE_ROOT}/cli/common.sh"
INIT_SCRIPT="${WORKTREE_ROOT}/cli/cmd-init.sh"
DOCTOR_SCRIPT="${WORKTREE_ROOT}/cli/cmd-doctor.sh"

setup() {
  PROJ_DIR="$(mktemp -d)"
  STUB_BIN="$(mktemp -d)"
  DOCKER_LOG="$(mktemp)"
  mkdir -p "${PROJ_DIR}/.fleet"
}

teardown() {
  rm -rf "${PROJ_DIR}" "${STUB_BIN}"
  rm -f "${DOCKER_LOG}"
}

# ── Helper: working Docker stub (docker info succeeds, buildx inspect succeeds) ──

_make_docker_stub() {
  cat > "${STUB_BIN}/docker" <<STUB
#!/bin/bash
echo "\$@" >> "${DOCKER_LOG}"
exit 0
STUB
  chmod +x "${STUB_BIN}/docker"
}

# ── Helper: Docker stub where 'docker info' fails (daemon not running) ─────────

_make_docker_no_daemon_stub() {
  cat > "${STUB_BIN}/docker" <<STUB
#!/bin/bash
echo "\$@" >> "${DOCKER_LOG}"
case "\${1:-}" in
  info) exit 1 ;;
esac
exit 0
STUB
  chmod +x "${STUB_BIN}/docker"
}

# ── Helper: working railpack stub ─────────────────────────────────────────────

_make_railpack_stub() {
  cat > "${STUB_BIN}/railpack" <<'STUB'
#!/bin/bash
case "${1:-}" in
  --version) echo "railpack 0.1.0" ;;
  plan)      echo '{"schema":1}' ;;
esac
STUB
  chmod +x "${STUB_BIN}/railpack"
}

# ── fleet init blocks when railpack is not on PATH ────────────────────────────

@test "fleet init: blocks with install instruction when railpack is missing" {
  _make_docker_stub

  # Write a minimal vite fleet.toml so init can parse config (preflight fires
  # before any TOML parsing, but we need a valid project layout to reach that
  # point; a minimal toml avoids the interactive wizard).
  mkdir -p "${PROJ_DIR}/frontend"
  touch "${PROJ_DIR}/frontend/package.json"
  cat > "${PROJ_DIR}/.fleet/fleet.toml" <<TOML
[project]
name = "test-proj"
root = "${PROJ_DIR}"
path = ".worktrees/{name}"

[ports]
proxy = 3000
admin = 4000
db    = 5432

[[services]]
name  = "frontend"
dir   = "frontend"
stack = "vite"
port  = 5173
build = "npm run build"
run   = "npm run dev"
TOML

  # Use a minimal PATH that has docker (from stub) but NOT railpack.
  # /usr/bin:/bin provides bash, echo, mkdir, etc. without including
  # any user-local paths where railpack might be installed.
  run env PATH="${STUB_BIN}:/usr/bin:/bin" bash -c "cd '${PROJ_DIR}' && bash '${INIT_SCRIPT}' 2>&1"

  # Must fail
  [ "$status" -ne 0 ]

  # Must mention railpack and the install URL in the output
  [[ "$output" == *"railpack"* ]]
  [[ "$output" == *"railpack.com"* ]]

  # Must NOT mention a deep buildx / mergeop error
  [[ "$output" != *"mergeop"* ]]
}

# ── fleet init blocks when Docker is not running ──────────────────────────────

@test "fleet init: blocks with Docker-not-running message when Docker daemon is down" {
  _make_docker_no_daemon_stub
  _make_railpack_stub

  mkdir -p "${PROJ_DIR}/frontend"
  touch "${PROJ_DIR}/frontend/package.json"
  cat > "${PROJ_DIR}/.fleet/fleet.toml" <<TOML
[project]
name = "test-proj"
root = "${PROJ_DIR}"
path = ".worktrees/{name}"

[ports]
proxy = 3000
admin = 4000
db    = 5432

[[services]]
name  = "frontend"
dir   = "frontend"
stack = "vite"
port  = 5173
build = "npm run build"
run   = "npm run dev"
TOML

  run env PATH="${STUB_BIN}:${PATH}" bash -c "cd '${PROJ_DIR}' && bash '${INIT_SCRIPT}' 2>&1"

  [ "$status" -ne 0 ]

  [[ "$output" == *"Docker"* ]]
}

# ── fleet doctor blocks when railpack is not on PATH ─────────────────────────

@test "fleet doctor: reports railpack missing and exits non-zero" {
  _make_docker_stub

  # Use a minimal PATH: docker stub present but NOT railpack.
  run env PATH="${STUB_BIN}:/usr/bin:/bin" bash "${DOCTOR_SCRIPT}" 2>&1

  [ "$status" -ne 0 ]
  [[ "$output" == *"railpack"* ]]
  [[ "$output" == *"railpack.com"* ]]
}

# ── fleet doctor blocks when Docker is not running ────────────────────────────

@test "fleet doctor: reports Docker not running and exits non-zero" {
  _make_docker_no_daemon_stub
  _make_railpack_stub

  run env PATH="${STUB_BIN}:${PATH}" bash "${DOCTOR_SCRIPT}" 2>&1

  [ "$status" -ne 0 ]
  [[ "$output" == *"Docker"* ]]
}

# ── build_feature_image passes --builder fleet-railpack ───────────────────────

@test "build_feature_image: passes --builder fleet-railpack to docker buildx" {
  _make_docker_stub

  mkdir -p "${PROJ_DIR}/.fleet/frontend"
  echo '{"schema":1}' > "${PROJ_DIR}/.fleet/frontend/railpack-plan.json"

  run env \
    FLEET_CONFIG_ROOT="${PROJ_DIR}" \
    FLEET_ROOT="${WORKTREE_ROOT}" \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "source '${COMMON_SH}' && build_feature_image 'frontend' 'test-image:latest' '/ctx'"

  [ "$status" -eq 0 ]

  # Must pass --builder fleet-railpack
  grep -q "\-\-builder fleet-railpack" "${DOCKER_LOG}"
}

# ── fleet doctor passes when all prerequisites met ───────────────────────────

@test "fleet doctor: exits 0 when Docker is running and railpack is present" {
  _make_docker_stub
  _make_railpack_stub

  run env PATH="${STUB_BIN}:${PATH}" bash "${DOCTOR_SCRIPT}" 2>&1

  [ "$status" -eq 0 ]
  [[ "$output" == *"All checks passed"* ]]
}
