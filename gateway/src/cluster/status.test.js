/**
 * Tests for gateway/src/cluster/status.js
 *
 * Strategy: inject a stub oc implementation via the _setOcImpl test seam so
 * tests exercise the full phase→status mapping and error-handling logic
 * without spawning a real oc binary or touching a cluster.
 *
 * Separate describe blocks test:
 *   1. Phase → Fleet status mapping (table-driven)
 *   2. Pod deleted / oc error → 'stopped'
 *   3. Correct pod name and namespace forwarded to oc
 *   4. Reconcile dispatch: cluster features use cluster backend; local features use docker
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { status, _setOcImpl } from './status.js';
import {
  reconcileSweep,
  _setDockerImpl,
  _setClusterStatusImpl,
} from '../reconcile.js';
import {
  register,
  unregister,
  getAll,
  getFeature,
  _clearPendingFlips,
} from '../registry.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function clearRegistry() {
  for (const f of getAll()) unregister(f.key);
  _clearPendingFlips();
}

/**
 * Build a minimal cluster feature for use as the `status()` argument.
 * @param {string} key  composite key (e.g. 'proj-feat')
 * @param {string} [namespace]
 */
function makeClusterFeature(key, namespace = 'fleet') {
  return { key, host: { cluster: 'cls', namespace } };
}

// ── phase → status mapping ────────────────────────────────────────────────────

describe('cluster/status — phase→status mapping', () => {
  afterEach(() => {
    // Restore real oc impl after each test.
    _setOcImpl(undefined);
  });

  const cases = [
    { phase: 'Running',           expected: 'up'       },
    { phase: 'Pending',           expected: 'starting' },
    { phase: 'Succeeded',         expected: 'stopped'  },
    { phase: 'Failed',            expected: 'failed'   },
    { phase: 'CrashLoopBackOff',  expected: 'failed'   },
    { phase: 'Unknown',           expected: 'stopped'  }, // fallback
    { phase: '',                  expected: 'stopped'  }, // empty string fallback
  ];

  for (const { phase, expected } of cases) {
    test(`phase '${phase}' → '${expected}'`, async () => {
      _setOcImpl({ getPodStatus: async () => phase });
      const result = await status(makeClusterFeature('proj-feat'));
      assert.equal(result, expected);
    });
  }
});

// ── pod deleted / oc error → 'stopped' ───────────────────────────────────────

describe('cluster/status — pod not found or oc error', () => {
  afterEach(() => {
    _setOcImpl(undefined);
  });

  test('returns stopped when oc throws (pod deleted out-of-band)', async () => {
    _setOcImpl({ getPodStatus: async () => { throw new Error('not found'); } });
    const result = await status(makeClusterFeature('proj-deleted'));
    assert.equal(result, 'stopped');
  });

  test('returns stopped when oc exits non-zero', async () => {
    _setOcImpl({ getPodStatus: async () => { throw new Error('oc get pod exited with code 1: Error from server: pods "fleet-proj-x" not found'); } });
    const result = await status(makeClusterFeature('proj-x'));
    assert.equal(result, 'stopped');
  });
});

// ── pod name and namespace forwarding ─────────────────────────────────────────

describe('cluster/status — pod name and namespace', () => {
  afterEach(() => {
    _setOcImpl(undefined);
  });

  test('derives pod name as fleet-<key> and passes namespace to oc', async () => {
    let receivedName;
    let receivedNs;
    _setOcImpl({
      getPodStatus: async (name, ns) => {
        receivedName = name;
        receivedNs = ns;
        return 'Running';
      },
    });
    await status({ key: 'myproj-myfeature', host: { cluster: 'cls', namespace: 'staging' } });
    assert.equal(receivedName, 'fleet-myproj-myfeature');
    assert.equal(receivedNs, 'staging');
  });
});

// ── reconcile dispatch — both backends ───────────────────────────────────────

describe('reconcileSweep dispatch — cluster vs local', () => {
  let dockerCalls;
  let clusterStatusCalls;

  /**
   * Minimal docker stub: listRunningContainers returns empty list (no docker
   * containers); inspectContainer and startContainer are not called.
   */
  function makeDockerStub() {
    return {
      listRunningContainers: async () => [],
      inspectContainer: async (name) => {
        dockerCalls.push(name);
        return null;
      },
      startContainer: async () => {},
    };
  }

  beforeEach(() => {
    clearRegistry();
    dockerCalls = [];
    clusterStatusCalls = [];
    _setDockerImpl(makeDockerStub());
    _setClusterStatusImpl({
      status: async (feature) => {
        clusterStatusCalls.push(feature.key);
        return 'up';
      },
    });
  });

  afterEach(() => {
    clearRegistry();
    // Restore real implementations.
    _setDockerImpl(undefined);
    _setClusterStatusImpl(undefined);
  });

  test('cluster feature is reconciled via cluster backend, not docker', async () => {
    register('proj', 'feat', 'main', null, 'up', [], null, null, { cluster: 'cls', namespace: 'fleet' });
    await reconcileSweep();
    assert.ok(clusterStatusCalls.includes('proj-feat'), 'cluster backend should be called for cluster feature');
    assert.ok(!dockerCalls.includes('fleet-proj-feat'), 'docker backend should NOT be called for cluster feature');
  });

  test('cluster feature is NOT unregistered as a phantom during sweep', async () => {
    register('proj', 'feat', 'main', null, 'up', [], null, null, { cluster: 'cls', namespace: 'fleet' });
    // Docker returns empty list — without the cluster-feature guard this would prune the entry.
    await reconcileSweep();
    assert.ok(getFeature('proj-feat') !== null, 'cluster feature must remain in registry after sweep');
  });

  test('cluster feature pod deleted shows as stopped after two sweeps', async () => {
    // Register as 'up', then simulate pod deletion (cluster status returns 'stopped').
    register('proj', 'gone', 'main', null, 'up', [], null, null, { cluster: 'cls', namespace: 'fleet' });
    _setClusterStatusImpl({ status: async () => 'stopped' });

    // First sweep — pending flip starts (count 1, below threshold of 2).
    await reconcileSweep();
    const afterOne = getFeature('proj-gone');
    // Status may still be 'up' after only one observation (debounce).

    // Second sweep — threshold reached, status commits to 'stopped'.
    await reconcileSweep();
    const afterTwo = getFeature('proj-gone');
    assert.equal(afterTwo.status, 'stopped', 'cluster feature with deleted pod must show stopped after two sweeps');
  });

  test('local feature (no host) is NOT reconciled via cluster backend', async () => {
    // Seed a local feature directly; Docker stub returns empty list so it will
    // be pruned as a phantom — but crucially, cluster backend is never called.
    register('local', 'feat', 'main', null, 'up', [], null, null, null);
    await reconcileSweep();
    assert.ok(!clusterStatusCalls.includes('local-feat'), 'cluster backend must not be called for local feature');
  });
});
