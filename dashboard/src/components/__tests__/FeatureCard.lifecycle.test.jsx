/**
 * Chip-variant tests for the building / starting / failed lifecycle statuses.
 *
 * These verify FeatureCard renders the correct registry-driven chip label,
 * color, and (for failed) the error string. The 'running' path is covered by
 * FeatureCard.services.test.jsx.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import FeatureCard from '../FeatureCard.jsx';
import * as api from '../../api.js';

vi.mock('../../api.js', () => ({
  getHealth: vi.fn().mockResolvedValue({ status: 'down' }),
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

describe('FeatureCard — kill flow', () => {
  const feature = makeFeature({ status: 'running' });

  function renderKillCard(onRemoved = vi.fn()) {
    return render(
      <FeatureCard
        feature={feature}
        isActive={false}
        isPreview={false}
        isStarting={false}
        onActivate={vi.fn()}
        onRemoved={onRemoved}
        onLogs={vi.fn()}
      />
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clicking [KILL] opens the ConfirmModal with a destruction explanation', () => {
    renderKillCard();

    fireEvent.click(screen.getByRole('button', { name: /Kill feature/i }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Modal must explain what is permanently destroyed
    expect(screen.getByText(/permanently removes/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it('confirming in the modal calls removeFeature and onRemoved', async () => {
    const onRemoved = vi.fn();
    renderKillCard(onRemoved);

    fireEvent.click(screen.getByRole('button', { name: /Kill feature/i }));

    // The modal's confirm button is labelled "[KILL]"; use within(dialog) to
    // distinguish it from the trigger button whose aria-label is different.
    const dialog = screen.getByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /\[KILL\]/i }));
    });

    expect(api.removeFeature).toHaveBeenCalledWith(feature.key);
    expect(onRemoved).toHaveBeenCalledWith(feature.key);
  });

  it('cancelling in the modal does not call removeFeature and closes the dialog', () => {
    renderKillCard();

    fireEvent.click(screen.getByRole('button', { name: /Kill feature/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));

    expect(api.removeFeature).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('focus returns to the [KILL] trigger after the modal closes via cancel', () => {
    renderKillCard();

    const killTrigger = screen.getByRole('button', { name: /Kill feature/i });
    // Ensure the trigger is focused before opening (simulates keyboard/mouse focus)
    killTrigger.focus();
    fireEvent.click(killTrigger);

    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Cancel — ConfirmModal restores focus to the element that was active when it opened
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));

    expect(document.activeElement).toBe(killTrigger);
  });
});
