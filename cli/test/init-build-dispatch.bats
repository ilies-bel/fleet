#!/usr/bin/env bats
# Tests that fleet init routes the warm-build step through build_feature_image:
# vite services  → docker buildx with BUILDKIT_SYNTAX
# other stacks   → plain docker build with Dockerfile.feature-base
#
# Behaviour is verified through the public interface (running cmd-init.sh) with
# all Docker/external commands stubbed.

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
  # entire gateway build/run block — docker is only called for image builds.
  printf '#!/bin/bash\nexit 0\n' > "${STUB_BIN}/curl"
  chmod +x "${STUB_BIN}/curl"

  # railpack stub: emit a minimal valid JSON plan on 'plan'; parseable version.
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

@test "fleet init against vite fixture invokes docker buildx with BUILDKIT_SYNTAX" {
  _write_vite_toml
  mkdir -p "${PROJ_DIR}/frontend"
  touch "${PROJ_DIR}/frontend/vite.config.js" "${PROJ_DIR}/frontend/package.json"

  run env PATH="${STUB_BIN}:${PATH}" bash -c "cd '${PROJ_DIR}' && bash '${SCRIPT_PATH}' 2>&1"

  [ "$status" -eq 0 ]

  # build_feature_image must have issued docker buildx
  grep -q "^buildx " "${DOCKER_LOG}"

  # The BUILDKIT_SYNTAX build-arg must reference the railpack frontend
  grep -q "BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend" "${DOCKER_LOG}"
}

@test "fleet init against spring fixture uses fragment Dockerfile, not buildx" {
  _write_spring_toml
  mkdir -p "${PROJ_DIR}/backend"
  printf '<project/>\n' > "${PROJ_DIR}/backend/pom.xml"

  run env PATH="${STUB_BIN}:${PATH}" bash -c "cd '${PROJ_DIR}' && bash '${SCRIPT_PATH}' 2>&1"

  [ "$status" -eq 0 ]

  # build_feature_image must have issued plain docker build with the fragment Dockerfile
  grep -q "Dockerfile.feature-base" "${DOCKER_LOG}"

  # Must NOT have invoked buildx with BUILDKIT_SYNTAX
  ! grep -q "BUILDKIT_SYNTAX" "${DOCKER_LOG}"
}
