/**
 * Cluster feature lifecycle management.
 *
 * Applies a pod + service manifest, waits for the pod to reach the Running
 * (idle-wait) phase, oc-rsyncs each service's worktree into /app/<svc>, then
 * touches the /app/.fleet-ready sentinel so supervisord starts.  Resolves when
 * supervisord is confirmed to be serving traffic via supervisorctl status.
 *
 * All cluster operations are routed through the _oc implementation so the
 * dependency can be swapped out in tests via _setOcImpl().
 */

import * as _ocDefault from './oc.js';
import { renderFeaturePod } from './manifest.js';

/**
 * Mutable oc implementation holder — swapped out in tests via _setOcImpl.
 * @type {typeof import('./oc.js')}
 */
let _oc = _ocDefault;

/**
 * Test seam: replace the oc implementation used by startClusterFeature.
 * Pass undefined to restore the real oc module.
 * @param {typeof import('./oc.js') | undefined} impl
 */
export function _setOcImpl(impl) {
  _oc = impl === undefined ? _ocDefault : impl;
}

/**
 * Structured error for cluster lifecycle failures.  The `step` field names
 * the phase that failed so callers can surface actionable context.
 */
export class ClusterLifecycleError extends Error {
  /**
   * @param {string} step  - e.g. 'apply-pod', 'wait-running', 'rsync-frontend'
   * @param {Error}  cause - original error from the failing oc operation
   */
  constructor(step, cause) {
    super(`startClusterFeature failed at step '${step}': ${cause.message}`);
    this.name = 'ClusterLifecycleError';
    this.step = step;
    this.cause = cause;
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll fn() (which returns a boolean Promise) until it returns true.
 * Errors from fn() are silently treated as "not ready yet" (transient).
 * Throws when the deadline is reached.
 *
 * @param {() => Promise<boolean>} fn
 * @param {number} intervalMs
 * @param {number} timeoutMs
 * @param {string} label  - included in the timeout error message
 * @returns {Promise<void>}
 */
async function pollUntil(fn, intervalMs, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      if (await fn()) return;
    } catch {
      // transient failure — keep polling
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label}: timed out after ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

/**
 * Default polling configuration. Pass opts to startClusterFeature to override
 * (e.g. shorter timeouts in tests).
 */
const POLL_DEFAULTS = {
  podPollIntervalMs: 2_000,
  podPollTimeoutMs: 120_000,
  supervisordPollIntervalMs: 2_000,
  supervisordPollTimeoutMs: 60_000,
};

/**
 * Start a fleet feature on a managed OpenShift cluster.
 *
 * Sequence:
 *   1. oc apply pod manifest
 *   2. oc apply service manifest
 *   3. Poll oc getPodStatus until phase === 'Running'  (pod is in idle-wait mode)
 *   4. For each service: oc rsync <svcAbsPath> → fleet-<key>:/app/<svc>
 *   5. oc exec touch /app/.fleet-ready  (signals supervisord to start)
 *   6. Poll oc exec supervisorctl status until supervisord is serving
 *
 * @param {{ key: string,
 *            host: { cluster: string, namespace: string },
 *            services?: Array<{ name: string, port?: number }>,
 *            svcAbsPaths?: string[] }} feature
 * @param {{ podPollIntervalMs?: number,
 *            podPollTimeoutMs?: number,
 *            supervisordPollIntervalMs?: number,
 *            supervisordPollTimeoutMs?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function startClusterFeature(feature, opts = {}) {
  const {
    podPollIntervalMs,
    podPollTimeoutMs,
    supervisordPollIntervalMs,
    supervisordPollTimeoutMs,
  } = { ...POLL_DEFAULTS, ...opts };

  const { key, host, services = [], svcAbsPaths = [] } = feature;
  const { namespace } = host;
  const podName = `fleet-${key}`;

  // ── Step 1 & 2: apply pod + service manifests ─────────────────────────────

  const { pod, service } = renderFeaturePod(feature);

  try {
    await _oc.apply(JSON.stringify(pod));
  } catch (err) {
    throw new ClusterLifecycleError('apply-pod', err);
  }

  try {
    await _oc.apply(JSON.stringify(service));
  } catch (err) {
    throw new ClusterLifecycleError('apply-service', err);
  }

  // ── Step 3: wait for pod to reach Running (idle-wait mode) ────────────────

  try {
    await pollUntil(
      async () => {
        const phase = await _oc.getPodStatus(podName, namespace);
        return phase === 'Running';
      },
      podPollIntervalMs,
      podPollTimeoutMs,
      `pod ${podName} Running`,
    );
  } catch (err) {
    throw new ClusterLifecycleError('wait-running', err);
  }

  // ── Step 4: rsync each service worktree into /app/<svc> ───────────────────

  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    const absPath = svcAbsPaths[i];
    try {
      await _oc.rsync(absPath, podName, `/app/${svc.name}`, namespace);
    } catch (err) {
      throw new ClusterLifecycleError(`rsync-${svc.name}`, err);
    }
  }

  // ── Step 5: touch the start sentinel ─────────────────────────────────────

  try {
    await _oc.exec(podName, namespace, ['touch', '/app/.fleet-ready']);
  } catch (err) {
    throw new ClusterLifecycleError('touch-sentinel', err);
  }

  // ── Step 6: wait for supervisord to serve traffic ─────────────────────────

  try {
    await pollUntil(
      async () => {
        await _oc.exec(podName, namespace, ['supervisorctl', 'status']);
        return true;
      },
      supervisordPollIntervalMs,
      supervisordPollTimeoutMs,
      'supervisord',
    );
  } catch (err) {
    throw new ClusterLifecycleError('wait-supervisord', err);
  }
}
