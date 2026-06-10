#!/usr/bin/env bats
# Unit tests for railpack_extract_run_meta() in cli/common.sh.
# Verifies that run command and artifact path are correctly extracted from a
# fixture railpack plan JSON without invoking Docker, fleet init, or any
# external services.

WORKTREE_ROOT="$(cd "$(dirname "${BATS_TEST_FILENAME}")/../.." && pwd)"

setup() {
  FIXTURE_DIR="$(mktemp -d)"

  # Minimal Vite railpack plan mirroring the real structure emitted by
  # `railpack plan` against a Vite subproject (verified against railpack 0.26.1).
  cat > "${FIXTURE_DIR}/railpack-plan.json" <<'JSON'
{
  "$schema": "https://schema.railpack.com",
  "deploy": {
    "startCommand": "caddy run --config /Caddyfile --adapter caddyfile 2>&1",
    "inputs": [
      { "include": ["/railpack/caddy"], "step": "packages:caddy" },
      { "include": ["/Caddyfile"], "step": "caddy" },
      { "include": ["dist"], "step": "build" }
    ]
  },
  "steps": [
    { "name": "build", "commands": [{ "cmd": "npm run build" }] }
  ]
}
JSON
}

teardown() {
  rm -rf "${FIXTURE_DIR}"
}

# ── Tests ─────────────────────────────────────────────────────────────────────

@test "railpack_extract_run_meta emits a non-empty RUN_CMD from a Vite fixture plan" {
  run bash -c "source '${WORKTREE_ROOT}/cli/common.sh' && railpack_extract_run_meta '${FIXTURE_DIR}/railpack-plan.json'"
  [ "$status" -eq 0 ]
  [[ "$output" =~ RUN_CMD=.+ ]]
}

@test "railpack_extract_run_meta emits a non-empty ARTIFACT_PATH from a Vite fixture plan" {
  run bash -c "source '${WORKTREE_ROOT}/cli/common.sh' && railpack_extract_run_meta '${FIXTURE_DIR}/railpack-plan.json'"
  [ "$status" -eq 0 ]
  [[ "$output" =~ ARTIFACT_PATH=.+ ]]
}

@test "railpack_extract_run_meta output evaluates to RUN_CMD containing the start command" {
  run bash -c "
source '${WORKTREE_ROOT}/cli/common.sh'
eval \"\$(railpack_extract_run_meta '${FIXTURE_DIR}/railpack-plan.json')\"
printf '%s' \"\$RUN_CMD\"
"
  [ "$status" -eq 0 ]
  [[ "$output" == *"caddy"* ]]
}

@test "railpack_extract_run_meta output evaluates to ARTIFACT_PATH=dist" {
  run bash -c "
source '${WORKTREE_ROOT}/cli/common.sh'
eval \"\$(railpack_extract_run_meta '${FIXTURE_DIR}/railpack-plan.json')\"
printf '%s' \"\$ARTIFACT_PATH\"
"
  [ "$status" -eq 0 ]
  [ "$output" = "dist" ]
}

@test "railpack_extract_run_meta returns non-zero for a missing plan file" {
  run bash -c "source '${WORKTREE_ROOT}/cli/common.sh' && railpack_extract_run_meta '/nonexistent/railpack-plan.json'"
  [ "$status" -ne 0 ]
}

@test "railpack_extract_run_meta succeeds with only ARTIFACT_PATH when startCommand is absent" {
  cat > "${FIXTURE_DIR}/no-cmd.json" <<'JSON'
{
  "deploy": {
    "inputs": [{ "include": ["dist"], "step": "build" }]
  }
}
JSON
  run bash -c "source '${WORKTREE_ROOT}/cli/common.sh' && railpack_extract_run_meta '${FIXTURE_DIR}/no-cmd.json'"
  [ "$status" -eq 0 ]
  [[ "$output" =~ ARTIFACT_PATH=.+ ]]
  [[ "$output" != *"RUN_CMD"* ]]
}

@test "railpack_extract_run_meta selects relative payload path over absolute dep-dir includes in multi-input build plan" {
  # Mirrors the real two-input shape emitted by railpack 0.26.1 against a Vite
  # project: first build input is the node_modules cache (absolute path), second
  # is the project tree (".").  The function must pick "." not "/app/node_modules".
  cat > "${FIXTURE_DIR}/two-build-inputs.json" <<'JSON'
{
  "deploy": {
    "inputs": [
      { "step": "build", "include": ["/app/node_modules"] },
      { "step": "build", "include": ["/root/.cache", "."], "exclude": ["node_modules", ".yarn"] }
    ]
  }
}
JSON
  run bash -c "
source '${WORKTREE_ROOT}/cli/common.sh'
eval \"\$(railpack_extract_run_meta '${FIXTURE_DIR}/two-build-inputs.json')\"
printf '%s' \"\$ARTIFACT_PATH\"
"
  [ "$status" -eq 0 ]
  [ "$output" = "." ]
}

@test "railpack_extract_run_meta emits no RUN_CMD for a multi-input Vite plan with no startCommand" {
  cat > "${FIXTURE_DIR}/two-build-inputs-no-cmd.json" <<'JSON'
{
  "deploy": {
    "inputs": [
      { "step": "build", "include": ["/app/node_modules"] },
      { "step": "build", "include": ["/root/.cache", "."], "exclude": ["node_modules", ".yarn"] }
    ]
  }
}
JSON
  run bash -c "source '${WORKTREE_ROOT}/cli/common.sh' && railpack_extract_run_meta '${FIXTURE_DIR}/two-build-inputs-no-cmd.json'"
  [ "$status" -eq 0 ]
  [[ "$output" != *"RUN_CMD"* ]]
}

@test "railpack_extract_run_meta returns non-zero for a plan without build step inputs" {
  cat > "${FIXTURE_DIR}/no-build.json" <<'JSON'
{
  "deploy": {
    "startCommand": "node server.js",
    "inputs": []
  }
}
JSON
  run bash -c "source '${WORKTREE_ROOT}/cli/common.sh' && railpack_extract_run_meta '${FIXTURE_DIR}/no-build.json'"
  [ "$status" -ne 0 ]
}

@test "railpack_extract_run_meta emits a non-empty BUILD_CMD from a Vite fixture plan" {
  run bash -c "source '${WORKTREE_ROOT}/cli/common.sh' && railpack_extract_run_meta '${FIXTURE_DIR}/railpack-plan.json'"
  [ "$status" -eq 0 ]
  [[ "$output" =~ BUILD_CMD=.+ ]]
}

@test "railpack_extract_run_meta output evaluates to BUILD_CMD containing npm run build" {
  run bash -c "
source '${WORKTREE_ROOT}/cli/common.sh'
eval \"\$(railpack_extract_run_meta '${FIXTURE_DIR}/railpack-plan.json')\"
printf '%s' \"\$BUILD_CMD\"
"
  [ "$status" -eq 0 ]
  [[ "$output" == *"npm run build"* ]]
}

@test "railpack_extract_run_meta emits no BUILD_CMD for a plan whose build step has no commands" {
  cat > "${FIXTURE_DIR}/no-build-cmd.json" <<'JSON'
{
  "deploy": {
    "startCommand": "caddy run --config /Caddyfile --adapter caddyfile 2>&1",
    "inputs": [{ "include": ["dist"], "step": "build" }]
  },
  "steps": [
    { "name": "build", "commands": [] }
  ]
}
JSON
  run bash -c "source '${WORKTREE_ROOT}/cli/common.sh' && railpack_extract_run_meta '${FIXTURE_DIR}/no-build-cmd.json'"
  [ "$status" -eq 0 ]
  [[ "$output" != *"BUILD_CMD"* ]]
}

@test "railpack_extract_run_meta emits no BUILD_CMD for a plan with no steps" {
  cat > "${FIXTURE_DIR}/no-steps.json" <<'JSON'
{
  "deploy": {
    "startCommand": "caddy run --config /Caddyfile --adapter caddyfile 2>&1",
    "inputs": [{ "include": ["dist"], "step": "build" }]
  }
}
JSON
  run bash -c "source '${WORKTREE_ROOT}/cli/common.sh' && railpack_extract_run_meta '${FIXTURE_DIR}/no-steps.json'"
  [ "$status" -eq 0 ]
  [[ "$output" != *"BUILD_CMD"* ]]
}
