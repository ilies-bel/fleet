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
} from './registry.js';

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
 */
function makeInspect(containerName, project, featureName, branch = 'main', running = true) {
  return {
    Config: {
      Env: [
        `PROJECT_NAME=${project}`,
        `FEATURE_NAME=${featureName}`,
        `BRANCH=${branch}`,
      ],
    },
    Mounts: [],
    State: { Running: running },
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

  test('calls startContainer when autoStart=true and container is stopped', async () => {
    const containerName = 'fleet-proj-sleepy';
    let startCalled = false;

    _setDockerImpl({
      listRunningContainers: async () => [],
      inspectContainer: async (name) => {
        if (name === containerName) {
          // After start, we'd normally be running — simulate that.
          return makeInspect(containerName, 'proj', 'sleepy', 'main', true);
        }
        return null;
      },
      startContainer: async (name) => {
        startCalled = true;
        startContainerCalls.push(name);
      },
    });

    const added = await reconcileOne(makeContainer(containerName, 'exited'), { autoStart: true });

    assert.ok(startCalled, 'startContainer must be called when autoStart=true and container is stopped');
    assert.equal(added, true);
    assert.ok(isRegistered('proj-sleepy'));
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
