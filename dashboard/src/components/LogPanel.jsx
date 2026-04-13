import { useState, useEffect, useRef, useCallback } from 'react';
import { getLogs } from '../api.js';

const SOURCES = ['backend', 'nginx', 'postgresql', 'supervisord', 'all'];

/** Color for each named source in the ALL view */
const SOURCE_COLOR = {
  backend:     'var(--color-accent)',
  nginx:       '#66d9ef',
  postgresql:  '#e6a700',
  supervisord: 'var(--color-muted)',
};

/** Empty per-source snapshot */
const EMPTY_ALL = { backend: '', nginx: '', postgresql: '', supervisord: '' };

export default function LogPanel({ featureName, onClose }) {
  const [source, setSource] = useState('backend');
  // Per-source (non-all) mode: plain string
  const [buffer, setBuffer]         = useState('');
  // ALL mode: { backend, nginx, postgresql, supervisord }
  const [allSources, setAllSources] = useState(EMPTY_ALL);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState(null);
  const [autoTail, setAutoTail]     = useState(true);
  const [fetchedAt, setFetchedAt]   = useState(null);
  const sentinelRef = useRef(null);
  const dialogRef   = useRef(null);

  // Focus dialog on mount for keyboard/screen-reader users
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Reset state when source or feature changes
  useEffect(() => {
    setBuffer('');
    setAllSources(EMPTY_ALL);
    setError(null);
  }, [featureName, source]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (source === 'all') {
        const data = await getLogs(featureName, { source, tail: 200 });
        setFetchedAt(data.fetchedAt);
        // data.sources: { backend, nginx, postgresql, supervisord }
        const snap = data.sources ?? EMPTY_ALL;
        setAllSources({
          backend:     snap.backend     ?? '',
          nginx:       snap.nginx       ?? '',
          postgresql:  snap.postgresql  ?? '',
          supervisord: snap.supervisord ?? '',
        });
      } else {
        const data = await getLogs(featureName, { source, tail: 200 });
        setFetchedAt(data.fetchedAt);
        setBuffer(data.lines ?? '');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [featureName, source]);

  // Polling effect
  useEffect(() => {
    fetchLogs();
    if (!autoTail) return;
    const id = setInterval(fetchLogs, 3000);
    return () => clearInterval(id);
  }, [fetchLogs, autoTail]);

  // Auto-scroll to bottom when content changes
  useEffect(() => {
    if (autoTail && sentinelRef.current) {
      sentinelRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [buffer, allSources, autoTail]);

  // Line count: sum all sources for 'all', plain split for others
  const lineCount = source === 'all'
    ? Object.values(allSources).reduce((sum, text) => {
        return sum + (text ? text.split('\n').length : 0);
      }, 0)
    : (buffer ? buffer.split('\n').length : 0);

  const fetchedTime = fetchedAt
    ? new Date(fetchedAt).toLocaleTimeString()
    : '—';

  function handleClear() {
    if (source === 'all') {
      setAllSources(EMPTY_ALL);
    } else {
      setBuffer('');
    }
  }

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Panel box — stop propagation so clicks inside don't close */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Logs — ${featureName}`}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{
          width: '860px',
          maxWidth: '95vw',
          height: '80dvh',
          background: '#0a0a0a',
          border: '1px solid #333',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '0.5rem 0.75rem',
          borderBottom: '1px solid #222',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          flexWrap: 'wrap',
        }}>
          <span style={{ color: 'var(--color-accent)', fontSize: '0.75rem', fontWeight: 700, marginRight: '0.25rem' }}>
            // LOGS — {featureName}
          </span>

          {/* Source tabs */}
          <div style={{ display: 'flex', gap: '0.3rem' }}>
            {SOURCES.map(s => (
              <button
                key={s}
                onClick={() => setSource(s)}
                aria-pressed={s === source}
                style={tabBtn(s === source)}
              >
                [{s.toUpperCase()}]
              </button>
            ))}
          </div>

          <div style={{ flex: 1 }} />

          {/* Auto-tail toggle */}
          <button
            onClick={() => setAutoTail(v => !v)}
            style={tabBtn(autoTail)}
            aria-pressed={autoTail}
            title={autoTail ? 'Pause auto-refresh' : 'Enable auto-refresh every 3s'}
          >
            {autoTail ? '[TAIL]' : '[PAUSED]'}
          </button>

          {/* Close */}
          <button onClick={onClose} style={dangerBtn} aria-label="Close log panel">
            [CLOSE]
          </button>
        </div>

        {/* Log area */}
        <div style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}>
          {error && (
            <div
              role="alert"
              style={{
                padding: '0.4rem 0.75rem',
                background: '#1a0000',
                color: 'var(--color-danger)',
                fontSize: '0.72rem',
                borderBottom: '1px solid #330000',
                flexShrink: 0,
              }}
            >
              {error}
            </div>
          )}
          {loading && source !== 'all' && !buffer && (
            <div
              role="status"
              aria-live="polite"
              style={{
                padding: '0.4rem 0.75rem',
                color: 'var(--color-muted)',
                fontSize: '0.72rem',
                flexShrink: 0,
              }}
            >
              // fetching…
            </div>
          )}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            background: '#050505',
            border: '1px solid #1a1a1a',
            margin: '0.5rem 0.75rem 0',
          }}>
            {source === 'all'
              ? <AllSourcesView sources={allSources} loading={loading} />
              : (
                <pre style={{
                  margin: 0,
                  padding: '0.5rem 0.75rem',
                  fontSize: '0.72rem',
                  lineHeight: 1.5,
                  color: '#ccc',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}>
                  {buffer || (loading ? '' : '// no output')}
                </pre>
              )
            }
            <div ref={sentinelRef} />
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: '0.4rem 0.75rem',
          borderTop: '1px solid #222',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <span style={{ color: 'var(--color-muted)', fontSize: '0.65rem' }}>
            {lineCount} lines | fetched {fetchedTime}
            {loading && autoTail ? ' | refreshing…' : ''}
          </span>
          <button
            onClick={handleClear}
            style={{ ...dangerBtn, fontSize: '0.65rem', padding: '1px 6px' }}
            aria-label="Clear log output"
          >
            [CLEAR]
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Renders the ALL view: four color-coded source blocks, each with a header.
 * Non-empty sources only.
 */
function AllSourcesView({ sources, loading }) {
  const names = ['backend', 'nginx', 'postgresql', 'supervisord'];
  const hasAny = names.some(n => sources[n]);

  if (!hasAny) {
    return (
      <pre style={{
        margin: 0,
        padding: '0.5rem 0.75rem',
        fontSize: '0.72rem',
        lineHeight: 1.5,
        color: 'var(--color-muted)',
        whiteSpace: 'pre-wrap',
      }}>
        {loading ? '' : '// no output'}
      </pre>
    );
  }

  return (
    <div style={{ padding: '0.5rem 0.75rem' }}>
      {names.map(name => {
        const text = sources[name];
        if (!text) return null;
        const color = SOURCE_COLOR[name];
        return (
          <div key={name} style={{ marginBottom: '0.75rem' }}>
            <div style={{
              fontSize: '0.72rem',
              lineHeight: 1.5,
              color,
              fontFamily: 'var(--font-mono)',
              marginBottom: '0.15rem',
              userSelect: 'none',
            }}>
              {'// ' + name}
            </div>
            <pre style={{
              margin: 0,
              fontSize: '0.72rem',
              lineHeight: 1.5,
              color,
              opacity: 0.85,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              fontFamily: 'var(--font-mono)',
            }}>
              {text}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

function tabBtn(active) {
  return {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.65rem',
    padding: '2px 6px',
    cursor: 'pointer',
    borderRadius: 0,
    background: active ? 'var(--color-accent)' : 'transparent',
    border: '1px solid var(--color-accent)',
    color: active ? '#000' : 'var(--color-accent)',
  };
}

const dangerBtn = {
  fontFamily: 'var(--font-mono)',
  fontSize: '0.68rem',
  padding: '2px 7px',
  cursor: 'pointer',
  borderRadius: 0,
  background: 'transparent',
  border: '1px solid var(--color-danger)',
  color: 'var(--color-danger)',
};
