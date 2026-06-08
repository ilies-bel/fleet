/**
 * Tests for GET /_fleet/api/features/:key/services/health
 *
 * Verifies per-service health probing: 404 for unknown features, empty array
 * when no services, up/down status per-service, correct probe URLs.
 *
 * Uses Node.js built-in test runner (node:test).
 * globalThis.fetch is replaced per-test with a discriminated stub that only
 * intercepts fleet container URLs (http://fleet-*); all other URLs pass through
 * to real fetch so the test-server requests are unaffected.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import apiRouter from '../src/api.js';
import { register, getAll, unregister } from '../src/registry.js';

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/_fleet/api', apiRouter);
  return app;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function request(server, { method, path }) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
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
    req.end();
  });
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('GET /_fleet/api/features/:key/services/health', () => {
  let server;
  const realFetch = globalThis.fetch;

  beforeEach((t, done) => {
    // Reset registry so features from previous tests don't bleed in.
    for (const f of getAll()) unregister(f.key);
    // Restore real fetch before each test (tests override as needed).
    globalThis.fetch = realFetch;
    server = buildApp().listen(0, '127.0.0.1', done);
  });

  afterEach((t, done) => {
    globalThis.fetch = realFetch;
    server.close(done);
  });

  test('returns 404 when the feature is not registered', async () => {
    const { status, body } = await request(server, {
      method: 'GET',
      path: '/_fleet/api/features/missing-key/services/health',
    });
    assert.equal(status, 404);
    assert.equal(body.error, 'Feature not registered');
  });

  test('returns empty services array when the feature has no services', async () => {
    register('testproj', 'feat', 'main');
    const { status, body } = await request(server, {
      method: 'GET',
      path: '/_fleet/api/features/testproj-feat/services/health',
    });
    assert.equal(status, 200);
    assert.deepEqual(body, { services: [] });
  });

  test('marks each service up when its container probe responds ok', async () => {
    register('testproj', 'feat', 'main', null, 'up', [
      { name: 'api', port: 3000 },
      { name: 'web', port: 8080 },
    ]);

    globalThis.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.startsWith('http://fleet-')) return { ok: true };
      return realFetch(url, opts);
    };

    const { status, body } = await request(server, {
      method: 'GET',
      path: '/_fleet/api/features/testproj-feat/services/health',
    });
    assert.equal(status, 200);
    assert.deepEqual(body.services, [
      { name: 'api', port: 3000, status: 'up' },
      { name: 'web', port: 8080, status: 'up' },
    ]);
  });

  test('treats any HTTP response (including non-ok) as up — service process answered', async () => {
    register('testproj', 'feat', 'main', null, 'up', [{ name: 'api', port: 3000 }]);

    // Non-ok (404/405) still means the service process is reachable; only a
    // thrown error (ECONNREFUSED / timeout) means 'down'.
    globalThis.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.startsWith('http://fleet-')) return { ok: false, status: 404 };
      return realFetch(url, opts);
    };

    const { status, body } = await request(server, {
      method: 'GET',
      path: '/_fleet/api/features/testproj-feat/services/health',
    });
    assert.equal(status, 200);
    assert.deepEqual(body.services, [{ name: 'api', port: 3000, status: 'up' }]);
  });

  test('marks services down when the probe throws (timeout / unreachable)', async () => {
    register('testproj', 'feat', 'main', null, 'up', [
      { name: 'api', port: 3000 },
      { name: 'worker', port: 4000 },
    ]);

    globalThis.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.startsWith('http://fleet-')) throw new Error('ECONNREFUSED');
      return realFetch(url, opts);
    };

    const { status, body } = await request(server, {
      method: 'GET',
      path: '/_fleet/api/features/testproj-feat/services/health',
    });
    assert.equal(status, 200);
    assert.deepEqual(body.services, [
      { name: 'api', port: 3000, status: 'down' },
      { name: 'worker', port: 4000, status: 'down' },
    ]);
  });

  test('probes each service via nginx path prefix on port 80 (not internal service port)', async () => {
    register('testproj', 'feat', 'main', null, 'up', [
      { name: 'api', port: 3000 },
      { name: 'web', port: 8080 },
    ]);

    const probeUrls = [];
    globalThis.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.startsWith('http://fleet-')) {
        probeUrls.push(url);
        return { ok: true };
      }
      return realFetch(url, opts);
    };

    await request(server, {
      method: 'GET',
      path: '/_fleet/api/features/testproj-feat/services/health',
    });

    // Must use nginx path-based routing (port 80 implied), NOT the internal service ports.
    assert.ok(probeUrls.includes('http://fleet-testproj-feat/api/'), `expected /api/ URL, got: ${JSON.stringify(probeUrls)}`);
    assert.ok(probeUrls.includes('http://fleet-testproj-feat/web/'), `expected /web/ URL, got: ${JSON.stringify(probeUrls)}`);
    // Must NOT probe internal ports directly.
    assert.ok(!probeUrls.some(u => u.includes(':3000') || u.includes(':8080')), `must not probe internal ports, got: ${JSON.stringify(probeUrls)}`);
  });

  test('returns mixed up/down statuses correctly', async () => {
    register('testproj', 'feat', 'main', null, 'up', [
      { name: 'api', port: 3000 },
      { name: 'worker', port: 4000 },
    ]);

    // api resolves (any HTTP response → up), worker throws (ECONNREFUSED → down).
    globalThis.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.startsWith('http://fleet-')) {
        if (url.includes('/worker/')) throw new Error('ECONNREFUSED');
        return { ok: true };
      }
      return realFetch(url, opts);
    };

    const { status, body } = await request(server, {
      method: 'GET',
      path: '/_fleet/api/features/testproj-feat/services/health',
    });
    assert.equal(status, 200);

    const api = body.services.find((s) => s.name === 'api');
    const worker = body.services.find((s) => s.name === 'worker');
    assert.equal(api.status, 'up');
    assert.equal(worker.status, 'down');
  });

  test('returns empty services for cluster features without probing', async () => {
    // Cluster features (host != null) use port-forward addresses the gateway
    // doesn't know — return empty list rather than mis-probing.
    register('testproj', 'feat', 'main', null, 'up', [
      { name: 'backend', port: 8080 },
    ], null, null, { cluster: 'test-cluster', namespace: 'default' });

    let probed = false;
    globalThis.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.startsWith('http://fleet-')) {
        probed = true;
        return { ok: true };
      }
      return realFetch(url, opts);
    };

    const { status, body } = await request(server, {
      method: 'GET',
      path: '/_fleet/api/features/testproj-feat/services/health',
    });
    assert.equal(status, 200);
    assert.deepEqual(body, { services: [] });
    assert.equal(probed, false, 'must not probe cluster feature containers');
  });
});
