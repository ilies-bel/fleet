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

/**
 * Renders the full git diff of a feature against main inside a <pre> block.
 * Calls getDiff(activeKey) once on mount.
 *
 * @param {{ activeKey: string }} props
 */
export default function DiffPane({ activeKey }) {
  const [patch, setPatch] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getDiff(activeKey)
      .then(data => setPatch(data.patch))
      .catch(err => setError(err.message));
  }, [activeKey]);

  if (error) {
    return (
      <pre style={{ ...preStyle, color: '#f55' }}>
        {error}
      </pre>
    );
  }

  if (patch === null) {
    return (
      <pre style={{ ...preStyle, color: '#555' }}>
        Loading diff…
      </pre>
    );
  }

  return (
    <pre style={{ ...preStyle, color: '#ccc' }}>
      {patch || '(no changes against main)'}
    </pre>
  );
}
