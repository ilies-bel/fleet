import { useState, useEffect, useRef, useCallback } from 'react';
import { getLogs } from '../api.js';
import { Button } from './Button.jsx';

const SOURCES = ['build', 'backend', 'nginx', 'postgresql', 'supervisord', 'all'];

/** Color for each named source in the ALL view */
const SOURCE_COLOR = {
  backend:     'var(--color-accent)',
  nginx:       'var(--color-source-nginx)',
  postgresql:  'var(--color-source-postgresql)',
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
  const sentinelRef  = useRef(null);
  const dialogRef    = useRef(null);
  const prevFocusRef = useRef(null);

  // Save the previously-focused element and move focus into the dialog on mount.
  useEffect(() => {
    prevFocusRef.current = document.activeElement;
    dialogRef.current?.focus();
  }, []);

  // Close the panel and restore focus to whoever opened it.
  const handleClose = useCallback(() => {
    prevFocusRef.current?.focus();
    onClose();
  }, [onClose]);

  // Keyboard handler on the dialog: Escape closes; Tab wraps within focusable set.
  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      handleClose();
      return;
    }
    if (e.key !== 'Tab') return;

    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusable = Array.from(
      dialog.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select, textarea',
      ),
    );
    if (focusable.length === 0) return;

    const first  = focusable[0];
    const last   = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (e.shiftKey) {
      // Shift+Tab from first (or the dialog container itself) → wrap to last.
      if (active === first || active === dialog) {
        e.preventDefault();
        last.focus();
      }
    } else {
      // Tab from last → wrap to first.
      if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

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

  // 'build' source: SSE stream (not REST polling). Connects once and accumulates
  // lines as the gateway sends them. Reconnects automatically via EventSource.
  useEffect(() => {
    if (source !== 'build') return;
    setLoading(true);
    setError(null);
    const es = new EventSource(`/_fleet/api/features/${featureName}/build-log`);
    es.onopen = () => setLoading(false);
    es.onmessage = (event) => {
      setBuffer(prev => {
        const next = prev ? `${prev}\n${event.data}` : event.data;
        // Cap to ~500 lines so modal stays responsive
        const lines = next.split('\n');
        return lines.length > 500 ? lines.slice(-500).join('\n') : next;
      });
      setFetchedAt(Date.now());
    };
    es.onerror = () => {
      // EventSource will reconnect on its own; surface a soft hint only
      setLoading(false);
    };
    return () => es.close();
  }, [featureName, source]);

  // REST polling effect (skipped for build source — that one uses SSE)
  useEffect(() => {
    if (source === 'build') return;
    fetchLogs();
    if (!autoTail) return;
    const id = setInterval(fetchLogs, 3000);
    return () => clearInterval(id);
  }, [fetchLogs, autoTail, source]);

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
      onClick={handleClose}
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
        onKeyDown={handleKeyDown}
        style={{
          width: '860px',
          maxWidth: '95vw',
          height: '80dvh',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border-strong)',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {/* Header */}
        <div style={{
          padding: 'var(--space-2) var(--space-3)',
          borderBottom: '1px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          flexWrap: 'wrap',
        }}>
          <span style={{ color: 'var(--color-accent)', fontSize: '0.75rem', fontWeight: 700, marginRight: 'var(--space-1)' }}>
            // LOGS — {featureName}
          </span>

          {/* Source tabs — primary tone; active tab shows the filled inversion */}
          <div style={{ display: 'flex', gap: '0.3rem' /* off-scale: 0.3rem micro-gap between tab buttons */ }}>
            {SOURCES.map(s => (
              <Button
                key={s}
                tone="primary"
                onClick={() => setSource(s)}
                aria-pressed={s === source}
                style={{
                  fontSize: '0.65rem',
                  padding: '2px 6px',
                  ...(s === source ? { background: 'var(--color-accent)', color: 'var(--color-bg-black)' } : {}),
                }}
              >
                [{s.toUpperCase()}]
              </Button>
            ))}
          </div>

          <div style={{ flex: 1 }} />

          {/* Auto-tail toggle — primary when active (tailing), caution when paused */}
          <Button
            tone={autoTail ? 'primary' : 'caution'}
            onClick={() => setAutoTail(v => !v)}
            aria-pressed={autoTail}
            title={autoTail ? 'Pause auto-refresh' : 'Enable auto-refresh every 3s'}
            style={{
              fontSize: '0.68rem',
              padding: '2px 7px',
              ...(autoTail ? { background: 'var(--color-accent)', color: 'var(--color-bg-black)' } : {}),
            }}
          >
            {autoTail ? '[TAIL]' : '[PAUSED]'}
          </Button>

          {/* Close — primary (closing the panel causes no data loss); handleClose restores focus */}
          <Button
            tone="primary"
            onClick={handleClose}
            aria-label="Close log panel"
            style={{ fontSize: '0.68rem', padding: '2px 7px' }}
          >
            [CLOSE]
          </Button>
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
                padding: 'var(--space-15) var(--space-3)',
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
                padding: 'var(--space-15) var(--space-3)',
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
            border: '1px solid var(--color-surface-header)',
            margin: 'var(--space-2) var(--space-3) 0',
          }}>
            {source === 'all'
              ? <AllSourcesView sources={allSources} loading={loading} />
              : (
                <pre style={{
                  margin: 0,
                  padding: 'var(--space-2) var(--space-3)',
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
          padding: 'var(--space-15) var(--space-3)',
          borderTop: '1px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <span style={{ color: 'var(--color-muted)', fontSize: '0.65rem' }}>
            {lineCount} lines | fetched {fetchedTime}
            {loading && autoTail ? ' | refreshing…' : ''}
          </span>
          {/* Clear — caution, not destructive: only clears the display buffer */}
          <Button
            tone="caution"
            onClick={handleClear}
            aria-label="Clear log output"
            style={{ fontSize: '0.65rem', padding: '1px 6px' }}
          >
            [CLEAR]
          </Button>
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
        padding: 'var(--space-2) var(--space-3)',
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
    <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
      {names.map(name => {
        const text = sources[name];
        if (!text) return null;
        const color = SOURCE_COLOR[name];
        return (
          <div key={name} style={{ marginBottom: 'var(--space-3)' }}>
            <div style={{
              fontSize: '0.72rem',
              lineHeight: 1.5,
              color,
              fontFamily: 'var(--font-mono)',
              marginBottom: '0.15rem', /* off-scale: 0.15rem source-header micro-gap */
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
