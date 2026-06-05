import { describe, it, expect } from 'vitest';
import { describeFeature, formatWorktree } from '../featurePresentation.js';

const f = (status) => ({ status });

describe('describeFeature', () => {
  it('surfaces terminal registry statuses verbatim, ignoring the health probe', () => {
    // Even if the probe somehow says 'up', a registry 'stopped' wins.
    const p = describeFeature(f('stopped'), 'up', false);
    expect(p.dotLabel).toBe('● STOPPED');
    expect(p.dotColor).toBe('#888');
    expect(p.showError).toBe(false);
  });

  it('marks failed with showError so the error message renders', () => {
    const p = describeFeature(f('failed'), 'down', false);
    expect(p.dotLabel).toBe('● FAILED');
    expect(p.showError).toBe(true);
  });

  it('distinguishes stopped (clean) from failed (crash)', () => {
    expect(describeFeature(f('stopped'), 'down', false).dotLabel).toBe('● STOPPED');
    expect(describeFeature(f('failed'), 'down', false).dotLabel).toBe('● FAILED');
  });

  it('renders unhealthy distinctly from down', () => {
    expect(describeFeature(f('unhealthy'), 'down', false).dotLabel).toBe('● UNHEALTHY');
  });

  it('blinks for lifecycle states', () => {
    expect(describeFeature(f('building'), 'checking', false).blink).toBe(true);
    expect(describeFeature(f('starting'), 'checking', false).blink).toBe(true);
    expect(describeFeature(f('restarting'), 'checking', false).blink).toBe(true);
  });

  it('does not blink for terminal states', () => {
    expect(describeFeature(f('stopped'), 'down', false).blink).toBe(false);
    expect(describeFeature(f('failed'), 'down', false).blink).toBe(false);
  });

  it('treats running registry status as UP and defers to the live probe', () => {
    expect(describeFeature(f('up'), 'up', false).dotLabel).toBe('● UP');
    // legacy 'running' token normalises to up
    expect(describeFeature(f('running'), 'up', false).dotLabel).toBe('● UP');
  });

  it('shows DOWN for a registry-up feature whose port-80 probe fails', () => {
    const p = describeFeature(f('up'), 'down', false);
    expect(p.dotLabel).toBe('● DOWN');
    expect(p.dotColor).toBe('var(--color-danger)'); // health-probe branch keeps CSS var
  });

  it('forces STARTING via the isStarting hint until the probe confirms up', () => {
    expect(describeFeature(f('up'), 'checking', true).dotLabel).toBe('● STARTING');
    expect(describeFeature(f('up'), 'down', true).dotLabel).toBe('● STARTING');
    // once the probe says up, the hint no longer overrides
    expect(describeFeature(f('up'), 'up', true).dotLabel).toBe('● UP');
  });

  it('dims only not_started', () => {
    expect(describeFeature(f('not_started'), 'down', false).dimmed).toBe(true);
    expect(describeFeature(f('stopped'), 'down', false).dimmed).toBe(false);
  });

  it('falls back to ... for an unknown health on a running feature', () => {
    const p = describeFeature(f('up'), 'weird-value', false);
    expect(p.dotLabel).toBe('● ...');
  });
});

describe('formatWorktree', () => {
  it('returns the path verbatim when a non-empty string is provided', () => {
    expect(formatWorktree('/abs/path/to/worktree')).toBe('/abs/path/to/worktree');
  });

  it('returns "direct mount" when worktreePath is null', () => {
    expect(formatWorktree(null)).toBe('direct mount');
  });

  it('returns "direct mount" when worktreePath is undefined', () => {
    expect(formatWorktree(undefined)).toBe('direct mount');
  });

  it('returns "direct mount" when worktreePath is an empty string', () => {
    expect(formatWorktree('')).toBe('direct mount');
  });
});
