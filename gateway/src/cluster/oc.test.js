/**
 * Tests for the oc cluster wrapper (gateway/src/cluster/oc.js).
 *
 * Strategy: each test writes a tiny Node.js mock script to a temp directory,
 * points FLEET_OC_BIN at it, and invokes the real module function. The mock
 * validates the arguments it receives (exiting non-zero on wrong args) and
 * emits the stdout/stderr the real oc would produce. This exercises the full
 * spawn + parse + promise chain without touching a real cluster.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  apply,
  getPodStatus,
  rsync,
  exec,
  portForward,
  deletePod,
  deleteService,
} from './oc.js';

let mockDir;
let mockBin;

/**
 * Write the body of a Node.js script to mockBin (executable).
 * The shebang is prepended automatically.
 * @param {string} body - JS script body (process.argv available)
 */
function writeMock(body) {
  writeFileSync(mockBin, `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
}

describe('oc wrapper', () => {
  beforeEach(() => {
    mockDir = join(tmpdir(), `fleet-oc-test-${process.pid}-${Date.now()}`);
    mkdirSync(mockDir, { recursive: true });
    mockBin = join(mockDir, 'oc');
    process.env.FLEET_OC_BIN = mockBin;
  });

  afterEach(() => {
    delete process.env.FLEET_OC_BIN;
    rmSync(mockDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // apply
  // ---------------------------------------------------------------------------

  test('apply passes manifest via stdin and resolves with oc output', async () => {
    writeMock(`
const args = process.argv.slice(2);
if (args[0] !== 'apply' || args[1] !== '-f' || args[2] !== '-') {
  process.stderr.write('wrong args: ' + args.join(' ') + '\\n');
  process.exit(1);
}
let data = '';
process.stdin.on('data', d => { data += d; });
process.stdin.on('end', () => {
  process.stdout.write('configured: ' + data.trim() + '\\n');
  process.exit(0);
});
`);
    const out = await apply('apiVersion: v1\nkind: Pod');
    assert.match(out, /configured: apiVersion: v1/);
  });

  test('apply rejects when oc exits non-zero', async () => {
    writeMock(`
process.stderr.write('server error\\n');
process.exit(1);
`);
    await assert.rejects(apply('bad manifest'), /exited with code 1/);
  });

  // ---------------------------------------------------------------------------
  // getPodStatus
  // ---------------------------------------------------------------------------

  test('getPodStatus returns trimmed pod phase', async () => {
    writeMock(`
const args = process.argv.slice(2);
// Expected: get pod <name> -n <ns> -o jsonpath={.status.phase}
if (args[0] !== 'get' || args[1] !== 'pod') {
  process.stderr.write('wrong subcommand\\n');
  process.exit(1);
}
process.stdout.write('  Running  ');
process.exit(0);
`);
    const phase = await getPodStatus('mypod', 'default');
    assert.equal(phase, 'Running');
  });

  test('getPodStatus passes pod name and namespace to oc', async () => {
    writeMock(`
const args = process.argv.slice(2);
// args: get pod <name> -n <ns> -o jsonpath=...
const name = args[2];
const nsFlag = args[3];
const ns = args[4];
if (name !== 'feature-pod' || nsFlag !== '-n' || ns !== 'fleet') {
  process.stderr.write('wrong args: ' + args.join(' ') + '\\n');
  process.exit(1);
}
process.stdout.write('Pending');
process.exit(0);
`);
    const phase = await getPodStatus('feature-pod', 'fleet');
    assert.equal(phase, 'Pending');
  });

  test('getPodStatus rejects on oc error', async () => {
    writeMock(`
process.stderr.write('not found\\n');
process.exit(1);
`);
    await assert.rejects(getPodStatus('missing', 'ns'), /exited with code 1/);
  });

  // ---------------------------------------------------------------------------
  // rsync
  // ---------------------------------------------------------------------------

  test('rsync streams stdout progress lines to logger.info', async () => {
    writeMock(`
const args = process.argv.slice(2);
if (args[0] !== 'rsync') {
  process.stderr.write('wrong subcommand\\n');
  process.exit(1);
}
process.stdout.write('sending file list...\\n');
process.stdout.write('5 files to consider\\n');
process.exit(0);
`);
    const lines = [];
    const logger = { info: msg => lines.push(msg) };
    await rsync('/local/dir', 'mypod', '/app', 'default', logger);
    assert.ok(lines.some(l => l.includes('sending file list')), 'progress line expected');
    assert.ok(lines.some(l => l.includes('5 files')), 'second progress line expected');
  });

  test('rsync streams stderr progress lines to logger.info', async () => {
    writeMock(`
process.stderr.write('rsync: warning about permissions\\n');
process.exit(0);
`);
    const lines = [];
    const logger = { info: msg => lines.push(msg) };
    await rsync('/local/dir', 'mypod', '/app', 'default', logger);
    assert.ok(lines.some(l => l.includes('warning')));
  });

  test('rsync rejects with error when oc exits non-zero', async () => {
    writeMock(`
process.stderr.write('permission denied\\n');
process.exit(1);
`);
    const logger = { info: () => {} };
    await assert.rejects(
      rsync('/local/dir', 'mypod', '/app', 'default', logger),
      /rsync exited with code 1/,
    );
  });

  test('rsync passes localDir, pod:path, and namespace to oc', async () => {
    writeMock(`
const args = process.argv.slice(2);
// Expected: rsync <localDir> <pod>:<podPath> -n <ns>
if (args[0] !== 'rsync' ||
    args[1] !== '/src' ||
    args[2] !== 'feature-pod:/workspace' ||
    args[3] !== '-n' ||
    args[4] !== 'staging') {
  process.stderr.write('wrong args: ' + JSON.stringify(args) + '\\n');
  process.exit(1);
}
process.exit(0);
`);
    const logger = { info: () => {} };
    await rsync('/src', 'feature-pod', '/workspace', 'staging', logger);
  });

  // ---------------------------------------------------------------------------
  // exec
  // ---------------------------------------------------------------------------

  test('exec returns stdout from the command', async () => {
    writeMock(`
const args = process.argv.slice(2);
if (args[0] !== 'exec') {
  process.stderr.write('wrong subcommand\\n');
  process.exit(1);
}
process.stdout.write('hello from pod\\n');
process.exit(0);
`);
    const out = await exec('mypod', 'default', ['echo', 'hello from pod']);
    assert.match(out, /hello from pod/);
  });

  test('exec passes pod name, namespace, and argv to oc', async () => {
    writeMock(`
const args = process.argv.slice(2);
// Expected: exec <pod> -n <ns> -- <cmd> [args...]
if (args[0] !== 'exec' ||
    args[1] !== 'feature-pod' ||
    args[2] !== '-n' ||
    args[3] !== 'prod' ||
    args[4] !== '--' ||
    args[5] !== 'ls' ||
    args[6] !== '-la') {
  process.stderr.write('wrong args: ' + JSON.stringify(args) + '\\n');
  process.exit(1);
}
process.stdout.write('total 0\\n');
process.exit(0);
`);
    const out = await exec('feature-pod', 'prod', ['ls', '-la']);
    assert.match(out, /total/);
  });

  test('exec rejects on non-zero exit', async () => {
    writeMock(`
process.stderr.write('command not found\\n');
process.exit(127);
`);
    await assert.rejects(exec('mypod', 'ns', ['badcmd']), /exited with code 127/);
  });

  // ---------------------------------------------------------------------------
  // portForward
  // ---------------------------------------------------------------------------

  test('portForward resolves with localPort parsed from oc output', async () => {
    writeMock(`
const args = process.argv.slice(2);
// Expected: port-forward svc/<name> 0:<remotePort> -n <ns>
if (args[0] !== 'port-forward' || !args[1].startsWith('svc/')) {
  process.stderr.write('wrong args: ' + JSON.stringify(args) + '\\n');
  process.exit(1);
}
process.stdout.write('Forwarding from 127.0.0.1:54321 -> 80\\n');
process.stdout.write('Forwarding from [::1]:54321 -> 80\\n');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 10000);
`);
    const { localPort, stop } = await portForward('my-svc', 'default', 80);
    assert.equal(localPort, 54321);
    await stop();
  });

  test('portForward uses svc/<name> and 0:<remotePort> args', async () => {
    writeMock(`
const args = process.argv.slice(2);
if (args[0] !== 'port-forward' ||
    args[1] !== 'svc/feature-svc' ||
    args[2] !== '0:8080' ||
    args[3] !== '-n' ||
    args[4] !== 'staging') {
  process.stderr.write('wrong args: ' + JSON.stringify(args) + '\\n');
  process.exit(1);
}
process.stdout.write('Forwarding from 127.0.0.1:11111 -> 8080\\n');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 10000);
`);
    const { localPort, stop } = await portForward('feature-svc', 'staging', 8080);
    assert.equal(localPort, 11111);
    await stop();
  });

  test('portForward stop() terminates the child process', async () => {
    writeMock(`
process.stdout.write('Forwarding from 127.0.0.1:22222 -> 3000\\n');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 10000);
`);
    const { stop } = await portForward('svc', 'ns', 3000);
    // stop() must resolve (not hang) — if it does the child exited
    await assert.doesNotReject(stop());
  });

  test('portForward rejects if oc exits before binding a port', async () => {
    writeMock(`
process.stderr.write('service not found\\n');
process.exit(1);
`);
    await assert.rejects(
      portForward('missing-svc', 'ns', 80),
      /exited with code 1 before port was bound/,
    );
  });

  // ---------------------------------------------------------------------------
  // deletePod
  // ---------------------------------------------------------------------------

  test('deletePod passes pod name and namespace to oc', async () => {
    writeMock(`
const args = process.argv.slice(2);
if (args[0] !== 'delete' || args[1] !== 'pod' || args[2] !== 'old-pod' || args[4] !== 'default') {
  process.stderr.write('wrong args: ' + JSON.stringify(args) + '\\n');
  process.exit(1);
}
process.stdout.write('pod "old-pod" deleted\\n');
process.exit(0);
`);
    const out = await deletePod('old-pod', 'default');
    assert.match(out, /deleted/);
  });

  test('deletePod rejects on oc error', async () => {
    writeMock(`
process.stderr.write('not found\\n');
process.exit(1);
`);
    await assert.rejects(deletePod('missing', 'ns'), /exited with code 1/);
  });

  // ---------------------------------------------------------------------------
  // deleteService
  // ---------------------------------------------------------------------------

  test('deleteService passes service name and namespace to oc', async () => {
    writeMock(`
const args = process.argv.slice(2);
if (args[0] !== 'delete' || args[1] !== 'service' || args[2] !== 'old-svc' || args[4] !== 'prod') {
  process.stderr.write('wrong args: ' + JSON.stringify(args) + '\\n');
  process.exit(1);
}
process.stdout.write('service "old-svc" deleted\\n');
process.exit(0);
`);
    const out = await deleteService('old-svc', 'prod');
    assert.match(out, /deleted/);
  });

  test('deleteService rejects on oc error', async () => {
    writeMock(`
process.stderr.write('forbidden\\n');
process.exit(1);
`);
    await assert.rejects(deleteService('restricted-svc', 'ns'), /exited with code 1/);
  });
});
