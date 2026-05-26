import * as _dockerDefault from './docker.js';
import { register, isRegistered, getAll, unregister, probeContainerState, commitProbedStatus } from './registry.js';

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
 * Recover the {name, port}[] services list from a container's FLEET_SERVICES_JSON
 * env var (written by `fleet add`). Mirrors the normalisation done by the
 * /register-feature endpoint so a reconciled entry is shaped identically to a
 * freshly-added one. Malformed or missing data yields an empty list.
 * @param {Record<string, string>} env
 * @returns {{ name: string, port: number }[]}
 */
function servicesFromEnv(env) {
  const raw = env.FLEET_SERVICES_JSON;
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((s) => s && typeof s === 'object' && typeof s.name === 'string' && Number.isFinite(Number(s.port)))
    .map((s) => ({ name: s.name, port: Number(s.port) }));
}

/**
 * Recover the host worktree path from the container's bind mounts.
 *
 * A fleet feature container mounts each service dir at `/app/<dir>` from
 * `<worktree>/<dir>` (e.g. /app/backend ← .../.worktrees/bd-x/backend). There
 * is no single `/app` mount in the split-subproject layout, so we take any
 * `/app/<dir>` bind mount and strip the trailing `/<dir>` to recover the
 * worktree root. Falls back to a legacy single `/app` mount if present.
 *
 * @param {Array<{ Type: string, Destination: string, Source: string }>} mounts
 * @returns {string|null}
 */
function worktreeFromMounts(mounts) {
  const binds = (mounts ?? []).filter((m) => m.Type === 'bind');
  // Legacy: a single /app mount maps straight to the worktree root.
  const appRoot = binds.find((m) => m.Destination === '/app');
  if (appRoot?.Source) return appRoot.Source;
  // Split layout: /app/<dir> ← <worktree>/<dir>. Strip the last path segment.
  const sub = binds.find(
    (m) => m.Destination.startsWith('/app/') && m.Destination.slice('/app/'.length).indexOf('/') === -1
  );
  if (sub?.Source) {
    const idx = sub.Source.replace(/\/+$/, '').lastIndexOf('/');
    return idx > 0 ? sub.Source.slice(0, idx) : sub.Source;
  }
  return null;
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
  const worktreePath = worktreeFromMounts(info.Mounts);
  const services = servicesFromEnv(env);

  // Classify the live container state rather than a bare Running boolean so a
  // crashed (non-zero exit / OOM) container is restored as 'failed', not
  // 'stopped'. probeContainerState reuses the inspect we already have.
  const probed = await probeContainerState(containerName, async () => info);
  const status = probed === 'unknown' || probed === 'missing' ? 'stopped' : probed;

  const featureName =
    env.FEATURE_NAME ??
    containerName.replace(/^fleet-/, '').replace(new RegExp(`^${project}-`), '');

  register(project, featureName, branch, worktreePath, status, services);
  console.log(
    `[reconcile] restored: ${key} (branch: ${branch}, status: ${status}, services: ${services.length})`
  );
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
 * Periodic sweep. Three responsibilities each cycle:
 *   1. Prune registry entries whose Docker container is gone (phantoms).
 *   2. Register newly-appearing containers not yet known (no auto-start).
 *   3. Reconcile the status of already-registered containers against Docker —
 *      so a container that exited/crashed out-of-band (Docker Desktop restart,
 *      OS sleep, OOM) is reflected as 'stopped'/'failed'/'unhealthy' instead of
 *      drifting at a stale 'up'. Flips away from 'up' are debounced (see
 *      commitProbedStatus) so a transient blip can't cause flapping.
 *
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

  // Single inspect pass: map composite key → { containerName, info }. Reused for
  // phantom-pruning, new-container registration, and status reconciliation so we
  // hit the Docker socket at most once per container per sweep.
  const seen = new Map();
  for (const container of qaContainers) {
    const containerName = bareContainerName(container);
    try {
      const info = await _docker.inspectContainer(containerName);
      if (!info) continue;
      const env = parseEnv(info.Config?.Env);
      const key = deriveKey(containerName, env);
      if (key) seen.set(key, { containerName, info, container });
    } catch {
      // Transient inspect failure — leave the registry entry intact this sweep.
    }
  }

  // 1. Prune registry entries whose container is gone.
  for (const entry of getAll()) {
    if (!seen.has(entry.key)) {
      unregister(entry.key);
      console.log(`[reconcile.sweep] unregistered phantom: ${entry.key}`);
    }
  }

  // 2 & 3. For each live container: register if new, else reconcile its status.
  for (const [key, { containerName, info, container }] of seen) {
    if (!isRegistered(key)) {
      try {
        await reconcileOne(container, { autoStart: false });
      } catch {
        // Transient error — skip this container this sweep cycle.
      }
      continue;
    }
    // Already registered — reconcile status from the inspect we already have.
    const probed = await probeContainerState(containerName, async () => info);
    const result = commitProbedStatus(key, probed);
    if (result.changed) {
      console.log(`[reconcile.sweep] ${key}: status → ${result.status}`);
    }
  }
}
