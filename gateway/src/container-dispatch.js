/**
 * Single dispatch point for all container-tooling operations in the gateway.
 *
 * All docker build/run/inspect calls must go through this module.
 * The lint script scripts/lint-no-direct-docker.sh enforces that no file
 * under gateway/src/ (except this one) contains an inline spawn/exec call
 * with 'docker' as the binary.
 */

import { spawn } from 'child_process';
import { buildFeatureImage } from './build-dispatch.js';

// Mutable shim so tests can intercept spawn calls without mocking child_process.
let _spawnImpl = spawn;

/** @internal — test seam, allows tests to replace spawn without mocking child_process. */
export function _setSpawnImpl(fn) { _spawnImpl = fn; }

/**
 * Spawn `docker <args>`, stream stdout+stderr to `onLine`, resolve on exit 0.
 *
 * @param {string[]} args    Docker sub-command and flags (everything after 'docker').
 * @param {(line: string) => void} onLine  Called with each non-empty output line.
 * @param {{ ignoreExitCode?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export function run(args, onLine, { ignoreExitCode = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = _spawnImpl('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const handleChunk = (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        const trimmed = line.trimEnd();
        if (trimmed.length > 0) onLine(trimmed);
      }
    };

    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', handleChunk);
    proc.on('error', (err) => reject(new Error(`docker spawn error: ${err.message}`)));
    proc.on('close', (code) => {
      if (ignoreExitCode || code === 0) resolve();
      else reject(new Error(`'docker ${args.join(' ')}' exited with code ${code}`));
    });
  });
}

/**
 * Spawn `docker inspect <containerName>`, return parsed JSON array.
 *
 * @param {string} containerName  Name or ID of the container to inspect.
 * @returns {Promise<object[]>}
 */
export function inspect(containerName) {
  return new Promise((resolve, reject) => {
    const proc = _spawnImpl('docker', ['inspect', containerName], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];

    proc.stdout.on('data', (chunk) => chunks.push(chunk));
    proc.stderr.on('data', () => {}); // stderr discarded; errors surface via exit code

    proc.on('error', (err) => reject(new Error(`docker inspect spawn error: ${err.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`'docker inspect ${containerName}' exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error(`Failed to parse 'docker inspect' output: ${e.message}`));
      }
    });
  });
}

/**
 * Build a feature image by delegating to buildFeatureImage from build-dispatch.js.
 *
 * @param {object}   opts            Same options accepted by buildFeatureImage.
 * @param {string}   opts.subName
 * @param {string}   opts.imageTag
 * @param {string}   opts.contextDir
 * @param {string}   opts.fleetDir
 * @param {function} opts.runCommand  (cmd: string, args: string[], opts?) => Promise<void>
 * @returns {Promise<void>}
 */
export function build(opts) {
  return buildFeatureImage(opts);
}
