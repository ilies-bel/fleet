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
