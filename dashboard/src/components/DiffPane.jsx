import { useState, useEffect, useMemo } from 'react';
import { Diff, Hunk, parseDiff, tokenize } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import { getDiff } from '../api.js';
import { refractor, langFromPath } from './diffLanguage.js';

// react-diff-view v3's tokenize expects refractor.highlight() to return a children
// array (refractor v3 behaviour). refractor v4 returns a full root node instead.
// Adapt by unwrapping .children so createRoot() receives the correct shape.
const r4Adapter = { highlight: (text, lang) => refractor.highlight(text, lang).children };

function DiffFile({ file }) {
  const tokens = useMemo(() => {
    const lang = langFromPath(file.newPath || file.oldPath);
    if (!lang) return undefined;
    try {
      return tokenize(file.hunks, { highlight: true, refractor: r4Adapter, language: lang });
    } catch {
      return undefined;
    }
  }, [file]);

  const headerPath =
    file.type === 'add'
      ? file.newPath
      : file.type === 'delete'
      ? file.oldPath
      : `${file.oldPath} → ${file.newPath}`;

  return (
    <section className="diff-file-block">
      <header className="diff-file-header">{headerPath}</header>
      <Diff
        viewType="split"
        diffType={file.type}
        hunks={file.hunks}
        tokens={tokens}
      >
        {hunks => hunks.map(hunk => <Hunk key={hunk.content} hunk={hunk} />)}
      </Diff>
    </section>
  );
}

const loadingStyle = {
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
 * Renders the full git diff of a feature against main as a polished
 * side-by-side diff using react-diff-view with syntax highlighting.
 *
 * States:
 *  - loading — getDiff(activeKey) is in flight.
 *  - error   — getDiff rejected; the message is shown inline.
 *  - empty   — branch is identical to main (isEmpty: true, empty patch, or
 *              no parseable files): a centered terminal-style message is shown.
 *  - diff    — one DiffFile block per changed file.
 *
 * The fetch is cancellable: re-rendering with a new activeKey aborts the
 * stale in-flight call so its result can't clobber the fresh one.
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

  const files = useMemo(() => {
    if (!patch) return [];
    return parseDiff(patch);
  }, [patch]);

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
      <pre style={{ ...loadingStyle, color: '#555' }}>
        Loading diff…
      </pre>
    );
  }

  if (isEmpty || !files.length) {
    return (
      <div style={emptyStyle}>
        // NO CHANGES VS main
      </div>
    );
  }

  return (
    <div className="diff-pane">
      {files.map(file => (
        <DiffFile
          key={(file.oldRevision ?? '') + (file.newRevision ?? '') + (file.newPath ?? file.oldPath ?? '')}
          file={file}
        />
      ))}
    </div>
  );
}
