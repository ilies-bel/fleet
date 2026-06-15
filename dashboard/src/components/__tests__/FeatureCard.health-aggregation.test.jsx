/**
 * Unit tests for the per-service health aggregation in FeatureCard.
 *
 * Verifies the sidebar dot status derived from getServicesHealth:
 *   - all services 'up'  → dot shows UP (accent color)
 *   - mixed up/down      → dot shows DEGRADED (warning color)
 *   - all services down  → dot shows DOWN (danger color)
 *   - empty services     → falls back to getHealth root probe
 *   - thrown error       → dot shows DOWN
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import FeatureCard from '../FeatureCard.jsx';

vi.mock('../../api.js', () => ({
  getHealth: vi.fn(),
  getServicesHealth: vi.fn(),
  removeFeature: vi.fn().mockResolvedValue({}),
  stopFeature: vi.fn().mockResolvedValue({}),
  startFeature: vi.fn().mockResolvedValue({}),
  syncFeature: vi.fn().mockResolvedValue({ ok: true }),
  renameFeature: vi.fn().mockResolvedValue({}),
  getFeatures: vi.fn().mockResolvedValue([]),
  activateFeature: vi.fn().mockResolvedValue({ ok: true }),
  addFeature: vi.fn().mockResolvedValue({}),
  getLogs: vi.fn().mockResolvedValue({ lines: '' }),
  getStats: vi.fn().mockResolvedValue({}),
  getStatus: vi.fn().mockResolvedValue({}),
}));

import * as api from '../../api.js';

const makeFeature = (overrides = {}) => ({
  key: 'proj-qa-main',
  name: 'qa-main',
  branch: 'main',
  project: 'proj',
  isActive: false,
  status: 'running',
  services: [],
  ...overrides,
});

function renderCard(feature) {
  return render(
    <FeatureCard
      feature={feature}
      isActive={false}
      isPreview={false}
      isStarting={false}
      onActivate={vi.fn()}
      onRemoved={vi.fn()}
      onLogs={vi.fn()}
    />
  );
}

describe('FeatureCard — per-service health aggregation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('all services up → dot shows UP (accent color)', async () => {
    api.getServicesHealth.mockResolvedValue({
      services: [
        { name: 'backend', port: 8080, status: 'up' },
        { name: 'frontend', port: 5173, status: 'up' },
      ],
    });

    await act(async () => { renderCard(makeFeature()); });

    const dot = screen.getByText('●');
    expect(dot).toHaveStyle({ color: 'var(--color-accent)' });
  });

  it('mixed up/down services → dot shows DEGRADED (warning color)', async () => {
    api.getServicesHealth.mockResolvedValue({
      services: [
        { name: 'backend', port: 8080, status: 'up' },
        { name: 'frontend', port: 5173, status: 'down' },
      ],
    });

    await act(async () => { renderCard(makeFeature()); });

    const dot = screen.getByText('●');
    expect(dot).toHaveStyle({ color: 'var(--color-warning)' });
  });

  it('all services down → dot shows DOWN (danger color)', async () => {
    api.getServicesHealth.mockResolvedValue({
      services: [
        { name: 'backend', port: 8080, status: 'down' },
        { name: 'frontend', port: 5173, status: 'down' },
      ],
    });

    await act(async () => { renderCard(makeFeature()); });

    const dot = screen.getByText('●');
    expect(dot).toHaveStyle({ color: 'var(--color-danger)' });
  });

  it('empty services list → falls back to getHealth root probe', async () => {
    api.getServicesHealth.mockResolvedValue({ services: [] });
    api.getHealth.mockResolvedValue({ status: 'up' });

    await act(async () => { renderCard(makeFeature()); });

    // Fallback path called getHealth
    expect(api.getHealth).toHaveBeenCalledWith('proj-qa-main');
    // Dot resolves to UP from the root probe
    const dot = screen.getByText('●');
    expect(dot).toHaveStyle({ color: 'var(--color-accent)' });
  });

  it('getServicesHealth throws → dot shows DOWN and getHealth is NOT called', async () => {
    api.getServicesHealth.mockRejectedValue(new Error('network error'));
    api.getHealth.mockResolvedValue({ status: 'up' });

    await act(async () => { renderCard(makeFeature()); });

    const dot = screen.getByText('●');
    expect(dot).toHaveStyle({ color: 'var(--color-danger)' });
    // On error, getHealth is not called (error path sets 'down' immediately)
    expect(api.getHealth).not.toHaveBeenCalled();
  });
});
