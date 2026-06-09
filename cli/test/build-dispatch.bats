#!/usr/bin/env bats
# Tests for build_feature_image dispatch logic in common.sh.
# Verifies that the function routes to docker buildx (railpack) when a plan
# file is present, and to plain docker build (fragment Dockerfile) when it is
# not — using only the public function signature as the observable interface.

WORKTREE_ROOT="$(cd "$(dirname "${BATS_TEST_FILENAME}")/../.." && pwd)"
COMMON_SH="${WORKTREE_ROOT}/cli/common.sh"

setup() {
  PROJ_DIR="$(mktemp -d)"
  STUB_BIN="$(mktemp -d)"
  DOCKER_LOG="$(mktemp)"
  mkdir -p "${PROJ_DIR}/.fleet"

  # Docker stub: records every invocation as a single space-joined line.
  # DOCKER_LOG is embedded at stub-creation time (expanded in the heredoc).
  cat > "${STUB_BIN}/docker" <<STUB
#!/bin/bash
echo "\$@" >> "${DOCKER_LOG}"
exit 0
STUB
  chmod +x "${STUB_BIN}/docker"
}

teardown() {
  rm -rf "${PROJ_DIR}" "${STUB_BIN}"
  rm -f "${DOCKER_LOG}"
}

# ── Plan-present branch ───────────────────────────────────────────────────────

@test "build_feature_image: plan present → docker buildx with BUILDKIT_SYNTAX, no Dockerfile.feature-base" {
  # Create the railpack plan file the function checks for.
  mkdir -p "${PROJ_DIR}/.fleet/frontend"
  echo '{"schema":1}' > "${PROJ_DIR}/.fleet/frontend/railpack-plan.json"

  run env \
    FLEET_CONFIG_ROOT="${PROJ_DIR}" \
    FLEET_ROOT="${WORKTREE_ROOT}" \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "source '${COMMON_SH}' && build_feature_image 'frontend' 'test-image:latest' '/ctx'"

  [ "$status" -eq 0 ]

  # Must invoke docker buildx
  grep -q "^buildx " "${DOCKER_LOG}"

  # Must pass BUILDKIT_SYNTAX pointing at the railpack frontend
  grep -q "BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend" "${DOCKER_LOG}"

  # Must reference the plan file, not a Dockerfile.feature-base
  grep -q "railpack-plan.json" "${DOCKER_LOG}"
  ! grep -q "Dockerfile.feature-base" "${DOCKER_LOG}"
}

# ── Plan-absent branch ────────────────────────────────────────────────────────

@test "build_feature_image: plan absent → plain docker build with Dockerfile.feature-base" {
  # No plan file; provide the fragment Dockerfile so the fallback has a target.
  touch "${PROJ_DIR}/.fleet/Dockerfile.feature-base"

  run env \
    FLEET_CONFIG_ROOT="${PROJ_DIR}" \
    FLEET_ROOT="${WORKTREE_ROOT}" \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "source '${COMMON_SH}' && build_feature_image 'backend' 'test-image:latest' '/ctx'"

  [ "$status" -eq 0 ]

  # Must NOT invoke docker buildx
  ! grep -q "^buildx " "${DOCKER_LOG}"

  # Must reference Dockerfile.feature-base
  grep -q "Dockerfile.feature-base" "${DOCKER_LOG}"

  # Must NOT reference BUILDKIT_SYNTAX
  ! grep -q "BUILDKIT_SYNTAX" "${DOCKER_LOG}"
}
