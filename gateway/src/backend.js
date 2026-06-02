/**
 * Backend dispatcher for fleet feature lifecycle operations.
 *
 * Routes startFeature() / stopFeature() to the cluster or local-Docker backend
 * based on whether the feature carries a host descriptor.  Callers (cmd-add and
 * friends) never import docker.js or lifecycle.js directly — this module
 * owns the dispatch so the local path stays unchanged for features with no
 * host.
 */

import * as _dockerDefault from './docker.js';
import { startClusterFeature as _startClusterFeatureDefault } from './cluster/lifecycle.js';
import * as _portForwardDefault from './cluster/port-forward.js';
import * as _ocDefault from './cluster/oc.js';

/**
 * Mutable holders for dependency injection in tests.
 * @type {typeof import('./docker.js')}
 */
let _docker = _dockerDefault;

/**
 * @type {{ startClusterFeature: typeof _startClusterFeatureDefault }}
 */
let _lifecycle = { startClusterFeature: _startClusterFeatureDefault };

/**
 * @type {{ unregisterForward: Function }}
 */
let _portForward = _portForwardDefault;

/**
 * @type {{ deletePod: Function, deleteService: Function }}
 */
let _oc = _ocDefault;

/**
 * Test seam: replace the Docker implementation.
 * Pass undefined to restore the real docker module.
 * @param {typeof import('./docker.js') | undefined} impl
 */
export function _setDockerImpl(impl) {
  _docker = impl === undefined ? _dockerDefault : impl;
}

/**
 * Test seam: replace the cluster lifecycle implementation.
 * Pass undefined to restore the real lifecycle module.
 * @param {{ startClusterFeature: Function } | undefined} impl
 */
export function _setLifecycleImpl(impl) {
  _lifecycle =
    impl === undefined ? { startClusterFeature: _startClusterFeatureDefault } : impl;
}

/**
 * Test seam: replace the port-forward implementation.
 * Pass undefined to restore the real port-forward module.
 * @param {{ unregisterForward: Function } | undefined} impl
 */
export function _setPortForwardImpl(impl) {
  _portForward = impl === undefined ? _portForwardDefault : impl;
}

/**
 * Test seam: replace the oc implementation used by stopFeature.
 * Pass undefined to restore the real oc module.
 * @param {{ deletePod: Function, deleteService: Function } | undefined} impl
 */
export function _setStopOcImpl(impl) {
  _oc = impl === undefined ? _ocDefault : impl;
}

/**
 * Start a fleet feature using the appropriate backend.
 *
 * - feature.host present  → cluster backend (startClusterFeature)
 * - feature.host absent   → local Docker backend (startContainer)
 *
 * @param {{ key: string, host?: object | null, [key: string]: unknown }} feature
 * @returns {Promise<void>}
 */
export function startFeature(feature) {
  if (feature.host) {
    return _lifecycle.startClusterFeature(feature);
  }
  return _docker.startContainer(`fleet-${feature.key}`);
}

/**
 * Stop and remove a fleet feature using the appropriate backend.
 *
 * - feature.host present  → cluster backend: kill port-forward, delete pod + service
 * - feature.host absent   → local Docker backend: remove container
 *
 * For cluster features the port-forward is always unregistered first so that
 * a partial failure (pod gone but service delete fails) never leaves an orphan
 * oc port-forward process.
 *
 * @param {{ key: string, host?: { namespace: string } | null, [key: string]: unknown }} feature
 * @returns {Promise<void>}
 */
export async function stopFeature(feature) {
  if (feature.host) {
    const { namespace } = feature.host;
    const resourceName = `fleet-${feature.key}`;
    await _portForward.unregisterForward(feature.key);
    await _oc.deletePod(resourceName, namespace);
    await _oc.deleteService(resourceName, namespace);
  } else {
    await _docker.removeContainer(`fleet-${feature.key}`);
  }
}
