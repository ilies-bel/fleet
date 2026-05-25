#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..');

// ── Platform guard ──────────────────────────────────────────────────────────

if (process.platform === 'win32') {
  console.error('error: fleet does not support Windows. Use WSL or a Linux/macOS machine.');
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function onPath(bin) {
  const result = spawnSync('which', [bin], { encoding: 'utf8' });
  return result.status === 0;
}

// ── Routing ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const subcmd = args[0];

if (subcmd === 'install-claude') {
  // Removed in v1.0.0: the Claude Code assets it copied were dropped from the
  // package, so the command no longer has anything to install. It will be
  // reintroduced once the agent/skill assets are restored.
  console.error('error: `fleet install-claude` was removed in v1.0.0.');
  console.error('       Run `fleet init` in your project to set fleet up.');
  process.exit(1);
}

// Pass-through to the bash fleet entrypoint
if (!onPath('bash')) {
  console.warn('warning: bash not found on PATH — fleet CLI requires bash');
}
const fleetBin = path.join(PKG_ROOT, 'fleet');
try {
  execFileSync('bash', [fleetBin, ...args], { stdio: 'inherit' });
} catch (err) {
  process.exit(typeof err.status === 'number' ? err.status : 1);
}
