/**
 * Unit tests for backend.stopFeature — cluster and local-Docker teardown paths.
 *
 * Uses Node.js built-in test runner (node:test) — zero external dependencies.
 * All external collaborators (docker, port-forward, oc) are injected via the
 * module's test seams so no real cluster or Docker daemon is needed.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  stopFeature,
  _setDockerImpl,
  _setPortForwardImpl,
  _setStopOcImpl,
} from './backend.js';

// ── helpers ────────────────────────────────────────────────────────────────────

function clusterFeature(key = 'proj-feat', namespace = 'my-ns') {
  return { key, host: { namespace } };
}

function localFeature(key = 'proj-feat') {
  return { key, host: null };
}

// ── local backend ──────────────────────────────────────────────────────────────

describe('stopFeature — local backend', () => {
  afterEach(() => {
    _setDockerImpl(undefined);
    _setPortForwardImpl(undefined);
    _setStopOcImpl(undefined);
  });

  test('calls docker.removeContainer with fleet-<key>', async () => {
    const removed = [];
    _setDockerImpl({ removeContainer: async (name) => { removed.push(name); } });

    await stopFeature(localFeature('proj-feat'));

    assert.deepEqual(removed, ['fleet-proj-feat']);
  });

  test('propagates errors from docker.removeContainer', async () => {
    _setDockerImpl({
      removeContainer: async () => { throw new Error('socket gone'); },
    });

    await assert.rejects(
      () => stopFeature(localFeature('proj-feat')),
      /socket gone/,
    );
  });

  test('does NOT call portForward or oc for local feature', async () => {
    const ocCalls = [];
    _setDockerImpl({ removeContainer: async () => {} });
    _setPortForwardImpl({ unregisterForward: async () => { ocCalls.push('pf'); } });
    _setStopOcImpl({
      deletePod: async () => { ocCalls.push('pod'); },
      deleteService: async () => { ocCalls.push('svc'); },
    });

    await stopFeature(localFeature('proj-feat'));

    assert.deepEqual(ocCalls, [], 'cluster operations must not run for a local feature');
  });
});

// ── cluster backend ────────────────────────────────────────────────────────────

describe('stopFeature — cluster backend', () => {
  afterEach(() => {
    _setDockerImpl(undefined);
    _setPortForwardImpl(undefined);
    _setStopOcImpl(undefined);
  });

  test('unregisters port-forward, deletes pod and service', async () => {
    const pfCalls = [];
    const podDeletes = [];
    const svcDeletes = [];

    _setPortForwardImpl({
      unregisterForward: async (key) => { pfCalls.push(key); },
    });
    _setStopOcImpl({
      deletePod: async (name, ns) => { podDeletes.push({ name, ns }); },
      deleteService: async (name, ns) => { svcDeletes.push({ name, ns }); },
    });

    await stopFeature(clusterFeature('proj-feat', 'my-ns'));

    assert.deepEqual(pfCalls, ['proj-feat'], 'unregisterForward should receive the feature key');
    assert.deepEqual(podDeletes, [{ name: 'fleet-proj-feat', ns: 'my-ns' }]);
    assert.deepEqual(svcDeletes, [{ name: 'fleet-proj-feat', ns: 'my-ns' }]);
  });

  test('unregisters port-forward BEFORE deleting pod', async () => {
    const order = [];

    _setPortForwardImpl({
      unregisterForward: async () => { order.push('pf'); },
    });
    _setStopOcImpl({
      deletePod: async () => { order.push('pod'); },
      deleteService: async () => { order.push('svc'); },
    });

    await stopFeature(clusterFeature());

    assert.equal(order[0], 'pf', 'port-forward must be unregistered first');
  });

  test('does NOT call docker.removeContainer for cluster feature', async () => {
    const dockerCalls = [];
    _setDockerImpl({ removeContainer: async () => { dockerCalls.push(true); } });
    _setPortForwardImpl({ unregisterForward: async () => {} });
    _setStopOcImpl({
      deletePod: async () => {},
      deleteService: async () => {},
    });

    await stopFeature(clusterFeature());

    assert.deepEqual(dockerCalls, [], 'docker path must not be called for cluster feature');
  });

  // ── partial-failure path ─────────────────────────────────────────────────────

  test('partial failure: pod deleted, service delete fails — error propagates, port-forward already stopped', async () => {
    const pfCalls = [];
    const podDeletes = [];

    _setPortForwardImpl({
      unregisterForward: async (key) => { pfCalls.push(key); },
    });
    _setStopOcImpl({
      deletePod: async (name) => { podDeletes.push(name); },
      deleteService: async () => { throw new Error('service delete failed'); },
    });

    await assert.rejects(
      () => stopFeature(clusterFeature('proj-feat', 'my-ns')),
      /service delete failed/,
    );

    // Port-forward was unregistered before the pod/service deletes were attempted —
    // no orphan oc process despite the service delete failure.
    assert.deepEqual(pfCalls, ['proj-feat'], 'port-forward must already be unregistered');
    assert.deepEqual(podDeletes, ['fleet-proj-feat'], 'pod delete ran before service error');
  });

  test('partial failure: pod delete fails — port-forward already stopped, service not attempted', async () => {
    const pfCalls = [];
    const svcCalls = [];

    _setPortForwardImpl({
      unregisterForward: async (key) => { pfCalls.push(key); },
    });
    _setStopOcImpl({
      deletePod: async () => { throw new Error('pod delete failed'); },
      deleteService: async () => { svcCalls.push(true); },
    });

    await assert.rejects(
      () => stopFeature(clusterFeature('proj-feat', 'my-ns')),
      /pod delete failed/,
    );

    assert.deepEqual(pfCalls, ['proj-feat'], 'port-forward unregistered before pod delete attempt');
    assert.deepEqual(svcCalls, [], 'service delete must not run after pod delete failure');
  });
});
