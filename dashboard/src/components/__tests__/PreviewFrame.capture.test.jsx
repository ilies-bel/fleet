/**
 * Behaviour tests for the Capture toggle button in PreviewFrame.
 *
 * Verifies:
 *  - Button renders with label 'Capture' when a preview is active.
 *  - aria-pressed starts as false.
 *  - Clicking the button toggles aria-pressed to true.
 *  - Clicking again toggles aria-pressed back to false.
 *  - Button is absent in the empty-state (no activePreview).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PreviewFrame from '../PreviewFrame.jsx';

// Mock the api module (required by DiffPane which is imported by PreviewFrame)
vi.mock('../../api.js', () => ({
  getDiff: vi.fn(),
}));

function renderFrame(props) {
  return render(<PreviewFrame previewKey={0} {...props} />);
}

describe('PreviewFrame Capture toggle', () => {
  // ── Tracer bullet: Capture button renders when a preview is active ─────────

  it('renders a Capture button when a preview is active', () => {
    renderFrame({ activePreview: 'feat-abc', branch: 'abc', title: 'Feat' });

    expect(
      screen.getByRole('button', { name: /capture/i })
    ).toBeInTheDocument();
  });

  // ── aria-pressed starts false ─────────────────────────────────────────────

  it('Capture button starts with aria-pressed="false"', () => {
    renderFrame({ activePreview: 'feat-abc', branch: 'abc', title: 'Feat' });

    const btn = screen.getByRole('button', { name: /capture/i });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  // ── Clicking toggles aria-pressed to true ────────────────────────────────

  it('sets aria-pressed to "true" after the first click', () => {
    renderFrame({ activePreview: 'feat-abc', branch: 'abc', title: 'Feat' });

    const btn = screen.getByRole('button', { name: /capture/i });
    fireEvent.click(btn);

    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  // ── Second click toggles back to false ───────────────────────────────────

  it('returns aria-pressed to "false" after the second click', () => {
    renderFrame({ activePreview: 'feat-abc', branch: 'abc', title: 'Feat' });

    const btn = screen.getByRole('button', { name: /capture/i });
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  // ── Button is absent in the empty state ──────────────────────────────────

  it('does not render the Capture button when no feature is active', () => {
    renderFrame({ activePreview: null });

    expect(
      screen.queryByRole('button', { name: /capture/i })
    ).not.toBeInTheDocument();
  });
});
