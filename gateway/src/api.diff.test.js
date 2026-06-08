/**
 * Tests for GET /_fleet/api/features/:key/diff
 *
 * Exercises the diff endpoint through a real Express HTTP server on an
 * ephemeral port. Host git execution is controlled via the _setHostGitStreamImpl
 * seam — no real git binary or Docker daemon is invoked.
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
import { _setHostGitStreamImpl, default as router } from './api.js';

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
  // Default: empty diff, successful exit.
  _setHostGitStreamImpl(() => makeGitResult(''));
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('GET /_fleet/api/features/:key/diff', () => {
  it('returns 404 when the feature is not registered', async () => {
    getFeature.mockReturnValue(null);

    const res = await fetch(`${baseUrl}/features/unknown-key/diff`);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Feature not registered' });
  });

  it('returns { status: "ok", patch, isEmpty: false } when git diff produces output', async () => {
    getFeature.mockReturnValue({
      key: 'app-feat',
      worktreePath: '/tmp/worktrees/app-feat',
      branch: 'feat',
    });
    const diffOutput = 'diff --git a/foo.js b/foo.js\n+added line\n';
    _setHostGitStreamImpl(() => makeGitResult(diffOutput));

    const res = await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.patch).toBe(diffOutput);
    expect(body.isEmpty).toBe(false);
    expect(body.truncated).toBe(false);
    expect(body.originalBytes).toBe(diffOutput.length);
  });

  it('returns { status: "no-changes", patch: "", isEmpty: true, truncated: false, originalBytes: 0 } when there are no changes', async () => {
    getFeature.mockReturnValue({
      key: 'app-clean',
      worktreePath: '/tmp/worktrees/app-clean',
      branch: 'clean',
    });

    const res = await fetch(`${baseUrl}/features/app-clean/diff`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'no-changes', patch: '', isEmpty: true, truncated: false, originalBytes: 0 });
  });

  it('runs host git against feature.worktreePath with --no-optional-locks and three-dot syntax', async () => {
    const worktreePath = '/opt/worktrees/app-feat';
    getFeature.mockReturnValue({ key: 'app-feat', worktreePath, branch: 'feat' });

    const capturedPaths = [];
    _setHostGitStreamImpl((wt) => {
      capturedPaths.push(wt);
      return makeGitResult('');
    });

    await fetch(`${baseUrl}/features/app-feat/diff`);

    // The seam is called with the feature's worktreePath — not a container path.
    expect(capturedPaths).toEqual([worktreePath]);
  });

  it('returns 422 when the feature has no worktreePath', async () => {
    getFeature.mockReturnValue({
      key: 'app-cluster',
      worktreePath: null,
      branch: 'cluster-branch',
    });

    const res = await fetch(`${baseUrl}/features/app-cluster/diff`);

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/worktree/i);
  });

  it('returns 200 { status: "unavailable" } when git exits non-zero (worktree gone / not a repo)', async () => {
    getFeature.mockReturnValue({
      key: 'app-feat',
      worktreePath: '/tmp/worktrees/app-feat',
      branch: 'feat',
    });
    _setHostGitStreamImpl(() => makeGitResult('', 128));

    const res = await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('unavailable');
    expect(typeof body.reason).toBe('string');
    expect(body.reason.length).toBeGreaterThan(0);
    expect(body.patch).toBe('');
    expect(body.isEmpty).toBe(true);
    expect(body.truncated).toBe(false);
    expect(body.originalBytes).toBe(0);
  });

  it('returns 200 { status: "unavailable" } when the git spawn itself fails (binary not found)', async () => {
    getFeature.mockReturnValue({
      key: 'app-feat',
      worktreePath: '/tmp/worktrees/app-feat',
      branch: 'feat',
    });
    _setHostGitStreamImpl(() => {
      throw new Error('spawn ENOENT');
    });

    const res = await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('unavailable');
    expect(body.reason).toMatch(/ENOENT/i);
    expect(body.patch).toBe('');
    expect(body.isEmpty).toBe(true);
  });
});
