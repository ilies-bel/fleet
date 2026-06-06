/**
 * Tests for log-store.js.
 *
 * Verifies observable behaviour: round-trip insert, outcome recording,
 * error message persistence, DESC ordering, retention pruning,
 * prune rate-limiting, reason_code persistence, and integration with
 * DockerSocketError / tagError.
 *
 * Uses Node.js built-in test runner (node:test).
 * FLEET_LOG_DB is overridden to a per-test tmp file so each test starts clean.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openLogStore,
  startOperation,
  endOperation,
  listOperations,
  listFailureClusters,
  appendEvent,
  getOperation,
  __resetPruneClock,
  __pruneCount,
  __getDb,
} from './log-store.js';
import { DockerSocketError } from './docker.js';
import { tagError } from './failure-reasons.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'fleet-log-test-'));
let dbIdx = 0;

describe('log-store', () => {
  beforeEach(() => {
    // Clear retention override so each test starts with the default (30 days).
    delete process.env.FLEET_LOG_RETENTION_DAYS;
    // Fresh SQLite file per test so state does not leak between tests.
    process.env.FLEET_LOG_DB = join(tmpDir, `test-${++dbIdx}.db`);
    openLogStore();
    // Reset prune rate-limit clock and counter.
    __resetPruneClock();
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
    assert.equal(op.reasonCode, null, 'reasonCode should be null before endOperation');
  });

  test('endOperation with success sets endedAt, outcome=success, errorMessage=null, reasonCode=null', () => {
    const id = startOperation({ kind: 'activate', key: 'proj-feat' });
    endOperation(id, { outcome: 'success' });

    const [op] = listOperations({ limit: 10 });
    assert.equal(op.outcome, 'success');
    assert.ok(op.endedAt > 0, 'endedAt should be a positive timestamp after endOperation');
    assert.equal(op.errorMessage, null);
    assert.equal(op.reasonCode, null);
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

  test('retention: startOperation prunes operations older than FLEET_LOG_RETENTION_DAYS', () => {
    // 0.0001 days ≈ 8.64 seconds — gives a very short cutoff window for testing.
    process.env.FLEET_LOG_RETENTION_DAYS = '0.0001';
    process.env.FLEET_LOG_DB = join(tmpDir, `test-${++dbIdx}.db`);
    openLogStore();
    __resetPruneClock();

    const cutoffMs = 0.0001 * 86_400_000; // ~8640 ms
    const pastCutoff = Date.now() - cutoffMs - 5_000; // clearly before cutoff

    // Insert two backdated rows directly so we control started_at.
    const rawDb = __getDb();
    const old1 = Number(
      rawDb
        .prepare('INSERT INTO operations (kind, key, started_at) VALUES (?, ?, ?)')
        .run('prune-test', 'old-1', pastCutoff).lastInsertRowid,
    );
    const old2 = Number(
      rawDb
        .prepare('INSERT INTO operations (kind, key, started_at) VALUES (?, ?, ?)')
        .run('prune-test', 'old-2', pastCutoff).lastInsertRowid,
    );

    // Insert a fresh row (started_at = now, well within retention window).
    const freshId = Number(
      rawDb
        .prepare('INSERT INTO operations (kind, key, started_at) VALUES (?, ?, ?)')
        .run('prune-test', 'fresh', Date.now()).lastInsertRowid,
    );

    // Trigger pruning via startOperation.
    startOperation({ kind: 'prune-test', key: 'trigger' });

    const remaining = listOperations({ limit: 100 });
    const remainingIds = remaining.map(op => op.id);

    assert.ok(!remainingIds.includes(old1), 'backdated row 1 should be pruned');
    assert.ok(!remainingIds.includes(old2), 'backdated row 2 should be pruned');
    assert.ok(remainingIds.includes(freshId), 'fresh row should survive pruning');
  });

  test('rate limit: prune runs at most once per 60 s across consecutive startOperation calls', () => {
    // beforeEach reset the clock, so the first call will trigger a prune.
    startOperation({ kind: 'rate-test', key: 'call-1' }); // prune runs
    startOperation({ kind: 'rate-test', key: 'call-2' }); // within 60 s — prune skipped

    assert.equal(__pruneCount, 1, 'prune should fire exactly once for two back-to-back calls');
  });

  test('DockerSocketError from stubbed activate flow writes reason_code=docker:socket-unavailable', () => {
    // Simulates the activate route catching a DockerSocketError and forwarding it to endOperation.
    // DockerSocketError constructor sets reasonCode automatically.
    const id = startOperation({ kind: 'activate', key: 'proj-feat' });
    const err = new DockerSocketError('Docker socket unavailable');
    endOperation(id, { outcome: 'failure', error: err });

    const [op] = listOperations({ limit: 1 });
    assert.equal(op.reasonCode, 'docker:socket-unavailable');
  });

  test('tagError(err, build:failed) flows through to the row', () => {
    // Simulates a rebuild catch tagging an error with build:failed before endOperation.
    const id = startOperation({ kind: 'rebuild', key: 'proj-feat' });
    const err = new Error('mvn exited with code 1');
    tagError(err, 'build:failed');
    endOperation(id, { outcome: 'failure', error: err });

    const [op] = listOperations({ limit: 1 });
    assert.equal(op.reasonCode, 'build:failed');
  });

  test('listFailureClusters collapses 3 failed build rows with same reason_code to count=3', () => {
    const err = new Error('docker socket gone');
    err.reasonCode = 'docker:socket-unavailable';

    const id1 = startOperation({ kind: 'build', key: 'proj-a' });
    endOperation(id1, { outcome: 'failure', error: err });
    const id2 = startOperation({ kind: 'build', key: 'proj-b' });
    endOperation(id2, { outcome: 'failure', error: err });
    const id3 = startOperation({ kind: 'build', key: 'proj-c' });
    endOperation(id3, { outcome: 'failure', error: err });

    const clusters = listFailureClusters({ sinceMs: Date.now() - 60_000 });

    assert.equal(clusters.length, 1, 'should collapse to one cluster');
    assert.equal(clusters[0].reasonCode, 'docker:socket-unavailable');
    assert.equal(clusters[0].count, 3, 'count should be 3');
    assert.ok(Array.isArray(clusters[0].sampleKeys), 'sampleKeys should be an array');
    assert.ok(clusters[0].sampleKeys.length > 0, 'sampleKeys should contain instance keys');
    assert.ok(clusters[0].lastSeenAt > 0, 'lastSeenAt should be a positive timestamp');
  });

  test('listFailureClusters excludes operations outside the time window', () => {
    const err = new Error('old failure');
    err.reasonCode = 'build:failed';

    // Insert a failure that ended outside the window (old)
    const rawDb = __getDb();
    const oldEndedAt = Date.now() - 48 * 60 * 60 * 1000; // 48h ago
    const oldId = Number(
      rawDb
        .prepare('INSERT INTO operations (kind, key, started_at, ended_at, outcome, reason_code) VALUES (?, ?, ?, ?, ?, ?)')
        .run('build', 'old-proj', oldEndedAt - 1000, oldEndedAt, 'failure', 'build:failed').lastInsertRowid,
    );

    // Insert a fresh failure within the window
    const freshId = startOperation({ kind: 'build', key: 'fresh-proj' });
    const freshErr = new Error('fresh failure');
    freshErr.reasonCode = 'build:failed';
    endOperation(freshId, { outcome: 'failure', error: freshErr });

    // Default 24h window — should exclude the 48h-old row
    const clusters = listFailureClusters({ sinceMs: Date.now() - 24 * 60 * 60 * 1000 });
    assert.equal(clusters.length, 1, 'only fresh cluster should appear');
    assert.equal(clusters[0].count, 1, 'only the fresh failure counts');

    void oldId; // prevent unused variable lint
  });

  test('listFailureClusters returns empty array when no failures exist', () => {
    startOperation({ kind: 'activate', key: 'proj-ok' });
    // No endOperation call — still in-flight, should be excluded

    const clusters = listFailureClusters({ sinceMs: Date.now() - 60_000 });
    assert.equal(clusters.length, 0);
  });

  test('getOperation returns null for unknown id', () => {
    const op = getOperation(999999);
    assert.equal(op, null);
  });

  test('getOperation returns the operation (including reasonCode) plus its events', () => {
    const id = startOperation({ kind: 'activate', key: 'proj-feat' });
    const err = new DockerSocketError('socket gone');
    endOperation(id, { outcome: 'failure', error: err });

    const result = getOperation(id);
    assert.ok(result !== null, 'getOperation should return the row');
    assert.equal(result.operation.id, id);
    assert.equal(result.operation.kind, 'activate');
    assert.equal(result.operation.reasonCode, 'docker:socket-unavailable');
    assert.ok(Array.isArray(result.events), 'events should be an array');
  });

  test('appendEvent + getOperation round-trip: events are retrievable ordered by ts ASC', () => {
    const id = startOperation({ kind: 'sync', key: 'proj-feat' });
    appendEvent(id, { message: 'sync started' });
    appendEvent(id, { message: 'running build', level: 'info' });
    appendEvent(id, { message: 'sync complete' });
    endOperation(id, { outcome: 'success' });

    const result = getOperation(id);

    assert.ok(result !== null, 'getOperation should return a result');
    assert.equal(result.operation.id, id);
    assert.equal(result.operation.kind, 'sync');
    assert.equal(result.operation.key, 'proj-feat');
    assert.equal(result.operation.outcome, 'success');

    assert.equal(result.events.length, 3, 'three events should be stored');

    const [first, second, third] = result.events;
    assert.equal(first.message, 'sync started');
    assert.equal(second.message, 'running build');
    assert.equal(third.message, 'sync complete');

    // Ordered by ts ASC — each event's ts should be >= the previous
    assert.ok(first.ts <= second.ts, 'events should be in ASC timestamp order');
    assert.ok(second.ts <= third.ts, 'events should be in ASC timestamp order');

    // level defaults to 'info' when not specified
    assert.equal(first.level, 'info');
    assert.equal(second.level, 'info');
  });

  test('getOperation returns empty events array for an operation with no events', () => {
    const id = startOperation({ kind: 'activate', key: 'proj-x' });
    const result = getOperation(id);

    assert.ok(result !== null);
    assert.equal(result.events.length, 0, 'no events appended — events array should be empty');
  });

  test('appendEvent supports custom level values', () => {
    const id = startOperation({ kind: 'activate', key: 'proj-y' });
    appendEvent(id, { message: 'warning message', level: 'warn' });

    const result = getOperation(id);
    assert.equal(result.events[0].level, 'warn');
    assert.equal(result.events[0].message, 'warning message');
  });
});
