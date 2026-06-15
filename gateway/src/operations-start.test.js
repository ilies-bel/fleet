/**
 * Tests for POST /features/:key/start operation logging and immediate status update.
 *
 * Strategy: mirrors operations-stop.test.js — we simulate the exact logic of the
 * route handler (startOperation / startContainer / updateStatus / endOperation)
 * without spinning up an HTTP server, using the real log-store and real registry.
 *
 * This verifies two behaviours:
 *  1. On success, the registry status flips to 'starting' immediately (the core bug fix).
 *  2. An operation row with kind='start' and the correct outcome is persisted.
 *
 * Uses Node.js built-in test runner (node --test).
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openLogStore, startOperation, endOperation, listOperations } from './log-store.js';
import { register, unregister, getAll, updateStatus, getFeature } from './registry.js';
import { DockerSocketError } from './docker.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'fleet-ops-start-test-'));
let dbIdx = 0;

function clearRegistry() {
  for (const f of getAll()) unregister(f.key);
}

/**
 * Simulate the start route handler's logic with an injected startContainer stub.
 * Mirrors the pattern in api.js after the fix:
 *   startOperation → startContainer → updateStatus('starting') → endOperation(success)
 *   or: endOperation(failure) on error.
 *
 * @param {string} key
 * @param {() => Promise<void>} startContainer  stub
 * @returns {Promise<{ status: number }>}
 */
async function runStartHandler(key, startContainer) {
  const opId = startOperation({ kind: 'start', key });
  try {
    await startContainer(`fleet-${key}`);
    updateStatus(key, 'starting');
    endOperation(opId, { outcome: 'success' });
    return { status: 200 };
  } catch (err) {
    endOperation(opId, { outcome: 'failure', error: err });
    if (err instanceof DockerSocketError) return { status: 503 };
    return { status: 500 };
  }
}

describe('POST /features/:key/start — status update and operation logging', () => {
  beforeEach(() => {
    // Fresh SQLite file per test so state does not leak between tests.
    process.env.FLEET_LOG_DB = join(tmpDir, `test-${++dbIdx}.db`);
    openLogStore();
    clearRegistry();
  });

  test('success path: status flips to "starting" in registry immediately', async () => {
    register('proj', 'feat', 'main', null, 'stopped');
    const key = 'proj-feat';
    assert.equal(getFeature(key)?.status, 'stopped', 'precondition: feature is stopped');

    await runStartHandler(key, async () => {});

    assert.equal(getFeature(key)?.status, 'starting',
      'registry status must be "starting" right after startContainer resolves');
  });

  test('success path: kind=start outcome=success operation row recorded', async () => {
    register('proj', 'feat', 'main', null, 'stopped');
    const key = 'proj-feat';

    await runStartHandler(key, async () => {});

    const ops = listOperations({ limit: 10 });
    assert.equal(ops.length, 1, 'exactly one operation row should be recorded');

    const [op] = ops;
    assert.equal(op.kind, 'start', 'kind must be "start"');
    assert.equal(op.key, key, 'key must match');
    assert.equal(op.outcome, 'success', 'outcome must be "success"');
    assert.ok(op.endedAt > 0, 'endedAt must be set after success');
    assert.equal(op.errorMessage, null, 'errorMessage must be null on success');
  });

  test('failure path: DockerSocketError → kind=start outcome=failure, status NOT changed', async () => {
    register('proj', 'feat', 'main', null, 'stopped');
    const key = 'proj-feat';
    const errMsg = 'Docker socket not available — restart the gateway with fleet init';
    const result = await runStartHandler(key, async () => { throw new DockerSocketError(errMsg); });

    assert.equal(result.status, 503);

    // Status must remain 'stopped' — we must not flip it when the container fails to start.
    assert.equal(getFeature(key)?.status, 'stopped',
      'registry status must stay "stopped" when startContainer throws');

    const ops = listOperations({ limit: 10 });
    assert.equal(ops.length, 1, 'exactly one operation row should be recorded');
    const [op] = ops;
    assert.equal(op.kind, 'start', 'kind must be "start"');
    assert.equal(op.outcome, 'failure', 'outcome must be "failure"');
    assert.equal(op.errorMessage, errMsg, 'error message must be persisted');
    assert.ok(op.endedAt > 0, 'endedAt must be set even on failure');
  });
});
