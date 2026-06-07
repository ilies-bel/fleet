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
  padding: 'var(--space-4)',
  overflow: 'auto',
  fontFamily: 'var(--font-mono)',
  fontSize: '0.75rem',
  background: 'var(--color-bg)',
};

const emptyStyle = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--color-bg)',
  fontFamily: 'var(--font-mono)',
  color: 'var(--color-muted)',
  fontSize: '1.1rem',
  letterSpacing: '0.05em',
};

const unavailableStyle = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--color-bg)',
  fontFamily: 'var(--font-mono)',
  color: 'var(--color-muted)',
  fontSize: '0.85rem',
  letterSpacing: '0.03em',
};

/** Format bytes as MB to one decimal place, e.g. 1048576 → "1.0 MB" */
const formatMB = b => (b / 1_048_576).toFixed(1) + ' MB';

/**
 * Parse a unified diff patch, tolerating a truncated trailing hunk.
 * If parseDiff throws (typically because the patch was cut mid-hunk),
 * the trailing partial file is dropped by retrying on the patch up to
 * the last `diff --git` boundary.
 *
 * @param {string} patch
 * @returns {import('react-diff-view').File[]}
 */
function parseDiffRobust(patch) {
  try {
    return parseDiff(patch);
  } catch {
    const lastDiff = patch.lastIndexOf('\ndiff --git ');
    if (lastDiff > 0) {
      try {
        return parseDiff(patch.slice(0, lastDiff));
      } catch {
        return [];
      }
    }
    return [];
  }
}

/**
 * Renders the full git diff of a feature against main as a polished
 * side-by-side diff using react-diff-view with syntax highlighting.
 *
 * States:
 *  - loading     — getDiff(activeKey) is in flight.
 *  - error       — getDiff rejected; the message is shown inline.
 *  - no-changes  — branch is identical to main (status: 'no-changes'): a
 *                  centered terminal-style message is shown.
 *  - unavailable — git metadata not accessible in the container (status:
 *                  'unavailable'): a calm panel with a short reason is shown.
 *  - diff        — one DiffFile block per changed file, optionally preceded by
 *                  a truncation banner when the gateway capped the output.
 *
 * The fetch is cancellable: re-rendering with a new activeKey aborts the
 * stale in-flight call so its result can't clobber the fresh one.
 *
 * @param {{ activeKey: string }} props
 */
export default function DiffPane({ activeKey }) {
  const [patch, setPatch] = useState(null);
  const [status, setStatus] = useState(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [originalBytes, setOriginalBytes] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setPatch(null);
    setStatus(null);
    setReason('');
    setTruncated(false);
    setOriginalBytes(0);
    getDiff(activeKey)
      .then(data => {
        if (cancelled) return;
        setStatus(data.status ?? (data.isEmpty || !data.patch ? 'no-changes' : 'ok'));
        if (data.status === 'unavailable') {
          setReason(data.reason ?? '');
        } else if (data.patch && !data.isEmpty) {
          setPatch(data.patch);
          if (data.truncated) {
            setTruncated(true);
            setOriginalBytes(data.originalBytes ?? 0);
          }
        }
      })
      .catch(e => { if (!cancelled) setError(e.message || String(e)); });
    return () => { cancelled = true; };
  }, [activeKey]);

  const files = useMemo(() => {
    if (!patch) return [];
    return parseDiffRobust(patch);
  }, [patch]);

  if (error) {
    return (
      <div
        className="diff-pane-error"
        style={{
          flex: 1,
          padding: 'var(--space-4)',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.8rem',
          color: 'var(--color-danger)',
          background: 'var(--color-bg)',
        }}
      >
        {'// DIFF UNAVAILABLE: ' + error}
      </div>
    );
  }

  if (status === null) {
    return (
      <pre style={{ ...loadingStyle, color: 'var(--color-muted)' }}>
        Loading diff…
      </pre>
    );
  }

  if (status === 'unavailable') {
    return (
      <div className="diff-pane-unavailable" style={unavailableStyle}>
        {'// Diff unavailable — ' + (reason || 'unknown reason')}
      </div>
    );
  }

  if (status === 'no-changes' || !files.length) {
    return (
      <div style={emptyStyle}>
        // NO CHANGES VS main
      </div>
    );
  }

  return (
    <div className="diff-pane">
      {truncated && (
        <div
          className="diff-truncation-banner"
          style={{
            padding: 'var(--space-2) var(--space-4)',
            background: '#332200',
            color: 'var(--color-warning)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.75rem',
            borderBottom: '1px solid #443300',
          }}
        >
          {`// DIFF TRUNCATED — showing first ${formatMB(1_048_576)} of ${formatMB(originalBytes)}`}
        </div>
      )}
      {files.map(file => (
        <DiffFile
          key={(file.oldRevision ?? '') + (file.newRevision ?? '') + (file.newPath ?? file.oldPath ?? '')}
          file={file}
        />
      ))}
    </div>
  );
}
