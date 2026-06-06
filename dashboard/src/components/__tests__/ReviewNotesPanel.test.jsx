/**
 * Behaviour tests for ReviewNotesPanel.
 *
 * Verifies:
 *  - Empty state renders the placeholder message.
 *  - Notes are grouped under their route as <h4> headings.
 *  - Notes without a route appear under a 'General' group.
 *  - Each note row shows refKind, truncated selector, and text.
 *  - Delete button calls removeNote with worktree + note id.
 *  - 'Clear all' button calls clearForWorktree only after window.confirm.
 *  - 'Clear all' button is absent when the notes list is empty.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReviewNotesPanel from '../ReviewNotesPanel.jsx';

const WORKTREE = 'feat-test';

function makeNote(overrides) {
  return {
    id: crypto.randomUUID(),
    refKind: 'class',
    selector: '.btn-primary',
    route: '/home',
    text: 'Make this button larger',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('ReviewNotesPanel', () => {
  // ── Tracer bullet: empty state ─────────────────────────────────────────

  it('renders the empty-state message when there are no notes', () => {
    render(
      <ReviewNotesPanel
        notes={[]}
        worktree={WORKTREE}
        removeNote={vi.fn()}
        clearForWorktree={vi.fn()}
      />
    );

    expect(screen.getByText('No review notes yet for this feature.')).toBeTruthy();
  });

  // ── Notes grouped by route ─────────────────────────────────────────────

  it('groups notes under their route as h4 headings', () => {
    const notes = [
      makeNote({ route: '/home', text: 'Note on home' }),
      makeNote({ route: '/settings', text: 'Note on settings' }),
    ];

    render(
      <ReviewNotesPanel
        notes={notes}
        worktree={WORKTREE}
        removeNote={vi.fn()}
        clearForWorktree={vi.fn()}
      />
    );

    expect(screen.getByRole('heading', { level: 4, name: '/home' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 4, name: '/settings' })).toBeTruthy();
    expect(screen.getByText('Note on home')).toBeTruthy();
    expect(screen.getByText('Note on settings')).toBeTruthy();
  });

  // ── General section for notes without a route ──────────────────────────

  it('groups notes without a route under a "General" heading', () => {
    const notes = [
      makeNote({ route: undefined, selector: undefined, refKind: undefined, text: 'General observation' }),
    ];

    render(
      <ReviewNotesPanel
        notes={notes}
        worktree={WORKTREE}
        removeNote={vi.fn()}
        clearForWorktree={vi.fn()}
      />
    );

    expect(screen.getByRole('heading', { level: 4, name: 'General' })).toBeTruthy();
    expect(screen.getByText('General observation')).toBeTruthy();
  });

  // ── Delete button calls removeNote ─────────────────────────────────────

  it('calls removeNote with the correct worktree and note id when ✕ is clicked', () => {
    const removeNote = vi.fn();
    const note = makeNote({ id: 'note-123', text: 'Delete me' });

    render(
      <ReviewNotesPanel
        notes={[note]}
        worktree={WORKTREE}
        removeNote={removeNote}
        clearForWorktree={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /delete note: delete me/i }));

    expect(removeNote).toHaveBeenCalledOnce();
    expect(removeNote).toHaveBeenCalledWith(WORKTREE, 'note-123');
  });

  // ── Clear all requires confirmation ───────────────────────────────────

  describe('"Clear all" button', () => {
    beforeEach(() => {
      vi.stubGlobal('confirm', vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('calls clearForWorktree when the user confirms', () => {
      window.confirm.mockReturnValue(true);
      const clearForWorktree = vi.fn();
      const notes = [makeNote()];

      render(
        <ReviewNotesPanel
          notes={notes}
          worktree={WORKTREE}
          removeNote={vi.fn()}
          clearForWorktree={clearForWorktree}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /clear all/i }));

      expect(window.confirm).toHaveBeenCalledOnce();
      expect(clearForWorktree).toHaveBeenCalledWith(WORKTREE);
    });

    it('does NOT call clearForWorktree when the user cancels the confirm dialog', () => {
      window.confirm.mockReturnValue(false);
      const clearForWorktree = vi.fn();
      const notes = [makeNote()];

      render(
        <ReviewNotesPanel
          notes={notes}
          worktree={WORKTREE}
          removeNote={vi.fn()}
          clearForWorktree={clearForWorktree}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /clear all/i }));

      expect(window.confirm).toHaveBeenCalledOnce();
      expect(clearForWorktree).not.toHaveBeenCalled();
    });

    it('does not render the "Clear all" button when there are no notes', () => {
      render(
        <ReviewNotesPanel
          notes={[]}
          worktree={WORKTREE}
          removeNote={vi.fn()}
          clearForWorktree={vi.fn()}
        />
      );

      expect(screen.queryByRole('button', { name: /clear all/i })).toBeNull();
    });
  });

  // ── Selector is truncated at 30 characters ─────────────────────────────

  it('truncates a long selector with an ellipsis', () => {
    const longSelector = '.some-very-long-class-name-that-exceeds-the-limit';
    const note = makeNote({ selector: longSelector });

    render(
      <ReviewNotesPanel
        notes={[note]}
        worktree={WORKTREE}
        removeNote={vi.fn()}
        clearForWorktree={vi.fn()}
      />
    );

    // Displayed text is truncated; full value is in title attribute.
    expect(screen.getByTitle(longSelector)).toBeTruthy();
    // The truncated text should not contain the full selector.
    const truncated = screen.getByTitle(longSelector).textContent;
    expect(truncated).toMatch(/…$/);
    expect(truncated.length).toBeLessThan(longSelector.length);
  });
});
