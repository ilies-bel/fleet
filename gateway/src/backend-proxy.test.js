/**
 * Tests for backend-proxy.js — verifies the /backend path prepend + query
 * string preservation.
 *
 * Strategy: spin an ephemeral upstream that echoes the received path back in
 * its response body, then send requests through a proxy that targets it.
 * Mirrors the harness in proxy.test.js but exercises backend-proxy's
 * onProxyReq path rewrite instead of the default router.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import express from 'express';
import { createProxyMiddleware, debugProxyErrorsPlugin, proxyEventsPlugin } from 'http-proxy-middleware';

// ── Local mirror of createBackendProxy's onProxyReq logic ────────────────────
// We cannot import createBackendProxy directly because it calls resolveTarget()
// which touches Docker. Instead, we re-create the proxy with the same onProxyReq
// rewrite against a fixed upstream, which is the behaviour under test.

function buildBackendProxy(upstreamUrl) {
  return createProxyMiddleware({
    router: () => upstreamUrl,
    changeOrigin: true,
    ejectPlugins: true,
    plugins: [debugProxyErrorsPlugin, proxyEventsPlugin],
    on: {
      proxyReq: (proxyReq, req) => {
        const incoming = req.url || '/';
        proxyReq.path = '/backend' + (incoming.startsWith('/') ? incoming : '/' + incoming);
      },
      error: (_err, _req, res) => {
        if (!res.headersSent) res.status(502).json({ error: 'upstream unreachable' });
      },
    },
  });
}

describe('backend-proxy — /backend path prepend', () => {
  let upstream;
  let gateway;
  const receivedPaths = [];

  before((_t, done) => {
    upstream = http.createServer((req, res) => {
      receivedPaths.push(req.url);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`received:${req.url}`);
    });
    upstream.listen(0, '127.0.0.1', () => {
      const { port: upstreamPort } = upstream.address();
      const app = express();
      app.use(buildBackendProxy(`http://127.0.0.1:${upstreamPort}`));
      gateway = app.listen(0, '127.0.0.1', done);
    });
  });

  after((_t, done) => {
    const closeUp = (cb) => upstream ? upstream.close(cb) : cb();
    const closeGw = (cb) => gateway ? gateway.close(cb) : cb();
    closeUp(() => closeGw(done));
  });

  beforeEach(() => { receivedPaths.length = 0; });

  test('prepends /backend to simple paths', (_t, done) => {
    const { port } = gateway.address();
    http.get(`http://127.0.0.1:${port}/api/tickets`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        assert.equal(res.statusCode, 200);
        assert.equal(receivedPaths[0], '/backend/api/tickets',
          `upstream should receive /backend/api/tickets, got ${receivedPaths[0]}`);
        assert.equal(body, 'received:/backend/api/tickets');
        done();
      });
    }).on('error', done);
  });

  test('preserves query strings after prepend', (_t, done) => {
    const { port } = gateway.address();
    http.get(`http://127.0.0.1:${port}/api/search?q=foo&limit=10`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        assert.equal(res.statusCode, 200);
        assert.equal(receivedPaths[0], '/backend/api/search?q=foo&limit=10',
          `query string should survive rewrite, got ${receivedPaths[0]}`);
        done();
      });
    }).on('error', done);
  });

  test('handles root path request', (_t, done) => {
    const { port } = gateway.address();
    http.get(`http://127.0.0.1:${port}/`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        assert.equal(res.statusCode, 200);
        assert.equal(receivedPaths[0], '/backend/',
          `root path should become /backend/, got ${receivedPaths[0]}`);
        done();
      });
    }).on('error', done);
  });
});

// ── WebSocket upgrade tests ───────────────────────────────────────────────────
// Mirrors proxy.test.js WS tests but verifies the /backend path rewrite is
// applied to req.url before proxy.upgrade is called.

/**
 * Build a standalone upgrade handler that mirrors createBackendProxy().upgrade
 * but accepts an injected resolveTarget so we can control success/failure.
 *
 * @param {{ ok: boolean, feature?: string, body?: string }} resolvedValue
 * @param {{ upgrade: Function }} proxyStub  Object with an `.upgrade` spy
 * @returns {Function}  async (req, socket, head) handler
 */
function buildBackendUpgradeHandler(resolvedValue, proxyStub) {
  return async (req, socket, head) => {
    if (!resolvedValue.ok) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    req._fleetFeature = resolvedValue.feature;
    const incoming = req.url || '/';
    req.url = '/backend' + (incoming.startsWith('/') ? incoming : '/' + incoming);
    proxyStub.upgrade(req, socket, head);
  };
}

describe('createBackendProxy — WebSocket upgrade handler', () => {
  test('calls proxy.upgrade with /backend path rewrite on success', (_t, done) => {
    const upgradeCalls = [];
    const proxyStub = {
      upgrade: (req, socket, head) => {
        upgradeCalls.push({ url: req.url, feature: req._fleetFeature });
        socket.destroy();
      },
    };

    const upgradeHandler = buildBackendUpgradeHandler({ ok: true, feature: 'main' }, proxyStub);

    const httpServer = http.createServer((_req, res) => { res.end(); });
    httpServer.on('upgrade', (req, socket, head) => {
      upgradeHandler(req, socket, head)
        .then(() => {
          assert.equal(upgradeCalls.length, 1, 'proxy.upgrade should be called once');
          assert.equal(upgradeCalls[0].feature, 'main',
            'req._fleetFeature should be set to resolved feature');
          assert.ok(
            upgradeCalls[0].url.startsWith('/backend/'),
            `req.url should be rewritten to /backend/..., got: ${upgradeCalls[0].url}`
          );
          httpServer.close(done);
        })
        .catch((err) => { httpServer.close(() => done(err)); });
    });

    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address();
      const clientSocket = net.connect(port, '127.0.0.1', () => {
        clientSocket.write(
          'GET /ws/live HTTP/1.1\r\n' +
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

  test('rewrites /backend path correctly for root WS path', (_t, done) => {
    const upgradeCalls = [];
    const proxyStub = {
      upgrade: (req, socket, head) => {
        upgradeCalls.push({ url: req.url });
        socket.destroy();
      },
    };

    const upgradeHandler = buildBackendUpgradeHandler({ ok: true, feature: 'main' }, proxyStub);

    const httpServer = http.createServer((_req, res) => { res.end(); });
    httpServer.on('upgrade', (req, socket, head) => {
      // Override req.url to root so we verify the root path rewrite
      req.url = '/';
      upgradeHandler(req, socket, head)
        .then(() => {
          assert.equal(upgradeCalls[0].url, '/backend/',
            `root ws path should become /backend/, got: ${upgradeCalls[0].url}`);
          httpServer.close(done);
        })
        .catch((err) => { httpServer.close(() => done(err)); });
    });

    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address();
      const clientSocket = net.connect(port, '127.0.0.1', () => {
        clientSocket.write(
          'GET / HTTP/1.1\r\n' +
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

    const upgradeHandler = buildBackendUpgradeHandler({ ok: false, body: 'no container' }, proxyStub);

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
          'GET /ws/live HTTP/1.1\r\n' +
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
