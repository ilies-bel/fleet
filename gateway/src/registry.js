/**
 * @typedef {{ name: string, port: number }} ServiceEntry
 * @typedef {{ branch: string, worktreePath: string|null, project: string|null, addedAt: Date, status: string, services: ServiceEntry[] }} FeatureEntry
 * @type {Map<string, FeatureEntry>}
 */
const features = new Map();

/** @type {string|null} */
let activeFeature = null;

/**
 * Register a new feature container. Auto-activates if no feature is currently active.
 * @param {string} name
 * @param {string} branch
 * @param {string|null} worktreePath - absolute path on the host Mac
 * @param {string|null} project - project name shown in the dashboard
 * @param {string} status - lifecycle status: 'running' | 'not_started' | 'stopped'
 * @param {ServiceEntry[]} services - per-service {name, port} entries for path-prefix routing
 */
export function register(name, branch, worktreePath = null, project = null, status = 'running', services = []) {
  features.set(name, { branch, worktreePath, project, addedAt: new Date(), status, services });
  // Only auto-activate if the feature is actually running
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
 * Update the status of a registered feature.
 * @param {string} name
 * @param {string} status
 */
export function updateStatus(name, status) {
  const entry = features.get(name);
  if (!entry) throw new Error(`Feature '${name}' is not registered`);
  features.set(name, { ...entry, status });
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
