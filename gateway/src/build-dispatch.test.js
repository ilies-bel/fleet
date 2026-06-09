/**
 * Tests for buildFeatureImage dispatch logic.
 *
 * Verifies that buildFeatureImage branches correctly on railpack-plan.json presence:
 *   - plan present  → docker buildx build with BUILDKIT_SYNTAX build-arg
 *   - plan absent   → docker build with Dockerfile.feature-base and contextDir context
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

  // ── Fragment path (no plan) ─────────────────────────────────────────────────

  test('no railpack-plan.json, global Dockerfile present → docker build with Dockerfile.feature-base', async () => {
    const subName = 'myproj-backend';
    const globalDockerfile = path.join(CONTEXT_DIR, 'Dockerfile.feature-base');

    // No plan, no project-local Dockerfile, but global Dockerfile exists
    fs.existsSync.mockImplementation((p) => p === globalDockerfile);

    await buildFeatureImage({
      subName,
      imageTag: `fleet-feature-base-${subName}`,
      contextDir: CONTEXT_DIR,
      fleetDir: FLEET_DIR,
      runCommand,
    });

    expect(calls).toHaveLength(1);
    const { cmd, args } = calls[0];

    expect(cmd).toBe('docker');
    expect(args[0]).toBe('build');
    expect(args).toContain('--load');
    expect(args).toContain('--no-cache');

    // -f must point at Dockerfile.feature-base
    const fIdx = args.indexOf('-f');
    expect(fIdx).not.toBe(-1);
    expect(args[fIdx + 1]).toContain('Dockerfile.feature-base');

    // Build context must be contextDir (FLEET_ROOT equivalent)
    expect(args[args.length - 1]).toBe(CONTEXT_DIR);

    // buildx must NOT be invoked
    expect(calls.some((c) => c.cmd === 'docker' && c.args[0] === 'buildx')).toBe(false);
    // BUILDKIT_SYNTAX must not appear
    expect(calls.some((c) => c.args.some((a) => a.startsWith('BUILDKIT_SYNTAX')))).toBe(false);
  });

  test('no railpack-plan.json, project-local Dockerfile present → uses project-local over global', async () => {
    const subName = 'myproj-service';
    const projectDockerfile = path.join(FLEET_DIR, 'Dockerfile.feature-base');

    // Project-local Dockerfile exists (global does not)
    fs.existsSync.mockImplementation((p) => p === projectDockerfile);

    await buildFeatureImage({
      subName,
      imageTag: `fleet-feature-base-${subName}`,
      contextDir: CONTEXT_DIR,
      fleetDir: FLEET_DIR,
      runCommand,
    });

    expect(calls).toHaveLength(1);
    const { cmd, args } = calls[0];
    const fIdx = args.indexOf('-f');
    expect(fIdx).not.toBe(-1);
    // Must use the project-local path (inside fleetDir), not the global one
    expect(args[fIdx + 1]).toBe(projectDockerfile);
  });

  test('no railpack-plan.json, no Dockerfile anywhere → throws', async () => {
    const subName = 'myproj-broken';

    // Nothing exists
    fs.existsSync.mockReturnValue(false);

    await expect(
      buildFeatureImage({
        subName,
        imageTag: `fleet-feature-base-${subName}`,
        contextDir: CONTEXT_DIR,
        fleetDir: FLEET_DIR,
        runCommand,
      }),
    ).rejects.toThrow('Dockerfile not found');
  });
});
