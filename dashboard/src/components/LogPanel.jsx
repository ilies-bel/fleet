import { useState, useEffect, useRef, useCallback } from 'react';
import { getLogs } from '../api.js';

const SOURCES = ['backend', 'nginx', 'postgresql', 'supervisord', 'all'];
const MAX_LINES = 5000;

export default function LogPanel({ featureName, onClose }) {
  const [source, setSource] = useState('backend');
  const [buffer, setBuffer] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [autoTail, setAutoTail] = useState(true);
  const [fetchedAt, setFetchedAt] = useState(null);
  const sinceRef = useRef(Math.floor(Date.now() / 1000) - 30);
  const sentinelRef = useRef(null);

  // Close on Escape
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Reset state when source or feature changes
  useEffect(() => {
    setBuffer('');
    setError(null);
    sinceRef.current = Math.floor(Date.now() / 1000) - 30;
  }, [featureName, source]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const opts = source === 'all'
        ? { source, tail: 200, since: sinceRef.current }
        : { source, tail: 200 };

      const data = await getLogs(featureName, opts);
      const text = data.lines || '';
      setFetchedAt(data.fetchedAt);

      if (source === 'all') {
        sinceRef.current = Math.floor(data.fetchedAt / 1000);
        if (text) {
          setBuffer(prev => {
            const combined = prev + text;
            const lines = combined.split('\n');
            return lines.length > MAX_LINES
              ? lines.slice(-MAX_LINES).join('\n')
              : combined;
          });
        }
      } else {
        setBuffer(text);
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

  // Auto-scroll to bottom when buffer changes
  useEffect(() => {
    if (autoTail && sentinelRef.current) {
      sentinelRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [buffer, autoTail]);

  const lineCount = buffer ? buffer.split('\n').length : 0;
  const fetchedTime = fetchedAt
    ? new Date(fetchedAt).toLocaleTimeString()
    : '—';

  return (
    <div
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
        onClick={e => e.stopPropagation()}
        style={{
          width: '860px',
          maxWidth: '95vw',
          height: '80vh',
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
            title={autoTail ? 'Pause auto-refresh' : 'Enable auto-refresh every 3s'}
          >
            {autoTail ? '[TAIL]' : '[PAUSED]'}
          </button>

          {/* Close */}
          <button onClick={onClose} style={dangerBtn}>
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
            <div style={{
              padding: '0.4rem 0.75rem',
              background: '#1a0000',
              color: 'var(--color-danger)',
              fontSize: '0.72rem',
              borderBottom: '1px solid #330000',
              flexShrink: 0,
            }}>
              {error}
            </div>
          )}
          {loading && !buffer && (
            <div style={{
              padding: '0.4rem 0.75rem',
              color: 'var(--color-muted)',
              fontSize: '0.72rem',
              flexShrink: 0,
            }}>
              // fetching...
            </div>
          )}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            background: '#050505',
            border: '1px solid #1a1a1a',
            margin: '0.5rem 0.75rem 0',
          }}>
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
            {loading && autoTail ? ' | refreshing...' : ''}
          </span>
          <button
            onClick={() => { setBuffer(''); sinceRef.current = Math.floor(Date.now() / 1000); }}
            style={{ ...dangerBtn, fontSize: '0.65rem', padding: '1px 6px' }}
          >
            [CLEAR]
          </button>
        </div>
      </div>
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
