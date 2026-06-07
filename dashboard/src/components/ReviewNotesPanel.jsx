import { useState } from 'react';
import { buildReviewPrompt } from '../lib/buildReviewPrompt.js';
import { Button } from './Button.jsx';
import ConfirmModal from './ConfirmModal.jsx';
import './ReviewNotesPanel.css';

/**
 * ReviewNotesPanel
 *
 * Lists all review notes for the active worktree, grouped by route.
 * Notes without a route (general notes) appear under a "General" section.
 * Provides an "Add general note" composer that works without capture mode.
 *
 * @param {{ notes: Array, worktree: string|null, addNote: Function, removeNote: Function, clearForWorktree: Function }} props
 */
export default function ReviewNotesPanel({ notes, worktree, addNote, removeNote, clearForWorktree }) {
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(buildReviewPrompt(worktree, notes));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // silently ignore clipboard errors (e.g. permission denied)
    }
  }

  function handleClearAll() {
    if (!worktree) return;
    setConfirmOpen(true);
  }

  function handleSave() {
    if (!composerText.trim()) return;
    addNote(worktree, {
      refKind: 'general',
      selectors: [],
      route: null,
      text: composerText.trim(),
    });
    setComposerText('');
    setComposerOpen(false);
  }

  function handleCancel() {
    setComposerText('');
    setComposerOpen(false);
  }

  // Group notes by route; notes without a route go under 'General'.
  const groups = {};
  for (const note of notes) {
    const key = note.route || 'General';
    if (!groups[key]) groups[key] = [];
    groups[key].push(note);
  }

  // Stable order: named routes sorted, then 'General' last.
  const routeKeys = Object.keys(groups)
    .filter(k => k !== 'General')
    .sort();
  if (groups['General']) routeKeys.push('General');

  return (
    <>
    <aside className="review-notes-panel" aria-label="Review notes">
      <div className="review-notes-panel__header">
        <h3 className="review-notes-panel__title">Review Notes</h3>
        <Button
          tone="primary"
          onClick={handleCopy}
          disabled={notes.length === 0}
          aria-label="Copy review notes as prompt"
        >
          {copied ? '[COPIED]' : '[COPY]'}
        </Button>
        {notes.length > 0 && (
          <Button
            tone="destructive"
            onClick={handleClearAll}
            aria-label="Clear all review notes"
          >
            [CLEAR ALL]
          </Button>
        )}
      </div>

      <div className="review-notes-panel__body">
        {notes.length === 0 ? (
          <p className="review-notes-panel__empty">
            No review notes yet for this feature.
          </p>
        ) : (
          routeKeys.map(route => (
            <div key={route}>
              <h4 className="review-notes-panel__group-heading">{route}</h4>
              {groups[route].map(note => (
                <div key={note.id} className="review-notes-panel__note-row">
                  <div className="review-notes-panel__note-body">
                    <div className="review-notes-panel__note-meta">
                      {note.selectors && note.selectors.length > 1 ? (
                        <span>multi · {note.selectors.length} targets</span>
                      ) : (
                        <>
                          {note.refKind && <span>{note.refKind}</span>}
                          {note.refKind && note.selectors && note.selectors[0] && <span> · </span>}
                          {note.selectors && note.selectors[0] && (
                            <span title={note.selectors[0]}>
                              {note.selectors[0].length > 30
                                ? note.selectors[0].slice(0, 30) + '…'
                                : note.selectors[0]}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                    <div className="review-notes-panel__note-text">{note.text}</div>
                  </div>
                  <button
                    className="review-notes-panel__delete-btn"
                    onClick={() => removeNote(worktree, note.id)}
                    aria-label={`Delete note: ${note.text}`}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ))
        )}

        <div className="review-notes-panel__composer">
          {composerOpen ? (
            <>
              <textarea
                className="review-notes-panel__composer-textarea"
                value={composerText}
                onChange={e => setComposerText(e.target.value)}
                placeholder="Add a general note…"
              />
              <div className="review-notes-panel__composer-actions">
                <Button tone="primary" onClick={handleSave}>
                  [SAVE]
                </Button>
                <Button tone="primary" onClick={handleCancel}>
                  [CANCEL]
                </Button>
              </div>
            </>
          ) : (
            <Button
              tone="primary"
              aria-label="Add general note"
              onClick={() => setComposerOpen(true)}
            >
              [ADD NOTE]
            </Button>
          )}
        </div>
      </div>
    </aside>
    <ConfirmModal
      open={confirmOpen}
      title="Clear all review notes"
      message="Clear all review notes for this feature?"
      confirmLabel="[CLEAR ALL]"
      onConfirm={() => { clearForWorktree(worktree); setConfirmOpen(false); }}
      onCancel={() => setConfirmOpen(false)}
      destructive
    />
    </>
  );
}
