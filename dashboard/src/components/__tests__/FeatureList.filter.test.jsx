/**
 * Behaviour tests for the FeatureList search box and status-chip filter.
 *
 * All assertions are on observable behaviour (what appears in the DOM),
 * not on internal state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FeatureList from '../FeatureList.jsx';

// FeatureCard calls several API functions on mount; mock the boundary.
vi.mock('../../api.js', () => ({
  getHealth: vi.fn().mockResolvedValue({ status: 'up' }),
  removeFeature: vi.fn().mockResolvedValue({}),
  stopFeature: vi.fn().mockResolvedValue({}),
  startFeature: vi.fn().mockResolvedValue({}),
  syncFeature: vi.fn().mockResolvedValue({ ok: true, message: 'syncing' }),
  getFeatures: vi.fn().mockResolvedValue([]),
  activateFeature: vi.fn().mockResolvedValue({ ok: true, active: 'feat' }),
  addFeature: vi.fn().mockResolvedValue({}),
  getLogs: vi.fn().mockResolvedValue({ lines: '', fetchedAt: 0 }),
  getStats: vi.fn().mockResolvedValue({ cpuPercent: 0, memUsageMB: 0, memLimitMB: 0, netRxMB: 0, netTxMB: 0 }),
  getStatus: vi.fn().mockResolvedValue({ uptimeMs: 1000, featureCount: 0, activeFeature: null, nodeVersion: '20.0.0' }),
}));

const makeFeature = (overrides = {}) => ({
  key: `${overrides.project ?? 'proj'}-${overrides.name ?? 'feat'}`,
  name: 'feat',
  branch: 'main',
  project: 'proj',
  isActive: false,
  status: 'running',
  ...overrides,
});

// jsdom does not implement localStorage; stub it.
let _store = {};
const localStorageMock = {
  getItem: (key) => Object.prototype.hasOwnProperty.call(_store, key) ? _store[key] : null,
  setItem: (key, value) => { _store[key] = String(value); },
  removeItem: (key) => { delete _store[key]; },
  clear: () => { _store = {}; },
};

function renderList(features) {
  return render(
    <FeatureList
      features={features}
      activePreview={null}
      startingFeatures={new Set()}
      onActivate={vi.fn()}
      onRemoved={vi.fn()}
      onLogs={vi.fn()}
    />
  );
}

describe('FeatureList — search and status-chip filter', () => {
  beforeEach(() => {
    _store = {};
    vi.stubGlobal('localStorage', localStorageMock);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Search input presence ─────────────────────────────────────────────────

  it('shows a search input when sidebar is expanded', () => {
    renderList([makeFeature()]);
    expect(screen.getByRole('textbox', { name: 'Search features' })).toBeInTheDocument();
  });

  it('hides the search input when sidebar is collapsed', () => {
    renderList([makeFeature()]);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.queryByRole('textbox', { name: 'Search features' })).not.toBeInTheDocument();
  });

  // ── Text search narrows the list ──────────────────────────────────────────

  it('narrows the list by feature name', () => {
    renderList([
      makeFeature({ name: 'alpha', key: 'proj-alpha' }),
      makeFeature({ name: 'beta', key: 'proj-beta' }),
    ]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search features' }), {
      target: { value: 'alpha' },
    });
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.queryByText('beta')).not.toBeInTheDocument();
  });

  it('narrows the list by branch', () => {
    renderList([
      makeFeature({ name: 'feat-a', key: 'proj-feat-a', branch: 'feature/xyz' }),
      makeFeature({ name: 'feat-b', key: 'proj-feat-b', branch: 'main' }),
    ]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search features' }), {
      target: { value: 'xyz' },
    });
    expect(screen.getByText('feat-a')).toBeInTheDocument();
    expect(screen.queryByText('feat-b')).not.toBeInTheDocument();
  });

  it('is case-insensitive', () => {
    renderList([makeFeature({ name: 'MyFeature', key: 'proj-MyFeature' })]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search features' }), {
      target: { value: 'myfeature' },
    });
    expect(screen.getByText('MyFeature')).toBeInTheDocument();
  });

  it('restores all features when the search is cleared', () => {
    renderList([
      makeFeature({ name: 'alpha', key: 'proj-alpha' }),
      makeFeature({ name: 'beta', key: 'proj-beta' }),
    ]);
    const input = screen.getByRole('textbox', { name: 'Search features' });
    fireEvent.change(input, { target: { value: 'alpha' } });
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
  });

  // ── Status chips ──────────────────────────────────────────────────────────

  it('shows status chip buttons when sidebar is expanded', () => {
    renderList([makeFeature()]);
    expect(screen.getByRole('button', { name: 'UP' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'STOPPED' })).toBeInTheDocument();
  });

  it('hides status chips when sidebar is collapsed', () => {
    renderList([makeFeature()]);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.queryByRole('button', { name: 'UP' })).not.toBeInTheDocument();
  });

  it('a status chip narrows to matching features (running → UP)', () => {
    renderList([
      makeFeature({ name: 'running-feat', key: 'proj-running-feat', status: 'running' }),
      makeFeature({ name: 'stopped-feat', key: 'proj-stopped-feat', status: 'stopped' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'UP' }));
    expect(screen.getByText('running-feat')).toBeInTheDocument();
    expect(screen.queryByText('stopped-feat')).not.toBeInTheDocument();
  });

  it('a status chip narrows to matching features (stopped)', () => {
    renderList([
      makeFeature({ name: 'running-feat', key: 'proj-running-feat', status: 'running' }),
      makeFeature({ name: 'stopped-feat', key: 'proj-stopped-feat', status: 'stopped' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'STOPPED' }));
    expect(screen.queryByText('running-feat')).not.toBeInTheDocument();
    expect(screen.getByText('stopped-feat')).toBeInTheDocument();
  });

  it('chips have correct aria-pressed state', () => {
    renderList([makeFeature()]);
    const chip = screen.getByRole('button', { name: 'UP' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip);
    expect(screen.getByRole('button', { name: 'UP' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('multiple selected chips are OR-ed together', () => {
    renderList([
      makeFeature({ name: 'running-feat', key: 'proj-running-feat', status: 'running' }),
      makeFeature({ name: 'stopped-feat', key: 'proj-stopped-feat', status: 'stopped' }),
      makeFeature({ name: 'failed-feat', key: 'proj-failed-feat', status: 'failed' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'UP' }));
    fireEvent.click(screen.getByRole('button', { name: 'STOPPED' }));
    expect(screen.getByText('running-feat')).toBeInTheDocument();
    expect(screen.getByText('stopped-feat')).toBeInTheDocument();
    expect(screen.queryByText('failed-feat')).not.toBeInTheDocument();
  });

  it('deselecting all chips restores all statuses', () => {
    renderList([
      makeFeature({ name: 'running-feat', key: 'proj-running-feat', status: 'running' }),
      makeFeature({ name: 'stopped-feat', key: 'proj-stopped-feat', status: 'stopped' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'UP' }));
    // Toggle it back off
    fireEvent.click(screen.getByRole('button', { name: 'UP' }));
    expect(screen.getByText('running-feat')).toBeInTheDocument();
    expect(screen.getByText('stopped-feat')).toBeInTheDocument();
  });

  // ── Combined search + status ──────────────────────────────────────────────

  it('combines text search AND status chip — both must pass', () => {
    renderList([
      makeFeature({ name: 'alpha', key: 'proj-alpha', status: 'running' }),
      makeFeature({ name: 'alpha-stopped', key: 'proj-alpha-stopped', status: 'stopped' }),
      makeFeature({ name: 'beta', key: 'proj-beta', status: 'running' }),
    ]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search features' }), {
      target: { value: 'alpha' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'UP' }));
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.queryByText('alpha-stopped')).not.toBeInTheDocument();
    expect(screen.queryByText('beta')).not.toBeInTheDocument();
  });

  // ── Empty state ───────────────────────────────────────────────────────────

  it('shows "no features match" when filters exclude all features', () => {
    renderList([makeFeature({ name: 'alpha', status: 'running' })]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search features' }), {
      target: { value: 'zzz-no-match' },
    });
    expect(screen.getByText(/no features match/i)).toBeInTheDocument();
  });

  it('shows "no features registered" (not "no features match") for truly empty features', () => {
    renderList([]);
    expect(screen.getByText(/no features registered/i)).toBeInTheDocument();
    expect(screen.queryByText(/no features match/i)).not.toBeInTheDocument();
  });

  // ── Group headers hide when group has no matches ──────────────────────────

  it('hides a project group header when all features in that group are filtered out', () => {
    renderList([
      makeFeature({ name: 'alpha', key: 'proj-a-alpha', project: 'proj-a', status: 'running' }),
      makeFeature({ name: 'beta', key: 'proj-b-beta', project: 'proj-b', status: 'stopped' }),
    ]);
    // Confirm proj-b group is initially visible
    expect(screen.getByText('beta')).toBeInTheDocument();

    // Filter to UP only — proj-b's stopped feature and its header should vanish
    fireEvent.click(screen.getByRole('button', { name: 'UP' }));

    // proj-a feature (running → UP) is still visible
    expect(screen.getByText('alpha')).toBeInTheDocument();
    // proj-b feature and its group header are completely gone from the DOM —
    // nothing with 'proj-b' renders once the group is empty
    expect(screen.queryByText(/proj-b/)).not.toBeInTheDocument();
  });
});
