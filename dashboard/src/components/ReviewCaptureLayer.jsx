import { useState, useEffect } from 'react';
import { PROXY_ORIGIN } from '../lib/captureProtocol.js';

/**
 * Listens for 'mars.capture.elementPicked' messages from the proxy and
 * presents a small inline input so the operator can type an improvement note.
 *
 * - Enter  → commits via addNote(activeWorktree, { ...payload, text })
 * - Escape → discards without saving
 *
 * If no activeWorktree is selected, the message is ignored and a
 * console.warn fires.
 *
 * @param {{ activeWorktree: string|null, addNote: Function }} props
 */
export default function ReviewCaptureLayer({ activeWorktree, addNote }) {
  const [pendingPick, setPendingPick] = useState(null);
  const [inputText, setInputText] = useState('');

  useEffect(() => {
    function onMessage(event) {
      if (event.origin !== PROXY_ORIGIN) return;
      if (!event.data || event.data.type !== 'mars.capture.elementPicked') return;

      if (!activeWorktree) {
        // eslint-disable-next-line no-console
        console.warn(
          '[ReviewCaptureLayer] elementPicked received but no active worktree is selected — ignoring'
        );
        return;
      }

      setPendingPick(event.data);
      setInputText('');
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [activeWorktree]);

  if (!pendingPick) return null;

  const { selectors = [], route = '' } = pendingPick;
  const hint = selectors.length > 1
    ? `${selectors.length} elements on ${route}`
    : `${selectors[0] || ''} on ${route}`;

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      addNote(activeWorktree, { ...pendingPick, text: inputText });
      setPendingPick(null);
      setInputText('');
    } else if (e.key === 'Escape') {
      setPendingPick(null);
      setInputText('');
    }
  }

  return (
    <div
      data-testid="review-capture-layer"
      style={{
        position: 'absolute',
        bottom: '1.25rem', /* off-scale: 1.25rem positioning offset has no exact token */
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'var(--color-surface)',
        border: '1px solid #444',
        padding: 'var(--space-2) var(--space-3)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.35rem', /* off-scale: 0.35rem gap has no exact token */
        zIndex: 10,
        minWidth: '320px',
        maxWidth: '600px',
      }}
    >
      <span
        aria-label="element hint"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.68rem',
          color: 'var(--color-ink-dim)',
          userSelect: 'none',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {hint}
      </span>
      <input
        aria-label="improvement note"
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        value={inputText}
        onChange={e => setInputText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Describe the improvement… (Enter to save, Esc to cancel)"
        style={{
          background: 'var(--color-bg-black)',
          border: '1px solid var(--color-border-strong)',
          color: '#ccc',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.8rem',
          padding: '0.3rem var(--space-2)', /* off-scale: 0.3rem vertical has no exact token */
          width: '100%',
          boxSizing: 'border-box',
        }}
      />
    </div>
  );
}
