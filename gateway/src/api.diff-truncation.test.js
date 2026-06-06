/**
 * Tests for the 1 MB cap on GET /_fleet/api/features/:key/diff
 *
 * Uses Node's built-in test runner (node --test). No module-level mocking is
 * needed: a test seam (_setDiffSpawnImpl) lets tests inject a fake git process,
 * and the real registry module is used to register a throwaway test feature.
 *
 * Run with:
 *   cd gateway && node --test src/api.diff-truncation.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import express from 'express';
import { _setDiffSpawnImpl, default as router } from './api.js';
import { register, unregister } from './registry.js';

const DIFF_CAP_BYTES = 1_048_576;
const TEST_PROJECT = 'trunc-test';
const TEST_NAME = 'feat';
const TEST_KEY = `${TEST_PROJECT}-${TEST_NAME}`;

// ── Test server lifecycle ─────────────────────────────────────────────────────

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/_fleet/api', router);
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}/_fleet/api`;
      resolve();
    });
  });

  // Register a throwaway feature so the diff endpoint doesn't 404
  register(TEST_PROJECT, TEST_NAME, 'test-branch', '/tmp/trunc-test-worktree');
});

after(async () => {
  unregister(TEST_KEY);
  _setDiffSpawnImpl(spawn); // restore real spawn
  await new Promise((resolve) => server.close(resolve));
});

// ── Helper: fake child process that emits chunks then closes ──────────────────

/**
 * Creates a fake child process that emits the given chunks as stdout data
 * events, then fires close. When kill() is called, emission stops and close
 * fires on the next tick.
 *
 * @param {Array<Buffer|string>} chunks
 */
function makeFakeChild(chunks) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  let killed = false;

  child.kill = () => { killed = true; };

  setImmediate(function emitNext(remaining) {
    if (killed || remaining.length === 0) {
      child.emit('close', killed ? 143 : 0);
      return;
    }
    const chunk = remaining[0];
    child.stdout.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    setImmediate(emitNext, remaining.slice(1));
  }, [...chunks]);

  return child;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /features/:key/diff — 1 MB cap', () => {
  it('truncates a 2 MB patch to <= 1 MB and sets truncated=true', async () => {
    // 2 MB of ASCII 'A' bytes — byte length == string length, so patch.length is predictable
    const twoMB = Buffer.alloc(2 * 1024 * 1024, 65);
    _setDiffSpawnImpl(() => makeFakeChild([twoMB]));

    const res = await fetch(`${baseUrl}/features/${TEST_KEY}/diff`);
    assert.equal(res.status, 200, `unexpected status ${res.status}`);

    const body = await res.json();
    assert.equal(body.truncated, true, 'truncated should be true for a 2 MB patch');
    assert.ok(
      body.patch.length <= DIFF_CAP_BYTES,
      `patch.length ${body.patch.length} should be <= cap ${DIFF_CAP_BYTES}`,
    );
    assert.ok(
      body.originalBytes > DIFF_CAP_BYTES,
      `originalBytes ${body.originalBytes} should exceed the cap for a 2 MB input`,
    );
  });

  it('does not set truncated for a below-cap patch', async () => {
    const smallPatch = 'diff --git a/foo.js b/foo.js\n+small change\n';
    _setDiffSpawnImpl(() => makeFakeChild([smallPatch]));

    const res = await fetch(`${baseUrl}/features/${TEST_KEY}/diff`);
    assert.equal(res.status, 200, `unexpected status ${res.status}`);

    const body = await res.json();
    assert.equal(body.truncated, false, 'truncated should be false for a small patch');
    assert.equal(
      body.originalBytes,
      smallPatch.length,
      'originalBytes should equal patch length for below-cap patches',
    );
  });
});
