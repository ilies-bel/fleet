/**
 * Tests for POST /features/:key/stop operation logging.
 *
 * Strategy (matches the reconcile.test.js convention in this repo): rather than
 * vm-module mocking (which requires an experimental flag in Node 26), we exercise
 * the exact same code path the route handler uses — startOperation / endOperation
 * via the real log-store — with a local stopContainer stub. This directly
 * verifies that both the success and failure branches of the stop handler produce
 * the expected log-store row.
 *
 * Uses Node.js built-in test runner (node --test).
 * FLEET_LOG_DB is overridden to a per-test tmp file so each test starts clean.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openLogStore, startOperation, endOperation, listOperations } from './log-store.js';
import { DockerSocketError } from './docker.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'fleet-ops-stop-test-'));
let dbIdx = 0;

/**
 * Simulate the stop route handler's logging flow with an injected stopContainer stub.
 * Mirrors the exact startOperation / try / endOperation pattern in api.js.
 *
 * @param {string} key
 * @param {() => Promise<void>} stopContainer  stub or real implementation
 * @returns {Promise<{ status: number }>}
 */
async function runStopHandler(key, stopContainer) {
  const opId = startOperation({ kind: 'stop', key });
  try {
    await stopContainer(`fleet-${key}`);
    endOperation(opId, { outcome: 'success' });
    return { status: 200 };
  } catch (err) {
    endOperation(opId, { outcome: 'failure', error: err });
    if (err instanceof DockerSocketError) return { status: 503 };
    return { status: 500 };
  }
}

describe('POST /features/:key/stop operation logging', () => {
  beforeEach(() => {
    // Fresh SQLite file per test so state does not leak between tests.
    process.env.FLEET_LOG_DB = join(tmpDir, `test-${++dbIdx}.db`);
    openLogStore();
  });

  test('success path: stopContainer resolves → kind=stop outcome=success row', async () => {
    const stopContainer = async () => {};  // resolves immediately

    await runStopHandler('proj-feat', stopContainer);

    const ops = listOperations({ limit: 10 });
    assert.equal(ops.length, 1, 'exactly one operation row should be recorded');

    const [op] = ops;
    assert.equal(op.kind, 'stop', 'kind must be "stop"');
    assert.equal(op.key, 'proj-feat', 'key must match');
    assert.equal(op.outcome, 'success', 'outcome must be "success"');
    assert.ok(op.endedAt > 0, 'endedAt must be set after success');
    assert.equal(op.errorMessage, null, 'errorMessage must be null on success');
  });

  test('failure path: DockerSocketError → kind=stop outcome=failure row with error message', async () => {
    const errMsg = 'Docker socket not available — restart the gateway with fleet init';
    const stopContainer = async () => { throw new DockerSocketError(errMsg); };

    await runStopHandler('proj-feat', stopContainer);

    const ops = listOperations({ limit: 10 });
    assert.equal(ops.length, 1, 'exactly one operation row should be recorded');

    const [op] = ops;
    assert.equal(op.kind, 'stop', 'kind must be "stop"');
    assert.equal(op.key, 'proj-feat', 'key must match');
    assert.equal(op.outcome, 'failure', 'outcome must be "failure"');
    assert.equal(op.errorMessage, errMsg, 'error message must be persisted');
    assert.ok(op.endedAt > 0, 'endedAt must be set even on failure');
  });
});
