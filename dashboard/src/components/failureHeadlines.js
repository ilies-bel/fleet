/**
 * Maps well-known reason codes to human-readable headline fragments.
 * Used by FailureClusters to build card headings like
 * "3 docker failed: docker socket unavailable".
 */
const HEADLINES = {
  'docker:socket-unavailable': 'docker socket unavailable',
  'docker:stop-failed': 'container stop failed',
  'docker:container-error': 'container error',
  'build:failed': 'build failed',
  'build:timeout': 'build timed out',
  'registry:not-registered': 'feature not registered',
  'sync:failed': 'sync failed',
};

/**
 * Return a human-readable headline fragment for the given reason code.
 * Falls back to the raw code when the code is not in the map.
 * @param {string} code
 * @returns {string}
 */
export function headlineFor(code) {
  return HEADLINES[code] ?? code;
}
