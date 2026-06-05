/**
 * Pure presentation resolver for a feature card.
 *
 * Collapses two inputs — the registry lifecycle status (authoritative for
 * terminal/lifecycle states) and the live port-80 health probe (refines the
 * running case) — into ONE presentation object the component renders from.
 * No React, no side effects: trivially unit-testable.
 */

/**
 * Canonical lifecycle → presentation map. Registry status wins when present.
 * Lifecycle states use literal hex (not CSS vars) so the computed color is
 * assertable in jsdom and matches the rest of the lifecycle palette.
 */
const STATUS_PRESENTATION = {
  not_started: { color: '#555', label: 'NOT STARTED', dimmed: true },
  created: { color: '#888', label: 'CREATED' },
  building: { color: '#ffaa00', label: 'BUILDING', blink: true },
  starting: { color: '#00aaff', label: 'STARTING', blink: true },
  restarting: { color: '#00aaff', label: 'RESTARTING', blink: true },
  unhealthy: { color: '#ffaa00', label: 'UNHEALTHY' },
  stopped: { color: '#888', label: 'STOPPED' },
  failed: { color: '#ff4444', label: 'FAILED', showError: true },
};

/** Live health probe → presentation, used only when registry status is 'up'/'running'. */
const HEALTH_PRESENTATION = {
  up: { color: 'var(--color-accent)', label: 'UP' },
  starting: { color: 'var(--color-warning)', label: 'STARTING', blink: true },
  down: { color: 'var(--color-danger)', label: 'DOWN' },
  checking: { color: 'var(--color-warning)', label: '...', blink: true },
};

const UNKNOWN_PRESENTATION = { color: 'var(--color-warning)', label: '...' };

/**
 * @typedef {{ dotColor: string, dotLabel: string, blink: boolean, dimmed: boolean, showError: boolean }} FeaturePresentation
 *
 * @param {{ status: string }} feature  the registry entry
 * @param {string} health  live probe result: 'up' | 'down' | 'starting' | 'checking'
 * @param {boolean} isStarting  parent-supplied hint that this feature is mid-startup
 * @returns {FeaturePresentation}
 */
export function describeFeature(feature, health, isStarting) {
  const status = feature.status === 'running' ? 'up' : feature.status;

  // Terminal / lifecycle states from the registry are authoritative — a
  // stopped/failed container has no nginx, so deferring to the health probe
  // would only produce a less specific 'DOWN'.
  const fromStatus = STATUS_PRESENTATION[status];
  if (fromStatus) return normalise(fromStatus);

  // Running feature: refine UP vs STARTING vs DOWN from the live probe. The
  // isStarting hint forces STARTING until the probe actually reports 'up'.
  const effectiveHealth = isStarting && health !== 'up' ? 'starting' : health;
  return normalise(HEALTH_PRESENTATION[effectiveHealth] ?? UNKNOWN_PRESENTATION);
}

/**
 * Returns the worktree path for display, or 'direct mount' when absent.
 *
 * @param {string|null|undefined} worktreePath
 * @returns {string}
 */
export function formatWorktree(worktreePath) {
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) return 'direct mount';
  return worktreePath;
}

/** Fill defaults so the component never reads undefined flags. */
function normalise(p) {
  return {
    dotColor: p.color,
    dotLabel: `● ${p.label}`,
    blink: p.blink ?? false,
    dimmed: p.dimmed ?? false,
    showError: p.showError ?? false,
  };
}
