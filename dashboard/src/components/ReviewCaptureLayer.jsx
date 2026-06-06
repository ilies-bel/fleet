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

  const { selector = '', route = '' } = pendingPick;
  const hint = `${selector} on ${route}`;

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
        bottom: '1.25rem',
        left: '50%',
        transform: 'translateX(-50%)',
        background: '#111',
        border: '1px solid #444',
        borderRadius: '3px',
        padding: '0.5rem 0.75rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.35rem',
        zIndex: 10,
        minWidth: '320px',
        maxWidth: '600px',
        boxShadow: '0 2px 12px rgba(0,0,0,0.6)',
      }}
    >
      <span
        aria-label="element hint"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.68rem',
          color: '#888',
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
          background: '#000',
          border: '1px solid #333',
          color: '#ccc',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.8rem',
          padding: '0.3rem 0.5rem',
          outline: 'none',
          borderRadius: 0,
          width: '100%',
          boxSizing: 'border-box',
        }}
      />
    </div>
  );
}
