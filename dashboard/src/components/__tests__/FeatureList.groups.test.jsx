/**
 * Behaviour tests for collapsible per-project group headers in FeatureList.
 *
 * All assertions are on observable behaviour through the public interface only:
 * what the user sees and can interact with.  No internal state is asserted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FeatureList from '../FeatureList.jsx';

// FeatureCard hits the API on mount — stub the boundary so tests are hermetic.
vi.mock('../../api.js', () => ({
  getHealth: vi.fn().mockResolvedValue({ status: 'up' }),
  getServicesHealth: vi.fn().mockResolvedValue({ services: [] }),
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
  key: `${overrides.project ?? 'alpha'}-${overrides.name ?? 'feat'}`,
  name: overrides.name ?? 'feat',
  branch: 'main',
  project: overrides.project ?? 'alpha',
  isActive: false,
  status: 'running',
  ...overrides,
});

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

// jsdom does not implement localStorage; provide an in-memory stub.
let _store = {};
const localStorageMock = {
  getItem: (key) => Object.prototype.hasOwnProperty.call(_store, key) ? _store[key] : null,
  setItem: (key, value) => { _store[key] = String(value); },
  removeItem: (key) => { delete _store[key]; },
  clear: () => { _store = {}; },
};

describe('FeatureList — collapsible project groups', () => {
  beforeEach(() => {
    _store = {};
    vi.stubGlobal('localStorage', localStorageMock);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Tracer bullet: groups are rendered with toggle buttons ────────────────

  it('renders project group headers as buttons when multi-project', () => {
    renderList([
      makeFeature({ project: 'alpha', name: 'feat-a' }),
      makeFeature({ project: 'beta', name: 'feat-b' }),
    ]);
    // Each project header is accessible as a button
    expect(screen.getByRole('button', { name: /\/\/ alpha/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\/\/ beta/ })).toBeInTheDocument();
  });

  // ── Groups are expanded by default ───────────────────────────────────────

  it('shows all feature cards when groups are expanded (default)', () => {
    renderList([
      makeFeature({ project: 'alpha', name: 'feat-a' }),
      makeFeature({ project: 'beta', name: 'feat-b' }),
    ]);
    expect(screen.getByText('feat-a')).toBeInTheDocument();
    expect(screen.getByText('feat-b')).toBeInTheDocument();
  });

  it('sets aria-expanded=true on group headers when expanded (default)', () => {
    renderList([
      makeFeature({ project: 'alpha', name: 'feat-a' }),
      makeFeature({ project: 'beta', name: 'feat-b' }),
    ]);
    expect(screen.getByRole('button', { name: /\/\/ alpha/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /\/\/ beta/ })).toHaveAttribute('aria-expanded', 'true');
  });

  // ── Clicking a header collapses its cards ────────────────────────────────

  it('hides the group cards after clicking the project header', () => {
    renderList([
      makeFeature({ project: 'alpha', name: 'feat-a' }),
      makeFeature({ project: 'beta', name: 'feat-b' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: /\/\/ alpha/ }));
    expect(screen.queryByText('feat-a')).not.toBeInTheDocument();
    // beta group remains visible
    expect(screen.getByText('feat-b')).toBeInTheDocument();
  });

  it('sets aria-expanded=false on the header after collapsing', () => {
    renderList([
      makeFeature({ project: 'alpha', name: 'feat-a' }),
      makeFeature({ project: 'beta', name: 'feat-b' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: /\/\/ alpha/ }));
    expect(screen.getByRole('button', { name: /\/\/ alpha/ })).toHaveAttribute('aria-expanded', 'false');
  });

  // ── Clicking again expands the group ─────────────────────────────────────

  it('shows cards again after clicking the header a second time', () => {
    renderList([
      makeFeature({ project: 'alpha', name: 'feat-a' }),
      makeFeature({ project: 'beta', name: 'feat-b' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: /\/\/ alpha/ }));
    fireEvent.click(screen.getByRole('button', { name: /\/\/ alpha/ }));
    expect(screen.getByText('feat-a')).toBeInTheDocument();
  });

  it('sets aria-expanded=true again after re-expanding', () => {
    renderList([
      makeFeature({ project: 'alpha', name: 'feat-a' }),
      makeFeature({ project: 'beta', name: 'feat-b' }),
    ]);
    const btn = () => screen.getByRole('button', { name: /\/\/ alpha/ });
    fireEvent.click(btn());
    fireEvent.click(btn());
    expect(btn()).toHaveAttribute('aria-expanded', 'true');
  });

  // ── Multiple groups collapse independently ────────────────────────────────

  it('collapses each group independently', () => {
    renderList([
      makeFeature({ project: 'alpha', name: 'feat-a' }),
      makeFeature({ project: 'beta', name: 'feat-b' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: /\/\/ alpha/ }));
    // alpha collapsed, beta still visible
    expect(screen.queryByText('feat-a')).not.toBeInTheDocument();
    expect(screen.getByText('feat-b')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /\/\/ beta/ }));
    // both collapsed
    expect(screen.queryByText('feat-a')).not.toBeInTheDocument();
    expect(screen.queryByText('feat-b')).not.toBeInTheDocument();
  });

  // ── localStorage persistence ──────────────────────────────────────────────

  it('persists collapsed group names to localStorage', () => {
    renderList([
      makeFeature({ project: 'alpha', name: 'feat-a' }),
      makeFeature({ project: 'beta', name: 'feat-b' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: /\/\/ alpha/ }));
    const saved = JSON.parse(localStorageMock.getItem('fleet.sidebar.collapsedGroups'));
    expect(saved).toContain('alpha');
  });

  it('removes group from localStorage after re-expanding', () => {
    renderList([
      makeFeature({ project: 'alpha', name: 'feat-a' }),
      makeFeature({ project: 'beta', name: 'feat-b' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: /\/\/ alpha/ }));
    fireEvent.click(screen.getByRole('button', { name: /\/\/ alpha/ }));
    const saved = JSON.parse(localStorageMock.getItem('fleet.sidebar.collapsedGroups'));
    expect(saved).not.toContain('alpha');
  });

  it('restores collapsed groups from localStorage on mount', () => {
    // Pre-populate storage with alpha collapsed
    localStorageMock.setItem('fleet.sidebar.collapsedGroups', JSON.stringify(['alpha']));
    renderList([
      makeFeature({ project: 'alpha', name: 'feat-a' }),
      makeFeature({ project: 'beta', name: 'feat-b' }),
    ]);
    // alpha should start collapsed (cards hidden)
    expect(screen.queryByText('feat-a')).not.toBeInTheDocument();
    // beta should be expanded
    expect(screen.getByText('feat-b')).toBeInTheDocument();
    // aria-expanded reflects the restored state
    expect(screen.getByRole('button', { name: /\/\/ alpha/ })).toHaveAttribute('aria-expanded', 'false');
  });

  // ── Ungrouped path (no project name) is unaffected ───────────────────────

  it('does not render group header buttons when no features have a project name', () => {
    // Features with no project ⇒ ungrouped flat rendering, no toggle headers
    renderList([
      { key: 'feat-a', name: 'feat-a', branch: 'main', isActive: false, status: 'running' },
      { key: 'feat-b', name: 'feat-b', branch: 'main', isActive: false, status: 'running' },
    ]);
    // No group header buttons should appear
    expect(screen.queryByRole('button', { name: /\/\// })).not.toBeInTheDocument();
    expect(screen.getByText('feat-a')).toBeInTheDocument();
    expect(screen.getByText('feat-b')).toBeInTheDocument();
  });
});
