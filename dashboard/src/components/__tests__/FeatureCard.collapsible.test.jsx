/**
 * Behaviour tests for per-card collapse/expand in FeatureCard.
 *
 * Verifies observable toggle behaviour through the public interface:
 * the controls region is hidden when collapsed and shown when expanded.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FeatureCard from '../FeatureCard.jsx';

vi.mock('../../api.js', () => ({
  getHealth: vi.fn().mockResolvedValue({ status: 'down' }),
  removeFeature: vi.fn().mockResolvedValue({}),
  stopFeature: vi.fn().mockResolvedValue({}),
  startFeature: vi.fn().mockResolvedValue({}),
  syncFeature: vi.fn().mockResolvedValue({ ok: true }),
  getFeatures: vi.fn().mockResolvedValue([]),
  activateFeature: vi.fn().mockResolvedValue({ ok: true }),
  addFeature: vi.fn().mockResolvedValue({}),
  getLogs: vi.fn().mockResolvedValue({ lines: '' }),
  getStats: vi.fn().mockResolvedValue({}),
  getStatus: vi.fn().mockResolvedValue({}),
}));

const makeFeature = (overrides = {}) => ({
  key: 'proj-alpha',
  name: 'alpha',
  branch: 'main',
  title: 'Alpha Feature',
  project: 'proj',
  isActive: false,
  status: 'running',
  services: [],
  ...overrides,
});

const renderCard = (overrides = {}) =>
  render(
    <FeatureCard
      feature={makeFeature(overrides)}
      isActive={false}
      isPreview={false}
      isStarting={false}
      onActivate={vi.fn()}
      onRemoved={vi.fn()}
      onLogs={vi.fn()}
    />
  );

describe('FeatureCard — collapsible', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Tracer bullet: expanded by default, controls visible ───────────────────

  it('is expanded by default and shows the controls region', () => {
    renderCard();
    expect(screen.getByTestId('feature-controls')).toBeInTheDocument();
  });

  // ── Toggle hides controls ─────────────────────────────────────────────────

  it('hides the controls region when the toggle button is clicked', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /collapse alpha feature/i }));
    expect(screen.queryByTestId('feature-controls')).not.toBeInTheDocument();
  });

  // ── Toggle re-shows controls ──────────────────────────────────────────────

  it('shows the controls region again when the collapsed header is clicked', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /collapse alpha feature/i }));
    fireEvent.click(screen.getByRole('button', { name: /expand alpha feature/i }));
    expect(screen.getByTestId('feature-controls')).toBeInTheDocument();
  });

  // ── Toggle is a proper button element (keyboard-accessible) ───────────────

  it('toggle is a <button> element so Enter/Space work natively', () => {
    renderCard();
    const toggle = screen.getByRole('button', { name: /collapse alpha feature/i });
    expect(toggle.tagName).toBe('BUTTON');
  });

  // ── Collapsed header: dot only, no status word ───────────────────────────

  it('collapsed header shows only the dot glyph, not the status word', () => {
    renderCard({ status: 'building', title: undefined });
    fireEvent.click(screen.getByRole('button', { name: /collapse alpha/i }));
    // (a) status word must NOT be present
    expect(screen.queryByText(/BUILDING/)).not.toBeInTheDocument();
    // (a) colored dot IS present
    expect(screen.getByText('●')).toBeInTheDocument();
  });

  // ── Expanded body: dot beside title, still no status word ─────────────────

  it('expanded card shows the status dot beside the title but never the status word', () => {
    renderCard({ status: 'building', title: undefined });
    // card is expanded by default — the dot communicates status in every
    // state, and the status WORD must not appear even when expanded.
    expect(screen.getByText('●')).toBeInTheDocument();
    expect(screen.queryByText(/BUILDING/)).not.toBeInTheDocument();
  });
});
