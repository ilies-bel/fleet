import { useState, useEffect } from 'react';
import { fetchOperations } from '../api.js';
import { relativeTime, absoluteTime } from '../lib/formatTime.js';

/**
 * Renders a table of recent gateway operations (activate events etc.)
 * polled from GET /_fleet/api/operations every 5 s.
 *
 * @param {{ onSelect?: (id: number) => void }} props
 *   onSelect — called with the operation id when a row is clicked.
 */
export default function OperationsList({ onSelect }) {
  const [operations, setOperations] = useState([]);

  useEffect(() => {
    function load() {
      fetchOperations()
        .then(setOperations)
        .catch(() => {/* gateway may be starting — stay silent */});
    }
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4)' }}>
      <table style={{
        width: '100%',
        maxWidth: '1100px',
        borderCollapse: 'collapse',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.75rem',
        color: 'var(--color-text)',
      }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #333' }}>
            <th style={thStyle}>Kind</th>
            <th style={thStyle}>Key</th>
            <th style={thStyle}>Started</th>
            <th style={thStyle}>Ended</th>
            <th style={thStyle}>Outcome</th>
            <th style={thStyle}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {operations.map(op => (
            <tr
              key={op.id}
              role={onSelect ? 'button' : undefined}
              tabIndex={onSelect ? 0 : undefined}
              onClick={onSelect ? () => onSelect(op.id) : undefined}
              onKeyDown={onSelect ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(op.id);
                }
              } : undefined}
              style={{
                borderBottom: '1px solid #1a1a1a',
                cursor: onSelect ? 'pointer' : 'default',
              }}
            >
              <td style={tdStyle}>{op.kind}</td>
              <td style={tdStyle}>{op.key}</td>
              <td style={tdStyle}>
                <span title={absoluteTime(op.startedAt)}>{relativeTime(op.startedAt)}</span>
              </td>
              <td style={tdStyle}>
                <span title={absoluteTime(op.endedAt)}>{relativeTime(op.endedAt)}</span>
              </td>
              <td style={{ ...tdStyle, color: outcomeColor(op.outcome) }}>{op.outcome ?? '…'}</td>
              <td style={tdStyle}>
                {op.outcome === 'failure' && op.reasonCode
                  ? <span className={`badge badge-${op.reasonCode.split(':')[0]}`} style={reasonBadgeStyle(op.reasonCode)}>{op.reasonCode}</span>
                  : null}
              </td>
            </tr>
          ))}
          {operations.length === 0 && (
            <tr>
              <td colSpan={6} style={{ ...tdStyle, color: 'var(--color-muted)', textAlign: 'center', padding: 'var(--space-6) 0' }}>
                no operations recorded
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const thStyle = {
  textAlign: 'left',
  padding: 'var(--space-15) var(--space-2)',
  color: 'var(--color-muted)',
  letterSpacing: '0.06em',
  fontSize: '0.65rem',
  fontWeight: 'normal',
};

const tdStyle = {
  padding: '0.35rem var(--space-2)', /* off-scale: 0.35rem vertical has no exact token */
  verticalAlign: 'middle',
};

function outcomeColor(outcome) {
  if (outcome === 'success') return '#00ff88';
  if (outcome === 'failure') return '#ff4444';
  return 'var(--color-muted)';
}

const REASON_PREFIX_COLORS = { docker: '#ffaa00', build: '#ff4444', registry: '#ffaa00', sync: '#00aaff' };

function reasonBadgeStyle(reasonCode) {
  const prefix = reasonCode?.split(':')[0];
  return {
    display: 'inline-block',
    padding: '0.1rem var(--space-15)', /* off-scale: 0.1rem vertical micro-gap */
    fontSize: '0.65rem',
    fontWeight: '600',
    background: '#222',
    color: REASON_PREFIX_COLORS[prefix] ?? 'var(--color-muted)',
    letterSpacing: '0.03em',
    whiteSpace: 'nowrap',
  };
}
