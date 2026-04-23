/**
 * Chip-variant tests for the building / starting / failed lifecycle statuses.
 *
 * These verify FeatureCard renders the correct registry-driven chip label,
 * color, and (for failed) the error string. The 'running' path is covered by
 * FeatureCard.services.test.jsx.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import FeatureCard from '../FeatureCard.jsx';

vi.mock('../../api.js', () => ({
  getHealth: vi.fn().mockResolvedValue({ status: 'down' }),
  removeFeature: vi.fn().mockResolvedValue({}),
  openTerminal: vi.fn().mockResolvedValue({ ok: true }),
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
  key: 'proj-test-feature',
  name: 'test-feature',
  branch: 'main',
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
    />
  );

describe('FeatureCard — lifecycle chip variants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders amber 'BUILDING' chip with blink animation for status='building'", () => {
    renderCard(makeFeature({ status: 'building' }));

    const chip = screen.getByText(/● BUILDING/);
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveStyle({ color: 'rgb(255, 170, 0)' });
    expect(chip.style.animation).toContain('blink');
  });

  it("renders blue 'STARTING' chip with blink animation for status='starting'", () => {
    renderCard(makeFeature({ status: 'starting' }));

    const chip = screen.getByText(/● STARTING/);
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveStyle({ color: 'rgb(0, 170, 255)' });
    expect(chip.style.animation).toContain('blink');
  });

  it("renders red 'FAILED' chip WITHOUT animation for status='failed'", () => {
    renderCard(makeFeature({ status: 'failed', error: 'docker build failed' }));

    const chip = screen.getByText(/● FAILED/);
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveStyle({ color: 'rgb(255, 68, 68)' });
    expect(chip.style.animation === '' || chip.style.animation === 'none').toBe(true);
  });

  it('surfaces feature.error text when status=failed', () => {
    const errMsg = 'mvn package -DskipTests exited 1';
    renderCard(makeFeature({ status: 'failed', error: errMsg }));
    expect(screen.getByRole('alert')).toHaveTextContent(errMsg);
  });

  it('does not render an alert region when status=failed has no error', () => {
    renderCard(makeFeature({ status: 'failed', error: null }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('prefers registry status over client-side health sentinel', () => {
    // isStarting=true would normally trigger the client-side 'starting' health
    // label — but the registry-driven BUILDING chip must take precedence.
    render(
      <FeatureCard
        feature={makeFeature({ status: 'building' })}
        isActive={false}
        isPreview={false}
        isStarting={true}
        onActivate={vi.fn()}
        onRemoved={vi.fn()}
        onLogs={vi.fn()}
      />
    );
    expect(screen.getByText(/● BUILDING/)).toBeInTheDocument();
    expect(screen.queryByText(/● STARTING/)).toBeNull();
  });
});
