/**
 * Tests for the shared sidecar renderer and applier (gateway/src/cluster/sidecars.js).
 *
 * Strategy: render tests exercise the pure YAML output directly.
 * Apply tests write a tiny Node.js mock script to a temp directory, point
 * FLEET_OC_BIN at it, and invoke ensureSidecars. The mock validates the
 * oc-apply call and emits output the same way the real oc would.
 *
 * clearDigestCache() is called in beforeEach to prevent in-memory state from
 * one test affecting another.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { renderSidecarManifests, ensureSidecars, clearDigestCache } from './sidecars.js';

let mockDir;
let mockBin;

/**
 * Write the body of a Node.js script to mockBin (executable).
 * @param {string} body - JS script body (process.argv available)
 */
function writeMock(body) {
  writeFileSync(mockBin, `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
}

describe('sidecars', () => {
  beforeEach(() => {
    mockDir = join(tmpdir(), `fleet-sidecars-test-${process.pid}-${Date.now()}`);
    mkdirSync(mockDir, { recursive: true });
    mockBin = join(mockDir, 'oc');
    process.env.FLEET_OC_BIN = mockBin;
    clearDigestCache();
  });

  afterEach(() => {
    delete process.env.FLEET_OC_BIN;
    rmSync(mockDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // renderSidecarManifests
  // ---------------------------------------------------------------------------

  describe('renderSidecarManifests', () => {
    test('renders a Deployment named fleet-sidecar-<name> in the given namespace', () => {
      const manifest = renderSidecarManifests('redis', { image: 'redis:7', port: 6379 }, 'my-ns');
      assert.match(manifest, /kind: Deployment/);
      assert.match(manifest, /name: fleet-sidecar-redis/);
      assert.match(manifest, /namespace: my-ns/);
    });

    test('renders a Service named fleet-sidecar-<name> in the given namespace', () => {
      const manifest = renderSidecarManifests('redis', { image: 'redis:7', port: 6379 }, 'my-ns');
      assert.match(manifest, /kind: Service/);
      assert.match(manifest, /name: fleet-sidecar-redis/);
    });

    test('Deployment contains container image and port', () => {
      const manifest = renderSidecarManifests('pg', { image: 'postgres:15', port: 5432 }, 'ns');
      assert.match(manifest, /image: postgres:15/);
      assert.match(manifest, /containerPort: 5432/);
    });

    test('Service selector targets pods by fleet-sidecar-<name> label', () => {
      const manifest = renderSidecarManifests('redis', { image: 'redis:7', port: 6379 }, 'ns');
      // The selector block must reference the same label used on the pod template
      assert.match(manifest, /app: fleet-sidecar-redis/);
    });

    test('Service port matches sidecar port', () => {
      const manifest = renderSidecarManifests('redis', { image: 'redis:7', port: 6379 }, 'ns');
      assert.match(manifest, /port: 6379/);
    });

    test('Service type is ClusterIP (enabling in-namespace DNS)', () => {
      const manifest = renderSidecarManifests('redis', { image: 'redis:7', port: 6379 }, 'ns');
      assert.match(manifest, /type: ClusterIP/);
    });

    test('Deployment and Service are separated by a YAML document separator', () => {
      const manifest = renderSidecarManifests('redis', { image: 'redis:7', port: 6379 }, 'ns');
      assert.match(manifest, /---/);
      // Both kinds must appear
      assert.match(manifest, /kind: Deployment/);
      assert.match(manifest, /kind: Service/);
    });

    test('different sidecar names produce different resource names', () => {
      const m1 = renderSidecarManifests('redis', { image: 'redis:7', port: 6379 }, 'ns');
      const m2 = renderSidecarManifests('postgres', { image: 'postgres:15', port: 5432 }, 'ns');
      assert.match(m1, /fleet-sidecar-redis/);
      assert.match(m2, /fleet-sidecar-postgres/);
      assert.doesNotMatch(m1, /fleet-sidecar-postgres/);
      assert.doesNotMatch(m2, /fleet-sidecar-redis/);
    });
  });

  // ---------------------------------------------------------------------------
  // ensureSidecars — apply behaviour
  // ---------------------------------------------------------------------------

  describe('ensureSidecars', () => {
    test('applies Deployment+Service manifest containing fleet-sidecar-<name>', async () => {
      const captureFile = join(mockDir, 'captured.txt');
      writeMock(`
const args = process.argv.slice(2);
if (args[0] !== 'apply' || args[1] !== '-f' || args[2] !== '-') {
  process.stderr.write('wrong args: ' + args.join(' ') + '\\n');
  process.exit(1);
}
const { writeFileSync } = require('fs');
let data = '';
process.stdin.on('data', d => { data += d; });
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(captureFile)}, data);
  process.stdout.write('applied\\n');
  process.exit(0);
});
`);
      await ensureSidecars('my-ns', {
        sidecars: [{ name: 'redis', image: 'redis:7', port: 6379 }],
      });
      const captured = readFileSync(captureFile, 'utf8');
      assert.match(captured, /fleet-sidecar-redis/);
      assert.match(captured, /Deployment/);
      assert.match(captured, /Service/);
    });

    test('applies manifests for each sidecar in the project config', async () => {
      const captureFile = join(mockDir, 'captured-multi.txt');
      writeMock(`
const { appendFileSync } = require('fs');
let data = '';
process.stdin.on('data', d => { data += d; });
process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(captureFile)}, data + '\\n===\\n');
  process.stdout.write('applied\\n');
  process.exit(0);
});
`);
      await ensureSidecars('my-ns', {
        sidecars: [
          { name: 'redis', image: 'redis:7', port: 6379 },
          { name: 'postgres', image: 'postgres:15', port: 5432 },
        ],
      });
      const captured = readFileSync(captureFile, 'utf8');
      assert.match(captured, /fleet-sidecar-redis/);
      assert.match(captured, /fleet-sidecar-postgres/);
    });

    // ---------------------------------------------------------------------------
    // ensureSidecars — idempotency
    // ---------------------------------------------------------------------------

    test('is idempotent — does not re-apply when sidecar config is unchanged', async () => {
      const countFile = join(mockDir, 'count.txt');
      writeMock(`
const { readFileSync, writeFileSync, existsSync } = require('fs');
const file = ${JSON.stringify(countFile)};
const count = existsSync(file) ? parseInt(readFileSync(file, 'utf8'), 10) : 0;
writeFileSync(file, String(count + 1));
let data = '';
process.stdin.on('data', d => { data += d; });
process.stdin.on('end', () => { process.stdout.write('ok\\n'); process.exit(0); });
`);
      const config = { sidecars: [{ name: 'pg', image: 'postgres:15', port: 5432 }] };
      await ensureSidecars('ns', config);
      await ensureSidecars('ns', config);
      await ensureSidecars('ns', config);
      const count = parseInt(readFileSync(countFile, 'utf8'), 10);
      assert.equal(count, 1, 'oc apply should only be called once for unchanged config');
    });

    test('re-applies when sidecar image changes', async () => {
      const countFile = join(mockDir, 'count2.txt');
      writeMock(`
const { readFileSync, writeFileSync, existsSync } = require('fs');
const file = ${JSON.stringify(countFile)};
const count = existsSync(file) ? parseInt(readFileSync(file, 'utf8'), 10) : 0;
writeFileSync(file, String(count + 1));
let data = '';
process.stdin.on('data', d => { data += d; });
process.stdin.on('end', () => { process.stdout.write('ok\\n'); process.exit(0); });
`);
      await ensureSidecars('ns2', { sidecars: [{ name: 'redis', image: 'redis:6', port: 6379 }] });
      await ensureSidecars('ns2', { sidecars: [{ name: 'redis', image: 'redis:7', port: 6379 }] });
      const count = parseInt(readFileSync(countFile, 'utf8'), 10);
      assert.equal(count, 2, 'oc apply should be called again after image changes');
    });

    test('different namespaces are tracked independently', async () => {
      const countFile = join(mockDir, 'count3.txt');
      writeMock(`
const { readFileSync, writeFileSync, existsSync } = require('fs');
const file = ${JSON.stringify(countFile)};
const count = existsSync(file) ? parseInt(readFileSync(file, 'utf8'), 10) : 0;
writeFileSync(file, String(count + 1));
let data = '';
process.stdin.on('data', d => { data += d; });
process.stdin.on('end', () => { process.stdout.write('ok\\n'); process.exit(0); });
`);
      const config = { sidecars: [{ name: 'redis', image: 'redis:7', port: 6379 }] };
      await ensureSidecars('ns-a', config);
      await ensureSidecars('ns-b', config);
      // Each namespace gets its own apply; same namespace does not repeat
      await ensureSidecars('ns-a', config);
      const count = parseInt(readFileSync(countFile, 'utf8'), 10);
      assert.equal(count, 2, 'each namespace applied once; second call to ns-a is a no-op');
    });

    // ---------------------------------------------------------------------------
    // ensureSidecars — local-only features (no sidecars)
    // ---------------------------------------------------------------------------

    test('is a no-op for projects with no sidecars property', async () => {
      // Mock fails if called — proves oc is never invoked
      writeMock(`process.stderr.write('should not be called\\n'); process.exit(1);`);
      await assert.doesNotReject(ensureSidecars('ns', {}));
    });

    test('is a no-op for projects with an empty sidecars array', async () => {
      writeMock(`process.stderr.write('should not be called\\n'); process.exit(1);`);
      await assert.doesNotReject(ensureSidecars('ns', { sidecars: [] }));
    });
  });
});
