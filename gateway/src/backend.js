/**
 * Backend dispatcher for fleet feature lifecycle operations.
 *
 * Routes startFeature() to the cluster or local-Docker backend based on
 * whether the feature carries a host descriptor.  Callers (cmd-add and
 * friends) never import docker.js or lifecycle.js directly — this module
 * owns the dispatch so the local path stays unchanged for features with no
 * host.
 */

import * as _dockerDefault from './docker.js';
import { startClusterFeature as _startClusterFeatureDefault } from './cluster/lifecycle.js';

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
