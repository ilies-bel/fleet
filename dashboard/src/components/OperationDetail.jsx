import { useState, useEffect } from 'react';
import { fetchOperation } from '../api.js';

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
      <button
        onClick={onBack}
        style={{
          background: 'none',
          border: '1px solid #333',
          color: 'var(--color-muted)',
          cursor: 'pointer',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.72rem',
          padding: 'var(--space-1) var(--space-2)',
          marginBottom: 'var(--space-4)',
        }}
      >
        ← Back
      </button>

      {error && (
        <div style={{ color: '#f44336', marginBottom: 'var(--space-4)' }}>
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
                Started: {data.operation.startedAt ? new Date(data.operation.startedAt).toISOString() : '—'}
              </span>
              <span style={{ marginRight: 'var(--space-6)' }}>
                Ended: {data.operation.endedAt ? new Date(data.operation.endedAt).toISOString() : '—'}
              </span>
              <span style={{ color: outcomeColor(data.operation.outcome) }}>
                {data.operation.outcome ?? '…'}
              </span>
            </div>
            {data.operation.errorMessage && (
              <div style={{ color: '#f44336', marginTop: '0.3rem' /* off-scale: 0.3rem has no exact token */ }}>
                {data.operation.errorMessage}
              </div>
            )}
          </div>

          {data.events.length === 0 ? (
            <div style={{ color: '#555' }}>No events recorded for this operation.</div>
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
                  <span style={{ color: '#555', flexShrink: 0, minWidth: '5rem' }}>
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

function outcomeColor(outcome) {
  if (outcome === 'success') return '#4caf50';
  if (outcome === 'failure') return '#f44336';
  return 'var(--color-muted)';
}

function levelColor(level) {
  if (level === 'warn') return '#ff9800';
  if (level === 'error') return '#f44336';
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

const REASON_PREFIX_COLORS = { docker: '#ff9800', build: '#f44336', registry: '#9c27b0', sync: '#2196f3' };

function reasonBadgeStyle(reasonCode) {
  const prefix = reasonCode?.split(':')[0];
  return {
    display: 'inline-block',
    padding: '0.2rem 0.6rem',
    borderRadius: '3px',
    fontSize: '0.7rem',
    fontWeight: '700',
    background: REASON_PREFIX_COLORS[prefix] ?? '#555',
    color: '#fff',
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
  };
}
