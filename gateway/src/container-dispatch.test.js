/**
 * Tests for container-dispatch.js — the single seam for all docker operations.
 *
 * Verifies:
 *   run()     — spawns 'docker' with given args, streams output, resolves/rejects
 *               on exit code
 *   inspect() — spawns 'docker inspect <name>' and returns parsed JSON
 *   build()   — delegates to buildFeatureImage from build-dispatch.js
 *
 * Spawn is controlled via _setSpawnImpl (no child_process mocking needed).
 * build-dispatch.js is vi-mocked so no real Docker or file system is required.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'child_process';

vi.mock('./build-dispatch.js', () => ({
  buildFeatureImage: vi.fn().mockResolvedValue(undefined),
}));

import { run, inspect, build, _setSpawnImpl } from './container-dispatch.js';
import { buildFeatureImage } from './build-dispatch.js';

/**
 * Create a minimal fake process that emits stdout/stderr data then exits.
 * @param {{ exitCode?: number, stdout?: string, stderr?: string }} opts
 */
function makeProc({ exitCode = 0, stdout = '', stderr = '' } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', exitCode);
  });
  return proc;
}

describe('container-dispatch', () => {
  let spawnCalls;

  beforeEach(() => {
    spawnCalls = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore the real spawn so other test files are unaffected.
    _setSpawnImpl(spawn);
  });

  // ── run() ──────────────────────────────────────────────────────────────────

  describe('run()', () => {
    test('spawns docker with the given args and resolves on exit 0', async () => {
      _setSpawnImpl((cmd, args) => {
        spawnCalls.push({ cmd, args: [...args] });
        return makeProc({ exitCode: 0 });
      });

      await run(['ps'], () => {});

      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].cmd).toBe('docker');
      expect(spawnCalls[0].args).toEqual(['ps']);
    });

    test('calls onLine for each non-empty output line from stdout and stderr', async () => {
      _setSpawnImpl((cmd, args) => makeProc({ stdout: 'line1\nline2\n', stderr: 'err1\n' }));
      const lines = [];
      await run(['ps'], (line) => lines.push(line));
      expect(lines).toContain('line1');
      expect(lines).toContain('line2');
      expect(lines).toContain('err1');
    });

    test('rejects with a message containing the exit code on non-zero exit', async () => {
      _setSpawnImpl(() => makeProc({ exitCode: 1 }));
      await expect(run(['ps'], () => {})).rejects.toThrow('exited with code 1');
    });

    test('resolves even on non-zero exit when ignoreExitCode is true', async () => {
      _setSpawnImpl(() => makeProc({ exitCode: 1 }));
      await expect(
        run(['stop', 'no-such'], () => {}, { ignoreExitCode: true }),
      ).resolves.toBeUndefined();
    });
  });

  // ── inspect() ──────────────────────────────────────────────────────────────

  describe('inspect()', () => {
    test('spawns docker inspect <name> and returns parsed JSON', async () => {
      const fixture = [{ Id: 'abc123', Name: '/mycontainer' }];
      _setSpawnImpl((cmd, args) => {
        spawnCalls.push({ cmd, args: [...args] });
        return makeProc({ stdout: JSON.stringify(fixture) });
      });

      const result = await inspect('mycontainer');

      expect(spawnCalls[0].cmd).toBe('docker');
      expect(spawnCalls[0].args).toEqual(['inspect', 'mycontainer']);
      expect(result).toEqual(fixture);
    });

    test('rejects on non-zero exit from docker inspect', async () => {
      _setSpawnImpl(() => makeProc({ exitCode: 1 }));
      await expect(inspect('no-such-container')).rejects.toThrow('exited with code 1');
    });
  });

  // ── build() ────────────────────────────────────────────────────────────────

  describe('build()', () => {
    test('delegates to buildFeatureImage with the given options', async () => {
      const opts = {
        subName: 'myproj-fe',
        imageTag: 'fleet-myproj-fe:latest',
        contextDir: '/fleet-root',
        fleetDir: '/project/.fleet',
        runCommand: vi.fn(),
      };

      await build(opts);

      expect(buildFeatureImage).toHaveBeenCalledOnce();
      expect(buildFeatureImage).toHaveBeenCalledWith(opts);
    });
  });
});
