import * as _dockerDefault from './docker.js';
import { register, isRegistered, getAll, unregister } from './registry.js';

const GATEWAY_NAME = 'fleet-gateway';

/** Regex that all valid fleet feature container names must match (bare name, no leading /). */
const FEATURE_NAME_RE = /^fleet-[a-z0-9]([a-z0-9-]*(\.[a-z0-9-]+)*)?$/;

/**
 * Mutable docker implementation holder.
 * Tests can swap this out with `_setDockerImpl(stub)`.
 * Production code always uses the real docker.js.
 * @type {{ listRunningContainers: Function, inspectContainer: Function, startContainer: Function }}
 */
let _docker = _dockerDefault;

/**
 * Test seam: replace the docker implementation used by reconcile functions.
 * Call with the real import (or a mock) to control behaviour in tests.
 * Not intended for production use.
 * @param {{ listRunningContainers: Function, inspectContainer: Function, startContainer: Function }} impl
 */
export function _setDockerImpl(impl) {
  _docker = impl;
}

/**
 * Derive the primary bare name from a container object (strips leading slash).
 * @param {{ Names: string[] }} container
 * @returns {string}
 */
function bareContainerName(container) {
  return container.Names[0].replace(/^\//, '');
}

/**
 * Derive the composite registry key from a container's env vars, falling back
 * to stripping the project prefix from the container name.
 * Returns null when PROJECT_NAME is absent (old CLI container — skip it).
 *
 * @param {string} containerName  bare container name (e.g. fleet-proj-feat)
 * @param {object} env  flat key→value map of container env vars
 * @returns {string|null}
 */
function deriveKey(containerName, env) {
  const project = env.PROJECT_NAME;
  if (!project) return null;
  const name =
    env.FEATURE_NAME ??
    containerName.replace(/^fleet-/, '').replace(new RegExp(`^${project}-`), '');
  return `${project}-${name}`;
}

/**
 * Parse a Docker Env array into a flat key→value object.
 * @param {string[]} envArray
 * @returns {Record<string, string>}
 */
function parseEnv(envArray) {
  return Object.fromEntries(
    (envArray ?? [])
      .map((e) => e.split('='))
      .filter(([k]) => k)
      .map(([k, ...rest]) => [k, rest.join('=')])
  );
}

/**
 * Filter a raw container list down to valid feature containers only.
 * @param {Array<{ Names: string[] }>} containers
 * @returns {Array<{ Names: string[] }>}
 */
function filterFeatureContainers(containers) {
  return containers.filter((c) =>
    c.Names.some((n) => {
      const bare = n.replace(/^\//, '');
      return FEATURE_NAME_RE.test(bare) && bare !== GATEWAY_NAME;
    })
  );
}

/**
 * Reconcile a single container into the registry.
 * When `autoStart` is true (boot path) stopped containers are started first.
 * When false (sweep path) stopped containers are registered with status
 * 'stopped' — the sweep must never auto-start anything.
 *
 * @param {{ Names: string[], State: string }} container  Docker container summary
 * @param {{ autoStart: boolean }} opts
 * @returns {Promise<boolean>} true when a new registration was made
 */
export async function reconcileOne(container, { autoStart }) {
  const containerName = bareContainerName(container);

  if (autoStart && container.State !== 'running') {
    try {
      await _docker.startContainer(containerName);
      console.log(`[reconcile] started: ${containerName}`);
    } catch (err) {
      console.warn(`[reconcile] could not start ${containerName}:`, err.message);
      return false;
    }
  }

  const info = await _docker.inspectContainer(containerName);
  if (!info) return false;

  const env = parseEnv(info.Config?.Env);
  const project = env.PROJECT_NAME;

  if (!project) {
    console.warn(`[reconcile] skipping ${containerName}: no PROJECT_NAME env — old CLI container`);
    return false;
  }

  const key = deriveKey(containerName, env);
  if (isRegistered(key)) return false;

  const branch = env.BRANCH ?? 'unknown';
  const appMount = (info.Mounts ?? []).find(
    (m) => m.Type === 'bind' && m.Destination === '/app'
  );
  const worktreePath = appMount?.Source ?? null;

  const isRunning = info.State?.Running === true;
  const status = isRunning ? 'up' : 'stopped';

  const featureName =
    env.FEATURE_NAME ??
    containerName.replace(/^fleet-/, '').replace(new RegExp(`^${project}-`), '');

  register(project, featureName, branch, worktreePath, status);
  console.log(`[reconcile] restored: ${key} (branch: ${branch}, status: ${status})`);
  return true;
}

/**
 * At startup, scan Docker for all fleet-* containers (running or stopped),
 * start any that are stopped, and register them.
 */
export async function reconcileFromDocker() {
  let containers;
  try {
    containers = await _docker.listRunningContainers('fleet-', { all: true });
  } catch (err) {
    console.warn('[reconcile] Docker unavailable, skipping:', err.message);
    return;
  }

  const qaContainers = filterFeatureContainers(containers);

  if (qaContainers.length === 0) {
    console.log('[reconcile] No feature containers found.');
    return;
  }

  let registered = 0;
  for (const container of qaContainers) {
    const added = await reconcileOne(container, { autoStart: true });
    if (added) registered++;
  }

  console.log(`[reconcile] ${registered} feature(s) restored.`);
}

/**
 * Periodic sweep: removes phantom registry entries (whose Docker container is
 * gone) and registers newly-appearing containers that aren't yet in the registry.
 * Never auto-starts stopped containers — that is the boot path's job.
 */
export async function reconcileSweep() {
  let containers;
  try {
    containers = await _docker.listRunningContainers('fleet-', { all: true });
  } catch (err) {
    console.warn('[reconcile.sweep] Docker unavailable, skipping:', err.message);
    return;
  }

  const qaContainers = filterFeatureContainers(containers);

  // Build a Set of composite keys that Docker actually knows about.
  // Inspect each container to read PROJECT_NAME / FEATURE_NAME from env.
  const dockerKeys = new Set();
  for (const container of qaContainers) {
    const containerName = bareContainerName(container);
    try {
      const info = await _docker.inspectContainer(containerName);
      if (!info) continue;
      const env = parseEnv(info.Config?.Env);
      const key = deriveKey(containerName, env);
      if (key) dockerKeys.add(key);
    } catch {
      // Transient inspect failure — leave the registry entry intact this sweep.
    }
  }

  // Prune registry entries whose container is gone.
  for (const entry of getAll()) {
    if (!dockerKeys.has(entry.key)) {
      unregister(entry.key);
      console.log(`[reconcile.sweep] unregistered phantom: ${entry.key}`);
    }
  }

  // Register containers not yet in the registry (no auto-start).
  for (const container of qaContainers) {
    const containerName = bareContainerName(container);
    try {
      const info = await _docker.inspectContainer(containerName);
      if (!info) continue;
      const env = parseEnv(info.Config?.Env);
      const key = deriveKey(containerName, env);
      if (!key || isRegistered(key)) continue;
      await reconcileOne(container, { autoStart: false });
    } catch {
      // Transient error — skip this container this sweep cycle.
    }
  }
}
