/**
 * Tests for GET /_fleet/api/host-stats
 *
 * Uses vitest with vi.mock to isolate the host-metrics module, then
 * starts a real HTTP server on an ephemeral port so requests travel
 * through the full Express router — same observable path as a real caller.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import express from 'express';

// ── mock host-metrics before importing api.js ─────────────────────────────────
vi.mock('./host-metrics.js', () => ({
  getHostMetrics: vi.fn(),
}));

// ── stub out the other api.js collaborators so no real Docker/registry needed ─
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

// ── import after mocks are in place ──────────────────────────────────────────
import { getHostMetrics } from './host-metrics.js';
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

// ── tests ─────────────────────────────────────────────────────────────────────

describe('GET /_fleet/api/host-stats', () => {
  it('returns 200 with the object from getHostMetrics on success', async () => {
    const metrics = {
      cpuPercent: 42,
      cpuCores: 8,
      memTotalMB: 16384,
      memFreeMB: 4096,
      memUsedMB: 12288,
    };
    getHostMetrics.mockResolvedValue(metrics);

    const res = await fetch(`${baseUrl}/host-stats`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(metrics);
  });

  it('returns 503 with { error } when getHostMetrics throws', async () => {
    getHostMetrics.mockRejectedValue(new Error('os.cpus failed'));

    const res = await fetch(`${baseUrl}/host-stats`);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: 'os.cpus failed' });
  });

  it('does not crash the server after a metrics error — subsequent requests succeed', async () => {
    getHostMetrics.mockRejectedValueOnce(new Error('transient'));

    const failing = await fetch(`${baseUrl}/host-stats`);
    expect(failing.status).toBe(503);

    const metrics = { cpuPercent: 5, cpuCores: 4, memTotalMB: 8192, memFreeMB: 2048, memUsedMB: 6144 };
    getHostMetrics.mockResolvedValueOnce(metrics);

    const ok = await fetch(`${baseUrl}/host-stats`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(metrics);
  });
});
