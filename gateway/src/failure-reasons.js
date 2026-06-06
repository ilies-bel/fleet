/**
 * Fleet failure reason vocabulary.
 *
 * FAILURE_REASONS — frozen object mapping constant names to the canonical string codes.
 * tagError(err, code) — attach a reason code to an error if none is already present.
 */

export const FAILURE_REASONS = Object.freeze({
  DOCKER_SOCKET_UNAVAILABLE: 'docker:socket-unavailable',
  DOCKER_STOP_FAILED: 'docker:stop-failed',
  DOCKER_CONTAINER_NOT_FOUND: 'docker:container-not-found',
  BUILD_FAILED: 'build:failed',
  REGISTRY_NOT_REGISTERED: 'registry:not-registered',
  SYNC_RSYNC_FAILED: 'sync:rsync-failed',
  SYNC_CONTAINER_MISSING: 'sync:container-missing',
});

/**
 * Attach a curated reason code to an error if none is already present.
 * Uses an idempotent guard so constructor-set codes are never overwritten.
 *
 * @param {Error} err
 * @param {string} code  One of the FAILURE_REASONS values.
 * @returns {Error}  The same error object (for chaining).
 */
export function tagError(err, code) {
  if (!err.reasonCode) err.reasonCode = code;
  return err;
}
