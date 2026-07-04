#!/usr/bin/env bats
# Functional tests for config/node-reconcile.sh — the crash-safe node_modules reconcile.
#
# node_modules is a named-volume MOUNTPOINT in a running feature stack. A bare in-place
# `npm install` corrupts the live tree if interrupted mid-rename (SIGKILL during
# `fleet sync --rebuild`), leaving a half-written package (e.g. vite/bin/vite.js gone ->
# .bin/vite dangling) that makes `exec vite` die and the gateway return 502. This script
# must: skip a healthy unchanged tree (fast path), detect the dangling-.bin corruption that
# `npm ls` alone misses, and never leave the tree worse than it found it.
#
# npm is stubbed so the tests run offline and deterministically: `npm install` materialises
# the packages named in package.json (incl. their bin -> .bin symlinks), and `npm ls` exits
# 0 iff every dependency dir exists. This lets us drive the health-check and swap logic
# without a network or a real registry.

WORKTREE_ROOT="$(cd "$(dirname "${BATS_TEST_FILENAME}")/../.." && pwd)"
SCRIPT="${WORKTREE_ROOT}/config/node-reconcile.sh"

setup() {
  APP="$(mktemp -d)"
  STUB_BIN="$(mktemp -d)"

  # package.json with one dep that ships a binary (mirrors vite/bin/vite.js).
  cat > "${APP}/package.json" <<'JSON'
{ "name": "app", "version": "1.0.0", "dependencies": { "vite": "1.0.0" } }
JSON
  cp "${APP}/package.json" "${APP}/package-lock.json"

  # npm stub. `install` builds node_modules from package.json deps (package dir + bin +
  # .bin symlink). `ls` exits 0 iff every declared dep dir is present. Runs relative to CWD.
  cat > "${STUB_BIN}/npm" <<'STUB'
#!/bin/bash
cmd="${1:-}"
case "$cmd" in
  install)
    mkdir -p node_modules/.bin
    # Single hard-coded dep 'vite' with a bin, matching the test's package.json.
    mkdir -p node_modules/vite/bin
    printf '#!/usr/bin/env node\n' > node_modules/vite/bin/vite.js
    chmod +x node_modules/vite/bin/vite.js
    ln -sf ../vite/bin/vite.js node_modules/.bin/vite
    exit 0
    ;;
  ls)
    # Healthy iff the vite package dir exists.
    [ -d node_modules/vite ] && exit 0 || exit 1
    ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "${STUB_BIN}/npm"
}

teardown() { rm -rf "${APP}" "${STUB_BIN}"; }

_run_reconcile() {
  ( cd "${APP}" && env PATH="${STUB_BIN}:${PATH}" bash "${SCRIPT}" frontend 2>&1 )
}

@test "node-reconcile.sh is valid bash" {
  run bash -n "${SCRIPT}"
  [ "$status" -eq 0 ]
}

@test "first run installs and writes a deps-hash marker" {
  run _run_reconcile
  [ "$status" -eq 0 ]
  [ -d "${APP}/node_modules/vite/bin" ]
  [ -f "${APP}/node_modules/.fleet-deps-hash" ]
  [[ "$output" == *"reconcile OK"* ]]
}

@test "second run skips reconcile when deps unchanged and tree healthy (fast path)" {
  _run_reconcile >/dev/null
  run _run_reconcile
  [ "$status" -eq 0 ]
  [[ "$output" == *"skipping reconcile"* ]]
}

@test "detects and self-heals a dangling .bin symlink that npm ls alone would miss" {
  _run_reconcile >/dev/null
  # Corrupt exactly like the real outage: remove the package's bin, leaving .bin/vite dangling.
  rm -rf "${APP}/node_modules/vite/bin"
  [ ! -e "${APP}/node_modules/.bin/vite" ]  # dangling now

  run _run_reconcile
  [ "$status" -eq 0 ]
  # Must NOT have taken the fast path — the dangling bin is corruption npm ls misses.
  [[ "$output" != *"skipping reconcile"* ]]
  # And it must be healed.
  [ -f "${APP}/node_modules/vite/bin/vite.js" ]
  [ -e "${APP}/node_modules/.bin/vite" ]
}

@test "a lockfile change forces a reconcile (marker mismatch)" {
  _run_reconcile >/dev/null
  printf '{"changed":true}' >> "${APP}/package-lock.json"
  run _run_reconcile
  [ "$status" -eq 0 ]
  [[ "$output" != *"skipping reconcile"* ]]
  [[ "$output" == *"reconcile OK"* ]]
}

@test "purges stale npm atomic-rename temp dirs and still succeeds" {
  _run_reconcile >/dev/null
  mkdir -p "${APP}/node_modules/.vite-AB12CD34/junk"
  printf 'stale' > "${APP}/node_modules/.fleet-deps-hash"   # force reconcile
  run _run_reconcile
  [ "$status" -eq 0 ]
  [ ! -d "${APP}/node_modules/.vite-AB12CD34" ]
}

@test "leaves no staging or old-swap scratch dirs behind" {
  printf 'stale' > "${APP}/node_modules/.fleet-deps-hash" 2>/dev/null || true
  _run_reconcile >/dev/null
  [ ! -d "${APP}/node_modules/.fleet-stage" ]
  run bash -c "ls -d '${APP}'/node_modules/.fleet-old-* 2>/dev/null"
  [ "$status" -ne 0 ]
}

@test "no package.json is a no-op success" {
  rm -f "${APP}/package.json" "${APP}/package-lock.json"
  run _run_reconcile
  [ "$status" -eq 0 ]
}
