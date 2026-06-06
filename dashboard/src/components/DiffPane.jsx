import { useState, useEffect } from 'react';
import { getDiff } from '../api.js';

const preStyle = {
  flex: 1,
  margin: 0,
  padding: '1rem',
  overflow: 'auto',
  fontFamily: 'var(--font-mono)',
  fontSize: '0.75rem',
  background: '#0a0a0a',
};

const emptyStyle = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--color-bg)',
  fontFamily: 'var(--font-mono)',
  color: '#333',
  fontSize: '1.1rem',
  letterSpacing: '0.05em',
};

/**
 * Renders the full git diff of a feature against main inside a <pre> block.
 * When the branch is identical to main (isEmpty: true or patch is empty),
 * renders a centered terminal-style message instead.
 * Calls getDiff(activeKey) once on mount.
 *
 * @param {{ activeKey: string }} props
 */
export default function DiffPane({ activeKey }) {
  const [patch, setPatch] = useState(null);
  const [isEmpty, setIsEmpty] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setPatch(null);
    setIsEmpty(false);
    getDiff(activeKey)
      .then(data => {
        if (cancelled) return;
        if (data.isEmpty || !data.patch) {
          setIsEmpty(true);
        } else {
          setPatch(data.patch);
        }
      })
      .catch(e => { if (!cancelled) setError(e.message || String(e)); });
    return () => { cancelled = true; };
  }, [activeKey]);

  if (error) {
    return (
      <div
        className="diff-pane-error"
        style={{
          flex: 1,
          padding: '1rem',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.8rem',
          color: '#ff5555',
          background: 'var(--color-bg)',
        }}
      >
        {'// DIFF UNAVAILABLE: ' + error}
      </div>
    );
  }

  if (patch === null && !isEmpty) {
    return (
      <pre style={{ ...preStyle, color: '#555' }}>
        Loading diff…
      </pre>
    );
  }

  if (isEmpty) {
    return (
      <div style={emptyStyle}>
        // NO CHANGES VS main
      </div>
    );
  }

  return (
    <pre style={{ ...preStyle, color: '#ccc' }}>
      {patch}
    </pre>
  );
}
