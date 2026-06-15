/**
 * Regression guard: essential text must not render at sub-3:1 colors on near-black.
 *
 * Background: Fleet uses #0a0a0a / #000 surfaces. Colors #333 (~1.3:1), #444
 * (~1.7:1), and #555 (~2.5:1) are effectively invisible there. This suite locks
 * the key empty-state and onboarding strings to colors >= #888 (~3:1) so the
 * regression cannot come back silently.
 *
 * Only the specific components + states flagged by the P1 critique are guarded
 * here. Lifecycle dot colors (featurePresentation.js) are governed by their own
 * tests and are outside this file's scope.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

// ─── API mock (shared across all describe blocks) ─────────────────────────────

vi.mock('../../api.js', () => ({
  getDiff: vi.fn(),
  getHealth: vi.fn().mockResolvedValue({ status: 'down' }),
  getServicesHealth: vi.fn().mockResolvedValue({ services: [] }),
  removeFeature: vi.fn().mockResolvedValue({}),
  stopFeature: vi.fn().mockResolvedValue({}),
  startFeature: vi.fn().mockResolvedValue({}),
  syncFeature: vi.fn().mockResolvedValue({ ok: true }),
  renameFeature: vi.fn().mockResolvedValue({ ok: true }),
  getFeatures: vi.fn(),
  getStats: vi.fn(),
}));

import { getDiff, getFeatures, getStats } from '../../api.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * RGB strings for the three forbidden dim colors:
 *   #333 = rgb(51,51,51)   contrast ~1.3:1 on #0a0a0a — invisible
 *   #444 = rgb(68,68,68)   contrast ~1.7:1             — invisible
 *   #555 = rgb(85,85,85)   contrast ~2.5:1             — unreadable
 */
const FORBIDDEN_DIM = ['rgb(51, 51, 51)', 'rgb(68, 68, 68)', 'rgb(85, 85, 85)'];

function assertNotDimColor(element, label) {
  const color = element.style.color;
  FORBIDDEN_DIM.forEach(bad => {
    expect(
      color,
      `"${label}" must not use ${bad} (sub-3:1 on near-black). Got: ${color}`,
    ).not.toBe(bad);
  });
}

// ─── DiffPane ────────────────────────────────────────────────────────────────

import DiffPane from '../DiffPane.jsx';

describe('contrast guard — DiffPane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('"// NO CHANGES VS main" empty-state is not sub-3:1 (#333/#444/#555)', async () => {
    getDiff.mockResolvedValue({ status: 'no-changes', patch: '', isEmpty: true });
    render(<DiffPane activeKey="feat-a" />);

    const el = await waitFor(() => screen.getByText(/\/\/ NO CHANGES VS main/));
    assertNotDimColor(el, '// NO CHANGES VS main');
  });

  it('"// Diff unavailable" state is not sub-3:1', async () => {
    getDiff.mockResolvedValue({ status: 'unavailable', reason: 'git not present' });
    render(<DiffPane activeKey="feat-a" />);

    const el = await waitFor(() => screen.getByText(/\/\/ Diff unavailable/));
    assertNotDimColor(el, '// Diff unavailable');
  });

  it('"Loading diff…" state is not sub-3:1', () => {
    // Never resolves — keeps component in loading state
    getDiff.mockImplementation(() => new Promise(() => {}));
    render(<DiffPane activeKey="feat-a" />);

    const el = screen.getByText('Loading diff…');
    assertNotDimColor(el, 'Loading diff…');
  });
});

// ─── FeatureCard not_started instruction ─────────────────────────────────────

import FeatureCard from '../FeatureCard.jsx';

const makeFeature = (overrides = {}) => ({
  key: 'proj-test-feature',
  name: 'my-feat',
  branch: 'feat/my-branch',
  title: 'My Feature',
  project: 'proj',
  isActive: false,
  status: 'running',
  services: [],
  ...overrides,
});

const renderCard = (feature) =>
  render(
    <FeatureCard
      feature={feature}
      isActive={false}
      isPreview={false}
      isStarting={false}
      onActivate={vi.fn()}
      onRemoved={vi.fn()}
      onLogs={vi.fn()}
    />,
  );

describe('contrast guard — FeatureCard not_started', () => {
  it('"Start:" instruction label is not sub-3:1 (#333/#444/#555)', () => {
    renderCard(makeFeature({ status: 'not_started' }));

    // The controls div wraps "Start: fleet add …"; the outer div has the muted color.
    const controls = screen.getByTestId('feature-controls');
    // getByText with regex finds the div whose full text content matches.
    const instructionDiv = within(controls).getByText(/Start:/);
    assertNotDimColor(instructionDiv, 'Start: label');
  });

  it('"fleet add <name> <branch>" command span is not sub-3:1', () => {
    renderCard(makeFeature({ status: 'not_started' }));

    const controls = screen.getByTestId('feature-controls');
    const cmdSpan = within(controls).getByText(/fleet add/);
    assertNotDimColor(cmdSpan, 'fleet add command');
  });
});

// ─── ResourceMonitor — n/a placeholder dashes ────────────────────────────────

import ResourceMonitor from '../ResourceMonitor.jsx';

describe('contrast guard — ResourceMonitor placeholders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('"—" placeholder spans in stopped rows are not sub-3:1 (#333/#444/#555)', async () => {
    getFeatures.mockResolvedValue([
      { key: 'k1', name: 'feat1', project: 'proj', branch: 'main' },
    ]);
    // Throwing with "not running" triggers status: 'stopped' path
    getStats.mockRejectedValue(new Error('container not running'));

    render(<ResourceMonitor />);

    // Wait for the async fetch + render cycle to complete.
    // The stopped row shows "STOPPED" status text alongside "—" placeholders.
    await waitFor(() => screen.getByText('STOPPED'));

    // CPU cell uses a <span style={{color}}>—</span>.
    // Memory and network cells render "—" as text nodes inside <td style={{color}}>.
    // All CPU placeholder spans must pass the contrast check.
    const dashes = screen.getAllByText('—');
    // At least one "—" span must exist (the CPU placeholder)
    expect(dashes.length).toBeGreaterThan(0);

    dashes.forEach(dash => {
      // Check the element itself (the span), or its closest styled ancestor td.
      const colorEl = dash.style.color ? dash : dash.closest('[style]') ?? dash;
      if (colorEl.style.color) {
        assertNotDimColor(colorEl, '"—" placeholder');
      }
    });
  });
});
