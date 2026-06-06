/**
 * Behaviour tests for note piping in PreviewFrame.
 *
 * Verifies that when capture mode activates, the mars.capture.activate
 * postMessage sent to the iframe includes the notes array so the picker
 * script can render tint overlays for existing review notes.
 *
 * Strategy: mock iframe.contentWindow via a prototype getter spy so the
 * postMessage call is intercepted without needing a real browsing context.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import PreviewFrame from '../PreviewFrame.jsx';

vi.mock('../../api.js', () => ({ getDiff: vi.fn() }));

const PROXY_URL = 'http://localhost:3000/';

let postMessageSpy;

beforeEach(() => {
  postMessageSpy = vi.fn();
  // Spy on contentWindow getter so every iframe instance returns our mock window.
  vi.spyOn(window.HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue({
    postMessage: postMessageSpy,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Renders PreviewFrame with controlled isCapture state and optional notes.
 */
function renderFrame({ initialCapture = false, notes = [], ...props } = {}) {
  function Wrapper() {
    const [isCapture, setIsCapture] = useState(initialCapture);
    return (
      <PreviewFrame
        previewKey={0}
        isCapture={isCapture}
        onToggleCapture={() => setIsCapture(c => !c)}
        notes={notes}
        {...props}
      />
    );
  }
  return render(<Wrapper />);
}

describe('PreviewFrame — notes piped through mars.capture.activate', () => {
  // ── Tracer bullet: notes included on activation ───────────────────────────

  it('sends the notes array in mars.capture.activate when capture mode turns on', () => {
    const notes = [{ id: 'n1', route: '/checkout', selector: '#save' }];

    renderFrame({ activePreview: 'feat-abc', branch: 'abc', title: 'Feat', notes });

    // Initial render sends active:false. Clear so we only check the click.
    postMessageSpy.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /capture/i }));

    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mars.capture.activate',
        active: true,
        notes,
      }),
      PROXY_URL,
    );
  });

  // ── Empty notes when no notes prop is provided ────────────────────────────

  it('sends an empty notes array when no notes prop is provided', () => {
    renderFrame({ activePreview: 'feat-abc', branch: 'abc', title: 'Feat' });

    postMessageSpy.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /capture/i }));

    const call = postMessageSpy.mock.calls.find(
      ([payload]) => payload?.type === 'mars.capture.activate' && payload?.active === true,
    );
    expect(call).toBeDefined();
    expect(Array.isArray(call[0].notes)).toBe(true);
    expect(call[0].notes).toHaveLength(0);
  });

  // ── Notes included on initial active render ───────────────────────────────

  it('sends notes on mount when capture mode starts active', () => {
    const notes = [{ id: 'n2', route: '/home', selector: 'h1' }];

    renderFrame({
      activePreview: 'feat-abc',
      branch: 'abc',
      title: 'Feat',
      initialCapture: true,
      notes,
    });

    const call = postMessageSpy.mock.calls.find(
      ([payload]) => payload?.type === 'mars.capture.activate' && payload?.active === true,
    );
    expect(call).toBeDefined();
    expect(call[0].notes).toEqual(notes);
  });

  // ── Notes sent even on deactivation (picker ignores them when inactive) ───

  it('includes notes in the payload when capture mode is deactivated', () => {
    const notes = [{ id: 'n3', route: '/page', selector: '#btn' }];

    renderFrame({
      activePreview: 'feat-abc',
      branch: 'abc',
      title: 'Feat',
      initialCapture: true,
      notes,
    });

    postMessageSpy.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /capture/i }));

    const call = postMessageSpy.mock.calls.find(
      ([payload]) => payload?.type === 'mars.capture.activate' && payload?.active === false,
    );
    expect(call).toBeDefined();
    // notes is still passed; the picker clears tints on deactivation regardless
    expect(Array.isArray(call[0].notes)).toBe(true);
  });
});
