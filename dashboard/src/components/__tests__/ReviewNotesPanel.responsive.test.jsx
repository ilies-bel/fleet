/**
 * Behaviour tests for the responsive off-canvas notes drawer.
 *
 * Verifies:
 *  - The notes panel carries data-open=false by default when notes exist.
 *  - The [NOTES n] toolbar button (aria-label "Toggle review notes panel")
 *    flips the panel to data-open=true when clicked.
 *  - The [NOTES n] button is absent when there are no notes.
 *  - Clicking the toolbar button a second time closes the panel (data-open=false).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import PreviewFrame from '../PreviewFrame.jsx';
import ReviewNotesPanel from '../ReviewNotesPanel.jsx';

// DiffPane (imported transitively by PreviewFrame) calls getDiff from api.js.
vi.mock('../../api.js', () => ({
  getDiff: vi.fn(),
}));

/**
 * Minimal wrapper that owns notesOpen state and wires both components together,
 * mirroring how FeaturesPage in App.jsx connects them.
 */
function NotesDrawerWrapper({ notes, isCapture = true }) {
  const [notesOpen, setNotesOpen] = useState(false);
  return (
    <>
      <PreviewFrame
        activePreview="feat-test"
        branch="test-branch"
        previewKey={0}
        isCapture={isCapture}
        onToggleCapture={() => {}}
        addNote={() => {}}
        notes={notes}
        notesOpen={notesOpen}
        onToggleNotes={() => setNotesOpen(o => !o)}
        hasFeatures
      />
      <ReviewNotesPanel
        notes={notes}
        worktree="feat-test"
        addNote={() => {}}
        removeNote={() => {}}
        clearForWorktree={() => {}}
        open={notesOpen}
        onClose={() => setNotesOpen(false)}
      />
    </>
  );
}

const NOTE = {
  id: 'n1',
  refKind: 'class',
  selectors: ['.btn'],
  route: '/home',
  text: 'Fix button colour',
  createdAt: new Date().toISOString(),
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('ReviewNotesPanel — off-canvas drawer behaviour', () => {
  // ── Tracer bullet: panel starts closed ───────────────────────────────────

  it('notes panel starts with data-open=false when notes are present', () => {
    render(<NotesDrawerWrapper notes={[NOTE]} />);

    const panel = screen.getByRole('complementary', { name: 'Review notes' });
    expect(panel).toHaveAttribute('data-open', 'false');
  });

  // ── [NOTES n] toggle button opens the panel ───────────────────────────────

  it('clicking the [NOTES n] toolbar button sets data-open=true on the panel', () => {
    render(<NotesDrawerWrapper notes={[NOTE]} />);

    fireEvent.click(
      screen.getByRole('button', { name: /toggle review notes panel/i })
    );

    const panel = screen.getByRole('complementary', { name: 'Review notes' });
    expect(panel).toHaveAttribute('data-open', 'true');
  });

  // ── Second click closes the panel ─────────────────────────────────────────

  it('clicking the toggle a second time sets data-open back to false', () => {
    render(<NotesDrawerWrapper notes={[NOTE]} />);

    const btn = screen.getByRole('button', { name: /toggle review notes panel/i });
    fireEvent.click(btn);
    fireEvent.click(btn);

    const panel = screen.getByRole('complementary', { name: 'Review notes' });
    expect(panel).toHaveAttribute('data-open', 'false');
  });

  // ── No toggle button when there are no notes ──────────────────────────────

  it('[NOTES] toggle button is absent when there are no notes', () => {
    render(<NotesDrawerWrapper notes={[]} />);

    expect(
      screen.queryByRole('button', { name: /toggle review notes panel/i })
    ).not.toBeInTheDocument();
  });

  // ── Toggle has correct aria attributes ────────────────────────────────────

  it('[NOTES n] toggle has aria-pressed=false when panel is closed', () => {
    render(<NotesDrawerWrapper notes={[NOTE]} />);

    const btn = screen.getByRole('button', { name: /toggle review notes panel/i });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('[NOTES n] toggle has aria-pressed=true when panel is open', () => {
    render(<NotesDrawerWrapper notes={[NOTE]} />);

    const btn = screen.getByRole('button', { name: /toggle review notes panel/i });
    fireEvent.click(btn);

    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  // ── Label shows the note count ─────────────────────────────────────────────

  it('[NOTES n] toggle label shows the note count', () => {
    render(<NotesDrawerWrapper notes={[NOTE, { ...NOTE, id: 'n2' }]} />);

    expect(screen.getByText('[NOTES 2]')).toBeInTheDocument();
  });
});
