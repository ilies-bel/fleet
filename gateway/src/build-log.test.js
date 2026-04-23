// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Integration tests for the build-log ring buffer + SSE endpoints.
 *
 * Uses Node.js built-in test runner (node:test). No external test deps.
 * The registry is module-level state — tests share it and explicitly clean up
 * via unregister() in beforeEach to stay isolated.
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

// ── HTTP helpers ─────────────────────────────────────────────────────────────

/**
 * Fire a single HTTP request and return { status, body }.
 */
function request(server, { method, path, body, contentType = 'application/json' }) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const port = addr.port;
    const payload = body !== undefined
      ? (contentType === 'text/plain' ? body : JSON.stringify(body))
      : undefined;

    const options = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': contentType,
        ...(payload != null ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
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
    if (payload != null) req.write(payload);
    req.end();
  });
}

/** Project name used in all build-log tests. */
const TEST_PROJECT = 'testproj';

/**
 * Register a feature under TEST_PROJECT, then POST a build-log chunk.
 * Returns the composite key `${TEST_PROJECT}-${name}`.
 */
async function registerFeature(server, name) {
  await request(server, {
    method: 'POST',
    path: '/register-feature',
    body: { project: TEST_PROJECT, name, branch: 'main', status: 'building' },
  });
  return `${TEST_PROJECT}-${name}`;
}

/**
 * POST a plain-text build-log chunk.
 * @param {http.Server} server
 * @param {string} key  composite key `${project}-${name}`
 * @param {string} text
 */
async function postLog(server, key, text) {
  return request(server, {
    method: 'POST',
    path: `/_fleet/api/features/${key}/build-log`,
    body: text,
    contentType: 'text/plain',
  });
}

/**
 * Consume the first N SSE data lines from the build-log SSE endpoint, then
 * abort the connection and return those lines.
 * @param {http.Server} server
 * @param {string} key  composite key `${project}-${name}`
 * @param {number} count
 * @param {number} [timeoutMs]
 */
function collectSseLines(server, key, count, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const port = addr.port;
    const lines = [];
    const timer = setTimeout(() => {
      req.destroy();
      resolve(lines); // return what we got before timeout
    }, timeoutMs);

    const options = {
      hostname: '127.0.0.1',
      port,
      path: `/_fleet/api/features/${key}/build-log`,
      method: 'GET',
    };

    const req = http.request(options, (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        // Extract data: lines
        const parts = buf.split('\n');
        buf = parts.pop(); // keep partial last line
        for (const part of parts) {
          const trimmed = part.trim();
          if (trimmed.startsWith('data:')) {
            lines.push(trimmed.slice(5).trim());
          }
        }
        if (lines.length >= count) {
          clearTimeout(timer);
          req.destroy();
          resolve(lines.slice(0, count));
        }
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve(lines);
      });
    });

    req.on('error', (err) => {
      if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
        clearTimeout(timer);
        resolve(lines);
        return;
      }
      clearTimeout(timer);
      reject(err);
    });

    req.end();
  });
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('Build log endpoints', () => {
  let server;

  beforeEach((t, done) => {
    for (const f of getAll()) unregister(f.key);
    if (server) {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => {
        server = buildApp().listen(0, '127.0.0.1', done);
      });
    } else {
      server = buildApp().listen(0, '127.0.0.1', done);
    }
  });

  after((t, done) => {
    if (server) {
      // Force-close any lingering keep-alive / SSE connections so server.close()
      // resolves immediately (Node 18.2+ provides closeAllConnections).
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      server.close(done);
    } else {
      done();
    }
  });

  // ── POST /build-log ─────────────────────────────────────────────────────

  test('POST /build-log returns 404 for unregistered feature', async () => {
    const res = await postLog(server, 'testproj-ghost', 'hello\n');
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });

  test('POST /build-log appends lines and returns {ok:true}', async () => {
    const key = await registerFeature(server, 'foo');
    const res = await postLog(server, key, 'line one\nline two\n');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  // ── GET /build-log (replay) ──────────────────────────────────────────────

  test('GET /build-log returns 404 for unregistered feature', async () => {
    const res = await request(server, {
      method: 'GET',
      path: '/_fleet/api/features/testproj-ghost/build-log',
    });
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });

  test('GET /build-log replays buffered lines via SSE', async () => {
    const key = await registerFeature(server, 'replay-test');
    await postLog(server, key, 'alpha\nbeta\ngamma\n');

    const lines = await collectSseLines(server, key, 3);
    assert.equal(lines.length, 3);
    assert.equal(lines[0], 'alpha');
    assert.equal(lines[1], 'beta');
    assert.equal(lines[2], 'gamma');
  });

  // ── ANSI stripping ───────────────────────────────────────────────────────

  test('ANSI escape sequences are stripped on POST', async () => {
    const key = await registerFeature(server, 'ansi-test');
    // Post a line with colour codes: ESC[32m = green, ESC[0m = reset
    await postLog(server, key, '\x1B[32mStep 1/10\x1B[0m\n');

    const lines = await collectSseLines(server, key, 1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], 'Step 1/10');
  });

  // ── Buffer cap ───────────────────────────────────────────────────────────

  test('buffer is capped at 500 lines (oldest lines dropped)', async () => {
    const key = await registerFeature(server, 'cap-test');
    // Post 600 lines in one chunk
    const chunk = Array.from({ length: 600 }, (_, i) => `line-${i}`).join('\n') + '\n';
    await postLog(server, key, chunk);

    // Collect first batch — should be capped to 500
    const lines = await collectSseLines(server, key, 500, 5000);
    assert.ok(lines.length <= 500, `expected ≤500 lines, got ${lines.length}`);
    // Oldest lines (0-99) should have been shifted off; newest should be present
    assert.ok(lines.includes('line-599'), 'last line should be present');
    assert.ok(!lines.includes('line-0'), 'oldest evicted lines should be gone');
  });

  // ── Multiple subscribers ─────────────────────────────────────────────────

  test('multiple SSE subscribers receive the same data', async () => {
    const key = await registerFeature(server, 'multi-sub');

    // Open two SSE connections before posting
    const p1 = collectSseLines(server, key, 2, 3000);
    const p2 = collectSseLines(server, key, 2, 3000);

    // Give both connections time to subscribe
    await new Promise(r => setTimeout(r, 50));

    await postLog(server, key, 'msg-a\nmsg-b\n');

    const [l1, l2] = await Promise.all([p1, p2]);
    assert.deepEqual(l1, ['msg-a', 'msg-b']);
    assert.deepEqual(l2, ['msg-a', 'msg-b']);
  });
});
