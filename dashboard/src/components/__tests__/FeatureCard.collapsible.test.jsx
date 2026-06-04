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

  // ── Compact header shows lifecycle status when collapsed ──────────────────

  it('compact header shows the lifecycle status label when collapsed', () => {
    renderCard({ status: 'building', title: undefined });
    fireEvent.click(screen.getByRole('button', { name: /collapse alpha/i }));
    // status chip is visible in the compact header
    expect(screen.getByText(/● BUILDING/)).toBeInTheDocument();
  });
});
