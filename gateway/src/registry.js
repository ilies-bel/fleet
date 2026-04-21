import { inspectContainer } from './docker.js';

/**
 * @typedef {{ name: string, port: number }} ServiceEntry
 * @typedef {{ branch: string, worktreePath: string|null, project: string|null, title: string|null, addedAt: Date, status: string, error: string|null, services: ServiceEntry[] }} FeatureEntry
 * @type {Map<string, FeatureEntry>}
 */
const features = new Map();

/** @type {string|null} */
let activeFeature = null;

/**
 * Register a new feature container. Auto-activates only when status is 'running' —
 * routing traffic to a not-yet-running container (building/starting) would 502.
 * @param {string} name
 * @param {string} branch
 * @param {string|null} worktreePath - absolute path on the host Mac
 * @param {string|null} project - project name shown in the dashboard
 * @param {string} status - lifecycle: 'building' | 'starting' | 'running' | 'stopped' | 'not_started' | 'failed'
 * @param {ServiceEntry[]} services - per-service {name, port} entries for path-prefix routing
 * @param {string|null} title - human-readable display title for the dashboard card
 * @param {string|null} error - human-readable failure reason (populated for status='failed')
 */
export function register(name, branch, worktreePath = null, project = null, status = 'running', services = [], title = null, error = null) {
  features.set(name, { branch, worktreePath, project, title, addedAt: new Date(), status, error, services });
  if (activeFeature === null && status === 'running') activeFeature = name;
}

/**
 * Return the services registered for a feature, or an empty array.
 * @param {string} name
 * @returns {ServiceEntry[]}
 */
export function getServices(name) {
  const entry = features.get(name);
  return entry?.services ?? [];
}

/**
 * Update the status of a registered feature. When `error` is undefined, the
 * existing entry.error is preserved — callers that just want to transition
 * status (e.g. building → starting) do not need to clear error state explicitly.
 * Pass null to clear it; pass a string to set it (typically with status='failed').
 * @param {string} name
 * @param {string} status
 * @param {string|null} [error]
 */
export function updateStatus(name, status, error) {
  const entry = features.get(name);
  if (!entry) throw new Error(`Feature '${name}' is not registered`);
  const next = { ...entry, status };
  if (error !== undefined) next.error = error;
  features.set(name, next);
}

/**
 * Unregister a feature container. Clears active feature if it was the active one.
 * @param {string} name
 */
export function unregister(name) {
  features.delete(name);
  if (activeFeature === name) activeFeature = null;
}

/**
 * Return all registered features as an array, with isActive flag.
 * @returns {({ name: string, isActive: boolean } & FeatureEntry)[]}
 */
export function getAll() {
  return Array.from(features.entries()).map(([name, data]) => ({
    name,
    ...data,
    isActive: name === activeFeature,
  }));
}

/**
 * Return the entry for a feature, or null.
 * @param {string} name
 * @returns {FeatureEntry|null}
 */
export function getFeature(name) {
  return features.get(name) ?? null;
}

/**
 * Check if a feature is registered.
 * @param {string} name
 * @returns {boolean}
 */
export function isRegistered(name) {
  return features.has(name);
}

/**
 * Return the name of the currently active feature, or null.
 * @returns {string|null}
 */
export function getActiveFeature() {
  return activeFeature;
}

/**
 * Set the active feature for the transparent proxy.
 * @param {string} name
 * @throws {Error} if the feature is not registered
 */
export function setActiveFeature(name) {
  if (!features.has(name)) throw new Error(`Feature '${name}' is not registered`);
  activeFeature = name;
}

/**
 * Live-check whether a feature's Docker container is currently running.
 * Queries the Docker daemon via inspectContainer and returns a normalised status.
 *
 * This is intentionally a lazy check — called only when a request arrives — so
 * the registry does not require a background poller.
 *
 * @param {string} name  feature name (without the 'fleet-' prefix)
 * @returns {Promise<'running' | 'stopped' | 'missing'>}
 */
export async function getContainerStatus(name) {
  try {
    const info = await inspectContainer(`fleet-${name}`);
    if (!info) return 'missing';
    return info.State?.Running === true ? 'running' : 'stopped';
  } catch {
    // Treat any docker error conservatively — container unreachable → stopped
    return 'stopped';
  }
}
