#!/usr/bin/env bats
# Tests for fleet init's railpack plan generation for Vite subprojects.
# These tests verify behaviour through the public interface (running cmd-init.sh)
# with all Docker/external commands stubbed.

WORKTREE_ROOT="$(cd "$(dirname "${BATS_TEST_FILENAME}")/../.." && pwd)"
SCRIPT_PATH="${WORKTREE_ROOT}/cli/cmd-init.sh"

setup() {
  PROJ_DIR="$(mktemp -d)"
  STUB_BIN="$(mktemp -d)"
  mkdir -p "${PROJ_DIR}/.fleet"

  # Docker stub: accepts every fleet init operation and succeeds.
  # gateway health check via curl returns 0, so the docker gateway section is
  # entirely skipped; docker is only called for buildx + image builds.
  cat > "${STUB_BIN}/docker" <<'STUB'
#!/bin/bash
case "${1:-}" in
  buildx)  exit 0 ;;
  build)   exit 0 ;;
  network) exit 0 ;;
  inspect) exit 1 ;;  # container doesn't exist; guarded call, not fatal
  run|rm)  exit 0 ;;
esac
exit 0
STUB
  chmod +x "${STUB_BIN}/docker"

  # curl stub: pretends the gateway is already healthy so fleet skips the
  # whole docker gateway build/run block.
  printf '#!/bin/bash\nexit 0\n' > "${STUB_BIN}/curl"
  chmod +x "${STUB_BIN}/curl"

  # Default railpack stub: emits a minimal valid JSON plan on `plan`, and a
  # parseable version string on `--version`.
  cat > "${STUB_BIN}/railpack" <<'STUB'
#!/bin/bash
case "${1:-}" in
  --version) echo "railpack 0.1.0" ;;
  plan)      echo '{"schema":1}' ;;
esac
STUB
  chmod +x "${STUB_BIN}/railpack"
}

teardown() {
  rm -rf "${PROJ_DIR}" "${STUB_BIN}"
}

# ── Helpers ───────────────────────────────────────────────────────────────────

_write_vite_toml() {
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
}

_write_spring_toml() {
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
name  = "backend"
dir   = "backend"
stack = "spring"
port  = 8081
build = "mvn package -DskipTests -q"
run   = "java -jar /home/developer/backend.jar"
TOML
}

# ── Tests ─────────────────────────────────────────────────────────────────────

@test "fleet init writes .fleet/<sub>/railpack-plan.json for a vite subproject" {
  _write_vite_toml
  mkdir -p "${PROJ_DIR}/frontend"
  touch "${PROJ_DIR}/frontend/vite.config.js" "${PROJ_DIR}/frontend/package.json"

  run env PATH="${STUB_BIN}:${PATH}" bash -c "cd '${PROJ_DIR}' && bash '${SCRIPT_PATH}' 2>&1"

  [ "$status" -eq 0 ]
  [ -f "${PROJ_DIR}/.fleet/frontend/railpack-plan.json" ]
}

@test "fleet init does not write railpack-plan.json for a spring subproject" {
  _write_spring_toml
  mkdir -p "${PROJ_DIR}/backend"
  printf '<project/>\n' > "${PROJ_DIR}/backend/pom.xml"

  run env PATH="${STUB_BIN}:${PATH}" bash -c "cd '${PROJ_DIR}' && bash '${SCRIPT_PATH}' 2>&1"

  [ "$status" -eq 0 ]
  plan_count=$(find "${PROJ_DIR}/.fleet" -name 'railpack-plan.json' | wc -l | tr -d ' ')
  [ "$plan_count" -eq 0 ]
}

@test "fleet init --override overwrites rather than appends railpack-plan.json" {
  _write_vite_toml
  mkdir -p "${PROJ_DIR}/frontend"
  touch "${PROJ_DIR}/frontend/vite.config.js" "${PROJ_DIR}/frontend/package.json"

  # First run — plan contains run-1 marker
  cat > "${STUB_BIN}/railpack" <<'STUB'
#!/bin/bash
case "${1:-}" in
  --version) echo "railpack 0.1.0" ;;
  plan)      echo '{"run":1}' ;;
esac
STUB
  chmod +x "${STUB_BIN}/railpack"
  run env PATH="${STUB_BIN}:${PATH}" bash -c "cd '${PROJ_DIR}' && bash '${SCRIPT_PATH}' 2>&1"
  [ "$status" -eq 0 ]

  # Second run with --override — plan should contain run-2 marker only
  cat > "${STUB_BIN}/railpack" <<'STUB'
#!/bin/bash
case "${1:-}" in
  --version) echo "railpack 0.1.0" ;;
  plan)      echo '{"run":2}' ;;
esac
STUB
  chmod +x "${STUB_BIN}/railpack"
  run env PATH="${STUB_BIN}:${PATH}" bash -c "cd '${PROJ_DIR}' && bash '${SCRIPT_PATH}' --override 2>&1"
  [ "$status" -eq 0 ]

  plan_file="${PROJ_DIR}/.fleet/frontend/railpack-plan.json"
  [ -f "$plan_file" ]

  plan_content=$(cat "$plan_file")
  # Must contain the second run's content
  [[ "$plan_content" == *'"run":2'* ]]
  # Must NOT contain the first run's content (overwrite, not append)
  [[ "$plan_content" != *'"run":1'* ]]
}

@test "fleet init aborts with non-zero exit and error message when railpack helper fails" {
  _write_vite_toml
  mkdir -p "${PROJ_DIR}/frontend"
  touch "${PROJ_DIR}/frontend/vite.config.js" "${PROJ_DIR}/frontend/package.json"

  # Stub railpack to fail on 'plan' so railpack_emit_plan's error handler fires
  cat > "${STUB_BIN}/railpack" <<'STUB'
#!/bin/bash
case "${1:-}" in
  --version) echo "railpack 0.1.0" ;;
  plan)
    echo "railpack: analysis failed" >&2
    exit 1
    ;;
esac
STUB
  chmod +x "${STUB_BIN}/railpack"

  run env PATH="${STUB_BIN}:${PATH}" bash -c "cd '${PROJ_DIR}' && bash '${SCRIPT_PATH}' 2>&1"

  [ "$status" -ne 0 ]
  [[ "$output" =~ "railpack" ]]
}
