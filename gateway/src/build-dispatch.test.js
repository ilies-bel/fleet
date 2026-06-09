/**
 * Tests for buildFeatureImage dispatch logic.
 *
 * Verifies that buildFeatureImage branches correctly on railpack-plan.json presence:
 *   - plan present  → docker buildx build with BUILDKIT_SYNTAX build-arg
 *   - plan absent   → throws an error naming the subproject
 *
 * Strategy:
 *   - fs is vi-mocked so no real files are needed.
 *   - runCommand is a captured stub — no Docker socket required.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import path from 'path';

vi.mock('fs');

import { buildFeatureImage } from './build-dispatch.js';
import fs from 'fs';

const RAILPACK_FRONTEND_IMAGE = 'ghcr.io/railwayapp/railpack-frontend:latest';

const FLEET_DIR = '/fake/project/.fleet';
const CONTEXT_DIR = '/fake/fleet-root';

describe('buildFeatureImage', () => {
  let calls;
  let runCommand;

  beforeEach(() => {
    calls = [];
    runCommand = async (cmd, args) => { calls.push({ cmd, args: [...args] }); };
    vi.resetAllMocks();
  });

  // ── Plan-present path ───────────────────────────────────────────────────────

  test('railpack-plan.json present → docker buildx build with BUILDKIT_SYNTAX arg', async () => {
    const subName = 'myproj-frontend';
    const planPath = path.join(FLEET_DIR, subName, 'railpack-plan.json');

    fs.existsSync.mockImplementation((p) => p === planPath);

    await buildFeatureImage({
      subName,
      imageTag: `fleet-feature-vite-${subName}`,
      contextDir: CONTEXT_DIR,
      fleetDir: FLEET_DIR,
      runCommand,
    });

    expect(calls).toHaveLength(1);
    const { cmd, args } = calls[0];

    expect(cmd).toBe('docker');
    expect(args[0]).toBe('buildx');
    expect(args[1]).toBe('build');
    expect(args).toContain('--load');
    expect(args).toContain('--no-cache');

    // --build-arg BUILDKIT_SYNTAX=<image> must be present
    const buildArgIdx = args.indexOf('--build-arg');
    expect(buildArgIdx).not.toBe(-1);
    expect(args[buildArgIdx + 1]).toBe(`BUILDKIT_SYNTAX=${RAILPACK_FRONTEND_IMAGE}`);

    // -f must point at the plan file
    const fIdx = args.indexOf('-f');
    expect(fIdx).not.toBe(-1);
    expect(args[fIdx + 1]).toContain('railpack-plan.json');
    expect(args[fIdx + 1]).toContain(subName);

    // build context must be the subproject directory (parent-of-fleetDir / subName)
    const subProjectDir = path.join(path.dirname(FLEET_DIR), subName);
    expect(args[args.length - 1]).toBe(subProjectDir);

    // Plain 'docker build' must NOT be invoked
    expect(calls.some((c) => c.cmd === 'docker' && c.args[0] === 'build')).toBe(false);
  });

  // ── Plan-absent path ────────────────────────────────────────────────────────

  test('no railpack-plan.json → throws error naming the subproject', async () => {
    const subName = 'myproj-broken';

    // No plan file exists
    fs.existsSync.mockReturnValue(false);

    await expect(
      buildFeatureImage({
        subName,
        imageTag: `fleet-feature-base-${subName}`,
        contextDir: CONTEXT_DIR,
        fleetDir: FLEET_DIR,
        runCommand,
      }),
    ).rejects.toThrow(subName);

    // Docker must NOT have been called
    expect(calls).toHaveLength(0);
  });
});
