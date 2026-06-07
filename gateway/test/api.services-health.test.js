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

  test('marks a service down when the probe returns a non-ok status', async () => {
    register('testproj', 'feat', 'main', null, 'up', [{ name: 'api', port: 3000 }]);

    globalThis.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.startsWith('http://fleet-')) return { ok: false };
      return realFetch(url, opts);
    };

    const { status, body } = await request(server, {
      method: 'GET',
      path: '/_fleet/api/features/testproj-feat/services/health',
    });
    assert.equal(status, 200);
    assert.deepEqual(body.services, [{ name: 'api', port: 3000, status: 'down' }]);
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

  test('probes each service at its correct fleet container URL', async () => {
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

    assert.ok(probeUrls.includes('http://fleet-testproj-feat:3000/'));
    assert.ok(probeUrls.includes('http://fleet-testproj-feat:8080/'));
  });

  test('returns mixed up/down statuses correctly', async () => {
    register('testproj', 'feat', 'main', null, 'up', [
      { name: 'api', port: 3000 },
      { name: 'worker', port: 4000 },
    ]);

    globalThis.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.startsWith('http://fleet-')) {
        return url.includes(':3000') ? { ok: true } : { ok: false };
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
});
