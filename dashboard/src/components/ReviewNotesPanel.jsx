import { useState } from 'react';
import { buildReviewPrompt } from '../lib/buildReviewPrompt.js';
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
      selector: null,
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
        <button
          className="review-notes-panel__copy-btn"
          onClick={handleCopy}
          disabled={notes.length === 0}
          aria-label="Copy review notes as prompt"
        >
          {copied ? 'Copied ✓' : 'Copy as prompt'}
        </button>
        {notes.length > 0 && (
          <button
            className="review-notes-panel__clear-btn"
            onClick={handleClearAll}
            aria-label="Clear all review notes"
          >
            Clear all
          </button>
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
                      {note.refKind && <span>{note.refKind}</span>}
                      {note.refKind && note.selector && <span> · </span>}
                      {note.selector && (
                        <span title={note.selector}>
                          {note.selector.length > 30
                            ? note.selector.slice(0, 30) + '…'
                            : note.selector}
                        </span>
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
                <button
                  className="review-notes-panel__composer-save"
                  onClick={handleSave}
                >
                  Save
                </button>
                <button
                  className="review-notes-panel__composer-cancel"
                  onClick={handleCancel}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <button
              className="review-notes-panel__add-btn"
              onClick={() => setComposerOpen(true)}
            >
              Add general note
            </button>
          )}
        </div>
      </div>
    </aside>
    <ConfirmModal
      open={confirmOpen}
      title="Clear all review notes"
      message="Clear all review notes for this feature?"
      confirmLabel="Clear all"
      onConfirm={() => { clearForWorktree(worktree); setConfirmOpen(false); }}
      onCancel={() => setConfirmOpen(false)}
      destructive
    />
    </>
  );
}
