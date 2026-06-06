/**
 * Behaviour tests for ReviewCaptureLayer.
 *
 * Verifies:
 *  - No input is shown initially.
 *  - elementPicked from PROXY_ORIGIN opens an input with selector+route hint.
 *  - Enter commits the note via addNote and hides the input.
 *  - Escape discards without calling addNote and hides the input.
 *  - Messages from foreign origins are ignored.
 *  - Messages with wrong type are ignored.
 *  - If activeWorktree is null, the message is ignored and console.warn fires.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReviewCaptureLayer from '../ReviewCaptureLayer.jsx';

const PROXY_ORIGIN = 'http://localhost:3000';

/** Dispatch a postMessage from the proxy to window. */
function dispatchPick(payload = {}, origin = PROXY_ORIGIN) {
  fireEvent(
    window,
    new MessageEvent('message', {
      data: {
        type: 'mars.capture.elementPicked',
        selector: '#submit-btn',
        route: '/checkout',
        refKind: 'id',
        label: 'Submit',
        ...payload,
      },
      origin,
    })
  );
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('ReviewCaptureLayer', () => {
  // ── Tracer bullet: no input shown initially ─────────────────────────────

  it('renders nothing initially', () => {
    render(<ReviewCaptureLayer activeWorktree="feat-abc" addNote={vi.fn()} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  // ── elementPicked from PROXY_ORIGIN opens an input with the hint ────────

  it('shows a text input after receiving elementPicked from PROXY_ORIGIN', () => {
    render(<ReviewCaptureLayer activeWorktree="feat-abc" addNote={vi.fn()} />);

    dispatchPick({ selector: '#login-button', route: '/login' });

    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('prefills the hint with selector and route', () => {
    render(<ReviewCaptureLayer activeWorktree="feat-abc" addNote={vi.fn()} />);

    dispatchPick({ selector: '#login-button', route: '/login' });

    expect(screen.getByText('#login-button on /login')).toBeInTheDocument();
  });

  // ── Enter commits the note and closes the input ─────────────────────────

  it('pressing Enter calls addNote with the typed text and closes the input', () => {
    const addNote = vi.fn();
    render(<ReviewCaptureLayer activeWorktree="feat-abc" addNote={addNote} />);

    dispatchPick({ selector: '#login-button', route: '/login', refKind: 'id', label: 'Login' });

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Make it green' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(addNote).toHaveBeenCalledWith(
      'feat-abc',
      expect.objectContaining({
        selector: '#login-button',
        route: '/login',
        refKind: 'id',
        label: 'Login',
        text: 'Make it green',
      })
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  // ── Escape discards without committing ──────────────────────────────────

  it('pressing Escape discards without calling addNote', () => {
    const addNote = vi.fn();
    render(<ReviewCaptureLayer activeWorktree="feat-abc" addNote={addNote} />);

    dispatchPick();

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Draft text' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(addNote).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  // ── Messages from foreign origin are ignored ────────────────────────────

  it('ignores elementPicked from a foreign origin', () => {
    render(<ReviewCaptureLayer activeWorktree="feat-abc" addNote={vi.fn()} />);

    dispatchPick({}, 'http://evil.example.com');

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  // ── Messages with wrong type are ignored ────────────────────────────────

  it('ignores messages with a different type from PROXY_ORIGIN', () => {
    render(<ReviewCaptureLayer activeWorktree="feat-abc" addNote={vi.fn()} />);

    fireEvent(
      window,
      new MessageEvent('message', {
        data: { type: 'mars.capture.keydown' },
        origin: PROXY_ORIGIN,
      })
    );

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  // ── No active worktree → warn and ignore ───────────────────────────────

  it('console.warns and shows no input when activeWorktree is null', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<ReviewCaptureLayer activeWorktree={null} addNote={vi.fn()} />);

    dispatchPick();

    expect(warnSpy).toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
