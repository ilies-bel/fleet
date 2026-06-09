/**
 * Tests for runRebuild artifact selection.
 *
 * Verifies that runRebuild branches on railpack.json presence:
 *   - plan feature (railpack-plan.json present at .fleet/<key>/railpack-plan.json)
 *     → docker buildx build --load --no-cache --build-arg BUILDKIT_SYNTAX=...
 *       -t <image> -f <railpack-plan.json> <FLEET_PROJECT_ROOT>/<key>
 *   - no plan (railpack-plan.json absent)
 *     → runRebuild rejects with a clear error naming the feature key
 *       (fragment Dockerfiles are no longer supported)
 *
 * Strategy:
 *   - Real registry (seeded via register(), cleared after each test).
 *   - Real file system using a per-test tmp directory.
 *   - spawn replaced via _setSpawnImpl so no Docker socket is needed.
 *   - global.fetch stubbed so the health-poll resolves immediately.
 *
 * Uses Node.js built-in test runner (node:test).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

import { runRebuild, _setSpawnImpl } from './api.js';
import { register, unregister, getAll } from './registry.js';
import { openLogStore } from './log-store.js';

/** Constant must match the value pinned in api.js. */
const RAILPACK_FRONTEND_IMAGE = 'ghcr.io/railwayapp/railpack-frontend:latest';

function clearRegistry() {
  for (const f of getAll()) unregister(f.key);
}

/**
 * Returns a spawn stub that captures each call and exits 0 immediately.
 * Each invocation pushes { cmd, args } onto the capturedCalls array.
 */
function makeSpawnStub(capturedCalls) {
  return (cmd, args) => {
    capturedCalls.push({ cmd, args: [...args] });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setImmediate(() => proc.emit('close', 0));
    return proc;
  };
}

describe('runRebuild artifact selection', () => {
  let tmpDir;
  let savedEnv;
  let savedFetch;
  let capturedCalls;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fleet-rebuild-vite-test-'));

    // Snapshot and override environment variables
    savedEnv = {
      FLEET_PROJECT_ROOT: process.env.FLEET_PROJECT_ROOT,
      FLEET_ROOT: process.env.FLEET_ROOT,
      FLEET_LOG_DB: process.env.FLEET_LOG_DB,
    };
    process.env.FLEET_PROJECT_ROOT = tmpDir;
    process.env.FLEET_ROOT = join(tmpDir, 'fleet-root');
    process.env.FLEET_LOG_DB = join(tmpDir, 'test.db');
    openLogStore();

    clearRegistry();

    capturedCalls = [];
    _setSpawnImpl(makeSpawnStub(capturedCalls));

    // Mock global.fetch so health-poll resolves immediately as healthy
    savedFetch = global.fetch;
    global.fetch = async () => ({ ok: true });
  });

  afterEach(() => {
    clearRegistry();
    // Restore the real spawn so other test files are not affected
    _setSpawnImpl(spawn);
    global.fetch = savedFetch;

    // Restore environment variables
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }

    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Vite feature path ───────────────────────────────────────────────────────

  test('plan feature: railpack-plan.json present → docker buildx build with BUILDKIT_SYNTAX arg', async () => {
    const key = 'myproj-frontend';

    // Build the fake fleet directory tree
    const fleetDir = join(tmpDir, '.fleet', key);
    mkdirSync(fleetDir, { recursive: true });

    // Compose file with a per-vite image name
    writeFileSync(join(fleetDir, 'docker-compose.yml'), [
      'services:',
      '  frontend:',
      `    image: fleet-feature-vite-${key}`,
    ].join('\n'));

    // railpack-plan.json presence signals this feature has a generated build plan
    writeFileSync(join(fleetDir, 'railpack-plan.json'), '{}');

    register('myproj', 'frontend', 'main');

    await runRebuild(key);

    // The build call must use 'buildx'
    const buildCall = capturedCalls.find(
      (c) => c.cmd === 'docker' && c.args[0] === 'buildx',
    );
    assert.ok(buildCall, 'docker buildx build must be invoked for a vite feature');
    assert.equal(buildCall.args[1], 'build', 'second arg must be "build"');
    assert.ok(buildCall.args.includes('--load'), '--load must be present');
    assert.ok(buildCall.args.includes('--no-cache'), '--no-cache must be present');

    // --build-arg BUILDKIT_SYNTAX=<image> must be present
    const buildArgIdx = buildCall.args.indexOf('--build-arg');
    assert.notEqual(buildArgIdx, -1, '--build-arg must be present');
    assert.equal(
      buildCall.args[buildArgIdx + 1],
      `BUILDKIT_SYNTAX=${RAILPACK_FRONTEND_IMAGE}`,
      '--build-arg value must be BUILDKIT_SYNTAX=<railpack-frontend>',
    );

    // -f must point at the per-feature railpack-plan.json
    const fIdx = buildCall.args.indexOf('-f');
    assert.notEqual(fIdx, -1, '-f must be present');
    assert.ok(
      buildCall.args[fIdx + 1].endsWith('railpack-plan.json'),
      `-f must point at railpack-plan.json, got: ${buildCall.args[fIdx + 1]}`,
    );
    assert.ok(
      buildCall.args[fIdx + 1].includes(key),
      `-f path must be scoped to the feature key directory, got: ${buildCall.args[fIdx + 1]}`,
    );

    // No plain 'docker build' (without buildx) must be invoked
    const plainBuild = capturedCalls.find(
      (c) => c.cmd === 'docker' && c.args[0] === 'build',
    );
    assert.equal(plainBuild, undefined, 'plain docker build must NOT be invoked for a vite feature');
  });

  // ── No-plan path ─────────────────────────────────────────────────────────────

  test('no railpack-plan.json → runRebuild rejects with a clear error naming the feature key', async () => {
    const key = 'myproj-backend';

    // Build the fake fleet directory tree — deliberately no railpack-plan.json
    const fleetDir = join(tmpDir, '.fleet', key);
    mkdirSync(fleetDir, { recursive: true });

    writeFileSync(join(fleetDir, 'docker-compose.yml'), [
      'services:',
      '  backend:',
      `    image: fleet-feature-base-${key}`,
    ].join('\n'));

    register('myproj', 'backend', 'main');

    await assert.rejects(
      () => runRebuild(key),
      (err) => {
        assert.ok(
          err.message.includes(key) || err.message.includes('backend'),
          `error message must name the feature/subproject, got: ${err.message}`,
        );
        return true;
      },
    );

    // Docker must NOT have been called at all
    assert.equal(capturedCalls.length, 0, 'docker must not be called when no plan is present');
  });
});
