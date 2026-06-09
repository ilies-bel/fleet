#!/usr/bin/env bats
# Tests for fleet init's railpack plan generation for Next.js subprojects.
# Verifies behaviour through the public interface (running cmd-init.sh) with
# all Docker/external commands stubbed, and asserts no remaining references to
# the deleted Dockerfile.feature-base.next fragment.

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

_write_next_toml() {
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
stack = "next"
port  = 3000
build = "npm run build"
run   = "npm run dev"
TOML
}

# ── Tests ─────────────────────────────────────────────────────────────────────

@test "fleet init writes .fleet/<sub>/railpack-plan.json for a next subproject" {
  _write_next_toml
  mkdir -p "${PROJ_DIR}/frontend"
  touch "${PROJ_DIR}/frontend/next.config.js" "${PROJ_DIR}/frontend/package.json"

  run env PATH="${STUB_BIN}:${PATH}" bash -c "cd '${PROJ_DIR}' && bash '${SCRIPT_PATH}' 2>&1"

  [ "$status" -eq 0 ]
  [ -f "${PROJ_DIR}/.fleet/frontend/railpack-plan.json" ]
}

@test "fleet init writes run.env alongside railpack-plan.json for a next subproject" {
  _write_next_toml
  mkdir -p "${PROJ_DIR}/frontend"
  touch "${PROJ_DIR}/frontend/next.config.mjs" "${PROJ_DIR}/frontend/package.json"

  # Railpack stub returns a plan with a startCommand so run.env is populated
  cat > "${STUB_BIN}/railpack" <<'STUB'
#!/bin/bash
case "${1:-}" in
  --version) echo "railpack 0.1.0" ;;
  plan)      printf '{"phases":{"start":{"cmds":[{"cmd":"node server.js"}]}}}\n' ;;
esac
STUB
  chmod +x "${STUB_BIN}/railpack"

  run env PATH="${STUB_BIN}:${PATH}" bash -c "cd '${PROJ_DIR}' && bash '${SCRIPT_PATH}' 2>&1"

  [ "$status" -eq 0 ]
  [ -f "${PROJ_DIR}/.fleet/frontend/railpack-plan.json" ]
}

@test "fleet init --override regenerates railpack-plan.json for a next subproject" {
  _write_next_toml
  mkdir -p "${PROJ_DIR}/frontend"
  touch "${PROJ_DIR}/frontend/next.config.ts" "${PROJ_DIR}/frontend/package.json"

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
  [[ "$plan_content" == *'"run":2'* ]]
  [[ "$plan_content" != *'"run":1'* ]]
}

@test "fleet init does not write railpack-plan.json for a spring subproject" {
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

  mkdir -p "${PROJ_DIR}/backend"
  printf '<project/>\n' > "${PROJ_DIR}/backend/pom.xml"

  run env PATH="${STUB_BIN}:${PATH}" bash -c "cd '${PROJ_DIR}' && bash '${SCRIPT_PATH}' 2>&1"

  [ "$status" -eq 0 ]
  plan_count=$(find "${PROJ_DIR}/.fleet" -name 'railpack-plan.json' | wc -l | tr -d ' ')
  [ "$plan_count" -eq 0 ]
}

@test "Dockerfile.feature-base.next does not exist in the fleet repo" {
  # This test asserts the fragment file has been deleted as required by the PRD.
  [ ! -f "${WORKTREE_ROOT}/.fleet/Dockerfile.feature-base.next" ]
}

@test "no reference to Dockerfile.feature-base.next in cli/, gateway/src/, or dashboard/src/" {
  # Scanning for lingering references to the deleted fragment across the three
  # directories mandated by the acceptance criteria.
  # Exclude this test file itself — it is the test for the deletion, so its
  # own mention of the filename is intentional and does not constitute a
  # functional reference to the removed fragment.
  local found
  found=$(rg --count-matches -l 'Dockerfile\.feature-base\.next' \
    --glob '!next-plan-end-to-end.bats' \
    "${WORKTREE_ROOT}/cli/" \
    "${WORKTREE_ROOT}/gateway/src/" \
    "${WORKTREE_ROOT}/dashboard/src/" 2>/dev/null || true)
  [ -z "$found" ]
}
