/**
 * Focus-trap and keyboard-navigation tests for FeatureConfigModal.
 *
 * Verifies:
 *   1. Focus moves to the [CLOSE] button on open
 *   2. Tab from the only focusable element wraps back to itself
 *   3. Shift+Tab from the only focusable element wraps back to itself
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FeatureConfigModal from '../FeatureConfigModal.jsx';

const makeFeature = (overrides = {}) => ({
  key: 'proj-alpha',
  name: 'alpha',
  branch: 'feature/my-branch',
  title: 'Alpha Feature',
  ...overrides,
});

describe('FeatureConfigModal — focus trap', () => {
  it('moves focus to the [CLOSE] button on open', () => {
    render(<FeatureConfigModal feature={makeFeature()} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('Tab from the close button (only focusable element) wraps back to itself', () => {
    render(<FeatureConfigModal feature={makeFeature()} onClose={vi.fn()} />);

    const closeBtn = screen.getByRole('button', { name: 'Close' });
    closeBtn.focus();
    fireEvent.keyDown(closeBtn, { key: 'Tab', shiftKey: false });

    expect(closeBtn).toHaveFocus();
  });

  it('Shift+Tab from the close button wraps back to itself', () => {
    render(<FeatureConfigModal feature={makeFeature()} onClose={vi.fn()} />);

    const closeBtn = screen.getByRole('button', { name: 'Close' });
    closeBtn.focus();
    fireEvent.keyDown(closeBtn, { key: 'Tab', shiftKey: true });

    expect(closeBtn).toHaveFocus();
  });
});
