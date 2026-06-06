/**
 * Behaviour tests for the Capture toggle button in PreviewFrame.
 *
 * Verifies:
 *  - Button renders with label 'Capture' when a preview is active.
 *  - aria-pressed starts as false.
 *  - Clicking the button toggles aria-pressed to true.
 *  - Clicking again toggles aria-pressed back to false.
 *  - Button is absent in the empty-state (no activePreview).
 *  - Receiving mars.capture.keydown from PROXY_ORIGIN toggles capture.
 *  - Receiving mars.capture.keydown from a different origin is ignored.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import PreviewFrame from '../PreviewFrame.jsx';

// Mock the api module (required by DiffPane which is imported by PreviewFrame)
vi.mock('../../api.js', () => ({
  getDiff: vi.fn(),
}));

/**
 * Wraps PreviewFrame with local isCapture state so tests can drive the
 * controlled component through button clicks exactly as the parent would.
 */
function renderFrame({ initialCapture = false, onToggleCapture, ...props } = {}) {
  function Wrapper() {
    const [isCapture, setIsCapture] = useState(initialCapture);
    const toggle = onToggleCapture ?? (() => setIsCapture(c => !c));
    return (
      <PreviewFrame
        previewKey={0}
        isCapture={isCapture}
        onToggleCapture={toggle}
        {...props}
      />
    );
  }
  return render(<Wrapper />);
}

afterEach(() => {
  vi.clearAllMocks();
});

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

describe('PreviewFrame — mars.capture.keydown message listener', () => {
  // ── Message from PROXY_ORIGIN toggles capture ────────────────────────────

  it('toggles capture when mars.capture.keydown is received from PROXY_ORIGIN', () => {
    renderFrame({ activePreview: 'feat-abc', branch: 'abc', title: 'Feat' });

    const btn = screen.getByRole('button', { name: /capture/i });
    expect(btn).toHaveAttribute('aria-pressed', 'false');

    fireEvent(
      window,
      new MessageEvent('message', {
        data: { type: 'mars.capture.keydown' },
        origin: 'http://localhost:3000',
      })
    );

    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  // ── Message from wrong origin is ignored ─────────────────────────────────

  it('does not toggle capture when mars.capture.keydown arrives from a foreign origin', () => {
    renderFrame({ activePreview: 'feat-abc', branch: 'abc', title: 'Feat' });

    const btn = screen.getByRole('button', { name: /capture/i });

    fireEvent(
      window,
      new MessageEvent('message', {
        data: { type: 'mars.capture.keydown' },
        origin: 'http://evil.example.com',
      })
    );

    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  // ── Unrelated message types are ignored ──────────────────────────────────

  it('does not toggle capture for unrelated message types from PROXY_ORIGIN', () => {
    renderFrame({ activePreview: 'feat-abc', branch: 'abc', title: 'Feat' });

    const btn = screen.getByRole('button', { name: /capture/i });

    fireEvent(
      window,
      new MessageEvent('message', {
        data: { type: 'mars.capture.activate', active: true },
        origin: 'http://localhost:3000',
      })
    );

    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });
});
