/**
 * Behaviour tests for FeatureConfigModal dismissal paths.
 *
 * Verifies observable behaviour through the public interface:
 * - Escape key closes the modal
 * - Clicking the backdrop (outer overlay) closes the modal
 * - Clicking inside the inner panel does NOT close the modal
 * - The [CLOSE] close button closes the modal
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FeatureConfigModal from '../FeatureConfigModal.jsx';

const makeFeature = (overrides = {}) => ({
  key: 'proj-alpha',
  name: 'alpha',
  branch: 'feature/my-branch',
  title: 'Alpha Feature',
  ...overrides,
});

describe('FeatureConfigModal — dismiss behaviour', () => {
  let onClose;

  beforeEach(() => {
    onClose = vi.fn();
  });

  // ── Escape key ─────────────────────────────────────────────────────────────

  it('pressing Escape calls onClose', () => {
    render(<FeatureConfigModal feature={makeFeature()} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Backdrop click ─────────────────────────────────────────────────────────

  it('clicking the backdrop (outer overlay) calls onClose', () => {
    render(<FeatureConfigModal feature={makeFeature()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Inner panel click ──────────────────────────────────────────────────────

  it('clicking inside the inner panel does NOT call onClose', () => {
    render(<FeatureConfigModal feature={makeFeature()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('heading', { name: 'Alpha Feature' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  // ── Close button ───────────────────────────────────────────────────────────

  it('clicking the [CLOSE] close button calls onClose', () => {
    render(<FeatureConfigModal feature={makeFeature()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
