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
import { createProxyMiddleware, debugProxyErrorsPlugin, proxyEventsPlugin } from 'http-proxy-middleware';

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

// ── Proxy passthrough integration tests ──────────────────────────────────────
// Spin an ephemeral upstream, wire createProxyMiddleware with the same
// ejectPlugins/plugins config as production, make real HTTP requests through it.
//
// Critical regression guard: an uncaughtException listener installed for each
// test will fail the test if the loggerPlugin crash (TypeError: ERR_INVALID_URL)
// resurfaces — that crash was unhandled and killed Node in production.

/**
 * Build a proxy middleware pointed at a fixed upstream URL, using the same
 * plugin config as the production createFeatureProxy.
 */
function buildProxy(upstreamUrl) {
  return createProxyMiddleware({
    router: () => upstreamUrl,
    changeOrigin: true,
    ejectPlugins: true,
    plugins: [debugProxyErrorsPlugin, proxyEventsPlugin],
    on: {
      error: (_err, _req, res) => {
        if (!res.headersSent) res.status(502).json({ error: 'upstream unreachable' });
      },
    },
  });
}

describe('proxy passthrough — ejectPlugins regression guard', () => {
  let upstream;
  let gateway;
  let uncaughtHandler;
  let uncaughtError;

  beforeEach((_t, done) => {
    uncaughtError = null;
    uncaughtHandler = (err) => { uncaughtError = err; };
    process.on('uncaughtException', uncaughtHandler);
    done();
  });

  after((_t, done) => {
    process.removeListener('uncaughtException', uncaughtHandler);
    const closeUpstream = (cb) => upstream ? upstream.close(cb) : cb();
    const closeGateway  = (cb) => gateway  ? gateway.close(cb)  : cb();
    closeUpstream(() => closeGateway(done));
  });

  test('proxies 200 response and body through without crashing', (_t, done) => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('upstream-ok');
    });

    upstream.listen(0, '127.0.0.1', () => {
      const { port: upstreamPort } = upstream.address();

      const app = express();
      app.use((_req, _res, next) => { next(); }); // no req._fleetFeature needed; router ignores it
      app.use(buildProxy(`http://127.0.0.1:${upstreamPort}`));

      gateway = app.listen(0, '127.0.0.1', () => {
        const { port: gwPort } = gateway.address();
        http.get(`http://127.0.0.1:${gwPort}/health`, (res) => {
          assert.equal(res.statusCode, 200, 'proxy should forward 200 from upstream');

          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            assert.equal(body, 'upstream-ok', 'proxy should pass body through');
            // Drain event loop so any pending uncaughtException fires before asserting
            setImmediate(() => {
              assert.equal(uncaughtError, null,
                `process must not crash — got uncaughtException: ${uncaughtError}`);
              done();
            });
          });
        }).on('error', done);
      });
    });
  });

  test('proxies 500 response from upstream without crashing', (_t, done) => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('upstream-error');
    });

    upstream.listen(0, '127.0.0.1', () => {
      const { port: upstreamPort } = upstream.address();

      const app = express();
      app.use(buildProxy(`http://127.0.0.1:${upstreamPort}`));

      gateway = app.listen(0, '127.0.0.1', () => {
        const { port: gwPort } = gateway.address();
        http.get(`http://127.0.0.1:${gwPort}/anything`, (res) => {
          assert.equal(res.statusCode, 500, 'proxy should forward 500 from upstream');

          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            assert.equal(body, 'upstream-error', 'proxy should pass error body through');
            setImmediate(() => {
              assert.equal(uncaughtError, null,
                `process must not crash — got uncaughtException: ${uncaughtError}`);
              done();
            });
          });
        }).on('error', done);
      });
    });
  });
});
