/**
 * Tests for reconcile.js — reconcileSweep behaviour.
 *
 * Strategy: monkey-patch the docker.js and registry.js module exports in-place
 * within each test by temporarily replacing imported function references via a
 * shared mock holder. Because ESM module caches make deep mocking hard without
 * a vm-modules flag, we instead test reconcileOne / reconcileSweep via the
 * real registry (in-memory Map) and a stub docker module injected through a
 * thin seam.
 *
 * We expose the seam by factoring the docker calls through importable wrapper
 * functions that the tests can swap at runtime. Since `reconcile.js` imports
 * docker functions at module load time into local bindings, we test reconcile
 * behaviour by calling reconcileOne/reconcileSweep directly with the registry
 * pre-seeded and a stubbed docker layer wired through module-level mocking.
 *
 * Simpler approach used here: re-export the reconcile logic so tests can call
 * it with an injected docker stub. We test by:
 *   1. Seeding the registry directly (using register/unregister from registry.js)
 *   2. Stubbing docker.js responses via node:test mock.module (Node 22+) or
 *      by testing the pure helper functions that do NOT touch docker.
 *
 * Since the project targets Node 20 (which does not have mock.module), we use
 * a pragmatic strategy: we test reconcileOne/reconcileSweep by calling them
 * with a wrapper that patches the docker import binding through a test-only
 * injection point exposed in reconcile.js via `_setDockerImpl` (only exported
 * when NODE_ENV=test). This keeps zero additional production surface area.
 *
 * Actually — Node 20 does not support mock.module, so we use the simplest
 * approach: expose a `_setDockerImpl` test seam in reconcile.js that lets
 * tests swap the docker layer at runtime.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  reconcileOne,
  reconcileSweep,
  reconcileFromDocker,
  _setDockerImpl,
} from './reconcile.js';

import {
  register,
  unregister,
  getAll,
  isRegistered,
  getActiveFeature,
  setActiveFeature,
  loadPersistedActive,
  loadPersistedRegistry,
  persistRegistryBaseline,
  probeContainerState,
  commitProbedStatus,
  updateStatus,
  _clearPendingFlips,
} from './registry.js';

import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── helpers ───────────────────────────────────────────────────────────────────

function clearRegistry() {
  for (const f of getAll()) unregister(f.key);
}

/**
 * Build a minimal Docker container summary as returned by listRunningContainers.
 */
function makeContainer(name, state = 'running') {
  return { Names: [`/${name}`], State: state };
}

/**
 * Build a minimal inspectContainer response.
 * @param {object} [opts]  extra { state, envExtra, mounts } to enrich the payload.
 */
function makeInspect(containerName, project, featureName, branch = 'main', running = true, opts = {}) {
  return {
    Config: {
      Env: [
        `PROJECT_NAME=${project}`,
        `FEATURE_NAME=${featureName}`,
        `BRANCH=${branch}`,
        ...(opts.envExtra ?? []),
      ],
    },
    Mounts: opts.mounts ?? [],
    State: opts.state ?? { Running: running },
  };
}

// ── reconcileSweep tests ──────────────────────────────────────────────────────

describe('reconcileSweep', () => {
  let startContainerCalls;

  beforeEach(() => {
    clearRegistry();
    startContainerCalls = [];
  });

  afterEach(() => {
    clearRegistry();
    // Reset docker impl to a no-op so other test suites are not affected.
    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async () => null,
      startContainer: async () => {},
    });
  });

  // ── 1. Sweep registers a new container not yet in the registry ─────────────

  test('registers a new container that is not yet in the registry', async () => {
    const containerName = 'fleet-proj-feat-new';

    _setDockerImpl({
      listRunningContainers: async () => [makeContainer(containerName, 'running')],
      inspectContainer: async (name) => {
        if (name === containerName) {
          return makeInspect(containerName, 'proj', 'feat-new', 'main', true);
        }
        return null;
      },
      startContainer: async (name) => { startContainerCalls.push(name); },
    });

    await reconcileSweep();

    assert.ok(isRegistered('proj-feat-new'), 'feature should be registered after sweep');
  });

  // ── 2. Sweep unregisters a phantom entry whose container is gone ───────────

  test('unregisters a phantom registry entry when Docker has no matching container', async () => {
    // Seed the registry with a key that has no Docker container.
    register('proj', 'feat-gone', 'main', null, 'up');
    assert.ok(isRegistered('proj-feat-gone'), 'precondition: feature should be registered');

    // Docker returns no containers.
    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async () => null,
      startContainer: async (name) => { startContainerCalls.push(name); },
    });

    await reconcileSweep();

    assert.equal(isRegistered('proj-feat-gone'), false, 'phantom entry should be removed');
  });

  // ── 3. Sweep does NOT auto-start stopped containers ─────────────────────────

  test('does not call startContainer for a stopped container', async () => {
    const containerName = 'fleet-proj-feat-stopped';

    _setDockerImpl({
      listRunningContainers: async () => [makeContainer(containerName, 'exited')],
      inspectContainer: async (name) => {
        if (name === containerName) {
          return makeInspect(containerName, 'proj', 'feat-stopped', 'main', false);
        }
        return null;
      },
      startContainer: async (name) => { startContainerCalls.push(name); },
    });

    await reconcileSweep();

    assert.equal(startContainerCalls.length, 0, 'sweep must NOT call startContainer');
    // The container should still be registered (with stopped status).
    assert.ok(isRegistered('proj-feat-stopped'), 'stopped container should still be registered');
  });
});

// ── reconcileOne tests ────────────────────────────────────────────────────────

describe('reconcileOne', () => {
  let startContainerCalls;

  beforeEach(() => {
    clearRegistry();
    startContainerCalls = [];
  });

  afterEach(() => {
    clearRegistry();
    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async () => null,
      startContainer: async () => {},
    });
  });

  test('registers a running container with status up', async () => {
    const containerName = 'fleet-proj-hello';

    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async (name) => {
        if (name === containerName) {
          return makeInspect(containerName, 'proj', 'hello', 'feat/hello', true);
        }
        return null;
      },
      startContainer: async (name) => { startContainerCalls.push(name); },
    });

    const added = await reconcileOne(makeContainer(containerName, 'running'), { autoStart: false });

    assert.equal(added, true);
    assert.ok(isRegistered('proj-hello'));
    const entry = getAll().find((f) => f.key === 'proj-hello');
    assert.equal(entry.status, 'up');
    assert.equal(startContainerCalls.length, 0);
  });

  test('calls startContainer when baseline was "up" and container is cleanly stopped', async () => {
    const containerName = 'fleet-proj-sleepy';
    let startCalled = false;

    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async (name) => {
        if (name === containerName) {
          // First inspect (pre-start): stopped (clean exit). Second inspect (post-start): running.
          return makeInspect(containerName, 'proj', 'sleepy', 'main', startCalled);
        }
        return null;
      },
      startContainer: async (name) => {
        startCalled = true;
        startContainerCalls.push(name);
      },
    });

    const baseline = { 'proj-sleepy': { status: 'up' } };
    const added = await reconcileOne(makeContainer(containerName, 'exited'), { baseline });

    assert.ok(startCalled, 'startContainer must be called when baseline was "up" and container is stopped');
    assert.equal(added, true);
    assert.ok(isRegistered('proj-sleepy'));
    // After starting, the container is running — status should be 'up'.
    assert.equal(getAll().find((f) => f.key === 'proj-sleepy').status, 'up');
  });

  test('skips container with no PROJECT_NAME env', async () => {
    const containerName = 'fleet-legacy-feature';

    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async (name) => {
        if (name === containerName) {
          return {
            Config: { Env: ['BRANCH=main'] },
            Mounts: [],
            State: { Running: true },
          };
        }
        return null;
      },
      startContainer: async () => {},
    });

    const added = await reconcileOne(makeContainer(containerName, 'running'), { autoStart: false });

    assert.equal(added, false);
    assert.equal(isRegistered('legacy-feature'), false);
  });
});

// ── boot-restore: simulates what index.js does after reconcileFromDocker ──────
//
// index.js boot-restore logic (verbatim):
//   const persistedKey = loadPersistedActive();
//   if (persistedKey && isRegistered(persistedKey)) {
//     setActiveFeature(persistedKey);
//     console.log(`[fleet] restored active feature: ${persistedKey}`);
//   }
//
// We test this logic by exercising the three registry functions directly with
// a controlled FLEET_STATE_FILE, avoiding the need to import index.js (which
// would bind ports and issue network calls).

describe('boot-restore logic', () => {
  let tmpDir;
  let stateFile;
  let savedEnv;

  beforeEach(() => {
    clearRegistry();
    tmpDir = mkdtempSync(join(tmpdir(), 'fleet-boot-test-'));
    stateFile = join(tmpDir, 'active.json');
    savedEnv = process.env.FLEET_STATE_FILE;
    process.env.FLEET_STATE_FILE = stateFile;
  });

  afterEach(() => {
    clearRegistry();
    if (savedEnv === undefined) {
      delete process.env.FLEET_STATE_FILE;
    } else {
      process.env.FLEET_STATE_FILE = savedEnv;
    }
    rmSync(tmpDir, { recursive: true, force: true });
    // Reset docker impl
    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async () => null,
      startContainer: async () => {},
    });
  });

  test('restores persisted key when it is registered', () => {
    // Register both features as stopped first (no auto-pick, no file write).
    // This simulates reconcileFromDocker running with stopped containers.
    register('proj', 'alpha', 'main', null, 'stopped');
    register('proj', 'beta', 'main', null, 'stopped');

    // Now manually set alpha as active (simulates first-up auto-pick after start).
    setActiveFeature('proj-alpha');  // writes proj-alpha to state file

    assert.equal(getActiveFeature(), 'proj-alpha', 'precondition: alpha is auto-picked');

    // Write the persisted choice AFTER all registry seeding — simulates
    // what was left on disk from the previous gateway session (user had
    // activated beta before the gateway was restarted).
    writeFileSync(stateFile, JSON.stringify({ key: 'proj-beta', updatedAt: new Date().toISOString() }), 'utf8');

    // Simulate index.js boot-restore
    const persistedKey = loadPersistedActive();
    if (persistedKey && isRegistered(persistedKey)) {
      setActiveFeature(persistedKey);
    }

    assert.equal(getActiveFeature(), 'proj-beta', 'boot-restore must reinstate the persisted choice');
  });

  test('does NOT call setActiveFeature when persisted key is not in registry', () => {
    // Persisted key whose container was removed between restarts.
    writeFileSync(stateFile, JSON.stringify({ key: 'proj-removed', updatedAt: new Date().toISOString() }), 'utf8');

    register('proj', 'alpha', 'main', null, 'up');  // only alpha is up now

    const persistedKey = loadPersistedActive();
    // Boot-restore guard: only restore if still registered
    if (persistedKey && isRegistered(persistedKey)) {
      setActiveFeature(persistedKey);
    }

    // Alpha should remain as auto-pick; no crash
    assert.equal(getActiveFeature(), 'proj-alpha', 'auto-pick should stand when persisted key is missing');
  });

  test('does nothing and does not throw when state file is absent', () => {
    // Read BEFORE any register so the file hasn't been written yet.
    const persistedKey = loadPersistedActive();
    assert.equal(persistedKey, null, 'loadPersistedActive must return null when no file exists');

    // Now simulate reconcileFromDocker — registers alpha, auto-picks it.
    register('proj', 'alpha', 'main', null, 'up');

    // Boot-restore is a no-op (persistedKey was null before registration).
    if (persistedKey && isRegistered(persistedKey)) {
      setActiveFeature(persistedKey);
    }

    assert.equal(getActiveFeature(), 'proj-alpha', 'auto-pick should stand when no state file exists');
  });
});

// ── probeContainerState — Docker state → status classification ────────────────

describe('probeContainerState', () => {
  const probe = (state) => probeContainerState('c', async () => ({ State: state }));

  test("running container → 'up'", async () => {
    assert.equal(await probe({ Running: true }), 'up');
  });

  test("clean exit (ExitCode 0) → 'stopped'", async () => {
    assert.equal(await probe({ Running: false, ExitCode: 0 }), 'stopped');
  });

  test("non-zero exit → 'failed'", async () => {
    assert.equal(await probe({ Running: false, ExitCode: 137 }), 'failed');
  });

  test("OOMKilled → 'failed' even with ExitCode 0", async () => {
    assert.equal(await probe({ Running: false, ExitCode: 0, OOMKilled: true }), 'failed');
  });

  test("Dead → 'failed'", async () => {
    assert.equal(await probe({ Running: false, ExitCode: 0, Dead: true }), 'failed');
  });

  test("Restarting → 'restarting' (don't decide yet)", async () => {
    assert.equal(await probe({ Running: false, Restarting: true }), 'restarting');
  });

  test("healthcheck 'starting' → 'starting'", async () => {
    assert.equal(await probe({ Running: true, Health: { Status: 'starting' } }), 'starting');
  });

  test("unhealthy with FailingStreak >= 2 → 'unhealthy'", async () => {
    assert.equal(
      await probe({ Running: true, Health: { Status: 'unhealthy', FailingStreak: 2 } }),
      'unhealthy'
    );
  });

  test("unhealthy with a single failure (streak 1) is NOT yet unhealthy → 'up'", async () => {
    assert.equal(
      await probe({ Running: true, Health: { Status: 'unhealthy', FailingStreak: 1 } }),
      'up'
    );
  });

  test("inspect returns null (404) → 'missing'", async () => {
    assert.equal(await probeContainerState('c', async () => null), 'missing');
  });

  test("inspect throws (socket error) → 'unknown' (do not change state)", async () => {
    assert.equal(
      await probeContainerState('c', async () => { throw new Error('EAGAIN'); }),
      'unknown'
    );
  });
});

// ── commitProbedStatus — debounced status transitions ─────────────────────────

describe('commitProbedStatus', () => {
  beforeEach(() => {
    clearRegistry();
    _clearPendingFlips();
  });

  test('flip up → stopped requires 2 consecutive reads', () => {
    register('p', 'a', 'main', null, 'up');

    const first = commitProbedStatus('p-a', 'stopped');
    assert.equal(first.changed, false, 'one observation must not flip');
    assert.equal(getAll().find((f) => f.key === 'p-a').status, 'up');

    const second = commitProbedStatus('p-a', 'stopped');
    assert.equal(second.changed, true, 'second consecutive observation commits');
    assert.equal(getAll().find((f) => f.key === 'p-a').status, 'stopped');
  });

  test('a transient unknown between two stopped reads resets the debounce', () => {
    register('p', 'b', 'main', null, 'up');

    commitProbedStatus('p-b', 'stopped');         // count = 1
    commitProbedStatus('p-b', 'unknown');         // resets pending, no-op
    const r = commitProbedStatus('p-b', 'stopped'); // count = 1 again, not 2

    assert.equal(r.changed, false, 'unknown must reset the streak so no flip yet');
    assert.equal(getAll().find((f) => f.key === 'p-b').status, 'up');
  });

  test("recovery to 'up' commits immediately (no debounce)", () => {
    register('p', 'c', 'main', null, 'stopped');
    const r = commitProbedStatus('p-c', 'up');
    assert.equal(r.changed, true);
    assert.equal(getAll().find((f) => f.key === 'p-c').status, 'up');
  });

  test('changing target mid-streak restarts the count', () => {
    register('p', 'd', 'main', null, 'up');
    commitProbedStatus('p-d', 'stopped');          // streak: stopped=1
    const r = commitProbedStatus('p-d', 'failed');  // different target → failed=1
    assert.equal(r.changed, false);
    const r2 = commitProbedStatus('p-d', 'failed'); // failed=2 → commit
    assert.equal(r2.changed, true);
    assert.equal(getAll().find((f) => f.key === 'p-d').status, 'failed');
  });

  test('probed === current status is a no-op', () => {
    register('p', 'e', 'main', null, 'up');
    const r = commitProbedStatus('p-e', 'up');
    assert.equal(r.changed, false);
  });
});

// ── reconcileSweep — status reconciliation for already-registered containers ──

describe('reconcileSweep — status drift correction', () => {
  beforeEach(() => {
    clearRegistry();
    _clearPendingFlips();
  });

  afterEach(() => {
    clearRegistry();
    _clearPendingFlips();
    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async () => null,
      startContainer: async () => {},
    });
  });

  test('flips a registered up→failed after 2 sweeps when the container crashed', async () => {
    register('proj', 'crashed', 'main', null, 'up');
    const containerName = 'fleet-proj-crashed';

    _setDockerImpl({
      listRunningContainers: async () => [makeContainer(containerName, 'exited')],
      inspectContainer: async (name) =>
        name === containerName
          ? makeInspect(containerName, 'proj', 'crashed', 'main', false, {
              state: { Running: false, ExitCode: 137 },
            })
          : null,
      startContainer: async () => {},
    });

    await reconcileSweep();
    assert.equal(getAll().find((f) => f.key === 'proj-crashed').status, 'up', 'one sweep must not flip');

    await reconcileSweep();
    assert.equal(getAll().find((f) => f.key === 'proj-crashed').status, 'failed', 'second sweep flips to failed');
  });

  test('flips a registered up→stopped after 2 sweeps for a clean exit', async () => {
    register('proj', 'clean', 'main', null, 'up');
    const containerName = 'fleet-proj-clean';

    _setDockerImpl({
      listRunningContainers: async () => [makeContainer(containerName, 'exited')],
      inspectContainer: async (name) =>
        name === containerName
          ? makeInspect(containerName, 'proj', 'clean', 'main', false, {
              state: { Running: false, ExitCode: 0 },
            })
          : null,
      startContainer: async () => {},
    });

    await reconcileSweep();
    await reconcileSweep();
    assert.equal(getAll().find((f) => f.key === 'proj-clean').status, 'stopped');
  });

  test('leaves a healthy registered container at up', async () => {
    register('proj', 'alive', 'main', null, 'up');
    const containerName = 'fleet-proj-alive';

    _setDockerImpl({
      listRunningContainers: async () => [makeContainer(containerName, 'running')],
      inspectContainer: async (name) =>
        name === containerName
          ? makeInspect(containerName, 'proj', 'alive', 'main', true)
          : null,
      startContainer: async () => {},
    });

    await reconcileSweep();
    await reconcileSweep();
    assert.equal(getAll().find((f) => f.key === 'proj-alive').status, 'up');
  });
});

// ── reconcileOne — recovers services + worktree from the container ────────────

describe('reconcileOne — full entry recovery', () => {
  beforeEach(() => clearRegistry());
  afterEach(() => {
    clearRegistry();
    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async () => null,
      startContainer: async () => {},
    });
  });

  test('populates services from FLEET_SERVICES_JSON env', async () => {
    const containerName = 'fleet-proj-svc';
    const servicesJson = JSON.stringify([
      { name: 'backend', port: '8081' },
      { name: 'frontend', port: '3000' },
      { name: 'garbage' }, // malformed — must be dropped
    ]);

    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async (name) =>
        name === containerName
          ? makeInspect(containerName, 'proj', 'svc', 'main', true, {
              envExtra: [`FLEET_SERVICES_JSON=${servicesJson}`],
            })
          : null,
      startContainer: async () => {},
    });

    await reconcileOne(makeContainer(containerName, 'running'), { autoStart: false });

    const entry = getAll().find((f) => f.key === 'proj-svc');
    assert.deepEqual(entry.services, [
      { name: 'backend', port: 8081 },
      { name: 'frontend', port: 3000 },
    ]);
  });

  test('recovers worktreePath from a /app/<dir> bind mount (split layout)', async () => {
    const containerName = 'fleet-proj-wt';
    const worktree = '/Users/x/app/.worktrees/bd-proj-wt';

    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async (name) =>
        name === containerName
          ? makeInspect(containerName, 'proj', 'wt', 'main', true, {
              mounts: [
                { Type: 'bind', Destination: '/app/backend', Source: `${worktree}/backend` },
                { Type: 'bind', Destination: '/app/frontend', Source: `${worktree}/frontend` },
                { Type: 'bind', Destination: '/root/.npmrc', Source: '/Users/x/.npmrc' },
              ],
            })
          : null,
      startContainer: async () => {},
    });

    await reconcileOne(makeContainer(containerName, 'running'), { autoStart: false });

    const entry = getAll().find((f) => f.key === 'proj-wt');
    assert.equal(entry.worktreePath, worktree);
  });

  test('restores a crashed container as failed, not stopped', async () => {
    const containerName = 'fleet-proj-boom';

    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async (name) =>
        name === containerName
          ? makeInspect(containerName, 'proj', 'boom', 'main', false, {
              state: { Running: false, ExitCode: 1 },
            })
          : null,
      startContainer: async () => {},
    });

    await reconcileOne(makeContainer(containerName, 'exited'));

    assert.equal(getAll().find((f) => f.key === 'proj-boom').status, 'failed');
  });
});

// ── reconcileOne — baseline-driven start decisions ───────────────────────────

describe('reconcileOne — baseline-driven boot start decisions', () => {
  let startContainerCalls;

  beforeEach(() => {
    clearRegistry();
    startContainerCalls = [];
  });

  afterEach(() => {
    clearRegistry();
    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async () => null,
      startContainer: async () => {},
    });
  });

  // (a) stopped container whose baseline was 'up' IS restarted
  test('(a) stopped container with baseline "up" IS started and registered as up', async () => {
    const containerName = 'fleet-proj-alpha';
    let startCalled = false;

    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async (name) => {
        if (name !== containerName) return null;
        // Before start: stopped (clean exit). After start: running.
        return makeInspect(containerName, 'proj', 'alpha', 'main', startCalled);
      },
      startContainer: async (name) => { startCalled = true; startContainerCalls.push(name); },
    });

    await reconcileOne(
      makeContainer(containerName, 'exited'),
      { baseline: { 'proj-alpha': { status: 'up' } } }
    );

    assert.ok(startCalled, 'startContainer must be called');
    assert.ok(isRegistered('proj-alpha'));
    assert.equal(getAll().find((f) => f.key === 'proj-alpha').status, 'up',
      'displayed status must reflect post-start live probe (up), not stale baseline');
  });

  // (b) stopped container with no baseline (absent key) is NOT restarted
  test('(b) stopped container with no baseline entry is NOT started, registered as stopped', async () => {
    const containerName = 'fleet-proj-beta';

    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async (name) =>
        name === containerName
          ? makeInspect(containerName, 'proj', 'beta', 'main', false)
          : null,
      startContainer: async (name) => { startContainerCalls.push(name); },
    });

    await reconcileOne(makeContainer(containerName, 'exited'), { baseline: {} });

    assert.equal(startContainerCalls.length, 0, 'must not start when baseline has no entry');
    assert.ok(isRegistered('proj-beta'));
    assert.equal(getAll().find((f) => f.key === 'proj-beta').status, 'stopped');
  });

  // (b) stopped container with baseline 'stopped' is NOT restarted
  test('(b) stopped container with baseline "stopped" is NOT started', async () => {
    const containerName = 'fleet-proj-gamma';

    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async (name) =>
        name === containerName
          ? makeInspect(containerName, 'proj', 'gamma', 'main', false)
          : null,
      startContainer: async (name) => { startContainerCalls.push(name); },
    });

    await reconcileOne(
      makeContainer(containerName, 'exited'),
      { baseline: { 'proj-gamma': { status: 'stopped' } } }
    );

    assert.equal(startContainerCalls.length, 0, 'baseline "stopped" must not trigger start');
    assert.equal(getAll().find((f) => f.key === 'proj-gamma').status, 'stopped');
  });

  // (c) crashed/failed container is NOT auto-restarted even if baseline was 'up'
  test('(c) crashed container with baseline "up" is NOT started — stays failed', async () => {
    const containerName = 'fleet-proj-crashed';

    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async (name) =>
        name === containerName
          ? makeInspect(containerName, 'proj', 'crashed', 'main', false, {
              state: { Running: false, ExitCode: 137 },
            })
          : null,
      startContainer: async (name) => { startContainerCalls.push(name); },
    });

    await reconcileOne(
      makeContainer(containerName, 'exited'),
      { baseline: { 'proj-crashed': { status: 'up' } } }
    );

    assert.equal(startContainerCalls.length, 0, 'crashed container must not be auto-restarted');
    assert.equal(getAll().find((f) => f.key === 'proj-crashed').status, 'failed',
      'crashed container must be registered as failed');
  });

  // (d) displayed status always equals live probe, never stale baseline
  test('(d) displayed status is the live probe, not the stale baseline', async () => {
    const containerName = 'fleet-proj-delta';

    // Container IS still running (live probe = up), baseline says 'stopped' (stale/wrong)
    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async (name) =>
        name === containerName
          ? makeInspect(containerName, 'proj', 'delta', 'main', true)
          : null,
      startContainer: async () => {},
    });

    await reconcileOne(
      makeContainer(containerName, 'running'),
      { baseline: { 'proj-delta': { status: 'stopped' } } }
    );

    assert.equal(getAll().find((f) => f.key === 'proj-delta').status, 'up',
      'status must be the live probe (up), not the stale baseline (stopped)');
  });
});

// ── reconcileFromDocker — baseline-driven boot (integration) ─────────────────

describe('reconcileFromDocker — baseline-driven boot', () => {
  let tmpDir;
  let registryFile;
  let savedRegistryEnv;
  let startContainerCalls;

  beforeEach(() => {
    clearRegistry();
    startContainerCalls = [];
    tmpDir = mkdtempSync(join(tmpdir(), 'fleet-boot-baseline-'));
    registryFile = join(tmpDir, 'registry.json');
    savedRegistryEnv = process.env.FLEET_REGISTRY_FILE;
    process.env.FLEET_REGISTRY_FILE = registryFile;
  });

  afterEach(() => {
    clearRegistry();
    _clearPendingFlips();
    if (savedRegistryEnv === undefined) {
      delete process.env.FLEET_REGISTRY_FILE;
    } else {
      process.env.FLEET_REGISTRY_FILE = savedRegistryEnv;
    }
    rmSync(tmpDir, { recursive: true, force: true });
    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async () => null,
      startContainer: async () => {},
    });
  });

  test('does not start a stopped container when baseline is empty (no prior state)', async () => {
    const containerName = 'fleet-proj-new';
    // No registry.json on disk → baseline is {}

    _setDockerImpl({
      listRunningContainers: async () => [makeContainer(containerName, 'exited')],
      inspectContainer: async (name) =>
        name === containerName
          ? makeInspect(containerName, 'proj', 'new', 'main', false)
          : null,
      startContainer: async (name) => { startContainerCalls.push(name); },
    });

    await reconcileFromDocker();

    assert.equal(startContainerCalls.length, 0, 'no prior baseline → do not start');
    assert.ok(isRegistered('proj-new'));
    assert.equal(getAll().find((f) => f.key === 'proj-new').status, 'stopped');
  });

  test('restarts a stopped container whose baseline was "up"', async () => {
    const containerName = 'fleet-proj-comeback';
    // Write baseline: this feature was 'up' before the gateway went down.
    writeFileSync(registryFile, JSON.stringify({ 'proj-comeback': { status: 'up' } }), 'utf8');

    let startCalled = false;
    _setDockerImpl({
      listRunningContainers: async () => [makeContainer(containerName, 'exited')],
      inspectContainer: async (name) => {
        if (name !== containerName) return null;
        return makeInspect(containerName, 'proj', 'comeback', 'main', startCalled);
      },
      startContainer: async (name) => { startCalled = true; startContainerCalls.push(name); },
    });

    await reconcileFromDocker();

    assert.ok(startCalled, 'container with baseline "up" must be restarted');
    assert.equal(getAll().find((f) => f.key === 'proj-comeback').status, 'up',
      'registered status must reflect post-start live probe');
  });

  test('does not restart a container whose baseline was "stopped"', async () => {
    const containerName = 'fleet-proj-intentional';
    writeFileSync(registryFile, JSON.stringify({ 'proj-intentional': { status: 'stopped' } }), 'utf8');

    _setDockerImpl({
      listRunningContainers: async () => [makeContainer(containerName, 'exited')],
      inspectContainer: async (name) =>
        name === containerName
          ? makeInspect(containerName, 'proj', 'intentional', 'main', false)
          : null,
      startContainer: async (name) => { startContainerCalls.push(name); },
    });

    await reconcileFromDocker();

    assert.equal(startContainerCalls.length, 0, 'deliberately-stopped feature must not be restarted');
    assert.equal(getAll().find((f) => f.key === 'proj-intentional').status, 'stopped');
  });

  test('does not restart a crashed container even if baseline was "up"', async () => {
    const containerName = 'fleet-proj-oom';
    writeFileSync(registryFile, JSON.stringify({ 'proj-oom': { status: 'up' } }), 'utf8');

    _setDockerImpl({
      listRunningContainers: async () => [makeContainer(containerName, 'exited')],
      inspectContainer: async (name) =>
        name === containerName
          ? makeInspect(containerName, 'proj', 'oom', 'main', false, {
              state: { Running: false, OOMKilled: true },
            })
          : null,
      startContainer: async (name) => { startContainerCalls.push(name); },
    });

    await reconcileFromDocker();

    assert.equal(startContainerCalls.length, 0, 'OOM-killed container must not be auto-restarted');
    assert.equal(getAll().find((f) => f.key === 'proj-oom').status, 'failed');
  });

  // (e) sweep path never starts anything
  test('(e) sweep path never calls startContainer regardless of baseline', async () => {
    const containerName = 'fleet-proj-sweep-check';
    // Seed a baseline that says 'up' — sweep must ignore it
    writeFileSync(registryFile, JSON.stringify({ 'proj-sweep-check': { status: 'up' } }), 'utf8');

    _setDockerImpl({
      listRunningContainers: async () => [makeContainer(containerName, 'exited')],
      inspectContainer: async (name) =>
        name === containerName
          ? makeInspect(containerName, 'proj', 'sweep-check', 'main', false)
          : null,
      startContainer: async (name) => { startContainerCalls.push(name); },
    });

    // reconcileSweep must never start containers (no baseline passed to reconcileOne)
    await reconcileSweep();

    assert.equal(startContainerCalls.length, 0, 'sweep must never call startContainer');
  });
});

// ── registry baseline persistence (persistRegistryBaseline / loadPersistedRegistry) ─

describe('registry baseline persistence', () => {
  let tmpDir;
  let registryFile;
  let savedRegistryEnv;

  beforeEach(() => {
    clearRegistry();
    tmpDir = mkdtempSync(join(tmpdir(), 'fleet-registry-baseline-'));
    registryFile = join(tmpDir, 'registry.json');
    savedRegistryEnv = process.env.FLEET_REGISTRY_FILE;
    process.env.FLEET_REGISTRY_FILE = registryFile;
  });

  afterEach(() => {
    clearRegistry();
    if (savedRegistryEnv === undefined) {
      delete process.env.FLEET_REGISTRY_FILE;
    } else {
      process.env.FLEET_REGISTRY_FILE = savedRegistryEnv;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // (f) baseline file is written on register()
  test('(f) register() writes the baseline file', () => {
    register('proj', 'f1', 'main', null, 'up');

    assert.ok(existsSync(registryFile), 'baseline file must exist after register()');
    const baseline = loadPersistedRegistry();
    assert.deepEqual(baseline['proj-f1'], { status: 'up' });
  });

  // (f) baseline file is written on updateStatus()
  test('(f) updateStatus() writes the baseline file', () => {
    register('proj', 'f2', 'main', null, 'up');
    updateStatus('proj-f2', 'stopped');

    const baseline = loadPersistedRegistry();
    assert.deepEqual(baseline['proj-f2'], { status: 'stopped' },
      'baseline must reflect the new status after updateStatus()');
  });

  // (f) loadPersistedRegistry round-trips correctly
  test('(f) loadPersistedRegistry round-trips the baseline', () => {
    register('proj', 'f3', 'main', null, 'up');
    register('proj', 'f4', 'main', null, 'stopped');

    const baseline = loadPersistedRegistry();
    assert.deepEqual(baseline['proj-f3'], { status: 'up' });
    assert.deepEqual(baseline['proj-f4'], { status: 'stopped' });
  });

  // (f) corrupt file yields {} without throwing
  test('(f) corrupt registry file yields {} without throwing', () => {
    writeFileSync(registryFile, 'not-valid-json', 'utf8');

    let result;
    assert.doesNotThrow(() => { result = loadPersistedRegistry(); });
    assert.deepEqual(result, {});
  });

  // (f) missing file yields {} without throwing
  test('(f) missing registry file yields {} without throwing', () => {
    // registryFile has never been written
    let result;
    assert.doesNotThrow(() => { result = loadPersistedRegistry(); });
    assert.deepEqual(result, {});
  });

  // (f) persistRegistryBaseline uses atomic tmp+rename (no .tmp file left behind)
  test('(f) persistRegistryBaseline writes atomically — no .tmp file left behind', () => {
    register('proj', 'f5', 'main', null, 'up');

    assert.ok(existsSync(registryFile), 'final file must exist');
    assert.equal(existsSync(`${registryFile}.tmp`), false, '.tmp file must not remain');
  });

  test('baseline is persisted as a map with only {status} per entry (no transient fields)', () => {
    register('proj', 'f6', 'main', '/some/path', 'up', [{ name: 'web', port: 3000 }]);

    const baseline = loadPersistedRegistry();
    const entry = baseline['proj-f6'];
    assert.ok(entry, 'entry must exist');
    assert.deepEqual(Object.keys(entry), ['status'], 'baseline must only contain status');
  });
});
