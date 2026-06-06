/**
 * Tests for GET /_fleet/api/features/:key/diff when the feature is a linked
 * git worktree (the worktree's .git is a pointer file, not a directory).
 *
 * For linked-worktree features the registry carries `gitDir` and `gitCommonDir`
 * fields that are used to mount the main repo's object store read-only into the
 * feature container.  The diff endpoint itself is unchanged — it still runs
 * `git diff main...HEAD` via dockerExec — so these tests verify that the
 * presence of the extra registry fields does not break the response contract
 * and that the same patch is returned as for a normal-repo feature.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
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
import { dockerExec } from './docker.js';
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

// ── a linked-worktree feature entry ──────────────────────────────────────────
const LINKED_FEATURE = {
  key: 'app-feat',
  worktreePath: '/main/.worktrees/feat',
  // .git pointer file inside the worktree points here:
  gitDir: '/main/.git/worktrees/feat',
  // main repo's object store (two levels up from the per-worktree gitdir):
  gitCommonDir: '/main/.git',
  branch: 'feat',
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe('GET /_fleet/api/features/:key/diff — linked-worktree feature', () => {
  it('returns { patch, isEmpty: false } for a linked-worktree feature with a non-empty diff', async () => {
    getFeature.mockReturnValue(LINKED_FEATURE);
    const diffOutput = 'diff --git a/src/Foo.java b/src/Foo.java\n+  // new line\n';
    dockerExec.mockResolvedValue(diffOutput);

    const res = await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.patch).toBe(diffOutput);
    expect(body.isEmpty).toBe(false);
    expect(body.truncated).toBe(false);
    expect(body.originalBytes).toBe(diffOutput.length);
  });

  it('returns { patch: "", isEmpty: true } for a linked-worktree feature with no changes', async () => {
    getFeature.mockReturnValue(LINKED_FEATURE);
    dockerExec.mockResolvedValue('');

    const res = await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ patch: '', isEmpty: true, truncated: false, originalBytes: 0 });
  });

  it('invokes dockerExec with the same args as for a normal-repo feature', async () => {
    getFeature.mockReturnValue(LINKED_FEATURE);
    dockerExec.mockResolvedValue('');

    await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(dockerExec).toHaveBeenCalledWith(
      'fleet-app-feat',
      ['git', '--no-optional-locks', '-C', '/app', 'diff', 'main...HEAD'],
    );
  });

  it('returns 500 when dockerExec rejects for a linked-worktree feature', async () => {
    getFeature.mockReturnValue(LINKED_FEATURE);
    dockerExec.mockRejectedValue(new Error('fatal: not a git repository'));

    const res = await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/not a git repository/i);
  });

  it('returns 422 when a linked-worktree feature has no worktreePath', async () => {
    getFeature.mockReturnValue({ ...LINKED_FEATURE, worktreePath: null });

    const res = await fetch(`${baseUrl}/features/app-feat/diff`);

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/worktree/i);
  });
});
