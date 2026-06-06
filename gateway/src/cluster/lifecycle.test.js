/**
 * Tests for gateway/src/cluster/lifecycle.js and gateway/src/backend.js.
 *
 * Strategy: inject a stub oc implementation via _setOcImpl so tests exercise
 * the full apply→poll→rsync→sentinel→supervisord sequence without touching a
 * real cluster.  The backend dispatch tests verify that startFeature() routes
 * to the cluster or Docker backend based on feature.host.
 *
 * Polling intervals are 0 throughout so tests complete on the first iteration.
 * Timeout values are generous (5 s) so retry tests have wall-clock headroom;
 * tests that intentionally trigger a timeout use their own inline config.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  startClusterFeature,
  ClusterLifecycleError,
  _setOcImpl,
} from './lifecycle.js';

import {
  startFeature,
  _setDockerImpl,
  _setLifecycleImpl,
} from '../backend.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Polling options used by the happy-path and error-step tests.
 * Intervals are 0 so iterations are immediate; timeouts are generous so that
 * multi-iteration retry tests never race a wall-clock deadline on a loaded CI
 * machine.  Tests that must trigger a timeout pass their own inline config.
 */
const FAST = {
  podPollIntervalMs: 0,
  podPollTimeoutMs: 5_000,
  supervisordPollIntervalMs: 0,
  supervisordPollTimeoutMs: 5_000,
};

/**
 * Build a minimal cluster feature object.
 * @param {object} [overrides]
 */
function makeFeature(overrides = {}) {
  return {
    key: 'proj-feat',
    host: { cluster: 'ocp-test', namespace: 'test-ns' },
    services: [{ name: 'frontend', port: 3000 }],
    svcAbsPaths: ['/worktrees/proj-feat/frontend'],
    ...overrides,
  };
}

/**
 * Build a stub oc object.  All operations resolve successfully unless
 * overridden by the caller.
 * @param {object} [overrides]
 */
function makeOc(overrides = {}) {
  return {
    apply: async () => 'configured',
    getPodStatus: async () => 'Running',
    rsync: async () => {},
    exec: async () => '',
    ...overrides,
  };
}

// ── happy path ────────────────────────────────────────────────────────────────

describe('startClusterFeature — happy path', () => {
  afterEach(() => _setOcImpl(undefined));

  test('resolves when all oc steps succeed', async () => {
    _setOcImpl(makeOc());
    await assert.doesNotReject(startClusterFeature(makeFeature(), FAST));
  });

  test('applies pod manifest then service manifest (two apply calls)', async () => {
    const applied = [];
    _setOcImpl(makeOc({ apply: async (body) => { applied.push(body); } }));
    await startClusterFeature(makeFeature(), FAST);
    assert.equal(applied.length, 2, 'apply called twice');
    const first = JSON.parse(applied[0]);
    const second = JSON.parse(applied[1]);
    assert.equal(first.kind, 'Pod', 'first apply is the pod manifest');
    assert.equal(second.kind, 'Service', 'second apply is the service manifest');
  });

  test('pod manifest carries fleet-feature label matching feature key', async () => {
    const applied = [];
    _setOcImpl(makeOc({ apply: async (body) => { applied.push(body); } }));
    await startClusterFeature(makeFeature(), FAST);
    const pod = JSON.parse(applied[0]);
    assert.equal(pod.metadata.labels['fleet-feature'], 'proj-feat');
  });

  test('polls getPodStatus until Running — passes pod name and namespace', async () => {
    const calls = [];
    _setOcImpl(makeOc({
      getPodStatus: async (name, ns) => {
        calls.push({ name, ns });
        return 'Running';
      },
    }));
    await startClusterFeature(makeFeature(), FAST);
    assert.ok(calls.length >= 1, 'getPodStatus called at least once');
    assert.equal(calls[0].name, 'fleet-proj-feat');
    assert.equal(calls[0].ns, 'test-ns');
  });

  test('one rsync call per service with correct src, pod:path, and namespace', async () => {
    const syncs = [];
    _setOcImpl(makeOc({
      rsync: async (src, pod, dest, ns) => { syncs.push({ src, pod, dest, ns }); },
    }));
    await startClusterFeature(makeFeature(), FAST);
    assert.equal(syncs.length, 1);
    assert.equal(syncs[0].src, '/worktrees/proj-feat/frontend');
    assert.equal(syncs[0].pod, 'fleet-proj-feat');
    assert.equal(syncs[0].dest, '/app/frontend');
    assert.equal(syncs[0].ns, 'test-ns');
  });

  test('rsyncs multiple services — one call per service in order', async () => {
    const syncs = [];
    const feature = makeFeature({
      services: [{ name: 'frontend', port: 3000 }, { name: 'backend', port: 8080 }],
      svcAbsPaths: ['/wt/frontend', '/wt/backend'],
    });
    _setOcImpl(makeOc({
      rsync: async (src, _pod, dest) => { syncs.push({ src, dest }); },
    }));
    await startClusterFeature(feature, FAST);
    assert.equal(syncs.length, 2);
    assert.equal(syncs[0].src, '/wt/frontend');
    assert.equal(syncs[0].dest, '/app/frontend');
    assert.equal(syncs[1].src, '/wt/backend');
    assert.equal(syncs[1].dest, '/app/backend');
  });

  test('touches /app/.fleet-ready sentinel via exec', async () => {
    const execCalls = [];
    _setOcImpl(makeOc({
      exec: async (pod, ns, argv) => { execCalls.push({ pod, ns, argv }); return ''; },
    }));
    await startClusterFeature(makeFeature(), FAST);
    const sentinelCall = execCalls.find(
      (c) => c.argv[0] === 'touch' && c.argv[1] === '/app/.fleet-ready',
    );
    assert.ok(sentinelCall, 'sentinel touch not found in exec calls');
    assert.equal(sentinelCall.pod, 'fleet-proj-feat');
    assert.equal(sentinelCall.ns, 'test-ns');
  });

  test('waits for supervisord to serve traffic after sentinel', async () => {
    const execCalls = [];
    _setOcImpl(makeOc({
      exec: async (_pod, _ns, argv) => {
        execCalls.push(argv[0]);
        return '';
      },
    }));
    await startClusterFeature(makeFeature(), FAST);
    assert.ok(
      execCalls.includes('supervisorctl'),
      'supervisorctl status polled after sentinel touch',
    );
    // supervisorctl check must come after the sentinel touch
    const touchIdx = execCalls.indexOf('touch');
    const supervisorIdx = execCalls.indexOf('supervisorctl');
    assert.ok(touchIdx < supervisorIdx, 'touch sentinel must precede supervisorctl poll');
  });

  test('resolves for a feature with no services (empty rsync loop)', async () => {
    const syncs = [];
    _setOcImpl(makeOc({ rsync: async () => { syncs.push(true); } }));
    await startClusterFeature(makeFeature({ services: [], svcAbsPaths: [] }), FAST);
    assert.equal(syncs.length, 0, 'no rsync calls for feature with no services');
  });
});

// ── failure steps ─────────────────────────────────────────────────────────────

describe('startClusterFeature — failures reject with ClusterLifecycleError', () => {
  afterEach(() => _setOcImpl(undefined));

  test('apply-pod failure rejects with step "apply-pod"', async () => {
    _setOcImpl(makeOc({ apply: async () => { throw new Error('server error'); } }));
    await assert.rejects(
      startClusterFeature(makeFeature(), FAST),
      (err) => {
        assert.ok(err instanceof ClusterLifecycleError);
        assert.equal(err.step, 'apply-pod');
        assert.match(err.message, /apply-pod/);
        return true;
      },
    );
  });

  test('apply-service failure rejects with step "apply-service"', async () => {
    let applyCount = 0;
    _setOcImpl(makeOc({
      apply: async () => {
        applyCount++;
        if (applyCount === 2) throw new Error('service apply failed');
      },
    }));
    await assert.rejects(
      startClusterFeature(makeFeature(), FAST),
      (err) => {
        assert.ok(err instanceof ClusterLifecycleError);
        assert.equal(err.step, 'apply-service');
        return true;
      },
    );
  });

  test('wait-running timeout rejects with step "wait-running"', async () => {
    // getPodStatus always returns Pending — timeout triggers failure.
    // Use a tight podPollTimeoutMs so the test finishes quickly.
    _setOcImpl(makeOc({ getPodStatus: async () => 'Pending' }));
    await assert.rejects(
      startClusterFeature(makeFeature(), { ...FAST, podPollTimeoutMs: 100 }),
      (err) => {
        assert.ok(err instanceof ClusterLifecycleError);
        assert.equal(err.step, 'wait-running');
        return true;
      },
    );
  });

  test('rsync failure rejects with step "rsync-<svcname>"', async () => {
    _setOcImpl(makeOc({ rsync: async () => { throw new Error('rsync denied'); } }));
    await assert.rejects(
      startClusterFeature(makeFeature(), FAST),
      (err) => {
        assert.ok(err instanceof ClusterLifecycleError);
        assert.equal(err.step, 'rsync-frontend');
        return true;
      },
    );
  });

  test('rsync failure step name includes the failing service name', async () => {
    const feature = makeFeature({
      services: [{ name: 'frontend', port: 3000 }, { name: 'backend', port: 8080 }],
      svcAbsPaths: ['/wt/frontend', '/wt/backend'],
    });
    let callCount = 0;
    _setOcImpl(makeOc({
      rsync: async () => {
        callCount++;
        if (callCount === 2) throw new Error('backend rsync failed');
      },
    }));
    await assert.rejects(
      startClusterFeature(feature, FAST),
      (err) => {
        assert.ok(err instanceof ClusterLifecycleError);
        assert.equal(err.step, 'rsync-backend');
        return true;
      },
    );
  });

  test('touch-sentinel failure rejects with step "touch-sentinel"', async () => {
    // exec for touch throws; exec for supervisorctl is never reached
    _setOcImpl(makeOc({
      exec: async (_pod, _ns, argv) => {
        if (argv[0] === 'touch') throw new Error('exec permission denied');
        return '';
      },
    }));
    await assert.rejects(
      startClusterFeature(makeFeature(), FAST),
      (err) => {
        assert.ok(err instanceof ClusterLifecycleError);
        assert.equal(err.step, 'touch-sentinel');
        return true;
      },
    );
  });

  test('wait-supervisord timeout rejects with step "wait-supervisord"', async () => {
    // supervisorctl status always fails — timeout triggers failure.
    // Use a tight supervisordPollTimeoutMs so the test finishes quickly;
    // podPollTimeoutMs is left generous so the pod reaches Running first.
    _setOcImpl(makeOc({
      exec: async (_pod, _ns, argv) => {
        if (argv[0] === 'supervisorctl') throw new Error('supervisord not running');
        return '';
      },
    }));
    await assert.rejects(
      startClusterFeature(makeFeature(), { ...FAST, supervisordPollTimeoutMs: 100 }),
      (err) => {
        assert.ok(err instanceof ClusterLifecycleError);
        assert.equal(err.step, 'wait-supervisord');
        return true;
      },
    );
  });

  test('ClusterLifecycleError preserves the original cause', async () => {
    const cause = new Error('oc: forbidden');
    _setOcImpl(makeOc({ apply: async () => { throw cause; } }));
    await assert.rejects(
      startClusterFeature(makeFeature(), FAST),
      (err) => {
        assert.ok(err instanceof ClusterLifecycleError);
        assert.equal(err.cause, cause);
        return true;
      },
    );
  });
});

// ── wait-running: transient errors are retried ────────────────────────────────

describe('startClusterFeature — getPodStatus transient errors are retried', () => {
  afterEach(() => _setOcImpl(undefined));

  test('getPodStatus errors are treated as transient and retried until Running', async () => {
    let calls = 0;
    _setOcImpl(makeOc({
      getPodStatus: async () => {
        calls++;
        if (calls < 3) throw new Error('pod not found yet');
        return 'Running';
      },
    }));
    await assert.doesNotReject(startClusterFeature(makeFeature(), FAST));
    assert.ok(calls >= 3, 'getPodStatus retried after transient errors');
  });
});

// ── backend dispatch ──────────────────────────────────────────────────────────

describe('backend.startFeature — dispatches on feature.host', () => {
  afterEach(() => {
    _setOcImpl(undefined);
    _setDockerImpl(undefined);
    _setLifecycleImpl(undefined);
  });

  test('cluster feature (host set) routes through startClusterFeature', async () => {
    const clusterCalls = [];
    _setLifecycleImpl({
      startClusterFeature: async (feature) => { clusterCalls.push(feature.key); },
    });
    const feature = { key: 'proj-feat', host: { cluster: 'cls', namespace: 'ns' } };
    await startFeature(feature);
    assert.ok(clusterCalls.includes('proj-feat'), 'startClusterFeature should be called for cluster feature');
  });

  test('local feature (no host) routes through docker.startContainer', async () => {
    const dockerCalls = [];
    _setDockerImpl({ startContainer: async (name) => { dockerCalls.push(name); } });
    const feature = { key: 'proj-feat', host: null };
    await startFeature(feature);
    assert.ok(dockerCalls.includes('fleet-proj-feat'), 'startContainer should be called for local feature');
  });

  test('local feature with undefined host also routes to docker', async () => {
    const dockerCalls = [];
    _setDockerImpl({ startContainer: async (name) => { dockerCalls.push(name); } });
    const feature = { key: 'local-feat' }; // host field absent
    await startFeature(feature);
    assert.ok(dockerCalls.includes('fleet-local-feat'));
  });

  test('cluster feature does NOT call docker.startContainer', async () => {
    const dockerCalls = [];
    _setDockerImpl({ startContainer: async (name) => { dockerCalls.push(name); } });
    _setLifecycleImpl({ startClusterFeature: async () => {} });
    await startFeature({ key: 'proj-feat', host: { cluster: 'cls', namespace: 'ns' } });
    assert.equal(dockerCalls.length, 0, 'docker path must not be called for cluster feature');
  });

  test('local feature does NOT call startClusterFeature', async () => {
    const clusterCalls = [];
    _setLifecycleImpl({ startClusterFeature: async () => { clusterCalls.push(true); } });
    _setDockerImpl({ startContainer: async () => {} });
    await startFeature({ key: 'local-feat', host: null });
    assert.equal(clusterCalls.length, 0, 'cluster path must not be called for local feature');
  });
});
