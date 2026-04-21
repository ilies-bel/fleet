/**
 * Integration test: POST /register-feature contract verification
 *
 * Verifies that the gateway tolerates the payload shape the new stack-agnostic
 * `fleet add` will send:
 *   { name, branch, worktreePath, project }
 * where worktreePath is the project root (not a per-service worktree path).
 *
 * Uses Node.js 20+ built-in test runner (node:test) — zero external deps.
 */

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cors from 'cors';

// We import the routers directly — registry.js is a module-level Map so we
// need to reset state between tests. We do this by calling unregister() and
// re-importing within the same process (modules are cached, state persists).
import authRouter from './auth.js';
import apiRouter from './api.js';
import { getAll, unregister } from './registry.js';

// ── App factory ──────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use('/_fleet/api', apiRouter);
  app.use('/', authRouter);
  return app;
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

/**
 * @param {http.Server} server
 * @param {{ method: string, path: string, body?: object }} opts
 * @returns {Promise<{ status: number, body: any }>}
 */
function request(server, { method, path, body }) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const port = addr.port;
    const payload = body ? JSON.stringify(body) : undefined;

    const options = {
      hostname: '127.0.0.1',
      port,
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

// ── Test suite ───────────────────────────────────────────────────────────────

describe('POST /register-feature — stack-agnostic contract', () => {
  let server;

  // Reset registry state before each test so tests are isolated
  beforeEach((t, done) => {
    // Unregister any features that might linger from previous test
    for (const f of getAll()) {
      unregister(f.name);
    }

    if (server) {
      server.close(() => {
        server = buildApp().listen(0, '127.0.0.1', done);
      });
    } else {
      server = buildApp().listen(0, '127.0.0.1', done);
    }
  });

  after((t, done) => {
    if (server) server.close(done);
    else done();
  });

  // ── Happy path: new payload with worktreePath = project root ───────────────

  test('accepts {name, branch, worktreePath, project} and echoes name+branch', async () => {
    const payload = {
      name: 'my-feature',
      branch: 'feat/my-feature',
      worktreePath: '/Users/dev/projects/my-project',
      project: 'my-project',
    };

    const res = await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: payload,
    });

    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.name, 'my-feature');
    assert.equal(res.body.branch, 'feat/my-feature');
  });

  test('round-trips through GET /_fleet/api/features with all fields', async () => {
    const payload = {
      name: 'round-trip',
      branch: 'feat/round-trip',
      worktreePath: '/Users/dev/projects/acme',
      project: 'acme',
    };

    await request(server, { method: 'POST', path: '/register-feature', body: payload });

    const res = await request(server, { method: 'GET', path: '/_fleet/api/features' });

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), 'response should be an array');
    assert.equal(res.body.length, 1);

    const feature = res.body[0];
    assert.equal(feature.name, 'round-trip');
    assert.equal(feature.branch, 'feat/round-trip');
    assert.equal(feature.worktreePath, '/Users/dev/projects/acme');
    assert.equal(feature.project, 'acme');
    assert.equal(feature.status, 'running', 'default status should be running');
    assert.ok(feature.isActive, 'first registered feature should become active');
    assert.ok(feature.addedAt, 'addedAt timestamp should be present');
  });

  // ── Backward compat: old minimal payload (name + branch only) ─────────────

  test('tolerates minimal payload without worktreePath or project (old CLI)', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { name: 'minimal', branch: 'main' },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.name === 'minimal');
    assert.ok(feature, 'feature should be in registry');
    assert.equal(feature.worktreePath, null, 'worktreePath defaults to null');
    assert.equal(feature.project, null, 'project defaults to null');
  });

  // ── worktreePath semantics: project root (not per-service) ─────────────────

  test('stores project-root worktreePath verbatim (no path manipulation)', async () => {
    const projectRoot = '/home/dev/acme-monorepo';

    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { name: 'mono-test', branch: 'main', worktreePath: projectRoot },
    });

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.name === 'mono-test');
    assert.equal(feature.worktreePath, projectRoot, 'path stored verbatim — gateway does not transform it');
  });

  // ── Registration idempotency / overwrite ───────────────────────────────────

  test('re-registering same name overwrites the entry', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { name: 'idempotent', branch: 'v1', worktreePath: '/old/path', project: 'p1' },
    });

    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { name: 'idempotent', branch: 'v2', worktreePath: '/new/path', project: 'p2' },
    });

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const features = list.body.filter((f) => f.name === 'idempotent');
    assert.equal(features.length, 1, 'should not create duplicate entries');
    assert.equal(features[0].branch, 'v2');
    assert.equal(features[0].worktreePath, '/new/path');
  });

  // ── Validation: missing required fields ────────────────────────────────────

  test('rejects missing name with 400', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { branch: 'main' },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error, 'should return error message');
  });

  test('rejects missing branch with 400', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { name: 'no-branch' },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error, 'should return error message');
  });

  test('rejects empty body with 400', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: {},
    });
    assert.equal(res.status, 400);
  });

  // ── DELETE /register-feature/:name ────────────────────────────────────────

  test('DELETE /register-feature/:name removes from registry', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { name: 'to-remove', branch: 'main' },
    });

    const del = await request(server, {
      method: 'DELETE',
      path: '/register-feature/to-remove',
    });
    assert.equal(del.status, 200);
    assert.equal(del.body.ok, true);

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const found = list.body.find((f) => f.name === 'to-remove');
    assert.equal(found, undefined, 'feature should be gone from registry');
  });

  // ── Status field (optional in new payload) ────────────────────────────────

  test('accepts explicit status field in payload', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { name: 'not-started', branch: 'main', status: 'not_started' },
    });
    assert.equal(res.status, 200);

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.name === 'not-started');
    assert.equal(feature.status, 'not_started');
    // not_started feature should NOT be auto-activated
    assert.equal(feature.isActive, false, 'not_started feature should not become active');
  });
  // ── Title field: optional, persisted, exposed via GET /features ──────────────

  test('persists title and exposes it through GET /_fleet/api/features', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { name: 'foo', branch: 'foo', title: 'Hello' },
    });

    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.ok, true);

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.name === 'foo');
    assert.ok(feature, 'feature should be in registry');
    assert.equal(feature.title, 'Hello', 'title should be persisted and returned');
  });

  test('title defaults to null when omitted (backward compat)', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { name: 'no-title', branch: 'main' },
    });

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.name === 'no-title');
    assert.ok(feature, 'feature should be in registry');
    assert.equal(feature.title, null, 'title should default to null');
  });

  // ── Lifecycle statuses (building / starting / failed) ────────────────────

  test('accepts status=building and does NOT auto-activate', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { name: 'build-early', branch: 'main', status: 'building' },
    });

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.name === 'build-early');
    assert.equal(feature.status, 'building');
    assert.equal(feature.isActive, false, 'building feature must not be auto-activated (would 502)');
  });

  test('accepts status=starting without auto-activation', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { name: 'booting', branch: 'main', status: 'starting' },
    });

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.name === 'booting');
    assert.equal(feature.status, 'starting');
    assert.equal(feature.isActive, false);
  });

  test('accepts status=failed with an error message', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: {
        name: 'broken',
        branch: 'main',
        status: 'failed',
        error: 'docker build step 3: ENOENT Dockerfile.feature-base.spring',
      },
    });

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.name === 'broken');
    assert.equal(feature.status, 'failed');
    assert.equal(feature.error, 'docker build step 3: ENOENT Dockerfile.feature-base.spring');
    assert.equal(feature.isActive, false);
  });

  test('error defaults to null when omitted', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { name: 'no-error', branch: 'main' },
    });

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.name === 'no-error');
    assert.equal(feature.error, null);
  });

  // ── PATCH /_fleet/api/features/:name/status contract ─────────────────────

  test('PATCH status transitions building → starting → running', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { name: 'lifecycle', branch: 'main', status: 'building' },
    });

    let res = await request(server, {
      method: 'PATCH',
      path: '/_fleet/api/features/lifecycle/status',
      body: { status: 'starting' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'starting');

    res = await request(server, {
      method: 'PATCH',
      path: '/_fleet/api/features/lifecycle/status',
      body: { status: 'running' },
    });
    assert.equal(res.status, 200);

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.name === 'lifecycle');
    assert.equal(feature.status, 'running');
  });

  test('PATCH status=failed accepts and persists an error field', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { name: 'crashy', branch: 'main', status: 'building' },
    });

    const res = await request(server, {
      method: 'PATCH',
      path: '/_fleet/api/features/crashy/status',
      body: { status: 'failed', error: 'mvn build exited 1' },
    });
    assert.equal(res.status, 200);

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.name === 'crashy');
    assert.equal(feature.status, 'failed');
    assert.equal(feature.error, 'mvn build exited 1');
  });

  test('PATCH without error field preserves existing error (no clobber)', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: {
        name: 'preserve-err',
        branch: 'main',
        status: 'failed',
        error: 'original build failure',
      },
    });

    // Transition back to building without sending error → original must persist.
    const res = await request(server, {
      method: 'PATCH',
      path: '/_fleet/api/features/preserve-err/status',
      body: { status: 'building' },
    });
    assert.equal(res.status, 200);

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.name === 'preserve-err');
    assert.equal(feature.status, 'building');
    assert.equal(feature.error, 'original build failure', 'error must persist when not explicitly cleared');
  });

  test('PATCH with error=null explicitly clears the error', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: {
        name: 'clear-err',
        branch: 'main',
        status: 'failed',
        error: 'transient glitch',
      },
    });

    const res = await request(server, {
      method: 'PATCH',
      path: '/_fleet/api/features/clear-err/status',
      body: { status: 'running', error: null },
    });
    assert.equal(res.status, 200);

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.name === 'clear-err');
    assert.equal(feature.error, null, 'explicit null must clear the error');
  });

  test('PATCH rejects non-string error with 400', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { name: 'bad-err-type', branch: 'main' },
    });

    const res = await request(server, {
      method: 'PATCH',
      path: '/_fleet/api/features/bad-err-type/status',
      body: { status: 'failed', error: 42 },
    });
    assert.equal(res.status, 400);
  });

});
