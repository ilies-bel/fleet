/**
 * Tests that POST /features/:key/sync records a kind='sync' operation row
 * in the log store with the correct outcome on both the happy path and on error.
 *
 * Strategy:
 *   - Real registry (seeded via register(), cleaned up after each test).
 *   - Real log store pointing at a per-test tmp SQLite file.
 *   - runSync replaced via the _setRunSync test seam so no Docker socket is needed.
 *   - Real Express HTTP server on an ephemeral port; requests made with fetch().
 *
 * Uses Node.js built-in test runner (node:test).
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import express from 'express';

import { openLogStore, listOperations } from './log-store.js';
import { register, unregister, getAll } from './registry.js';
import router, { _setRunSync } from './api.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'fleet-sync-ops-test-'));
let dbIdx = 0;

function clearRegistry() {
  for (const f of getAll()) unregister(f.key);
}

describe('POST /features/:key/sync — operation logging', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/_fleet/api', router);

    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}/_fleet/api`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    // Fresh SQLite file per test so rows do not bleed between tests.
    process.env.FLEET_LOG_DB = join(tmpDir, `test-${++dbIdx}.db`);
    openLogStore();
    clearRegistry();
    // Seed the feature the route handler looks up via getFeature().
    register('proj', 'feat', 'main');
    // Default stub: resolves immediately (overridden per test as needed).
    _setRunSync(async () => {});
  });

  afterEach(() => {
    clearRegistry();
    // Restore to a safe no-op so leftover route calls cannot reach real Docker.
    _setRunSync(async () => {});
  });

  test('happy path: kind=sync row is written with outcome=success', async () => {
    // Controlled deferred so we decide exactly when sync completes.
    let resolveSync;
    _setRunSync(() => new Promise((resolve) => { resolveSync = resolve; }));

    const res = await fetch(`${baseUrl}/features/proj-feat/sync`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    // The 200 was sent before runSync settled; resolve it now.
    resolveSync();
    // Yield to the event loop so the .then(endOperation) microtask drains.
    await new Promise((resolve) => setImmediate(resolve));

    const ops = listOperations({ limit: 10 });
    assert.equal(ops.length, 1, 'exactly one operation row should be written');
    const [op] = ops;
    assert.equal(op.kind, 'sync');
    assert.equal(op.key, 'proj-feat');
    assert.equal(op.outcome, 'success');
    assert.ok(op.startedAt > 0, 'startedAt should be a positive timestamp');
    assert.ok(op.endedAt > 0, 'endedAt should be set after success');
    assert.equal(op.errorMessage, null);
  });

  test('failure path: kind=sync row is written with outcome=failure on thrown error', async () => {
    let rejectSync;
    _setRunSync(() => new Promise((_, reject) => { rejectSync = reject; }));

    const res = await fetch(`${baseUrl}/features/proj-feat/sync`, { method: 'POST' });
    assert.equal(res.status, 200);

    // Simulate an rsync / container-missing failure.
    rejectSync(new Error('rsync exit code 1'));
    await new Promise((resolve) => setImmediate(resolve));

    const ops = listOperations({ limit: 10 });
    assert.equal(ops.length, 1, 'exactly one operation row should be written');
    const [op] = ops;
    assert.equal(op.kind, 'sync');
    assert.equal(op.key, 'proj-feat');
    assert.equal(op.outcome, 'failure');
    assert.equal(op.errorMessage, 'rsync exit code 1');
    assert.ok(op.endedAt > 0, 'endedAt should be set even on failure');
  });
});
