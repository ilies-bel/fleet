/**
 * Enforcement test: no file outside gateway/src/cluster/ may spawn oc or kubectl directly.
 *
 * All cluster access must route through gateway/src/cluster/oc.js so that
 * RBAC/auth handling lives in exactly one place. This test walks the repo
 * and fails if any source file outside the cluster directory contains a
 * spawn/exec call with the literal binary name 'oc' or 'kubectl'.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLUSTER_DIR = fileURLToPath(new URL('.', import.meta.url));
// Navigate up three levels: cluster/ → src/ → gateway/ → repo root
const REPO_ROOT = join(CLUSTER_DIR, '..', '..', '..');

// Matches spawn/exec-family calls with 'oc' or 'kubectl' as the binary argument.
// Handles both spawn('oc', [...]) and execSync('kubectl get pods') forms.
const DIRECT_SPAWN_RE =
  /\b(?:spawn|execFile|spawnSync|exec|execSync)\s*\(\s*['"`](?:oc|kubectl)(?:['"`\s])/;

const SKIP_DIRS = new Set(['node_modules', '.git', '.mars', 'dist', 'build']);
const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);

/**
 * Recursively collect source files under dir.
 * @param {string} dir
 * @param {string[]} results
 * @returns {string[]}
 */
function collectSourceFiles(dir, results = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, results);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.');
      if (dot !== -1 && SOURCE_EXTS.has(entry.name.slice(dot))) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * Returns true if the file lives inside the allowed cluster directory.
 * @param {string} absPath
 */
function isInClusterDir(absPath) {
  // Normalise so both paths use the same separator before comparing.
  const rel = relative(CLUSTER_DIR, absPath);
  return !rel.startsWith('..') && !rel.startsWith(sep + '..');
}

test('no file outside gateway/src/cluster/ spawns oc or kubectl directly', () => {
  const files = collectSourceFiles(REPO_ROOT);
  const violations = [];

  for (const file of files) {
    if (isInClusterDir(file)) continue;
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (DIRECT_SPAWN_RE.test(src)) {
      violations.push(relative(REPO_ROOT, file));
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Direct oc/kubectl spawn found outside gateway/src/cluster/:\n${violations.join('\n')}`,
  );
});
