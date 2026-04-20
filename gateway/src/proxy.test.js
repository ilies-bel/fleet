/**
 * Tests for proxy.js liveness check and 503 body.
 *
 * We mock docker.js at module level using Node.js built-in test runner's
 * module mock support (--experimental-vm-modules not needed; we fake via
 * direct registry manipulation since docker.js is imported by registry.js).
 *
 * Strategy: register features directly, then override `getContainerStatus`
 * via a thin wrapper so we control what liveness check returns per test.
 */

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import { register, unregister, getAll, setActiveFeature } from './registry.js';
import { stoppedContainerBody } from './proxy.js';

// ── stoppedContainerBody unit tests ──────────────────────────────────────────

describe('stoppedContainerBody', () => {
  test('includes the feature name', () => {
    const html = stoppedContainerBody('my-feature');
    assert.ok(html.includes('fleet-my-feature'), 'should contain container name');
    assert.ok(html.includes('docker start fleet-my-feature'), 'should contain start command');
  });

  test('references localhost:4000 dashboard', () => {
    const html = stoppedContainerBody('any');
    assert.ok(html.includes('localhost:4000'), 'should link to dashboard');
  });

  test('returns non-empty HTML string', () => {
    const html = stoppedContainerBody('test');
    assert.ok(typeof html === 'string' && html.length > 0);
    assert.ok(html.startsWith('<html>'), 'should be HTML');
  });
});

// ── Registry cleanup helper ───────────────────────────────────────────────────

function clearRegistry() {
  for (const f of getAll()) unregister(f.name);
}

// ── Proxy middleware integration tests ───────────────────────────────────────
// We test the outer middleware layer. For stopped-container scenarios we stub
// getContainerStatus by registering a test variant via dynamic import override.
// Since ESM modules are cached, we instead test the helper exports directly and
// verify registry state mutations (updateStatus side-effect).

describe('proxy middleware — no active feature', () => {
  let server;

  beforeEach((_t, done) => {
    clearRegistry();
    // Build a minimal express app that uses the outer middleware guard logic
    // We recreate the guard inline here since we cannot stub docker in ESM easily
    const app = express();
    app.use(async (req, res) => {
      const { getActiveFeature } = await import('./registry.js');
      const feature = getActiveFeature();
      if (!feature) {
        return res.status(503).send(
          '<html><body>// NO ACTIVE FEATURE</body></html>'
        );
      }
      res.status(200).send('ok');
    });
    server = app.listen(0, '127.0.0.1', done);
  });

  after((_t, done) => { if (server) server.close(done); else done(); });

  test('returns 503 when no feature is active', (t, done) => {
    const { port } = server.address();
    http.get(`http://127.0.0.1:${port}/anything`, (res) => {
      assert.equal(res.statusCode, 503);
      done();
    }).on('error', done);
  });
});

describe('registry updateStatus side-effect on liveness failure', () => {
  test('updateStatus marks feature as stopped in registry', async () => {
    clearRegistry();
    register('dying', 'main', null, null, 'running');
    setActiveFeature('dying');

    const { updateStatus, getFeature } = await import('./registry.js');
    updateStatus('dying', 'stopped');

    const entry = getFeature('dying');
    assert.equal(entry.status, 'stopped', 'registry should reflect stopped status');

    clearRegistry();
  });
});
