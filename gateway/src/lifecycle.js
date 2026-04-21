import { startContainer, inspectContainer, DockerContainerError } from './docker.js';

/**
 * Auto-start `fleet-main` on gateway boot so it's always available as the
 * routing fallback target for the main-fallback behaviour in proxy.js /
 * backend-proxy.js.
 *
 * Behaviour:
 *   - Container exists and running → no-op.
 *   - Container exists and stopped → docker start.
 *   - Container missing           → log a warning and return; first-time setup
 *                                    can legitimately have no main yet.
 *   - Any other error             → log and return; this is best-effort.
 *
 * @returns {Promise<void>}
 */
export async function ensureMainRunning() {
  try {
    const info = await inspectContainer('fleet-main');
    if (!info) {
      console.warn('[fleet] fleet-main container not found — skipping auto-start (run `fleet add main --direct` to create it).');
      return;
    }
    if (info.State?.Running) {
      console.log('[fleet] fleet-main is already running.');
      return;
    }
    console.log('[fleet] fleet-main is stopped — starting it.');
    await startContainer('fleet-main');
    console.log('[fleet] fleet-main started.');
  } catch (err) {
    if (err instanceof DockerContainerError && err.status === 404) {
      console.warn('[fleet] fleet-main container not found — skipping auto-start.');
      return;
    }
    console.warn(`[fleet] ensureMainRunning failed: ${err.message}`);
  }
}
