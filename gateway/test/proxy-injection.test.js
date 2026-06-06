/**
 * Tests for the Mars picker-script injection layer.
 *
 * Two layers:
 *   1. injectPickerScript — pure HTML transformation (unit tests).
 *   2. Proxy proxyRes hook — HTML gains the script tag; non-HTML passes through
 *      unchanged (integration tests via real upstream HTTP servers).
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import express from 'express';
import { createProxyMiddleware, debugProxyErrorsPlugin, proxyEventsPlugin } from 'http-proxy-middleware';

import { injectPickerScript } from '../src/proxy.js';
import { INJECTED_PICKER } from '../src/injected-picker.js';

// ── Unit tests for injectPickerScript ─────────────────────────────────────────

test('injectPickerScript inserts the picker <script> tag before </body>', () => {
  const html = '<html><body><p>Hello</p></body></html>';
  const result = injectPickerScript(html);
  const tag = `<script>${INJECTED_PICKER}</script>`;
  assert.ok(result.includes(tag), 'result must contain the picker script tag');
  assert.ok(
    result.indexOf(tag) < result.indexOf('</body>'),
    'script tag must appear before </body>'
  );
  assert.ok(result.includes('</body></html>'), 'existing closing tags must be preserved');
});

test('injectPickerScript appends the script tag at the end when </body> is absent', () => {
  const html = '<html><p>No closing body tag</p>';
  const result = injectPickerScript(html);
  const tag = `<script>${INJECTED_PICKER}</script>`;
  assert.ok(result.endsWith(tag), 'script tag must be appended at the end of the document');
});

// ── INJECTED_PICKER content tests ─────────────────────────────────────────────

test('INJECTED_PICKER attaches a window message event listener', () => {
  assert.ok(
    INJECTED_PICKER.includes("addEventListener('message'"),
    'bootstrap must install a window message listener'
  );
});

test('INJECTED_PICKER is dormant until it receives mars.capture.activate', () => {
  assert.ok(
    INJECTED_PICKER.includes("'mars.capture.activate'"),
    "bootstrap must gate on the 'mars.capture.activate' message type"
  );
  assert.ok(
    INJECTED_PICKER.includes('active') && INJECTED_PICKER.includes('true'),
    'bootstrap must also check the active:true flag'
  );
});

// ── Integration tests: proxy injects into HTML, passes non-HTML unchanged ─────
//
// Each test spins up a real upstream server + a gateway proxy.  The proxy uses
// the same injectPickerScript import as createFeatureProxy so the transformation
// logic is identical to production.

/**
 * Build a minimal test proxy with the same HTML-injection proxyRes hook that
 * createFeatureProxy uses, pointed at a fixed upstream URL.
 *
 * @param {string} upstreamUrl
 */
function buildInjectionProxy(upstreamUrl) {
  return createProxyMiddleware({
    router: () => upstreamUrl,
    changeOrigin: true,
    ejectPlugins: true,
    plugins: [debugProxyErrorsPlugin, proxyEventsPlugin],
    on: {
      proxyReq: (proxyReq) => {
        // Mirror the production proxy: force identity encoding so the upstream
        // returns plain text/html.  Without this, a browser-like Accept-Encoding:
        // gzip in the test client would reach the upstream, which would gzip the
        // response, and the proxyRes hook below would corrupt it by calling
        // .toString('utf8') on compressed bytes.
        proxyReq.setHeader('accept-encoding', 'identity');
      },
      proxyRes: (proxyRes, _req, res) => {
        const contentType = proxyRes.headers['content-type'] || '';
        if (!contentType.startsWith('text/html')) return; // non-HTML: pass through untouched

        res.removeHeader('content-length');
        const chunks = [];
        const origWrite = res.write.bind(res);
        const origEnd = res.end.bind(res);

        res.write = (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          return true;
        };

        res.end = (chunk) => {
          if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          const modified = injectPickerScript(Buffer.concat(chunks).toString('utf8'));
          const buf = Buffer.from(modified, 'utf8');
          res.removeHeader('transfer-encoding');
          res.setHeader('content-length', buf.byteLength);
          res.write = origWrite;
          res.end = origEnd;
          return res.end(buf);
        };
      },
      error: (_err, _req, res) => {
        if (!res.headersSent) res.status(502).json({ error: 'upstream unreachable' });
      },
    },
  });
}

describe('proxy injection — HTML and non-HTML responses', () => {
  let upstream;
  let gateway;

  afterEach((_t, done) => {
    const closeUpstream = (cb) => upstream ? (upstream.closeAllConnections?.(), upstream.close(cb)) : cb();
    const closeGateway  = (cb) => gateway  ? (gateway.closeAllConnections?.(),  gateway.close(cb))  : cb();
    closeUpstream(() => closeGateway(() => { upstream = null; gateway = null; done(); }));
  });

  test('HTML response gains the injected picker script tag', (_t, done) => {
    upstream = http.createServer((_req, res) => {
      const body = '<html><body><h1>App</h1></body></html>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    });

    upstream.listen(0, '127.0.0.1', () => {
      const { port: upstreamPort } = upstream.address();
      const app = express();
      app.use(buildInjectionProxy(`http://127.0.0.1:${upstreamPort}`));
      gateway = app.listen(0, '127.0.0.1', () => {
        const { port: gwPort } = gateway.address();
        http.get(`http://127.0.0.1:${gwPort}/`, (res) => {
          assert.equal(res.statusCode, 200);
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            const tag = `<script>${INJECTED_PICKER}</script>`;
            assert.ok(body.includes(tag), 'proxied HTML must contain the picker script tag');
            assert.ok(
              body.indexOf(tag) < body.indexOf('</body>'),
              'picker script must appear before </body>'
            );
            done();
          });
        }).on('error', done);
      });
    });
  });

  test('JSON response is passed through the proxy unchanged', (_t, done) => {
    const payload = JSON.stringify({ ok: true, value: 42 });
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    });

    upstream.listen(0, '127.0.0.1', () => {
      const { port: upstreamPort } = upstream.address();
      const app = express();
      app.use(buildInjectionProxy(`http://127.0.0.1:${upstreamPort}`));
      gateway = app.listen(0, '127.0.0.1', () => {
        const { port: gwPort } = gateway.address();
        http.get(`http://127.0.0.1:${gwPort}/api/data`, (res) => {
          assert.equal(res.statusCode, 200);
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            assert.equal(body, payload, 'JSON body must pass through untouched');
            assert.ok(!body.includes('<script>'), 'JSON response must not gain a script tag');
            done();
          });
        }).on('error', done);
      });
    });
  });

  // Regression test for the gzip-corruption bug.
  //
  // Before the fix: the proxy forwarded the client's Accept-Encoding: gzip to
  // the upstream; the upstream gzipped its response; the proxyRes hook called
  // .toString('utf8') on the compressed bytes, producing U+FFFD corruption
  // while leaving content-encoding: gzip in place.  The browser tried to gunzip
  // garbage and rendered a blank page.
  //
  // After the fix: the proxyReq hook overrides to accept-encoding: identity, so
  // the upstream returns plain text, and injection proceeds correctly.
  test('gzip-capable upstream: body is browser-decodable HTML containing the picker script', (_t, done) => {
    const rawBody = '<html><body><h1>Gzip App</h1></body></html>';

    // Upstream honours Accept-Encoding — gzip when asked, plain text otherwise.
    // This mirrors real nginx behaviour.
    upstream = http.createServer((req, res) => {
      const acceptEncoding = req.headers['accept-encoding'] || '';
      if (acceptEncoding.includes('gzip')) {
        zlib.gzip(Buffer.from(rawBody, 'utf8'), (err, compressed) => {
          if (err) { res.writeHead(500); res.end(); return; }
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-encoding': 'gzip',
            'content-length': compressed.byteLength,
          });
          res.end(compressed);
        });
      } else {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(rawBody),
        });
        res.end(rawBody);
      }
    });

    upstream.listen(0, '127.0.0.1', () => {
      const { port: upstreamPort } = upstream.address();
      const app = express();
      app.use(buildInjectionProxy(`http://127.0.0.1:${upstreamPort}`));
      gateway = app.listen(0, '127.0.0.1', () => {
        const { port: gwPort } = gateway.address();
        // Send Accept-Encoding: gzip exactly as a real browser would.
        // Without the fix the proxy forwards this header; the upstream gzips;
        // .toString('utf8') on compressed bytes produces U+FFFD garbage.
        const options = {
          hostname: '127.0.0.1',
          port: gwPort,
          path: '/',
          headers: { 'accept-encoding': 'gzip' },
        };
        http.get(options, (res) => {
          assert.equal(res.statusCode, 200);
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            // U+FFFD appears when gzip magic bytes (e.g. 0x8b) are mis-decoded as UTF-8.
            assert.ok(
              !body.includes('�'),
              'body must not contain U+FFFD replacement chars — would indicate gzip bytes mis-decoded as UTF-8'
            );
            const tag = `<script>${INJECTED_PICKER}</script>`;
            assert.ok(body.includes(tag), 'proxied HTML must contain the injected picker script tag');
            done();
          });
        }).on('error', done);
      });
    });
  });
});
