/**
 * Cluster status backend for fleet feature reconciliation.
 *
 * Translates an OpenShift/Kubernetes pod phase into Fleet's registry status
 * vocabulary. Used by reconcileSweep when a feature's host descriptor is set.
 */

import * as _ocDefault from './oc.js';

/**
 * Mutable oc implementation holder — swapped out in tests via _setOcImpl.
 * @type {{ getPodStatus: Function }}
 */
let _oc = _ocDefault;

/**
 * Test seam: replace the oc implementation used by status().
 * Not intended for production use.
 * @param {{ getPodStatus: Function }} impl
 */
export function _setOcImpl(impl) {
  _oc = impl;
}

/**
 * Map from Kubernetes/OpenShift pod phase (or container reason) to Fleet's
 * registry status vocabulary.
 *
 *   Phase           → Fleet status
 *   ─────────────────────────────
 *   Running         → up
 *   Pending         → starting
 *   Succeeded       → stopped
 *   Failed          → failed
 *   CrashLoopBackOff→ failed   (container state reason; treated as phase here)
 *
 * Any unrecognised phase falls back to 'stopped'.
 */
const PHASE_TO_STATUS = {
  Running: 'up',
  Pending: 'starting',
  Succeeded: 'stopped',
  Failed: 'failed',
  CrashLoopBackOff: 'failed',
};

/**
 * Derive the pod name for a cluster feature.
 * Convention: fleet-<composite-key> (mirrors the local Docker container name).
 * @param {{ key: string }} feature
 * @returns {string}
 */
function podName(feature) {
  return `fleet-${feature.key}`;
}

/**
 * Return the Fleet status for a cluster-hosted feature by querying its pod phase.
 *
 * If the pod is absent (deleted out-of-band) or the oc call fails for any
 * reason, the feature is treated as 'stopped' — the registry entry is retained
 * and the caller (reconcileSweep) will commit the status change via the normal
 * debounce path.
 *
 * @param {{ key: string, host: { cluster: string, namespace: string } }} feature
 * @returns {Promise<'up'|'starting'|'stopped'|'failed'>}
 */
export async function status(feature) {
  const pod = podName(feature);
  const { namespace } = feature.host;
  let phase;
  try {
    phase = await _oc.getPodStatus(pod, namespace);
  } catch {
    // Pod not found or oc unavailable — treat as stopped, not as an error that
    // should leave the registry entry stale.
    return 'stopped';
  }
  return PHASE_TO_STATUS[phase] ?? 'stopped';
}
