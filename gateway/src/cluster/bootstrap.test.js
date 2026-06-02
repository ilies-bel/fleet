/**
 * Tests for gateway/src/cluster/bootstrap.js
 *
 * Strategy:
 *  - renderBuildConfig tests exercise the pure template rendering directly,
 *    snapshot-comparing key structural properties of the generated YAML.
 *  - bootstrap tests write a mock Node.js oc script to a temp directory, point
 *    FLEET_OC_BIN at it, and verify the oc call sequence. The same FLEET_OC_BIN
 *    seam used by oc.test.js is used here.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { renderBuildConfig, bootstrap } from './bootstrap.js';

let mockDir;
let mockBin;

/**
 * Write a Node.js mock script body to mockBin (chmod 755).
 * @param {string} body
 */
function writeMock(body) {
  writeFileSync(mockBin, `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
}

describe('bootstrap', () => {
  beforeEach(() => {
    mockDir = join(tmpdir(), `fleet-bootstrap-test-${process.pid}-${Date.now()}`);
    mkdirSync(mockDir, { recursive: true });
    mockBin = join(mockDir, 'oc');
    process.env.FLEET_OC_BIN = mockBin;
  });

  afterEach(() => {
    delete process.env.FLEET_OC_BIN;
    rmSync(mockDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // renderBuildConfig — template rendering (snapshot-style)
  // ---------------------------------------------------------------------------

  describe('renderBuildConfig', () => {
    test('renders an ImageStream named fleet-feature-base in the given namespace', () => {
      const manifest = renderBuildConfig('my-namespace');
      assert.match(manifest, /kind: ImageStream/);
      assert.match(manifest, /name: fleet-feature-base/);
      assert.match(manifest, /namespace: my-namespace/);
    });

    test('renders a BuildConfig named fleet-feature-base in the given namespace', () => {
      const manifest = renderBuildConfig('my-namespace');
      assert.match(manifest, /kind: BuildConfig/);
      assert.match(manifest, /name: fleet-feature-base/);
      assert.match(manifest, /namespace: my-namespace/);
    });

    test('output references fleet-feature-base:latest as an ImageStreamTag', () => {
      const manifest = renderBuildConfig('my-namespace');
      assert.match(manifest, /fleet-feature-base:latest/);
      assert.match(manifest, /kind: ImageStreamTag/);
    });

    test('BuildConfig uses Docker strategy', () => {
      const manifest = renderBuildConfig('my-namespace');
      assert.match(manifest, /type: Docker/);
    });

    test('BuildConfig source type is Binary', () => {
      const manifest = renderBuildConfig('my-namespace');
      assert.match(manifest, /type: Binary/);
    });

    test('namespace placeholder is substituted in both documents', () => {
      const manifest = renderBuildConfig('test-ns');
      const occurrences = (manifest.match(/namespace: test-ns/g) || []).length;
      assert.ok(
        occurrences >= 2,
        `expected namespace substituted in at least 2 places, got ${occurrences}`
      );
    });

    test('different namespaces produce different manifests', () => {
      const m1 = renderBuildConfig('ns-one');
      const m2 = renderBuildConfig('ns-two');
      assert.match(m1, /namespace: ns-one/);
      assert.match(m2, /namespace: ns-two/);
      assert.doesNotMatch(m1, /namespace: ns-two/);
    });

    test('snapshot: manifest is multi-document YAML with correct API groups and labels', () => {
      const manifest = renderBuildConfig('my-ns');

      // Multi-document separator
      assert.match(manifest, /---/);

      // API groups
      assert.match(manifest, /apiVersion: image\.openshift\.io\/v1/);
      assert.match(manifest, /apiVersion: build\.openshift\.io\/v1/);

      // managed-by label on both resources
      const labelCount = (manifest.match(/managed-by: fleet/g) || []).length;
      assert.ok(labelCount >= 2, `expected managed-by label on both resources, got ${labelCount}`);

      // Internal registry ref usable by later slices
      assert.match(manifest, /fleet-feature-base:latest/);
    });
  });

  // ---------------------------------------------------------------------------
  // bootstrap — apply + tag-check + start-build
  // ---------------------------------------------------------------------------

  describe('bootstrap apply behaviour', () => {
    test('applies the ImageStream+BuildConfig manifest to the cluster', async () => {
      const captureFile = join(mockDir, 'captured.txt');
      writeMock(`
const args = process.argv.slice(2);
if (args[0] === 'apply' && args[1] === '-f' && args[2] === '-') {
  const { writeFileSync } = require('fs');
  let data = '';
  process.stdin.on('data', d => { data += d; });
  process.stdin.on('end', () => {
    writeFileSync(${JSON.stringify(captureFile)}, data);
    process.stdout.write('applied\\n');
    process.exit(0);
  });
} else if (args[0] === 'get') {
  process.stderr.write('not found\\n');
  process.exit(1);
} else if (args[0] === 'start-build') {
  process.stdout.write('build started\\n');
  process.exit(0);
} else {
  process.exit(1);
}
`);
      await bootstrap('test-ns', { buildContextDir: mockDir });
      const captured = readFileSync(captureFile, 'utf8');
      assert.match(captured, /ImageStream/);
      assert.match(captured, /BuildConfig/);
      assert.match(captured, /namespace: test-ns/);
    });
  });

  describe('bootstrap idempotency', () => {
    test('does not start a build when fleet-feature-base:latest already exists', async () => {
      const startBuildFile = join(mockDir, 'start-build-called.txt');
      writeMock(`
const args = process.argv.slice(2);
if (args[0] === 'apply') {
  let data = '';
  process.stdin.on('data', d => { data += d; });
  process.stdin.on('end', () => { process.stdout.write('applied\\n'); process.exit(0); });
} else if (args[0] === 'get' && args[1] === 'imagestreamtag') {
  // Tag exists
  process.stdout.write('fleet-feature-base:latest   2024-01-01\\n');
  process.exit(0);
} else if (args[0] === 'start-build') {
  const { writeFileSync } = require('fs');
  writeFileSync(${JSON.stringify(startBuildFile)}, 'called');
  process.stdout.write('build started\\n');
  process.exit(0);
} else {
  process.exit(1);
}
`);
      await bootstrap('test-ns', { buildContextDir: mockDir });
      assert.ok(!existsSync(startBuildFile), 'start-build must not be called when tag exists');
    });

    test('re-running bootstrap multiple times does not error', async () => {
      writeMock(`
const args = process.argv.slice(2);
if (args[0] === 'apply') {
  let data = '';
  process.stdin.on('data', d => { data += d; });
  process.stdin.on('end', () => { process.stdout.write('applied\\n'); process.exit(0); });
} else if (args[0] === 'get' && args[1] === 'imagestreamtag') {
  process.stdout.write('fleet-feature-base:latest   exists\\n');
  process.exit(0);
} else {
  process.exit(1);
}
`);
      await assert.doesNotReject(bootstrap('idempotent-ns', { buildContextDir: mockDir }));
      await assert.doesNotReject(bootstrap('idempotent-ns', { buildContextDir: mockDir }));
    });
  });

  describe('bootstrap build trigger', () => {
    test('starts a build when tag is absent, passing namespace and build context', async () => {
      const argsFile = join(mockDir, 'start-build-args.txt');
      writeMock(`
const args = process.argv.slice(2);
if (args[0] === 'apply') {
  let data = '';
  process.stdin.on('data', d => { data += d; });
  process.stdin.on('end', () => { process.stdout.write('applied\\n'); process.exit(0); });
} else if (args[0] === 'get' && args[1] === 'imagestreamtag') {
  process.stderr.write('not found\\n');
  process.exit(1);
} else if (args[0] === 'start-build') {
  const { writeFileSync } = require('fs');
  writeFileSync(${JSON.stringify(argsFile)}, args.join(' '));
  process.stdout.write('build started\\n');
  process.exit(0);
} else {
  process.exit(1);
}
`);
      const ctxDir = '/tmp/fleet-test-ctx';
      await bootstrap('build-ns', { buildContextDir: ctxDir });
      const capturedArgs = readFileSync(argsFile, 'utf8');
      assert.match(capturedArgs, /start-build/);
      assert.match(capturedArgs, /fleet-feature-base/);
      assert.match(capturedArgs, new RegExp(`--from-dir=${ctxDir.replace(/\//g, '\\/')}`));
      assert.match(capturedArgs, /-n/);
      assert.match(capturedArgs, /build-ns/);
      assert.match(capturedArgs, /--wait/);
    });

    test('uses FLEET_ROOT env var when buildContextDir is not passed', async () => {
      const argsFile = join(mockDir, 'fleet-root-args.txt');
      writeMock(`
const args = process.argv.slice(2);
if (args[0] === 'apply') {
  let data = '';
  process.stdin.on('data', d => { data += d; });
  process.stdin.on('end', () => { process.stdout.write('applied\\n'); process.exit(0); });
} else if (args[0] === 'get' && args[1] === 'imagestreamtag') {
  process.stderr.write('not found\\n');
  process.exit(1);
} else if (args[0] === 'start-build') {
  const { writeFileSync } = require('fs');
  writeFileSync(${JSON.stringify(argsFile)}, args.join(' '));
  process.stdout.write('build started\\n');
  process.exit(0);
} else {
  process.exit(1);
}
`);
      process.env.FLEET_ROOT = '/env/fleet/root';
      try {
        await bootstrap('env-ns');
        const capturedArgs = readFileSync(argsFile, 'utf8');
        assert.match(capturedArgs, /--from-dir=\/env\/fleet\/root/);
      } finally {
        delete process.env.FLEET_ROOT;
      }
    });

    test('throws when neither buildContextDir nor FLEET_ROOT is set and tag is absent', async () => {
      writeMock(`
const args = process.argv.slice(2);
if (args[0] === 'apply') {
  let data = '';
  process.stdin.on('data', d => { data += d; });
  process.stdin.on('end', () => { process.stdout.write('applied\\n'); process.exit(0); });
} else if (args[0] === 'get' && args[1] === 'imagestreamtag') {
  process.stderr.write('not found\\n');
  process.exit(1);
} else {
  process.exit(1);
}
`);
      delete process.env.FLEET_ROOT;
      await assert.rejects(
        bootstrap('no-ctx-ns'),
        /FLEET_ROOT/
      );
    });
  });
});
