/**
 * Port-forward manager for cluster features.
 *
 * Maintains a live Map<featureKey, { localPort, stop }> of active oc
 * port-forward processes. When an oc process exits unexpectedly the manager
 * restarts it under a per-key Promise lock so at most one restart runs per key
 * at a time. SIGTERM drains all active forwards cleanly.
 *
 * The module exports a singleton wired to the real oc wrapper. Use
 * createPortForwardManager(mockPortForward) in tests for a fully isolated
 * instance.
 *
 * @module cluster/port-forward
 */

import * as oc from './oc.js';

/**
 * @callback PortForwardFn
 * @param {string} svcName
 * @param {string} ns
 * @param {number} remotePort
 * @returns {Promise<{ localPort: number, stop: () => Promise<void>, exitPromise: Promise<number> }>}
 */

/**
 * Create an isolated port-forward manager (useful for testing).
 *
 * @param {PortForwardFn} portForward - injected port-forward implementation
 * @returns {{
 *   registerForward(featureKey: string, ns: string): Promise<number>,
 *   getLocalPort(featureKey: string): number | undefined,
 *   unregisterForward(featureKey: string): Promise<void>,
 *   drain(): Promise<void>,
 * }}
 */
export function createPortForwardManager(portForward) {
  /**
   * @type {Map<string, { localPort: number, stop: () => Promise<void>, ns: string }>}
   */
  const forwards = new Map();

  /**
   * Per-key restart locks. While a Promise for featureKey is present, an
   * in-flight restart is running for that key — new exit events are ignored.
   * @type {Map<string, Promise<void>>}
   */
  const restartPromises = new Map();

  /**
   * Keys that were unregistered while a restart was in progress. When the
   * restart completes it stops the fresh process and does not add the entry.
   * @type {Set<string>}
   */
  const cancelled = new Set();

  let draining = false;

  /**
   * Open a new forward, register it, and watch for unexpected exits.
   * If the key has been cancelled (unregistered mid-restart) or draining is
   * active, the newly-started process is stopped immediately.
   *
   * @param {string} featureKey
   * @param {string} ns
   * @returns {Promise<number | undefined>} local port, or undefined if cancelled
   */
  async function startAndWatch(featureKey, ns) {
    const { localPort, stop, exitPromise } = await portForward(`fleet-${featureKey}`, ns, 80);

    if (cancelled.has(featureKey) || draining) {
      cancelled.delete(featureKey);
      await stop();
      return undefined;
    }

    forwards.set(featureKey, { localPort, stop, ns });
    exitPromise.then(() => onExit(featureKey));
    return localPort;
  }

  /**
   * Handle an unexpected exit of the oc process for featureKey.
   * Acquires the per-key lock before restarting; ignores the event if the key
   * was intentionally unregistered, is already restarting, or drain is active.
   *
   * @param {string} featureKey
   */
  function onExit(featureKey) {
    if (draining) return;
    if (!forwards.has(featureKey)) return; // intentionally unregistered
    if (restartPromises.has(featureKey)) return; // restart already in flight

    const { ns } = forwards.get(featureKey);
    // Remove the stale entry so getLocalPort returns undefined during restart.
    forwards.delete(featureKey);

    const p = startAndWatch(featureKey, ns)
      .catch(err => {
        console.error(`[port-forward] restart failed for ${featureKey}:`, err.message);
      })
      .finally(() => restartPromises.delete(featureKey));

    restartPromises.set(featureKey, p);
  }

  return {
    /**
     * Open a port-forward for svc/fleet-<featureKey> and store the entry.
     * Returns the existing port immediately if the key is already registered.
     *
     * @param {string} featureKey
     * @param {string} ns - OpenShift namespace
     * @returns {Promise<number>} kernel-assigned local port
     */
    async registerForward(featureKey, ns) {
      const existing = forwards.get(featureKey);
      if (existing) return existing.localPort;
      return startAndWatch(featureKey, ns);
    },

    /**
     * Return the kernel-assigned local port for an active forward, or
     * undefined if the key is not registered (including during restart).
     *
     * @param {string} featureKey
     * @returns {number | undefined}
     */
    getLocalPort(featureKey) {
      return forwards.get(featureKey)?.localPort;
    },

    /**
     * Kill the forward for featureKey and remove its map entry.
     * If a restart is in progress, marks it cancelled and waits for it to
     * finish before returning (the fresh process is stopped by the restart
     * path itself).
     * No-op if the key is not registered and not restarting.
     *
     * @param {string} featureKey
     * @returns {Promise<void>}
     */
    async unregisterForward(featureKey) {
      if (restartPromises.has(featureKey)) {
        // Signal the in-flight restart to discard its fresh process.
        cancelled.add(featureKey);
        await restartPromises.get(featureKey);
        return;
      }
      const entry = forwards.get(featureKey);
      if (!entry) return;
      // Remove first so onExit (if it fires concurrently) sees the key gone.
      forwards.delete(featureKey);
      await entry.stop();
    },

    /**
     * Drain all active forwards. After drain, no automatic restarts occur.
     * Call this on SIGTERM before exiting to leave no orphan oc processes.
     *
     * @returns {Promise<void>}
     */
    async drain() {
      draining = true;
      const entries = [...forwards.values()];
      forwards.clear();
      await Promise.all(entries.map(e => e.stop()));
    },
  };
}

// ---------------------------------------------------------------------------
// Production singleton — wired to the real oc wrapper
// ---------------------------------------------------------------------------

const _singleton = createPortForwardManager(
  (svcName, ns, remotePort) => oc.portForward(svcName, ns, remotePort),
);

export const registerForward = _singleton.registerForward.bind(_singleton);
export const getLocalPort = _singleton.getLocalPort.bind(_singleton);
export const unregisterForward = _singleton.unregisterForward.bind(_singleton);
export const drain = _singleton.drain.bind(_singleton);

process.on('SIGTERM', () => {
  _singleton
    .drain()
    .catch(err => console.error('[port-forward] drain error:', err.message))
    .finally(() => process.exit(0));
});
