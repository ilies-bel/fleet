/**
 * Tests for log-store.js.
 *
 * Verifies observable behaviour: round-trip insert, outcome recording,
 * error message persistence, and DESC ordering.
 *
 * Uses Node.js built-in test runner (node:test).
 * FLEET_LOG_DB is overridden to a per-test tmp file so each test starts clean.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openLogStore, startOperation, endOperation, listOperations } from './log-store.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'fleet-log-test-'));
let dbIdx = 0;

describe('log-store', () => {
  beforeEach(() => {
    // Fresh SQLite file per test so state does not leak between tests.
    process.env.FLEET_LOG_DB = join(tmpDir, `test-${++dbIdx}.db`);
    openLogStore();
  });

  test('round-trip: startOperation inserts a row retrievable by listOperations', () => {
    const id = startOperation({ kind: 'activate', key: 'proj-feat' });

    assert.ok(typeof id === 'number', 'startOperation should return a numeric id');
    assert.ok(id > 0, 'id should be a positive integer');

    const ops = listOperations({ limit: 10 });
    assert.equal(ops.length, 1, 'exactly one row should be in the store');

    const [op] = ops;
    assert.equal(op.kind, 'activate');
    assert.equal(op.key, 'proj-feat');
    assert.ok(op.startedAt > 0, 'startedAt should be a positive timestamp');
    assert.equal(op.endedAt, null, 'endedAt should be null before endOperation');
    assert.equal(op.outcome, null, 'outcome should be null before endOperation');
    assert.equal(op.errorMessage, null, 'errorMessage should be null before endOperation');
  });

  test('endOperation with success sets endedAt, outcome=success, errorMessage=null', () => {
    const id = startOperation({ kind: 'activate', key: 'proj-feat' });
    endOperation(id, { outcome: 'success' });

    const [op] = listOperations({ limit: 10 });
    assert.equal(op.outcome, 'success');
    assert.ok(op.endedAt > 0, 'endedAt should be a positive timestamp after endOperation');
    assert.equal(op.errorMessage, null);
  });

  test('endOperation with failure records error.message', () => {
    const id = startOperation({ kind: 'activate', key: 'proj-feat' });
    endOperation(id, { outcome: 'failure', error: new Error('boom') });

    const [op] = listOperations({ limit: 10 });
    assert.equal(op.outcome, 'failure');
    assert.equal(op.errorMessage, 'boom');
    assert.ok(op.endedAt > 0);
  });

  test('listOperations returns rows ordered by startedAt DESC', () => {
    startOperation({ kind: 'activate', key: 'proj-a' });
    startOperation({ kind: 'activate', key: 'proj-b' });

    const ops = listOperations({ limit: 10 });
    assert.equal(ops.length, 2);
    // Second insert's id should be higher (later) → it comes first in DESC order.
    assert.ok(
      ops[0].id > ops[1].id,
      'most recent row (higher id) should be first in DESC result',
    );
  });

  test('listOperations respects the limit parameter', () => {
    startOperation({ kind: 'activate', key: 'proj-a' });
    startOperation({ kind: 'activate', key: 'proj-b' });
    startOperation({ kind: 'activate', key: 'proj-c' });

    const ops = listOperations({ limit: 2 });
    assert.equal(ops.length, 2, 'limit=2 should return exactly 2 rows');
  });
});
