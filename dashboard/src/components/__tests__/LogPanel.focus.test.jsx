/**
 * Focus-trap and keyboard-navigation tests for LogPanel.
 *
 * Verifies:
 *   1. Focus moves into the dialog on open
 *   2. Tab past the last focusable element wraps back to the first
 *   3. Escape closes the panel and restores focus to the trigger element
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LogPanel from '../LogPanel.jsx';

// jsdom does not implement scrollIntoView — stub it so LogPanel's auto-scroll
// effect doesn't throw during tests.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock('../../api.js', () => ({
  getLogs: vi.fn().mockResolvedValue({ lines: '' }),
}));

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select, textarea';

describe('LogPanel — focus trap', () => {
  let onClose;

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('moves focus into the dialog on open', () => {
    onClose = vi.fn();
    render(<LogPanel featureName="test-feature" onClose={onClose} />);
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('Tab past the last focusable element wraps to the first', () => {
    onClose = vi.fn();
    render(<LogPanel featureName="test-feature" onClose={onClose} />);

    const dialog = screen.getByRole('dialog');
    const focusable = Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR));
    expect(focusable.length).toBeGreaterThan(0);

    const last = focusable[focusable.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab', shiftKey: false });

    expect(focusable[0]).toHaveFocus();
  });

  it('Escape closes the dialog and restores focus to the trigger', () => {
    onClose = vi.fn();

    // Simulate a trigger button that had focus before the dialog opened
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    render(<LogPanel featureName="test-feature" onClose={onClose} />);

    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();

    document.body.removeChild(trigger);
  });
});
