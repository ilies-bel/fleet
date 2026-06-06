/**
 * Tests for GET /_fleet/api/features/:key/diff
 *
 * Exercises the diff endpoint through a real Express HTTP server on an
 * ephemeral port. child_process.spawn is mocked so no real git binary
 * is invoked — we are testing the HTTP contract, not git itself.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import express from 'express';
import { EventEmitter } from 'events';

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
import { spawn } from 'child_process';
import { getFeature } from './registry.js';
import router from './api.js';

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
});

// ── helper: create a fake child process that emits stdout then closes ─────────

/**
 * @param {{ stdout?: string, error?: Error }} opts
 */
function makeChildProcess({ stdout = '', error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  setImmediate(() => {
    if (error) {
      child.emit('error', error);
    } else {
      if (stdout.length > 0) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', 0);
    }
  });

  return child;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('GET /_fleet/api/features/:key/diff', () => {
  it('returns 404 when the feature is not registered', async () => {
    getFeature.mockReturnValue(null);

    const res = await fetch(`${baseUrl}/features/unknown-key/diff`);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Feature not registered' });
  });

  it('returns { patch, isEmpty: false } when git diff produces output', async () => {
    getFeature.mockReturnValue({
      key: 'app-feat',
      worktreePath: '/tmp/worktrees/app-feat',
      branch: 'feat',
    });
    const diffOutput = 'diff --git a/foo.js b/foo.js\n+added line\n';
    spawn.mockImplementation(() => makeChildProcess({ stdout: diffOutput }));

    const res = await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.patch).toBe(diffOutput);
    expect(body.isEmpty).toBe(false);
    expect(body.truncated).toBe(false);
    expect(body.originalBytes).toBe(diffOutput.length);
  });

  it('returns { patch: "", isEmpty: true } when there are no changes', async () => {
    getFeature.mockReturnValue({
      key: 'app-clean',
      worktreePath: '/tmp/worktrees/app-clean',
      branch: 'clean',
    });
    spawn.mockImplementation(() => makeChildProcess({ stdout: '' }));

    const res = await fetch(`${baseUrl}/features/app-clean/diff`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.patch).toBe('');
    expect(body.isEmpty).toBe(true);
  });

  it('invokes git with the three-dot merge-base syntax', async () => {
    getFeature.mockReturnValue({
      key: 'app-feat',
      worktreePath: '/opt/worktrees/app-feat',
      branch: 'feat',
    });
    spawn.mockImplementation(() => makeChildProcess());

    await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['-C', '/opt/worktrees/app-feat', 'diff', 'main...HEAD'],
    );
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

  it('returns 500 when git exits with an error', async () => {
    getFeature.mockReturnValue({
      key: 'app-feat',
      worktreePath: '/tmp/worktrees/app-feat',
      branch: 'feat',
    });
    spawn.mockImplementation(() =>
      makeChildProcess({ error: new Error('fatal: not a git repository') }),
    );

    const res = await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/not a git repository/i);
  });
});
