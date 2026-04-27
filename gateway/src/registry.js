import { inspectContainer } from './docker.js';
import { writeFileSync, renameSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Return the path to the active-feature state file.
 * Read on every call so that tests can override FLEET_STATE_FILE at runtime
 * without re-importing the module.
 * @returns {string}
 */
function stateFilePath() {
  return process.env.FLEET_STATE_FILE ?? '/var/lib/fleet/active.json';
}

/**
 * Write the active feature key to disk atomically (tmp + rename).
 * Silently swallows errors — persistence is best-effort; the gateway must
 * never crash because state could not be written (e.g. read-only mount).
 * @param {string|null} key
 */
function persistActive(key) {
  try {
    const file = stateFilePath();
    mkdirSync(dirname(file), { recursive: true });
    const payload = JSON.stringify({ key, updatedAt: new Date().toISOString() });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, payload, 'utf8');
    renameSync(tmp, file);
  } catch {
    // Best-effort — never throw from persistence layer.
  }
}

/**
 * Read the persisted active feature key from disk.
 * Returns null on missing file, unreadable file, or malformed JSON.
 * Never throws.
 * @returns {string|null}
 */
export function loadPersistedActive() {
  try {
    const raw = readFileSync(stateFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.key === 'string' && parsed.key.length > 0) {
      return parsed.key;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * @typedef {{ name: string, port: number }} ServiceEntry
 * @typedef {{ project: string, name: string, key: string, branch: string, worktreePath: string|null, title: string|null, addedAt: Date, status: string, error: string|null, services: ServiceEntry[] }} FeatureEntry
 * @type {Map<string, FeatureEntry>}
 */
const features = new Map();

/**
 * Per-feature build log store. Keyed by composite key `${project}-${name}`.
 * @type {Map<string, { lines: string[], subscribers: Set<Function>, timer: NodeJS.Timeout|null }>}
 */
const buildLogs = new Map();

/** ANSI escape sequence regex for stripping colour codes from build output. */
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

/** Maximum number of log lines retained per feature (ring buffer cap). */
const BUILD_LOG_MAX_LINES = 500;

/**
 * Append a chunk of build output for a feature.
 * Splits by newline, strips ANSI escape sequences, caps buffer at 500 lines.
 * Notifies all active SSE subscribers.
 * @param {string} key  composite key `${project}-${name}`
 * @param {string} chunk
 */
export function appendBuildLog(key, chunk) {
  if (!buildLogs.has(key)) {
    buildLogs.set(key, { lines: [], subscribers: new Set(), timer: null });
  }
  const entry = buildLogs.get(key);
  const newLines = chunk
    .split('\n')
    .map(l => l.replace(ANSI_RE, ''))
    .filter(l => l.length > 0);

  for (const line of newLines) {
    entry.lines.push(line);
    if (entry.lines.length > BUILD_LOG_MAX_LINES) {
      entry.lines.shift();
    }
    for (const cb of entry.subscribers) {
      try { cb(line); } catch { /* subscriber died; unsubscribe on next tick */ }
    }
  }
}

/**
 * Return current buffered log lines for a feature, or null if no entry exists.
 * @param {string} key  composite key `${project}-${name}`
 * @returns {{ lines: string[] }|null}
 */
export function getBuildLog(key) {
  const entry = buildLogs.get(key);
  if (!entry) return null;
  return { lines: entry.lines };
}

/**
 * Subscribe to live build log lines for a feature.
 * The callback is called with each new line string as it arrives.
 * Returns an unsubscribe function.
 * @param {string} key  composite key `${project}-${name}`
 * @param {Function} callback
 * @returns {Function} unsubscribe
 */
export function subscribeBuildLog(key, callback) {
  if (!buildLogs.has(key)) {
    buildLogs.set(key, { lines: [], subscribers: new Set(), timer: null });
  }
  const entry = buildLogs.get(key);
  entry.subscribers.add(callback);
  return () => { entry.subscribers.delete(callback); };
}

/**
 * Schedule eviction of a feature's build log after delayMs milliseconds.
 * Cancels any previously scheduled eviction for the same feature.
 * @param {string} key  composite key `${project}-${name}`
 * @param {number} [delayMs=60000]
 */
export function clearBuildLog(key, delayMs = 60000) {
  const entry = buildLogs.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    buildLogs.delete(key);
  }, delayMs);
}

/** @type {string|null} */
let activeFeature = null;

/**
 * Normalise legacy 'running' tokens from older CLIs to the canonical 'up'.
 * New vocabulary: 'created' | 'building' | 'starting' | 'up' | 'failed' | 'stopped' | 'not_started'.
 * @param {string} status
 * @returns {string}
 */
function normaliseStatus(status) {
  return status === 'running' ? 'up' : status;
}

/**
 * Register a new feature container. Auto-activates only when status is 'up' —
 * routing traffic to a not-yet-running container (building/starting) would 502.
 * @param {string} project - project name (required — determines composite key)
 * @param {string} name - feature/branch short name
 * @param {string} branch
 * @param {string|null} worktreePath - absolute path on the host Mac
 * @param {string} status - lifecycle: 'created' | 'building' | 'starting' | 'up' | 'stopped' | 'not_started' | 'failed'. 'running' is silently mapped to 'up' for back-compat.
 * @param {ServiceEntry[]} services - per-service {name, port} entries for path-prefix routing
 * @param {string|null} title - human-readable display title for the dashboard card
 * @param {string|null} error - human-readable failure reason (populated for status='failed')
 */
export function register(project, name, branch, worktreePath = null, status = 'up', services = [], title = null, error = null) {
  const key = `${project}-${name}`;
  const normalised = normaliseStatus(status);
  features.set(key, { project, name, key, branch, worktreePath, title, addedAt: new Date(), status: normalised, error, services });
  if (activeFeature === null && normalised === 'up') {
    activeFeature = key;
    persistActive(key);
  }
}

/**
 * Return the services registered for a feature, or an empty array.
 * @param {string} key  composite key `${project}-${name}`
 * @returns {ServiceEntry[]}
 */
export function getServices(key) {
  const entry = features.get(key);
  return entry?.services ?? [];
}

/**
 * Update the status of a registered feature. When `error` is undefined, the
 * existing entry.error is preserved — callers that just want to transition
 * status (e.g. building → starting) do not need to clear error state explicitly.
 * Pass null to clear it; pass a string to set it (typically with status='failed').
 * @param {string} key  composite key `${project}-${name}`
 * @param {string} status
 * @param {string|null} [error]
 */
export function updateStatus(key, status, error) {
  const entry = features.get(key);
  if (!entry) throw new Error(`Feature '${key}' is not registered`);
  const normalised = normaliseStatus(status);
  const next = { ...entry, status: normalised };
  if (error !== undefined) next.error = error;
  if ((normalised === 'stopped' || normalised === 'failed') && activeFeature === key) {
    activeFeature = null;
  }
  features.set(key, next);

  // Build log lifecycle: initialise fresh buffer on 'building', schedule
  // eviction 60s after 'up' or 'failed' so page-refresh can replay.
  if (normalised === 'building') {
    buildLogs.delete(key);
    buildLogs.set(key, { lines: [], subscribers: new Set(), timer: null });
  } else if (normalised === 'up' || normalised === 'failed') {
    clearBuildLog(key, 60000);
  }
}

/**
 * Unregister a feature container. Clears active feature if it was the active one.
 * @param {string} key  composite key `${project}-${name}`
 */
export function unregister(key) {
  features.delete(key);
  if (activeFeature === key) activeFeature = null;
}

/**
 * Return all registered features as an array, with isActive flag.
 * Each entry includes project, name, and key (the composite) for dashboard use.
 * @returns {(FeatureEntry & { isActive: boolean })[]}
 */
export function getAll() {
  return Array.from(features.entries()).map(([key, data]) => ({
    ...data,
    isActive: key === activeFeature,
  }));
}

/**
 * Return the entry for a feature by composite key, or null.
 * @param {string} key  composite key `${project}-${name}`
 * @returns {FeatureEntry|null}
 */
export function getFeature(key) {
  return features.get(key) ?? null;
}

/**
 * Check if a feature is registered by composite key.
 * @param {string} key  composite key `${project}-${name}`
 * @returns {boolean}
 */
export function isRegistered(key) {
  return features.has(key);
}

/**
 * Return the composite key of the currently active feature, or null.
 * @returns {string|null}
 */
export function getActiveFeature() {
  return activeFeature;
}

/**
 * Set the active feature for the transparent proxy.
 * @param {string} key  composite key `${project}-${name}`
 * @throws {Error} if the feature is not registered
 */
export function setActiveFeature(key) {
  if (!features.has(key)) throw new Error(`Feature '${key}' is not registered`);
  activeFeature = key;
  persistActive(key);
}

/**
 * Live-check whether a feature's Docker container is currently running.
 * Queries the Docker daemon via inspectContainer and returns a normalised status.
 *
 * This is intentionally a lazy check — called only when a request arrives — so
 * the registry does not require a background poller.
 *
 * @param {string} key  composite key `${project}-${name}` — maps to container `fleet-${key}`
 * @returns {Promise<'running' | 'stopped' | 'missing'>}
 */
export async function getContainerStatus(key) {
  try {
    const info = await inspectContainer(`fleet-${key}`);
    if (!info) return 'missing';
    return info.State?.Running === true ? 'running' : 'stopped';
  } catch {
    // Treat any docker error conservatively — container unreachable → stopped
    return 'stopped';
  }
}
