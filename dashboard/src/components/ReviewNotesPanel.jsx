import './ReviewNotesPanel.css';

/**
 * ReviewNotesPanel
 *
 * Lists all review notes for the active worktree, grouped by route.
 * Notes without a route (general notes) appear under a "General" section.
 *
 * @param {{ notes: Array, worktree: string|null, removeNote: Function, clearForWorktree: Function }} props
 */
export default function ReviewNotesPanel({ notes, worktree, removeNote, clearForWorktree }) {
  function handleClearAll() {
    if (!worktree) return;
    if (window.confirm('Clear all review notes for this feature?')) {
      clearForWorktree(worktree);
    }
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
    <aside className="review-notes-panel" aria-label="Review notes">
      <div className="review-notes-panel__header">
        <h3 className="review-notes-panel__title">Review Notes</h3>
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
      </div>
    </aside>
  );
}
