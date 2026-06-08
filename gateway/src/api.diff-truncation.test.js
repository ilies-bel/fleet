/**
 * Tests for the 1 MB cap on GET /_fleet/api/features/:key/diff
 *
 * Uses Vitest. The _setContainerGitStreamImpl seam lets tests inject a fake
 * streaming exec result without requiring a real Docker daemon. The real
 * registry module is used to register a throwaway test feature.
 *
 * Run with:
 *   cd gateway && npx vitest run src/api.diff-truncation.test.js
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import express from 'express';

// ── mock child_process (api.js imports spawn for other routes) ────────────────
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
}));

// ── mock heavy docker collaborators — not needed for this test ────────────────
vi.mock('./docker.js', () => ({
  dockerExec: vi.fn(),
  dockerExecStreamWithExitCode: vi.fn(),
  dockerLogs: vi.fn(),
  stopContainer: vi.fn(),
  startContainer: vi.fn(),
  getContainerStats: vi.fn(),
  inspectContainer: vi.fn(),
  DockerSocketError: class DockerSocketError extends Error {},
  DockerContainerError: class DockerContainerError extends Error {},
}));

vi.mock('./cluster/bootstrap.js', () => ({ bootstrap: vi.fn() }));
vi.mock('./backend.js', () => ({ stopFeature: vi.fn() }));
vi.mock('./host-metrics.js', () => ({ getHostMetrics: vi.fn() }));

// ── import after mocks ────────────────────────────────────────────────────────
import { _setContainerGitStreamImpl, default as router } from './api.js';
import { register, unregister } from './registry.js';

const DIFF_CAP_BYTES = 1_048_576;
const TEST_PROJECT = 'trunc-test';
const TEST_NAME = 'feat';
const TEST_KEY = `${TEST_PROJECT}-${TEST_NAME}`;

// ── Test server lifecycle ─────────────────────────────────────────────────────

let server;
let baseUrl;

beforeAll(async () => {
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

afterAll(async () => {
  unregister(TEST_KEY);
  await new Promise((resolve) => server.close(resolve));
});

// ── Helper: fake streaming exec result that emits chunks then closes ──────────

/**
 * Creates a fake container exec stream result with a stdout EventEmitter that
 * emits the given chunks as data events then fires end/close. When abort() is
 * called, emission stops and close fires on the next tick.
 *
 * @param {Array<Buffer|string>} chunks
 * @returns {{ stdout: EventEmitter, abort: () => void, exitCode: Promise<number> }}
 */
function makeFakeStream(chunks) {
  const stdout = new EventEmitter();
  let aborted = false;

  const abort = () => { aborted = true; };

  setImmediate(function emitNext(remaining) {
    if (aborted) {
      stdout.emit('close');
      return;
    }
    if (remaining.length === 0) {
      stdout.emit('end');
      stdout.emit('close');
      return;
    }
    const chunk = remaining[0];
    stdout.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    setImmediate(emitNext, remaining.slice(1));
  }, [...chunks]);

  return { stdout, abort, exitCode: Promise.resolve(0) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /features/:key/diff — 1 MB cap', () => {
  it('truncates a 2 MB patch to <= 1 MB and sets truncated=true', async () => {
    // 2 MB of ASCII 'A' bytes — byte length == string length, so patch.length is predictable
    const twoMB = Buffer.alloc(2 * 1024 * 1024, 65);
    _setContainerGitStreamImpl(() => makeFakeStream([twoMB]));

    const res = await fetch(`${baseUrl}/features/${TEST_KEY}/diff`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.truncated).toBe(true);
    expect(body.patch.length).toBeLessThanOrEqual(DIFF_CAP_BYTES);
    expect(body.originalBytes).toBeGreaterThan(DIFF_CAP_BYTES);
  });

  it('does not set truncated for a below-cap patch', async () => {
    const smallPatch = 'diff --git a/foo.js b/foo.js\n+small change\n';
    _setContainerGitStreamImpl(() => makeFakeStream([smallPatch]));

    const res = await fetch(`${baseUrl}/features/${TEST_KEY}/diff`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.truncated).toBe(false);
    expect(body.originalBytes).toBe(smallPatch.length);
  });
});
