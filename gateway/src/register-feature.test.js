/**
 * Integration test: POST /register-feature contract verification
 *
 * Verifies that the gateway enforces composite `${project}-${name}` keying
 * and exposes project, name, and key in all responses.
 *
 * Uses Node.js 20+ built-in test runner (node:test) — zero external deps.
 */

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cors from 'cors';

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

describe('POST /register-feature — composite key contract', () => {
  let server;

  // Reset registry state before each test so tests are isolated
  beforeEach((t, done) => {
    for (const f of getAll()) {
      unregister(f.key);
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

  // ── Happy path: project + name ────────────────────────────────────────────

  test('accepts {project, name, branch, worktreePath} and echoes composite key', async () => {
    const payload = {
      project: 'my-project',
      name: 'my-feature',
      branch: 'feat/my-feature',
      worktreePath: '/Users/dev/projects/my-project',
    };

    const res = await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: payload,
    });

    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.project, 'my-project');
    assert.equal(res.body.name, 'my-feature');
    assert.equal(res.body.key, 'my-project-my-feature');
    assert.equal(res.body.branch, 'feat/my-feature');
  });

  test('round-trips through GET /_fleet/api/features with project, name, and key', async () => {
    const payload = {
      project: 'acme',
      name: 'round-trip',
      branch: 'feat/round-trip',
      worktreePath: '/Users/dev/projects/acme',
    };

    await request(server, { method: 'POST', path: '/register-feature', body: payload });

    const res = await request(server, { method: 'GET', path: '/_fleet/api/features' });

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), 'response should be an array');
    assert.equal(res.body.length, 1);

    const feature = res.body[0];
    assert.equal(feature.project, 'acme');
    assert.equal(feature.name, 'round-trip');
    assert.equal(feature.key, 'acme-round-trip');
    assert.equal(feature.branch, 'feat/round-trip');
    assert.equal(feature.worktreePath, '/Users/dev/projects/acme');
    assert.equal(feature.status, 'up', 'default status should be up (running normalised)');
    assert.ok(feature.isActive, 'first registered feature should become active');
    assert.ok(feature.addedAt, 'addedAt timestamp should be present');
  });

  // ── Collision isolation: same name, different project ────────────────────

  test('two projects registering same feature name get distinct keys', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { project: 'alpha', name: 'foo', branch: 'main' },
    });
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { project: 'beta', name: 'foo', branch: 'main' },
    });

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    assert.equal(list.body.length, 2, 'both features should be registered independently');

    const keys = list.body.map(f => f.key).sort();
    assert.deepEqual(keys, ['alpha-foo', 'beta-foo']);
  });

  // ── Backward compat: project required ────────────────────────────────────

  test('rejects payload without project with 400 and upgrade message', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { name: 'no-project', branch: 'main' },
    });

    assert.equal(res.status, 400);
    assert.ok(res.body.error, 'should return error message');
    assert.ok(
      res.body.error.includes('project required'),
      `error should mention project required, got: ${res.body.error}`
    );
    assert.ok(
      res.body.error.includes('upgrade'),
      `error should mention upgrading CLI, got: ${res.body.error}`
    );
  });

  // ── worktreePath semantics: project root (not per-service) ─────────────────

  test('stores project-root worktreePath verbatim (no path manipulation)', async () => {
    const projectRoot = '/home/dev/acme-monorepo';

    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { project: 'acme', name: 'mono-test', branch: 'main', worktreePath: projectRoot },
    });

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.key === 'acme-mono-test');
    assert.equal(feature.worktreePath, projectRoot, 'path stored verbatim — gateway does not transform it');
  });

  // ── Registration idempotency / overwrite ───────────────────────────────────

  test('re-registering same composite key overwrites the entry', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { project: 'p1', name: 'idempotent', branch: 'v1', worktreePath: '/old/path' },
    });

    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { project: 'p1', name: 'idempotent', branch: 'v2', worktreePath: '/new/path' },
    });

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const features = list.body.filter((f) => f.key === 'p1-idempotent');
    assert.equal(features.length, 1, 'should not create duplicate entries');
    assert.equal(features[0].branch, 'v2');
    assert.equal(features[0].worktreePath, '/new/path');
  });

  // ── Validation: missing required fields ────────────────────────────────────

  test('rejects missing name with 400', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { project: 'myproj', branch: 'main' },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error, 'should return error message');
  });

  test('rejects missing branch with 400', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { project: 'myproj', name: 'no-branch' },
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

  // ── DELETE /register-feature/:key ─────────────────────────────────────────

  test('DELETE /register-feature/:key removes from registry', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { project: 'myproj', name: 'to-remove', branch: 'main' },
    });

    const del = await request(server, {
      method: 'DELETE',
      path: '/register-feature/myproj-to-remove',
    });
    assert.equal(del.status, 200);
    assert.equal(del.body.ok, true);
    assert.equal(del.body.key, 'myproj-to-remove');

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const found = list.body.find((f) => f.key === 'myproj-to-remove');
    assert.equal(found, undefined, 'feature should be gone from registry');
  });

  // ── Status field (optional in new payload) ────────────────────────────────

  test('accepts explicit status field in payload', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { project: 'myproj', name: 'not-started', branch: 'main', status: 'not_started' },
    });
    assert.equal(res.status, 200);

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.key === 'myproj-not-started');
    assert.equal(feature.status, 'not_started');
    // not_started feature should NOT be auto-activated
    assert.equal(feature.isActive, false, 'not_started feature should not become active');
  });

  // ── Title field: optional, persisted, exposed via GET /features ──────────────

  test('persists title and exposes it through GET /_fleet/api/features', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { project: 'myproj', name: 'foo', branch: 'foo', title: 'Hello' },
    });

    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.ok, true);

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.key === 'myproj-foo');
    assert.ok(feature, 'feature should be in registry');
    assert.equal(feature.title, 'Hello', 'title should be persisted and returned');
  });

  test('title defaults to null when omitted', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { project: 'myproj', name: 'no-title', branch: 'main' },
    });

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.key === 'myproj-no-title');
    assert.ok(feature, 'feature should be in registry');
    assert.equal(feature.title, null, 'title should default to null');
  });

  // ── Lifecycle statuses (building / starting / failed) ────────────────────

  test('accepts status=building and does NOT auto-activate', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { project: 'myproj', name: 'build-early', branch: 'main', status: 'building' },
    });

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.key === 'myproj-build-early');
    assert.equal(feature.status, 'building');
    assert.equal(feature.isActive, false, 'building feature must not be auto-activated (would 502)');
  });

  test('accepts status=starting without auto-activation', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { project: 'myproj', name: 'booting', branch: 'main', status: 'starting' },
    });

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.key === 'myproj-booting');
    assert.equal(feature.status, 'starting');
    assert.equal(feature.isActive, false);
  });

  test('accepts status=failed with an error message', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: {
        project: 'myproj',
        name: 'broken',
        branch: 'main',
        status: 'failed',
        error: 'docker build step 3: ENOENT Dockerfile.feature-base.spring',
      },
    });

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.key === 'myproj-broken');
    assert.equal(feature.status, 'failed');
    assert.equal(feature.error, 'docker build step 3: ENOENT Dockerfile.feature-base.spring');
    assert.equal(feature.isActive, false);
  });

  test('error defaults to null when omitted', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { project: 'myproj', name: 'no-error', branch: 'main' },
    });

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.key === 'myproj-no-error');
    assert.equal(feature.error, null);
  });

  // ── PATCH /_fleet/api/features/:key/status contract ──────────────────────

  test('PATCH status transitions building → starting → up (running normalised)', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { project: 'myproj', name: 'lifecycle', branch: 'main', status: 'building' },
    });

    let res = await request(server, {
      method: 'PATCH',
      path: '/_fleet/api/features/myproj-lifecycle/status',
      body: { status: 'starting' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'starting');

    // Legacy CLI still sends 'running' — gateway normalises it to 'up'.
    res = await request(server, {
      method: 'PATCH',
      path: '/_fleet/api/features/myproj-lifecycle/status',
      body: { status: 'running' },
    });
    assert.equal(res.status, 200);

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.key === 'myproj-lifecycle');
    assert.equal(feature.status, 'up');
  });

  test('PATCH status=failed accepts and persists an error field', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { project: 'myproj', name: 'crashy', branch: 'main', status: 'building' },
    });

    const res = await request(server, {
      method: 'PATCH',
      path: '/_fleet/api/features/myproj-crashy/status',
      body: { status: 'failed', error: 'mvn build exited 1' },
    });
    assert.equal(res.status, 200);

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.key === 'myproj-crashy');
    assert.equal(feature.status, 'failed');
    assert.equal(feature.error, 'mvn build exited 1');
  });

  test('PATCH without error field preserves existing error (no clobber)', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: {
        project: 'myproj',
        name: 'preserve-err',
        branch: 'main',
        status: 'failed',
        error: 'original build failure',
      },
    });

    // Transition back to building without sending error → original must persist.
    const res = await request(server, {
      method: 'PATCH',
      path: '/_fleet/api/features/myproj-preserve-err/status',
      body: { status: 'building' },
    });
    assert.equal(res.status, 200);

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.key === 'myproj-preserve-err');
    assert.equal(feature.status, 'building');
    assert.equal(feature.error, 'original build failure', 'error must persist when not explicitly cleared');
  });

  test('PATCH with error=null explicitly clears the error', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: {
        project: 'myproj',
        name: 'clear-err',
        branch: 'main',
        status: 'failed',
        error: 'transient glitch',
      },
    });

    const res = await request(server, {
      method: 'PATCH',
      path: '/_fleet/api/features/myproj-clear-err/status',
      body: { status: 'running', error: null },
    });
    assert.equal(res.status, 200);

    const list = await request(server, { method: 'GET', path: '/_fleet/api/features' });
    const feature = list.body.find((f) => f.key === 'myproj-clear-err');
    assert.equal(feature.error, null, 'explicit null must clear the error');
  });

  test('PATCH rejects non-string error with 400', async () => {
    await request(server, {
      method: 'POST',
      path: '/register-feature',
      body: { project: 'myproj', name: 'bad-err-type', branch: 'main' },
    });

    const res = await request(server, {
      method: 'PATCH',
      path: '/_fleet/api/features/myproj-bad-err-type/status',
      body: { status: 'failed', error: 42 },
    });
    assert.equal(res.status, 400);
  });

});
