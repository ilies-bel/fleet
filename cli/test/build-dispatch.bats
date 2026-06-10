#!/usr/bin/env bats
# Tests for build_feature_image dispatch logic in common.sh.
# Verifies that the function routes to docker buildx (railpack) when a plan
# file is present, and errors clearly when no plan is found — fragment
# Dockerfiles are no longer supported.

WORKTREE_ROOT="$(cd "$(dirname "${BATS_TEST_FILENAME}")/../.." && pwd)"
COMMON_SH="${WORKTREE_ROOT}/cli/common.sh"

setup() {
  PROJ_DIR="$(mktemp -d)"
  STUB_BIN="$(mktemp -d)"
  DOCKER_LOG="$(mktemp)"
  mkdir -p "${PROJ_DIR}/.fleet"

  # Docker stub: records every invocation as a single space-joined line.
  # buildx inspect returns 0 (builder already exists) so ensure_fleet_builder
  # skips creation.  All other invocations also return 0.
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

  # Must target the fleet-railpack builder
  grep -q "\-\-builder fleet-railpack" "${DOCKER_LOG}"

  # Must pass BUILDKIT_SYNTAX pointing at the railpack frontend
  grep -q "BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend" "${DOCKER_LOG}"

  # Must reference the plan file, not a Dockerfile.feature-base
  grep -q "railpack-plan.json" "${DOCKER_LOG}"
  ! grep -q "Dockerfile.feature-base" "${DOCKER_LOG}"
}

# ── Plan-absent branch ────────────────────────────────────────────────────────

@test "build_feature_image: plan absent → non-zero exit with error message naming the subproject" {
  # No plan file exists for this subproject.

  run env \
    FLEET_CONFIG_ROOT="${PROJ_DIR}" \
    FLEET_ROOT="${WORKTREE_ROOT}" \
    PATH="${STUB_BIN}:${PATH}" \
    bash -c "source '${COMMON_SH}' && build_feature_image 'backend' 'test-image:latest' '/ctx'"

  # Must fail
  [ "$status" -ne 0 ]

  # Error message must mention the subproject name
  [[ "$output" == *"backend"* ]]

  # Docker must NOT have been called at all
  [ ! -s "${DOCKER_LOG}" ]
}
