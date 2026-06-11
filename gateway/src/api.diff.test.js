/**
 * Tests for GET /_fleet/api/features/:key/diff
 *
 * Exercises the diff endpoint through a real Express HTTP server on an
 * ephemeral port. The container git exec is controlled via the
 * _setContainerGitStreamImpl seam — no real Docker daemon is invoked.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
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
import { _setContainerGitStreamImpl, _setDiffTimeoutMs, default as router } from './api.js';

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
  _setContainerGitStreamImpl(() => makeGitResult(''));
  // Reset timeout to a safe high value so normal tests never hit it.
  _setDiffTimeoutMs(15_000);
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
      gitDir: '/tmp/worktrees/app-feat/.git',
      worktreePath: '/tmp/worktrees/app-feat',
      branch: 'feat',
    });
    const diffOutput = 'diff --git a/foo.js b/foo.js\n+added line\n';
    _setContainerGitStreamImpl(() => makeGitResult(diffOutput));

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
      gitDir: '/tmp/worktrees/app-clean/.git',
      worktreePath: '/tmp/worktrees/app-clean',
      branch: 'clean',
    });

    const res = await fetch(`${baseUrl}/features/app-clean/diff`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'no-changes', patch: '', isEmpty: true, truncated: false, originalBytes: 0 });
  });

  it('execs git inside the feature container derived from the feature key', async () => {
    const worktreePath = '/opt/worktrees/app-feat';
    getFeature.mockReturnValue({ key: 'app-feat', gitDir: `${worktreePath}/.git`, worktreePath, branch: 'feat' });

    const capturedContainers = [];
    _setContainerGitStreamImpl((name) => {
      capturedContainers.push(name);
      return makeGitResult('');
    });

    await fetch(`${baseUrl}/features/app-feat/diff`);

    // Container name is fleet-<key>; the seam never receives a host path.
    expect(capturedContainers).toEqual(['fleet-app-feat']);
  });

  it('returns 200 unavailable when the feature has no worktreePath', async () => {
    getFeature.mockReturnValue({
      key: 'app-cluster',
      gitDir: '/repo/.git',
      worktreePath: null,
      branch: 'cluster-branch',
    });

    const res = await fetch(`${baseUrl}/features/app-cluster/diff`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('unavailable');
    expect(body.reason).toMatch(/worktree/i);
  });

  it('returns 200 unavailable without executing docker for a cluster-hosted feature with no worktreePath', async () => {
    getFeature.mockReturnValue({
      key: 'app-cluster',
      // no worktreePath — cluster-hosted feature, no local worktree on this host
      host: 'k8s.example.internal',
      branch: 'feat/cluster-branch',
    });

    let execCalled = false;
    _setContainerGitStreamImpl(() => { execCalled = true; return makeGitResult(''); });

    const res = await fetch(`${baseUrl}/features/app-cluster/diff`);

    expect(execCalled).toBe(false);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: 'unavailable',
      reason: 'no local worktree',
      patch: '',
      isEmpty: true,
      truncated: false,
      originalBytes: 0,
    });
  });

  it('returns 200 { status: "unavailable" } when git exits non-zero (worktree gone / not a repo)', async () => {
    getFeature.mockReturnValue({
      key: 'app-feat',
      gitDir: '/tmp/worktrees/app-feat/.git',
      worktreePath: '/tmp/worktrees/app-feat',
      branch: 'feat',
    });
    _setContainerGitStreamImpl(() => makeGitResult('', 128));

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

  it('returns 200 { status: "unavailable" } when the container exec itself fails (container not running)', async () => {
    getFeature.mockReturnValue({
      key: 'app-feat',
      gitDir: '/tmp/worktrees/app-feat/.git',
      worktreePath: '/tmp/worktrees/app-feat',
      branch: 'feat',
    });
    _setContainerGitStreamImpl(() => {
      throw new Error('Container not running');
    });

    const res = await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('unavailable');
    expect(body.reason).toMatch(/Container not running/i);
    expect(body.patch).toBe('');
    expect(body.isEmpty).toBe(true);
  });

  it('attempts in-container exec even when gitDir is undefined (gateway-in-container condition)', async () => {
    // Regression: the gateway runs inside Docker and cannot statSync host paths,
    // so resolveGitContext() always returns gitDir=undefined in production.
    // The diff endpoint must gate on worktreePath (host-independent), not gitDir,
    // so locally-hosted features are not permanently broken in production.
    getFeature.mockReturnValue({
      key: 'app-feat',
      gitDir: undefined,           // as resolveGitContext returns when statSync fails in container
      worktreePath: '/Users/host/projects/app/.worktrees/feat',
      branch: 'feat',
    });
    const diffOutput = 'diff --git a/App.java b/App.java\n+  // fix\n';
    let execCalledWith = null;
    _setContainerGitStreamImpl((name) => {
      execCalledWith = name;
      return makeGitResult(diffOutput);
    });

    const res = await fetch(`${baseUrl}/features/app-feat/diff`);

    // Exec must be attempted despite gitDir being undefined.
    expect(execCalledWith).toBe('fleet-app-feat');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.patch).toBe(diffOutput);
  });

  it('resolves within a bounded time when the stream never ends (server-side timeout)', async () => {
    getFeature.mockReturnValue({
      key: 'app-feat',
      worktreePath: '/tmp/worktrees/app-feat',
      branch: 'feat',
    });

    // A stream that emits data but never calls end/close — simulates a hanging TTY exec.
    const hangingStdout = new EventEmitter();
    _setContainerGitStreamImpl(() => ({
      stdout: hangingStdout,
      abort: vi.fn(),
      // exitCode promise never resolves (exec hangs)
      exitCode: new Promise(() => {}),
    }));

    // Set a short timeout so the test completes quickly.
    _setDiffTimeoutMs(150);

    const start = Date.now();
    const res = await fetch(`${baseUrl}/features/app-feat/diff`);
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('unavailable');
    expect(body.reason).toMatch(/timed out/i);
    expect(body.patch).toBe('');
    expect(body.isEmpty).toBe(true);
    // Should resolve close to the timeout, well within 3s.
    expect(elapsed).toBeLessThan(3_000);
  });
});
