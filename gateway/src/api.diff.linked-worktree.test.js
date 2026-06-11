/**
 * Tests for GET /_fleet/api/features/:key/diff when the feature lives in a
 * git linked worktree.
 *
 * In-container diff runs `git -C /var/fleet/git/worktree diff main...HEAD` inside
 * the feature container via docker exec. The dedicated read-only mount at
 * /var/fleet/git/worktree (established by slice 2) provides the worktree root
 * with its .git pointer and the full common object store, so the command resolves
 * regardless of whether the feature is a normal or linked worktree on the host.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { PassThrough } from 'node:stream';
import express from 'express';

// ── mock child_process before importing api.js ────────────────────────────────
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
}));

// ── stub out api.js collaborators so no real Docker/registry needed ───────────
vi.mock('./registry.js', () => ({
  getAll: vi.fn(() => []),
  getFeature: vi.fn(() => null),
  setActiveFeature: vi.fn(),
  getActiveFeature: vi.fn(() => null),
  unregister: vi.fn(),
  updateStatus: vi.fn(),
  getContainerStatus: vi.fn(),
  appendBuildLog: vi.fn(),
  getBuildLog: vi.fn(() => ({ lines: [] })),
  subscribeBuildLog: vi.fn(() => () => {}),
}));

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

vi.mock('./cluster/bootstrap.js', () => ({
  bootstrap: vi.fn(),
}));

vi.mock('./backend.js', () => ({
  stopFeature: vi.fn(),
}));

vi.mock('./host-metrics.js', () => ({
  getHostMetrics: vi.fn(),
}));

// ── import after mocks are in place ──────────────────────────────────────────
import { getFeature } from './registry.js';
import { _setContainerGitStreamImpl, default as router } from './api.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeStream(str) {
  const pt = new PassThrough();
  if (str) pt.write(Buffer.from(str, 'utf8'));
  pt.end();
  return pt;
}

function makeGitResult(str, exitCode = 0) {
  return {
    stdout: makeStream(str),
    abort: vi.fn(),
    exitCode: Promise.resolve(exitCode),
  };
}

// ── test server lifecycle ─────────────────────────────────────────────────────
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
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  _setContainerGitStreamImpl(() => makeGitResult(''));
});

// ── a linked-worktree feature entry (worktreePath is checked by the diff endpoint) ──
const LINKED_FEATURE = {
  key: 'app-feat',
  worktreePath: '/main/.worktrees/feat',
  branch: 'feat',
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe('GET /_fleet/api/features/:key/diff — linked-worktree feature', () => {
  it('returns { patch, isEmpty: false } for a linked-worktree feature with a non-empty diff', async () => {
    getFeature.mockReturnValue(LINKED_FEATURE);
    const diffOutput = 'diff --git a/src/Foo.java b/src/Foo.java\n+  // new line\n';
    _setContainerGitStreamImpl(() => makeGitResult(diffOutput));

    const res = await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.patch).toBe(diffOutput);
    expect(body.isEmpty).toBe(false);
    expect(body.truncated).toBe(false);
    expect(body.originalBytes).toBe(diffOutput.length);
  });

  it('returns { status: "no-changes", patch: "", isEmpty: true } for a linked-worktree feature with no changes', async () => {
    getFeature.mockReturnValue(LINKED_FEATURE);

    const res = await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'no-changes', patch: '', isEmpty: true, truncated: false, originalBytes: 0 });
  });

  it('execs git inside the feature container (not against a host worktree path)', async () => {
    getFeature.mockReturnValue(LINKED_FEATURE);
    const capturedContainers = [];
    _setContainerGitStreamImpl((name) => {
      capturedContainers.push(name);
      return makeGitResult('');
    });

    await fetch(`${baseUrl}/features/app-feat/diff`);

    // The seam receives the container name fleet-<key>, never the host worktreePath.
    expect(capturedContainers).toEqual(['fleet-app-feat']);
  });

  it('returns 200 { status: "unavailable" } when git exits non-zero for a linked-worktree feature', async () => {
    getFeature.mockReturnValue(LINKED_FEATURE);
    _setContainerGitStreamImpl(() => makeGitResult('', 128));

    const res = await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('unavailable');
    expect(typeof body.reason).toBe('string');
    expect(body.patch).toBe('');
    expect(body.isEmpty).toBe(true);
  });

  it('returns 200 unavailable when a linked-worktree feature has no worktreePath', async () => {
    getFeature.mockReturnValue({ ...LINKED_FEATURE, worktreePath: null });

    const res = await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('unavailable');
    expect(body.reason).toMatch(/worktree/i);
  });
});
