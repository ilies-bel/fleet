/**
 * Behaviour tests for the collapsible FeatureList sidebar.
 *
 * These tests verify observable behaviour through the public interface only:
 * what the user sees and can do, not how the state is stored internally.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FeatureList from '../FeatureList.jsx';

// FeatureCard calls getHealth on mount; mock the api boundary so tests are hermetic.
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
  key: 'proj-feat',
  name: 'feat',
  branch: 'main',
  project: 'proj',
  isActive: false,
  status: 'running',
  ...overrides,
});

function renderList(features = [makeFeature()]) {
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

// jsdom does not implement localStorage; stub it so both the component
// code and the assertions share the same in-memory store.
let _store = {};
const localStorageMock = {
  getItem: (key) => Object.prototype.hasOwnProperty.call(_store, key) ? _store[key] : null,
  setItem: (key, value) => { _store[key] = String(value); },
  removeItem: (key) => { delete _store[key]; },
  clear: () => { _store = {}; },
};

describe('FeatureList — collapsible sidebar', () => {
  beforeEach(() => {
    _store = {};
    vi.stubGlobal('localStorage', localStorageMock);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Tracer bullet: expanded by default ────────────────────────────────────

  it('is expanded by default and shows the feature list', () => {
    renderList([makeFeature({ name: 'my-feature' })]);
    expect(screen.getByText('my-feature')).toBeInTheDocument();
  });

  // ── Toggle control is present ─────────────────────────────────────────────

  it('renders a collapse toggle button when expanded', () => {
    renderList();
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
  });

  // ── Collapse hides the feature list ──────────────────────────────────────

  it('hides the feature list after clicking the collapse toggle', () => {
    renderList([makeFeature({ name: 'hidden-feature' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.queryByText('hidden-feature')).not.toBeInTheDocument();
  });

  it('hides the // FEATURES header label when collapsed', () => {
    renderList();
    expect(screen.getByText('// FEATURES')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.queryByText('// FEATURES')).not.toBeInTheDocument();
  });

  // ── Expand restores the feature list ─────────────────────────────────────

  it('shows the feature list again after expanding', () => {
    renderList([makeFeature({ name: 'visible-feature' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(screen.getByText('visible-feature')).toBeInTheDocument();
  });

  // ── localStorage persistence ──────────────────────────────────────────────

  it('persists collapsed=true to localStorage after collapsing', () => {
    renderList();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(localStorageMock.getItem('fleet.sidebar.collapsed')).toBe('true');
  });

  it('persists collapsed=false to localStorage after expanding', () => {
    renderList();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(localStorageMock.getItem('fleet.sidebar.collapsed')).toBe('false');
  });

  it('starts collapsed when localStorage has fleet.sidebar.collapsed=true', () => {
    localStorageMock.setItem('fleet.sidebar.collapsed', 'true');
    renderList([makeFeature({ name: 'should-be-hidden' })]);
    expect(screen.queryByText('should-be-hidden')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });

  it('starts expanded when localStorage has fleet.sidebar.collapsed=false', () => {
    localStorageMock.setItem('fleet.sidebar.collapsed', 'false');
    renderList([makeFeature({ name: 'should-be-visible' })]);
    expect(screen.getByText('should-be-visible')).toBeInTheDocument();
  });
});
