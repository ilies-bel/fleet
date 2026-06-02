/**
 * Unit tests for verify-cluster-smoke.js
 *
 * These tests verify the observable behaviour of runSmoke() through its public
 * interface: log output, step results, and exit code.
 *
 * exec, spawnBg, and fetch are injected mocks — they represent real system
 * boundaries (oc CLI, background processes, HTTP).
 *
 * Run: node --test scripts/verify-cluster-smoke.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runSmoke } from './verify-cluster-smoke.js';

// ── Mock factories ────────────────────────────────────────────────────────────

/**
 * Returns a spawnBg mock that fires `onReady` or `onError` asynchronously,
 * giving the caller time to register callbacks synchronously after the call.
 *
 * @param {'ready'|'error'|'hang'} mode
 */
function makeSpawnBgMock(mode = 'ready') {
  let lastHandle = null;

  function spawnBg(_cmd, _args) {
    const readyCbs = [];
    const errorCbs = [];
    let killed = false;

    const handle = {
      onReady(cb) { readyCbs.push(cb); },
      onError(cb) { errorCbs.push(cb); },
      kill() { killed = true; },
      get wasKilled() { return killed; },
    };

    if (mode === 'ready') {
      setImmediate(() => readyCbs.forEach((cb) => cb()));
    } else if (mode === 'error') {
      setImmediate(() => errorCbs.forEach((cb) => cb(new Error('oc port-forward process failed'))));
    }
    // mode === 'hang': never fires — simulates a timeout scenario

    lastHandle = handle;
    return handle;
  }

  return { fn: spawnBg, getLastHandle: () => lastHandle };
}

/** Returns a fetch mock that succeeds for all URLs by default. */
function makeSuccessFetch(overrides = {}) {
  const calls = [];

  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET' });
    const key = `${opts.method ?? 'GET'} ${url}`;
    if (overrides[key]) return overrides[key];
    return {
      ok: true,
      status: 200,
      text: async () => '{}',
      json: async () => ({ ok: true }),
    };
  };

  return { fn, calls };
}

/** Shorthand for a clean set of dependencies where everything succeeds. */
function makeHappyDeps(execOverride) {
  const spawnBg = makeSpawnBgMock('ready');
  const fetch = makeSuccessFetch();
  const logs = [];

  const execCalls = [];
  const exec = async (cmd, args, opts) => {
    execCalls.push({ cmd, args, opts });
    if (execOverride) return execOverride(cmd, args, opts);
    return { stdout: '', stderr: '' };
  };

  return {
    deps: {
      exec,
      spawnBg: spawnBg.fn,
      fetch: fetch.fn,
      log: (msg) => logs.push(msg),
    },
    logs,
    execCalls,
    fetch,
    spawnBg,
  };
}

const BASE_OPTS = { namespace: 'test-ns', featureKey: 'my-feature' };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('verify-cluster-smoke — step output format', () => {

  test('logs PASS:<step> for every step when all succeed', async () => {
    const { deps, logs } = makeHappyDeps();

    const result = await runSmoke(BASE_OPTS, deps);

    assert.equal(result.exitCode, 0, 'exitCode should be 0 on success');
    assert.ok(result.steps.length > 0, 'should have run at least one step');
    assert.ok(
      result.steps.every((s) => s.status === 'PASS'),
      `all steps should be PASS, got: ${JSON.stringify(result.steps)}`,
    );
    assert.ok(
      logs.every((l) => l.startsWith('PASS:')),
      `all log lines should start with PASS:, got: ${JSON.stringify(logs)}`,
    );
  });

  test('logs FAIL:<step> <reason> when a step throws', async () => {
    const { deps, logs } = makeHappyDeps((cmd, args) => {
      if (cmd === 'oc' && args[0] === 'delete') {
        throw new Error('connection refused');
      }
      return { stdout: '', stderr: '' };
    });

    const result = await runSmoke({ ...BASE_OPTS, continueOnFail: true }, deps);

    const failLine = logs.find((l) => l.startsWith('FAIL: cleanup-leftovers'));
    assert.ok(failLine, `expected a FAIL: cleanup-leftovers log line, got: ${JSON.stringify(logs)}`);
    assert.ok(failLine.includes('connection refused'), `reason should appear in log line: ${failLine}`);
    assert.equal(result.exitCode, 1);
  });

});

describe('verify-cluster-smoke — exit code behaviour', () => {

  test('exits non-zero on first FAIL by default (no --continue)', async () => {
    const { deps, logs } = makeHappyDeps((cmd, args) => {
      if (cmd === 'oc' && args[0] === 'delete') throw new Error('cluster unavailable');
      return { stdout: '', stderr: '' };
    });

    const result = await runSmoke(BASE_OPTS /* continueOnFail defaults false */, deps);

    assert.equal(result.exitCode, 1);
    // Only cleanup-leftovers should have executed (it fails and stops the run)
    const nonPassSteps = result.steps.filter((s) => s.status === 'FAIL');
    assert.ok(nonPassSteps.length >= 1, 'should have at least one FAIL step');
    // Subsequent steps (create-pod, wait-pod-ready, …) should not appear
    const stepNames = result.steps.map((s) => s.name);
    assert.ok(!stepNames.includes('create-pod'), 'create-pod must not run after stop-on-first-fail');
  });

  test('continues through all steps and exits non-zero when --continue is set', async () => {
    // Make cleanup-leftovers fail so we can confirm execution continues
    const { deps, logs } = makeHappyDeps((cmd, args) => {
      if (cmd === 'oc' && args[0] === 'delete') throw new Error('oc error');
      return { stdout: '', stderr: '' };
    });

    const result = await runSmoke({ ...BASE_OPTS, continueOnFail: true }, deps);

    assert.equal(result.exitCode, 1, 'exitCode is still 1 even with --continue');
    // Steps after cleanup-leftovers should also have run
    const stepNames = result.steps.map((s) => s.name);
    assert.ok(stepNames.includes('create-pod'), `create-pod should run with --continue; steps: ${stepNames}`);
  });

});

describe('verify-cluster-smoke — --keep-pod flag', () => {

  test('skips teardown when keepPod is true', async () => {
    const { deps, logs, execCalls } = makeHappyDeps();

    const result = await runSmoke({ ...BASE_OPTS, keepPod: true }, deps);

    assert.equal(result.exitCode, 0);
    // The teardown step should be present but marked as "skipped"
    const teardown = result.steps.find((s) => s.name === 'teardown');
    assert.ok(teardown, 'teardown step should still appear in results');
    assert.equal(teardown.status, 'PASS', 'teardown step should be PASS (skipped is a pass)');

    // oc delete should NOT have been called during teardown
    // (cleanup-leftovers calls it too, so filter by the step context — we check
    // that oc delete without --ignore-not-found was never called, since the
    // non-idempotent teardown delete doesn't pass --ignore-not-found)
    const hardDeletes = execCalls.filter(
      (c) => c.cmd === 'oc' && c.args[0] === 'delete' && !c.args.includes('--ignore-not-found'),
    );
    assert.equal(hardDeletes.length, 0, 'teardown hard-deletes must not run with --keep-pod');
  });

  test('runs teardown and kills port-forward when keepPod is false', async () => {
    const { deps, spawnBg } = makeHappyDeps();

    await runSmoke({ ...BASE_OPTS, keepPod: false }, deps);

    assert.ok(spawnBg.getLastHandle()?.wasKilled, 'port-forward process should be killed during teardown');
  });

});

describe('verify-cluster-smoke — idempotency', () => {

  test('cleanup-leftovers calls oc delete with --ignore-not-found for pod and service', async () => {
    const { deps, execCalls } = makeHappyDeps();

    await runSmoke(BASE_OPTS, deps);

    const podDelete = execCalls.find(
      (c) => c.cmd === 'oc' && c.args.includes('delete') && c.args.includes('--ignore-not-found') && c.args.some((a) => a.startsWith('fleet-smoke-')),
    );
    assert.ok(podDelete, `should have called oc delete with --ignore-not-found; calls: ${JSON.stringify(execCalls.map(c => `${c.cmd} ${c.args.join(' ')}`))}`);
  });

  test('cleanup-leftovers does not fail when there are no leftovers (pkill error is swallowed)', async () => {
    const { deps } = makeHappyDeps((cmd) => {
      // pkill fails (no matching process) — this must not stop the run
      if (cmd === 'pkill') throw new Error('no matching processes');
      return { stdout: '', stderr: '' };
    });

    const result = await runSmoke(BASE_OPTS, deps);

    assert.equal(result.exitCode, 0, 'pkill failure must not cause cleanup-leftovers to FAIL');
    const step = result.steps.find((s) => s.name === 'cleanup-leftovers');
    assert.equal(step?.status, 'PASS');
  });

});

describe('verify-cluster-smoke — port-forward step', () => {

  test('port-forward step passes when spawnBg emits ready', async () => {
    const { deps, logs } = makeHappyDeps();

    const result = await runSmoke(BASE_OPTS, deps);

    const pf = result.steps.find((s) => s.name === 'port-forward');
    assert.ok(pf, 'port-forward step should be in results');
    assert.equal(pf.status, 'PASS');
  });

  test('port-forward step fails when spawnBg emits error', async () => {
    const spawnBg = makeSpawnBgMock('error');
    const fetch = makeSuccessFetch();
    const logs = [];

    const result = await runSmoke(
      { ...BASE_OPTS, continueOnFail: true },
      {
        exec: async () => ({ stdout: '', stderr: '' }),
        spawnBg: spawnBg.fn,
        fetch: fetch.fn,
        log: (msg) => logs.push(msg),
      },
    );

    const pf = result.steps.find((s) => s.name === 'port-forward');
    assert.ok(pf, 'port-forward step should be in results');
    assert.equal(pf.status, 'FAIL');
    assert.equal(result.exitCode, 1);
  });

});

describe('verify-cluster-smoke — register-feature step', () => {

  test('register-feature step fails when gateway returns non-ok', async () => {
    const fetch = makeSuccessFetch({
      'POST http://localhost:4000/register-feature': {
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
        json: async () => ({ error: 'Service Unavailable' }),
      },
    });
    const logs = [];

    const result = await runSmoke(
      { ...BASE_OPTS, continueOnFail: true },
      {
        exec: async () => ({ stdout: '', stderr: '' }),
        spawnBg: makeSpawnBgMock('ready').fn,
        fetch: fetch.fn,
        log: (msg) => logs.push(msg),
      },
    );

    const step = result.steps.find((s) => s.name === 'register-feature');
    assert.ok(step, 'register-feature step should be in results');
    assert.equal(step.status, 'FAIL');
    assert.ok(step.reason?.includes('503'), `reason should mention 503: ${step.reason}`);
  });

});

describe('verify-cluster-smoke — dashboard-switch step', () => {

  test('dashboard-switch step fails when activate returns ok=false', async () => {
    const logs = [];

    const result = await runSmoke(
      { ...BASE_OPTS, continueOnFail: true },
      {
        exec: async () => ({ stdout: '', stderr: '' }),
        spawnBg: makeSpawnBgMock('ready').fn,
        fetch: async (url, opts = {}) => {
          if ((opts.method ?? 'GET') === 'POST' && url.includes('/activate')) {
            return {
              ok: true,
              status: 200,
              text: async () => '{"ok":false}',
              json: async () => ({ ok: false }),
            };
          }
          return { ok: true, status: 200, text: async () => '{}', json: async () => ({ ok: true }) };
        },
        log: (msg) => logs.push(msg),
      },
    );

    const step = result.steps.find((s) => s.name === 'dashboard-switch');
    assert.ok(step, 'dashboard-switch step should be in results');
    assert.equal(step.status, 'FAIL');
  });

});

describe('verify-cluster-smoke — request-proxy step', () => {

  test('request-proxy step fails when fetch throws (proxy unreachable)', async () => {
    const logs = [];

    const result = await runSmoke(
      { ...BASE_OPTS, continueOnFail: true },
      {
        exec: async () => ({ stdout: '', stderr: '' }),
        spawnBg: makeSpawnBgMock('ready').fn,
        fetch: async (url) => {
          if (url === 'http://localhost:3000') throw new Error('ECONNREFUSED');
          return { ok: true, status: 200, text: async () => '{}', json: async () => ({ ok: true }) };
        },
        log: (msg) => logs.push(msg),
      },
    );

    const step = result.steps.find((s) => s.name === 'request-proxy');
    assert.ok(step, 'request-proxy step should be in results');
    assert.equal(step.status, 'FAIL');
    assert.ok(step.reason?.includes('ECONNREFUSED'), `reason should mention ECONNREFUSED: ${step.reason}`);
  });

  test('request-proxy step passes for any HTTP status (502 means proxy is up but routing is down)', async () => {
    const logs = [];

    const result = await runSmoke(
      BASE_OPTS,
      {
        exec: async () => ({ stdout: '', stderr: '' }),
        spawnBg: makeSpawnBgMock('ready').fn,
        fetch: async (url) => {
          if (url === 'http://localhost:3000') {
            return { ok: false, status: 502, text: async () => 'Bad Gateway', json: async () => ({}) };
          }
          return { ok: true, status: 200, text: async () => '{}', json: async () => ({ ok: true }) };
        },
        log: (msg) => logs.push(msg),
      },
    );

    const step = result.steps.find((s) => s.name === 'request-proxy');
    assert.ok(step, 'request-proxy step should be in results');
    assert.equal(step.status, 'PASS', '502 from proxy should still pass — proxy is reachable');
  });

});
