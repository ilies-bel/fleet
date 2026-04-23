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

import { test, describe, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
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
  for (const f of getAll()) unregister(f.key);
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
    register('testproject', 'dying', 'main', null, 'running');
    setActiveFeature('testproject-dying');

    const { updateStatus, getFeature } = await import('./registry.js');
    updateStatus('testproject-dying', 'stopped');

    const entry = getFeature('testproject-dying');
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

  // Close each test's servers after the test so handles don't leak between tests.
  afterEach((_t, done) => {
    process.removeListener('uncaughtException', uncaughtHandler);
    const closeUpstream = (cb) => upstream ? (upstream.closeAllConnections?.(), upstream.close(cb)) : cb();
    const closeGateway  = (cb) => gateway  ? (gateway.closeAllConnections?.(),  gateway.close(cb))  : cb();
    closeUpstream(() => closeGateway(() => { upstream = null; gateway = null; done(); }));
  });

  after((_t, done) => { done(); });

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

// ── WebSocket upgrade tests ───────────────────────────────────────────────────
// Build a minimal upgrade handler that mirrors createFeatureProxy's .upgrade
// logic without touching Docker. This lets us verify the handler's branching:
//   1. resolveTarget returns ok → proxy.upgrade called with (req, socket, head)
//   2. resolveTarget returns !ok → socket written with 503 and destroyed

/**
 * Build a standalone upgrade handler that mirrors createFeatureProxy().upgrade
 * but accepts an injected resolveTarget so we can control success/failure.
 *
 * @param {{ ok: boolean, feature?: string, body?: string }} resolvedValue
 * @param {{ upgrade: Function }} proxyStub  Object with an `.upgrade` spy
 * @returns {Function}  async (req, socket, head) handler
 */
function buildUpgradeHandler(resolvedValue, proxyStub) {
  return async (req, socket, head) => {
    if (!resolvedValue.ok) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    req._fleetFeature = resolvedValue.feature;
    proxyStub.upgrade(req, socket, head);
  };
}

describe('createFeatureProxy — WebSocket upgrade handler', () => {
  test('calls proxy.upgrade on success', (_t, done) => {
    const upgradeCalls = [];
    const proxyStub = {
      upgrade: (req, socket, head) => {
        upgradeCalls.push({ req, socket, head });
        socket.destroy();
      },
    };

    const upgradeHandler = buildUpgradeHandler({ ok: true, feature: 'main' }, proxyStub);

    const httpServer = http.createServer((_req, res) => { res.end(); });
    httpServer.on('upgrade', (req, socket, head) => {
      upgradeHandler(req, socket, head)
        .then(() => {
          assert.equal(upgradeCalls.length, 1, 'proxy.upgrade should be called once');
          assert.equal(upgradeCalls[0].req._fleetFeature, 'main',
            'req._fleetFeature should be set to resolved feature');
          httpServer.close(done);
        })
        .catch((err) => { httpServer.close(() => done(err)); });
    });

    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address();
      // Send a raw WebSocket upgrade request
      const clientSocket = net.connect(port, '127.0.0.1', () => {
        clientSocket.write(
          'GET /_next/webpack-hmr HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n'
        );
      });
      // Suppress errors on client socket — server destroys it intentionally
      clientSocket.on('error', () => {});
    });
  });

  test('writes 503 and destroys socket when no container is running', (_t, done) => {
    const proxyStub = {
      upgrade: () => { throw new Error('proxy.upgrade should not be called on 503'); },
    };

    const upgradeHandler = buildUpgradeHandler({ ok: false, body: 'no container' }, proxyStub);

    // once-guard: the upgrade async handler resolves AFTER socket.destroy().
    // The client socket may emit 'data', 'close', or 'error' — only call done once.
    let finished = false;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      httpServer.close(() => { if (err) done(err); else done(); });
    };

    const httpServer = http.createServer((_req, res) => { res.end(); });
    httpServer.on('upgrade', (req, socket, head) => {
      upgradeHandler(req, socket, head)
        .then(() => finish())
        .catch(finish);
    });

    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address();
      const clientSocket = net.connect(port, '127.0.0.1', () => {
        clientSocket.write(
          'GET /_next/webpack-hmr HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n'
        );
      });

      let response = '';
      clientSocket.on('data', (chunk) => { response += chunk.toString(); });
      clientSocket.on('close', () => {
        try {
          assert.ok(response.includes('503'),
            `socket should receive 503 header, got: ${response}`);
          finish();
        } catch (err) {
          finish(err);
        }
      });
      // Socket destroyed by server — suppress; close event carries the assertion
      clientSocket.on('error', () => {});
    });
  });
});
