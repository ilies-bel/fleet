#!/usr/bin/env node
/**
 * verify-cluster-smoke.js
 *
 * Smoke verification for Fleet + OpenShift cluster integration.
 *
 * Lifecycle:
 *   cleanup-leftovers → create-pod → wait-pod-ready → port-forward →
 *   register-feature → request-proxy → dashboard-switch → teardown
 *
 * Usage:
 *   node scripts/verify-cluster-smoke.js \
 *     --namespace <ns> \
 *     --feature-key <key> \
 *     [--keep-pod] \
 *     [--continue] \
 *     [--local-port 13000] \
 *     [--gateway-url http://localhost:4000] \
 *     [--proxy-url http://localhost:3000]
 *
 * Exits 0 if all steps pass, 1 if any step fails, 2 on bad arguments.
 */

import { parseArgs } from 'node:util';
import { spawn as nodeSpawn } from 'node:child_process';
// All oc/kubectl spawning routes through the cluster module (architectural invariant).
import { runOc, spawnOcProcess } from '../gateway/src/cluster/oc.js';

// ── Internal sentinel ─────────────────────────────────────────────────────────

class StepFailed extends Error {
  constructor(name) {
    super(`step failed: ${name}`);
    this.name = 'StepFailed';
    this.stepName = name;
  }
}

// ── Core runner (exported for testing) ───────────────────────────────────────

/**
 * Run the full smoke lifecycle.
 *
 * @param {{
 *   namespace: string,
 *   featureKey: string,
 *   keepPod?: boolean,
 *   continueOnFail?: boolean,
 *   localPort?: number,
 * }} opts
 *
 * @param {{
 *   oc: {
 *     delete(kind: string, name: string, ns: string, opts?: { ignoreNotFound?: boolean }): Promise<string>,
 *     apply(manifest: string, ns: string): Promise<string>,
 *     waitReady(podName: string, ns: string): Promise<string>,
 *     portForward(podRef: string, ns: string, localPort: number, podPort: number): {
 *       onReady(cb: () => void): void,
 *       onError(cb: (err: Error) => void): void,
 *       kill(): void,
 *     },
 *   },
 *   pkill(pattern: string): Promise<void>,
 *   fetch(url: string, init?: object): Promise<{ok: boolean, status: number, text(): Promise<string>, json(): Promise<any>}>,
 *   log(msg: string): void,
 *   gatewayUrl?: string,
 *   proxyUrl?: string,
 * }} deps
 *
 * @returns {Promise<{
 *   steps: Array<{name: string, status: 'PASS'|'FAIL', reason?: string}>,
 *   exitCode: number,
 * }>}
 */
export async function runSmoke(opts, { oc, pkill, fetch: doFetch, log, gatewayUrl = 'http://localhost:4000', proxyUrl = 'http://localhost:3000' }) {
  const {
    namespace,
    featureKey,
    keepPod = false,
    continueOnFail = false,
    localPort = 13000,
  } = opts;

  const steps = [];
  let hadFailure = false;
  let pfHandle = null;

  const podName = `fleet-smoke-${featureKey}`;
  const svcName = `fleet-smoke-${featureKey}`;
  // composite key used with Fleet's /register-feature endpoint (project=smoke)
  const compositeKey = `smoke-${featureKey}`;

  async function runStep(name, fn) {
    try {
      await fn();
      log(`PASS: ${name}`);
      steps.push({ name, status: 'PASS' });
    } catch (err) {
      const reason = err?.message ?? String(err);
      log(`FAIL: ${name} ${reason}`);
      steps.push({ name, status: 'FAIL', reason });
      hadFailure = true;
      if (!continueOnFail) throw new StepFailed(name);
    }
  }

  try {
    // ── 1. cleanup-leftovers (idempotency) ────────────────────────────────────
    await runStep('cleanup-leftovers', async () => {
      // Kill any leftover port-forward from a prior run (best-effort; ignore if no process)
      await pkill(`oc port-forward.*${podName}`).catch(() => {});

      // ignoreNotFound means oc exits 0 even when the resource is absent
      await oc.delete('pod', podName, namespace, { ignoreNotFound: true });
      await oc.delete('service', svcName, namespace, { ignoreNotFound: true });

      // Deregister from Fleet if it's reachable (best-effort)
      await doFetch(`${gatewayUrl}/register-feature/${compositeKey}`, { method: 'DELETE' }).catch(() => {});
    });

    // ── 2. create-pod ─────────────────────────────────────────────────────────
    await runStep('create-pod', async () => {
      const manifest = buildManifest(namespace, podName, svcName);
      await oc.apply(manifest, namespace);
    });

    // ── 3. wait-pod-ready ─────────────────────────────────────────────────────
    await runStep('wait-pod-ready', async () => {
      await oc.waitReady(podName, namespace);
    });

    // ── 4. port-forward ───────────────────────────────────────────────────────
    await runStep('port-forward', async () => {
      pfHandle = oc.portForward(`pod/${podName}`, namespace, localPort, 80);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('port-forward ready signal timed out after 10s')),
          10_000,
        );
        pfHandle.onReady(() => { clearTimeout(timeout); resolve(); });
        pfHandle.onError((err) => { clearTimeout(timeout); reject(err); });
      });
    });

    // ── 5. register-feature ───────────────────────────────────────────────────
    await runStep('register-feature', async () => {
      const res = await doFetch(`${gatewayUrl}/register-feature`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: 'smoke',
          name: featureKey,
          branch: featureKey,
          worktreePath: `/tmp/fleet-smoke-${featureKey}`,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body}`);
      }
    });

    // ── 6. request-proxy ──────────────────────────────────────────────────────
    await runStep('request-proxy', async () => {
      let res;
      try {
        res = await doFetch(proxyUrl);
      } catch (err) {
        throw new Error(`proxy unreachable: ${err.message}`);
      }
      // Accept any HTTP response — even a 502 means the proxy is running.
      // A thrown error (ECONNREFUSED) is the real failure case.
      if (!res || typeof res.status !== 'number') {
        throw new Error('unexpected non-HTTP response from proxy');
      }
    });

    // ── 7. dashboard-switch ───────────────────────────────────────────────────
    await runStep('dashboard-switch', async () => {
      const res = await doFetch(`${gatewayUrl}/_fleet/api/features/${compositeKey}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body}`);
      }
      const data = await res.json().catch(() => ({}));
      if (!data.ok) {
        throw new Error(`activate response missing ok=true: ${JSON.stringify(data)}`);
      }
    });

    // ── 8. teardown ───────────────────────────────────────────────────────────
    if (keepPod) {
      log('PASS: teardown (skipped — --keep-pod set)');
      steps.push({ name: 'teardown', status: 'PASS' });
    } else {
      await runStep('teardown', async () => {
        if (pfHandle) { pfHandle.kill(); pfHandle = null; }
        await oc.delete('pod', podName, namespace);
        await oc.delete('service', svcName, namespace);
        await doFetch(`${gatewayUrl}/register-feature/${compositeKey}`, { method: 'DELETE' }).catch(() => {});
      });
    }

  } catch (err) {
    if (!(err instanceof StepFailed)) {
      // Unexpected error that escaped all step wrappers
      const reason = err?.message ?? String(err);
      log(`FAIL: unexpected-error ${reason}`);
      steps.push({ name: 'unexpected-error', status: 'FAIL', reason });
      hadFailure = true;
    }
  } finally {
    // Always clean up the port-forward background process unless asked to keep it
    if (!keepPod && pfHandle) {
      pfHandle.kill();
    }
  }

  return { steps, exitCode: hadFailure ? 1 : 0 };
}

// ── Manifest builder ──────────────────────────────────────────────────────────

function buildManifest(namespace, podName, svcName) {
  return [
    'apiVersion: v1',
    'kind: Pod',
    'metadata:',
    `  name: ${podName}`,
    `  namespace: ${namespace}`,
    '  labels:',
    `    app: ${podName}`,
    'spec:',
    '  containers:',
    '  - name: app',
    '    image: nginx:alpine',
    '    ports:',
    '    - containerPort: 80',
    '---',
    'apiVersion: v1',
    'kind: Service',
    'metadata:',
    `  name: ${svcName}`,
    `  namespace: ${namespace}`,
    'spec:',
    '  selector:',
    `    app: ${podName}`,
    '  ports:',
    '  - port: 80',
    '    targetPort: 80',
  ].join('\n');
}

// ── Real dependency implementations ──────────────────────────────────────────

/**
 * Build the oc deps object backed by gateway/src/cluster/oc.js.
 * All oc/kubectl spawning routes through runOc/spawnOcProcess from that module.
 *
 * @returns {{
 *   delete(kind, name, ns, opts?): Promise<string>,
 *   apply(manifest, ns): Promise<string>,
 *   waitReady(podName, ns): Promise<string>,
 *   portForward(podRef, ns, localPort, podPort): { onReady, onError, kill },
 * }}
 */
function makeOcDeps() {
  return {
    /**
     * @param {string} kind - e.g. 'pod' or 'service'
     * @param {string} name
     * @param {string} ns
     * @param {{ ignoreNotFound?: boolean }} [ocOpts]
     */
    delete(kind, name, ns, ocOpts = {}) {
      const args = ['delete', kind, name, '-n', ns];
      if (ocOpts.ignoreNotFound) args.push('--ignore-not-found');
      return runOc(args);
    },

    /**
     * @param {string} manifest - YAML/JSON manifest string
     * @param {string} ns
     */
    apply(manifest, ns) {
      return runOc(['apply', '-f', '-', '-n', ns], { stdin: manifest });
    },

    /**
     * @param {string} podName
     * @param {string} ns
     */
    waitReady(podName, ns) {
      return runOc(['wait', `pod/${podName}`, '-n', ns, '--for=condition=Ready', '--timeout=120s']);
    },

    /**
     * @param {string} podRef  - e.g. 'pod/fleet-smoke-foo'
     * @param {string} ns
     * @param {number} localPort
     * @param {number} podPort
     * @returns {{ onReady(cb): void, onError(cb): void, kill(): void }}
     */
    portForward(podRef, ns, localPort, podPort) {
      const child = spawnOcProcess(['port-forward', podRef, `${localPort}:${podPort}`, '-n', ns]);

      const readyCbs = [];
      const errorCbs = [];
      let fired = false;
      let firedError = null;

      function emitReady() {
        if (fired) return;
        fired = true;
        readyCbs.forEach((cb) => cb());
      }

      function emitError(err) {
        firedError = err;
        errorCbs.forEach((cb) => cb(err));
      }

      // oc port-forward prints "Forwarding from 127.0.0.1:PORT -> PORT" on stdout
      child.stdout.on('data', (chunk) => {
        if (/Forwarding from/i.test(chunk.toString())) emitReady();
      });
      // Some oc versions write to stderr instead
      child.stderr.on('data', (chunk) => {
        if (/Forwarding from/i.test(chunk.toString())) emitReady();
      });

      child.on('error', emitError);

      child.on('close', (code) => {
        if (!fired && code !== 0) {
          emitError(new Error(`oc port-forward exited unexpectedly with code ${code}`));
        }
      });

      return {
        onReady(cb) { if (fired) cb(); else readyCbs.push(cb); },
        onError(cb) { if (firedError) cb(firedError); else errorCbs.push(cb); },
        kill() { child.kill('SIGTERM'); },
      };
    },
  };
}

/**
 * Returns a pkill function that sends SIGTERM to processes matching a pattern
 * against the full command line (pkill -f). Only used for non-oc cleanup
 * (killing leftover port-forward wrappers by process name pattern).
 * @returns {(pattern: string) => Promise<void>}
 */
function makePkill() {
  return function pkill(pattern) {
    return new Promise((resolve, reject) => {
      const child = nodeSpawn('pkill', ['-f', pattern]);
      child.on('error', reject);
      child.on('close', () => resolve());
    });
  };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

// Guard: only run as CLI when this file is the entry point, not when imported.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        namespace:      { type: 'string' },
        'feature-key':  { type: 'string' },
        'keep-pod':     { type: 'boolean', default: false },
        continue:       { type: 'boolean', default: false },
        'local-port':   { type: 'string',  default: '13000' },
        'gateway-url':  { type: 'string',  default: 'http://localhost:4000' },
        'proxy-url':    { type: 'string',  default: 'http://localhost:3000' },
      },
      strict: true,
    });
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(2);
  }

  const { values } = parsed;

  if (!values.namespace) {
    process.stderr.write('Error: --namespace is required\n');
    process.exit(2);
  }
  if (!values['feature-key']) {
    process.stderr.write('Error: --feature-key is required\n');
    process.exit(2);
  }

  const localPort = parseInt(values['local-port'], 10);
  if (Number.isNaN(localPort) || localPort < 1024 || localPort > 65535) {
    process.stderr.write('Error: --local-port must be a valid port number between 1024 and 65535\n');
    process.exit(2);
  }

  const { exitCode } = await runSmoke(
    {
      namespace:      values.namespace,
      featureKey:     values['feature-key'],
      keepPod:        values['keep-pod'],
      continueOnFail: values.continue,
      localPort,
    },
    {
      oc:         makeOcDeps(),
      pkill:      makePkill(),
      fetch:      globalThis.fetch,
      log:        (msg) => process.stdout.write(msg + '\n'),
      gatewayUrl: values['gateway-url'],
      proxyUrl:   values['proxy-url'],
    },
  );

  process.exit(exitCode);
}
