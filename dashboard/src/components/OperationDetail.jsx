import { useState, useEffect } from 'react';
import { fetchOperation } from '../api.js';

/**
 * Renders a detail view for a single gateway operation, fetched by id.
 * Prominently surfaces the reasonCode when the operation failed.
 *
 * @param {{ operationId: number | null }} props
 */
export default function OperationDetail({ operationId }) {
  const [op, setOp] = useState(null);

  useEffect(() => {
    if (!operationId) { setOp(null); return; }
    fetchOperation(operationId)
      .then(setOp)
      .catch(() => {/* gateway may be starting */});
  }, [operationId]);

  if (!op) return null;

  return (
    <div style={{
      padding: '1rem',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.8rem',
      color: 'var(--color-text)',
    }}>
      <div style={{ marginBottom: '0.75rem', color: 'var(--color-muted)', fontSize: '0.65rem', letterSpacing: '0.06em' }}>
        OPERATION #{op.id}
      </div>

      {/* Prominently show reasonCode when the operation failed */}
      {op.outcome === 'failure' && op.reasonCode && (
        <div style={{ marginBottom: '1rem' }}>
          <span
            className={`badge badge-${op.reasonCode.split(':')[0]}`}
            style={reasonBadgeStyle(op.reasonCode)}
          >
            {op.reasonCode}
          </span>
        </div>
      )}

      <dl style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '0.4rem 1rem', margin: 0 }}>
        <dt style={dtStyle}>Kind</dt>
        <dd style={ddStyle}>{op.kind}</dd>

        <dt style={dtStyle}>Key</dt>
        <dd style={ddStyle}>{op.key}</dd>

        <dt style={dtStyle}>Outcome</dt>
        <dd style={{ ...ddStyle, color: outcomeColor(op.outcome) }}>{op.outcome ?? '…'}</dd>

        {op.reasonCode && (
          <>
            <dt style={dtStyle}>Reason</dt>
            <dd style={ddStyle}>
              <span
                className={`badge badge-${op.reasonCode.split(':')[0]}`}
                style={reasonBadgeStyle(op.reasonCode)}
              >
                {op.reasonCode}
              </span>
            </dd>
          </>
        )}

        <dt style={dtStyle}>Started</dt>
        <dd style={ddStyle}>{op.startedAt ? new Date(op.startedAt).toISOString() : '—'}</dd>

        <dt style={dtStyle}>Ended</dt>
        <dd style={ddStyle}>{op.endedAt ? new Date(op.endedAt).toISOString() : '—'}</dd>

        {op.errorMessage && (
          <>
            <dt style={dtStyle}>Error</dt>
            <dd style={{ ...ddStyle, color: '#f44336' }}>{op.errorMessage}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

const dtStyle = {
  color: 'var(--color-muted)',
  fontSize: '0.65rem',
  letterSpacing: '0.06em',
  paddingTop: '0.1rem',
  margin: 0,
};

const ddStyle = {
  margin: 0,
};

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

function outcomeColor(outcome) {
  if (outcome === 'success') return '#4caf50';
  if (outcome === 'failure') return '#f44336';
  return 'var(--color-muted)';
}
