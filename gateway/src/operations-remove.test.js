/**
 * Tests for DELETE /features/:key operation logging.
 *
 * Verifies observable behaviour: every remove operation is recorded in the
 * log store with kind='remove', correct outcome, and error message when
 * applicable — and the row survives even after the registry entry is gone.
 *
 * Uses Node.js built-in test runner (node:test).
 * FLEET_LOG_DB is overridden to a per-test tmp file so each test starts clean.
 * Docker is injected via backend's _setDockerImpl test seam so no real daemon
 * is required.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import express from 'express';

import { openLogStore, listOperations } from './log-store.js';
import apiRouter from './api.js';
import { register, getFeature, getAll, unregister } from './registry.js';
import { _setDockerImpl } from './backend.js';
import { DockerSocketError } from './docker.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'fleet-remove-test-'));
let dbIdx = 0;

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/_fleet/api', apiRouter);
  return app;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

/**
 * @param {http.Server} server
 * @param {{ method: string, path: string, body?: object }} opts
 * @returns {Promise<{ status: number, body: any }>}
 */
function request(server, { method, path, body }) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const payload = body ? JSON.stringify(body) : undefined;
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('DELETE /features/:key — operation logging', () => {
  let server;

  beforeEach((t, done) => {
    // Fresh SQLite file per test so log state does not leak between tests.
    process.env.FLEET_LOG_DB = join(tmpDir, `test-${++dbIdx}.db`);
    openLogStore();

    // Reset registry so features from previous tests do not bleed in.
    for (const f of getAll()) {
      unregister(f.key);
    }

    // Default: Docker remove succeeds (no-op) — individual tests override as needed.
    _setDockerImpl({ removeContainer: async () => {} });

    server = buildApp().listen(0, '127.0.0.1', done);
  });

  afterEach((t, done) => {
    _setDockerImpl(undefined); // restore real Docker module
    server.close(done);
  });

  // ── Success path ──────────────────────────────────────────────────────────

  test('success: logs kind=remove / outcome=success and row survives after unregister', async () => {
    register('proj', 'feat', 'main');

    const res = await request(server, {
      method: 'DELETE',
      path: '/_fleet/api/features/proj-feat',
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    // Feature is gone from registry
    assert.equal(getFeature('proj-feat'), null, 'feature should be unregistered after DELETE');

    // Log row persists even though the registry entry is gone
    const ops = listOperations({ limit: 10 });
    assert.equal(ops.length, 1, 'exactly one operation should be logged');

    const [op] = ops;
    assert.equal(op.kind, 'remove');
    assert.equal(op.key, 'proj-feat');
    assert.equal(op.outcome, 'success');
    assert.equal(op.errorMessage, null);
    assert.ok(op.startedAt > 0, 'startedAt should be a positive timestamp');
    assert.ok(op.endedAt > 0, 'endedAt should be set after operation completes');
  });

  // ── Docker-failure path ───────────────────────────────────────────────────

  test('Docker socket failure: logs outcome=failure with error message and returns 503', async () => {
    register('proj', 'feat', 'main');

    _setDockerImpl({
      removeContainer: async () => {
        throw new DockerSocketError('socket timeout');
      },
    });

    const res = await request(server, {
      method: 'DELETE',
      path: '/_fleet/api/features/proj-feat',
    });

    assert.equal(res.status, 503);
    assert.ok(res.body.error, 'error field should be present in response');

    // Log row is persisted with failure even though the operation was rejected
    const ops = listOperations({ limit: 10 });
    assert.equal(ops.length, 1, 'exactly one operation should be logged');

    const [op] = ops;
    assert.equal(op.kind, 'remove');
    assert.equal(op.key, 'proj-feat');
    assert.equal(op.outcome, 'failure');
    assert.equal(op.errorMessage, 'socket timeout');
    assert.ok(op.endedAt > 0, 'endedAt should be set even on failure');
  });
});
