/**
 * Tests for GET /_fleet/api/features/:key/diff
 *
 * Exercises the diff endpoint through a real Express HTTP server on an
 * ephemeral port. dockerExecStream is mocked so no real Docker daemon or git
 * binary is invoked — we are testing the HTTP contract, not git itself.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { PassThrough } from 'node:stream';
import express from 'express';

// ── mock child_process before importing api.js (api.js uses spawn in other routes) ──
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
  dockerExecStream: vi.fn(),
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
import { dockerExec, dockerExecStream, inspectContainer } from './docker.js';
import router from './api.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Wrap a string in a PassThrough stream so the streaming diff handler can
 * consume it like a real docker exec response.
 * @param {string} str
 * @returns {import('stream').PassThrough}
 */
function makeStream(str) {
  const pt = new PassThrough();
  if (str) pt.write(Buffer.from(str, 'utf8'));
  pt.end();
  return pt;
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
  // Default: probe succeeds (git is available inside the container).
  dockerExec.mockResolvedValue('true\n');
  // Default: container has BACKEND_DIR=backend so the handler resolves /app/backend.
  inspectContainer.mockResolvedValue({ Config: { Env: ['BACKEND_DIR=backend'] } });
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
    dockerExecStream.mockResolvedValue({ stdout: makeStream(diffOutput), abort: vi.fn() });

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
    dockerExecStream.mockResolvedValue({ stdout: makeStream(''), abort: vi.fn() });

    const res = await fetch(`${baseUrl}/features/app-clean/diff`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'no-changes', patch: '', isEmpty: true, truncated: false, originalBytes: 0 });
  });

  it('invokes dockerExecStream with --no-optional-locks and three-dot merge-base syntax', async () => {
    getFeature.mockReturnValue({
      key: 'app-feat',
      worktreePath: '/opt/worktrees/app-feat',
      branch: 'feat',
    });
    dockerExecStream.mockResolvedValue({ stdout: makeStream(''), abort: vi.fn() });

    await fetch(`${baseUrl}/features/app-feat/diff`);

    // BACKEND_DIR=backend (default from beforeEach) resolves to /app/backend.
    expect(dockerExecStream).toHaveBeenCalledWith(
      'fleet-app-feat',
      ['git', '--no-optional-locks', '-C', '/app/backend', 'diff', 'main...HEAD'],
    );
  });

  it('uses BACKEND_DIR from container env: resolves git -C to /app/backend', async () => {
    getFeature.mockReturnValue({
      key: 'app-feat',
      worktreePath: '/tmp/worktrees/app-feat',
      branch: 'feat',
    });
    inspectContainer.mockResolvedValue({ Config: { Env: ['BACKEND_DIR=backend'] } });
    dockerExecStream.mockResolvedValue({ stdout: makeStream(''), abort: vi.fn() });

    await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(dockerExec).toHaveBeenCalledWith(
      'fleet-app-feat',
      ['git', '-C', '/app/backend', 'rev-parse', '--is-inside-work-tree'],
    );
    expect(dockerExecStream).toHaveBeenCalledWith(
      'fleet-app-feat',
      ['git', '--no-optional-locks', '-C', '/app/backend', 'diff', 'main...HEAD'],
    );
  });

  it('returns 200 { status: "unavailable" } when inspectContainer returns null (container not found)', async () => {
    getFeature.mockReturnValue({
      key: 'app-feat',
      worktreePath: '/tmp/worktrees/app-feat',
      branch: 'feat',
    });
    inspectContainer.mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('unavailable');
    expect(body.reason).toMatch(/container not found/i);
    expect(body.patch).toBe('');
    expect(body.isEmpty).toBe(true);
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

  it('returns 500 when dockerExecStream rejects after a successful probe', async () => {
    getFeature.mockReturnValue({
      key: 'app-feat',
      worktreePath: '/tmp/worktrees/app-feat',
      branch: 'feat',
    });
    // Probe succeeds (already set in beforeEach); diff stream fails unexpectedly.
    dockerExecStream.mockRejectedValue(new Error('docker exec stream error'));

    const res = await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/docker exec stream error/i);
  });

  it('returns 200 { status: "unavailable" } when the probe exec throws (container not running)', async () => {
    getFeature.mockReturnValue({
      key: 'app-feat',
      worktreePath: '/tmp/worktrees/app-feat',
      branch: 'feat',
    });
    dockerExec.mockRejectedValue(new Error("Container 'fleet-app-feat' is not running"));

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

  it('returns 200 { status: "unavailable" } when the probe output does not contain "true" (not a git repo)', async () => {
    getFeature.mockReturnValue({
      key: 'app-feat',
      worktreePath: '/tmp/worktrees/app-feat',
      branch: 'feat',
    });
    dockerExec.mockResolvedValue('fatal: not a git repository\n');

    const res = await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('unavailable');
    expect(body.reason).toBe('not a git repository');
    expect(body.patch).toBe('');
    expect(body.isEmpty).toBe(true);
  });
});
