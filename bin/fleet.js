#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');
const os = require('os');
const readline = require('readline');

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

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ── Routing ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const subcmd = args[0];

if (subcmd === 'install-claude') {
  runInstaller(args.slice(1)).catch((err) => {
    console.error('error:', err.message);
    process.exit(1);
  });
} else {
  // Pass-through to bash fleet entrypoint
  if (!onPath('bash')) {
    console.warn('warning: bash not found on PATH — fleet CLI requires bash');
  }
  const fleetBin = path.join(PKG_ROOT, 'fleet');
  try {
    execFileSync('bash', [fleetBin, ...args], { stdio: 'inherit' });
  } catch (err) {
    process.exit(typeof err.status === 'number' ? err.status : 1);
  }
}

// ── Installer ────────────────────────────────────────────────────────────────

async function runInstaller(installerArgs) {
  const flags = parseInstallerFlags(installerArgs);

  let targetDir;
  if (flags.global) {
    targetDir = path.join(os.homedir(), '.claude');
  } else if (flags.local) {
    targetDir = path.join(process.cwd(), '.claude');
  } else {
    targetDir = await promptScope();
  }

  console.log(`\nInstalling Claude Code assets to: ${targetDir}\n`);

  const srcClaudeDir = path.join(PKG_ROOT, '.claude');
  const results = [];

  // commands/fleet/init.md
  results.push(...copyFile(
    path.join(srcClaudeDir, 'commands', 'fleet', 'init.md'),
    path.join(targetDir, 'commands', 'fleet', 'init.md'),
    flags.force
  ));

  // agents/*.md — all agents
  const agentsDir = path.join(srcClaudeDir, 'agents');
  const agentFiles = fs.readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md') && fs.statSync(path.join(agentsDir, f)).isFile());
  for (const f of agentFiles) {
    results.push(...copyFile(
      path.join(agentsDir, f),
      path.join(targetDir, 'agents', f),
      flags.force
    ));
  }

  // skills/* — all skill directories (copy recursively)
  const skillsDir = path.join(srcClaudeDir, 'skills');
  const skillDirs = fs.readdirSync(skillsDir)
    .filter((f) => fs.statSync(path.join(skillsDir, f)).isDirectory());
  for (const d of skillDirs) {
    const skillResults = copyDirRecursive(
      path.join(skillsDir, d),
      path.join(targetDir, 'skills', d),
      flags.force
    );
    results.push(...skillResults);
  }

  // Print results
  for (const r of results) {
    const label = r.action === 'installed'   ? 'installed'
                : r.action === 'overwritten' ? 'overwritten'
                : 'skipped (exists)';
    console.log(`  ${label.padEnd(18)} ${r.dest}`);
  }

  console.log(`\n${results.filter((r) => r.action !== 'skipped').length} file(s) installed, ` +
              `${results.filter((r) => r.action === 'skipped').length} skipped.\n`);

  // Docker check
  if (!onPath('docker')) {
    console.warn('warning: docker not found on PATH — fleet requires Docker to run containers.');
  }

  // Post-install tip
  console.log('Done! Open Claude Code in your project and run:\n');
  console.log('  /fleet:init\n');
  console.log('This will walk you through setting up qa-fleet for your project.\n');
}

function parseInstallerFlags(args) {
  return {
    global: args.includes('--global'),
    local:  args.includes('--local'),
    force:  args.includes('--force'),
  };
}

async function promptScope() {
  const answer = await ask(
    'Install Claude Code assets globally (~/.claude) or locally (./.claude)?\n' +
    'Enter "global" or "local" [local]: '
  );
  if (answer === 'global') {
    return path.join(os.homedir(), '.claude');
  }
  return path.join(process.cwd(), '.claude');
}

function copyFile(src, dest, force) {
  if (!fs.existsSync(src)) return [];
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && !force) {
    return [{ action: 'skipped', dest }];
  }
  const action = fs.existsSync(dest) ? 'overwritten' : 'installed';
  fs.copyFileSync(src, dest);
  return [{ action, dest }];
}

function copyDirRecursive(srcDir, destDir, force) {
  if (!fs.existsSync(srcDir)) return [];
  const results = [];
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...copyDirRecursive(srcPath, destPath, force));
    } else {
      results.push(...copyFile(srcPath, destPath, force));
    }
  }
  return results;
}
