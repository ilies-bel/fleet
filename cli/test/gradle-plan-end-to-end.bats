#!/usr/bin/env bats
# End-to-end tests for fleet init's railpack plan generation for Gradle subprojects.
# Verifies observable behaviour: plan file created, docker buildx dispatched with
# BUILDKIT_SYNTAX, and no remaining reference to the deleted
# Dockerfile.feature-base.gradle fragment anywhere in cli/, gateway/src/, or
# dashboard/src/.

WORKTREE_ROOT="$(cd "$(dirname "${BATS_TEST_FILENAME}")/../.." && pwd)"
SCRIPT_PATH="${WORKTREE_ROOT}/cli/cmd-init.sh"

setup() {
  PROJ_DIR="$(mktemp -d)"
  STUB_BIN="$(mktemp -d)"
  DOCKER_LOG="$(mktemp)"
  mkdir -p "${PROJ_DIR}/.fleet"

  # Docker stub: logs every invocation as a space-joined line; returns 1 only
  # for container inspect (guarded, non-fatal), 0 for everything else.
  # Note: "docker network inspect" has ${1} = "network", not "inspect", so
  # the network-existence check correctly returns 0 (network already exists).
  cat > "${STUB_BIN}/docker" <<STUB
#!/bin/bash
echo "\$@" >> "${DOCKER_LOG}"
case "\${1:-}" in
  inspect) exit 1 ;;
esac
exit 0
STUB
  chmod +x "${STUB_BIN}/docker"

  # curl stub: pretends the gateway is already healthy so fleet skips the
  # entire docker gateway build/run block — docker is only called for image builds.
  printf '#!/bin/bash\nexit 0\n' > "${STUB_BIN}/curl"
  chmod +x "${STUB_BIN}/curl"

  # Default railpack stub: emits a minimal valid JSON plan on 'plan';
  # parseable version string on '--version'.
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
  rm -f "${DOCKER_LOG}"
}

# ── Helpers ───────────────────────────────────────────────────────────────────

_write_gradle_toml() {
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
stack = "gradle"
port  = 8081
build = "gradle build -x test"
run   = "java -jar /home/developer/backend.jar"
TOML
}

# ── Tests ─────────────────────────────────────────────────────────────────────

@test "fleet init writes .fleet/<sub>/railpack-plan.json for a gradle subproject" {
  _write_gradle_toml
  mkdir -p "${PROJ_DIR}/backend"
  touch "${PROJ_DIR}/backend/build.gradle"

  run env PATH="${STUB_BIN}:${PATH}" bash -c "cd '${PROJ_DIR}' && bash '${SCRIPT_PATH}' 2>&1"

  [ "$status" -eq 0 ]
  [ -f "${PROJ_DIR}/.fleet/backend/railpack-plan.json" ]
}

@test "fleet init against gradle fixture invokes docker buildx with BUILDKIT_SYNTAX" {
  _write_gradle_toml
  mkdir -p "${PROJ_DIR}/backend"
  touch "${PROJ_DIR}/backend/build.gradle"

  run env PATH="${STUB_BIN}:${PATH}" bash -c "cd '${PROJ_DIR}' && bash '${SCRIPT_PATH}' 2>&1"

  [ "$status" -eq 0 ]

  # build_feature_image must have dispatched to docker buildx (plan present)
  grep -q "^buildx " "${DOCKER_LOG}"

  # The BUILDKIT_SYNTAX build-arg must reference the railpack frontend image
  grep -q "BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend" "${DOCKER_LOG}"
}

@test "railpack plan for jOOQ gradle project adds -x generateJooq to build step command" {
  # Arrange: gradle project with nu.studer.jooq plugin declared in build file
  _write_gradle_toml
  mkdir -p "${PROJ_DIR}/backend"
  cat > "${PROJ_DIR}/backend/build.gradle.kts" <<'KTS'
plugins {
    kotlin("jvm") version "2.0.21"
    id("org.springframework.boot") version "3.5.7"
    id("nu.studer.jooq") version "9.0"
}
KTS

  # Override railpack stub to emit a realistic plan with a gradlew build step
  cat > "${STUB_BIN}/railpack" <<'STUB'
#!/bin/bash
case "${1:-}" in
  --version) echo "railpack 0.1.0" ;;
  plan) cat <<'JSON'
{
  "steps": [
    {
      "name": "build",
      "commands": [{"cmd": "./gradlew clean build -x check -x test -Pproduction"}]
    }
  ],
  "deploy": {
    "startCommand": "java $JAVA_OPTS -jar app.jar",
    "inputs": [{"step": "build", "include": ["build/libs/app.jar"]}]
  }
}
JSON
    ;;
esac
STUB
  chmod +x "${STUB_BIN}/railpack"

  # Act
  run env PATH="${STUB_BIN}:${PATH}" bash -c "cd '${PROJ_DIR}' && bash '${SCRIPT_PATH}' 2>&1"
  [ "$status" -eq 0 ]

  # Assert: build step command must include -x generateJooq
  local cmd
  cmd=$(jq -r '
    [.steps[] | select(.name == "build") | .commands[] | select(.cmd?) | .cmd][0] // ""
  ' "${PROJ_DIR}/.fleet/backend/railpack-plan.json")
  echo "build cmd: ${cmd}"
  [[ "${cmd}" == *"-x generateJooq"* ]]
}

@test "railpack plan for non-jOOQ gradle project does not add -x generateJooq" {
  # Arrange: plain gradle project, no jOOQ references
  _write_gradle_toml
  mkdir -p "${PROJ_DIR}/backend"
  cat > "${PROJ_DIR}/backend/build.gradle.kts" <<'KTS'
plugins {
    kotlin("jvm") version "2.0.21"
    id("org.springframework.boot") version "3.5.7"
}
KTS

  # Override railpack stub to emit a plan with a build step
  cat > "${STUB_BIN}/railpack" <<'STUB'
#!/bin/bash
case "${1:-}" in
  --version) echo "railpack 0.1.0" ;;
  plan) cat <<'JSON'
{
  "steps": [
    {
      "name": "build",
      "commands": [{"cmd": "./gradlew clean build -x check -x test -Pproduction"}]
    }
  ],
  "deploy": {
    "startCommand": "java $JAVA_OPTS -jar app.jar",
    "inputs": [{"step": "build", "include": ["build/libs/app.jar"]}]
  }
}
JSON
    ;;
esac
STUB
  chmod +x "${STUB_BIN}/railpack"

  # Act
  run env PATH="${STUB_BIN}:${PATH}" bash -c "cd '${PROJ_DIR}' && bash '${SCRIPT_PATH}' 2>&1"
  [ "$status" -eq 0 ]

  # Assert: build step command must NOT include -x generateJooq
  local cmd
  cmd=$(jq -r '
    [.steps[] | select(.name == "build") | .commands[] | select(.cmd?) | .cmd][0] // ""
  ' "${PROJ_DIR}/.fleet/backend/railpack-plan.json")
  echo "build cmd: ${cmd}"
  [[ "${cmd}" != *"-x generateJooq"* ]]
}

@test "Dockerfile.feature-base.gradle is not referenced in cli/, gateway/src/, or dashboard/src/" {
  local match_count
  # Exclude this test file itself (its name and test-name strings mention the
  # target filename by design); we want to catch references in production code only.
  match_count=$(grep -r --exclude='gradle-plan-end-to-end.bats' \
    'Dockerfile\.feature-base\.gradle' \
    "${WORKTREE_ROOT}/cli/" \
    "${WORKTREE_ROOT}/gateway/src/" \
    "${WORKTREE_ROOT}/dashboard/src/" 2>/dev/null | wc -l | tr -d ' ')
  [ "${match_count}" -eq 0 ]
}
