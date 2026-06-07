import { useState, useEffect } from 'react';
import { fetchOperation } from '../api.js';
import { Button } from './Button.jsx';

/**
 * Renders the header and full event timeline for a single operation.
 * Prominently surfaces the reasonCode when the operation failed.
 *
 * @param {{ id: number, onBack: () => void }} props
 */
export default function OperationDetail({ id, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    setError(null);
    fetchOperation(id)
      .then(setData)
      .catch(err => setError(err.message));
  }, [id]);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--color-text)' }}>
      <Button
        tone="primary"
        onClick={onBack}
        style={{ marginBottom: 'var(--space-4)', fontSize: '0.72rem', padding: 'var(--space-1) var(--space-2)' }}
      >
        [← BACK]
      </Button>

      {error && (
        <div style={{ color: '#ff4444', marginBottom: 'var(--space-4)' }}>
          Error: {error}
        </div>
      )}

      {!data && !error && (
        <div style={{ color: 'var(--color-muted)' }}>Loading…</div>
      )}

      {data && (
        <>
          <div style={{ marginBottom: '1.25rem', /* off-scale: 1.25rem between var(--space-4) and var(--space-6) */ borderBottom: '1px solid #222', paddingBottom: 'var(--space-3)' }}>
            <div style={{ color: 'var(--color-accent)', fontWeight: 'bold', marginBottom: 'var(--space-15)' }}>
              {data.operation.kind} — {data.operation.key}
            </div>

            {/* Prominently show reasonCode when the operation failed */}
            {data.operation.outcome === 'failure' && data.operation.reasonCode && (
              <div style={{ marginBottom: 'var(--space-2)' }}>
                <span
                  className={`badge badge-${data.operation.reasonCode.split(':')[0]}`}
                  style={reasonBadgeStyle(data.operation.reasonCode)}
                >
                  {data.operation.reasonCode}
                </span>
              </div>
            )}

            <div style={{ color: 'var(--color-muted)', marginBottom: 'var(--space-05)' }}>
              <span style={{ marginRight: 'var(--space-6)' }}>
                Started: {fmtTime(data.operation.startedAt)}
              </span>
              <span style={{ marginRight: 'var(--space-6)' }}>
                Ended: {fmtTime(data.operation.endedAt)}
              </span>
              <span style={{ color: outcomeColor(data.operation.outcome) }}>
                {data.operation.outcome ?? '…'}
              </span>
            </div>
            {data.operation.errorMessage && (
              <div style={{ color: '#ff4444', marginTop: '0.3rem' /* off-scale: 0.3rem has no exact token */ }}>
                {data.operation.errorMessage}
              </div>
            )}
          </div>

          {data.events.length === 0 ? (
            <div style={{ color: 'var(--color-muted)' }}>No events recorded for this operation.</div>
          ) : (
            <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {data.events.map(event => (
                <li
                  key={event.id}
                  style={{
                    display: 'flex',
                    gap: 'var(--space-4)',
                    padding: '0.35rem 0', /* off-scale: 0.35rem vertical has no exact token */
                    borderBottom: '1px solid #111',
                    alignItems: 'baseline',
                  }}
                >
                  <span style={{ color: 'var(--color-muted)', flexShrink: 0, minWidth: '5rem' }}>
                    +{relativeMs(data.operation.startedAt, event.ts)}
                  </span>
                  <span style={{ color: levelColor(event.level), flexShrink: 0, minWidth: '3rem' }}>
                    {event.level ?? 'info'}
                  </span>
                  <span>{event.message}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function outcomeColor(outcome) {
  if (outcome === 'success') return '#00ff88';
  if (outcome === 'failure') return '#ff4444';
  return 'var(--color-muted)';
}

function levelColor(level) {
  if (level === 'warn') return '#ffaa00';
  if (level === 'error') return '#ff4444';
  return 'var(--color-muted)';
}

/**
 * Format the offset from operationStart to eventTs as a human-readable string.
 * @param {number|null} operationStart
 * @param {number} eventTs
 * @returns {string}
 */
function relativeMs(operationStart, eventTs) {
  if (!operationStart) return `${eventTs}ms`;
  const delta = eventTs - operationStart;
  if (delta < 1000) return `${delta}ms`;
  return `${(delta / 1000).toFixed(1)}s`;
}

const REASON_PREFIX_COLORS = { docker: '#ffaa00', build: '#ff4444', registry: '#ffaa00', sync: '#00aaff' };

function reasonBadgeStyle(reasonCode) {
  const prefix = reasonCode?.split(':')[0];
  return {
    display: 'inline-block',
    padding: '0.2rem 0.6rem',
    fontSize: '0.7rem',
    fontWeight: '700',
    background: '#222',
    color: REASON_PREFIX_COLORS[prefix] ?? 'var(--color-muted)',
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
  };
}
