import { useRef, useEffect, useCallback } from 'react';
import { formatWorktree, formatHost } from './featurePresentation.js';

export default function FeatureConfigModal({ feature, onClose }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const displayName = feature.title || feature.name;

  // Focus the close button on mount.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Escape closes the modal (global listener so it fires regardless of focus position).
  useEffect(() => {
    function handler(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Tab traps focus within the inner panel (matches ConfirmModal / LogPanel pattern).
  const handleKeyDown = useCallback((e) => {
    if (e.key !== 'Tab') return;

    const panel = dialogRef.current;
    if (!panel) return;

    const focusable = Array.from(
      panel.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select, textarea',
      ),
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (e.shiftKey) {
      if (active === first || active === panel) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${displayName} configuration`}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.6)',
        zIndex: 1000,
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        style={{
          background: 'var(--color-surface-header)',
          border: '1px solid var(--color-border-strong)',
          padding: 'var(--space-6)',
          minWidth: '320px',
          maxWidth: '480px',
          fontFamily: 'var(--font-mono)',
          outline: 'none',
        }}
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'var(--space-4)',
        }}>
          <h2 style={{
            margin: 0,
            fontSize: '0.9rem',
            color: 'var(--color-ink)',
            fontFamily: 'var(--font-mono)',
          }}>
            {displayName}
          </h2>
          <button
            ref={closeRef}
            className="btn btn-primary"
            aria-label="Close"
            onClick={onClose}
            style={{ fontSize: '0.75rem', padding: '2px 8px' }}
          >
            [CLOSE]
          </button>
        </div>
        <dl style={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: 'var(--space-15) var(--space-4)',
          fontSize: '0.68rem',
          color: '#ccc',
        }}>
          <dt style={{ color: 'var(--color-ink-dim)' }}>Branch</dt>
          <dd style={{ margin: 0 }}>{feature.branch}</dd>
          <dt style={{ color: 'var(--color-ink-dim)' }}>Worktree</dt>
          <dd style={{ margin: 0, wordBreak: 'break-all', fontFamily: 'var(--font-mono)' }}>{formatWorktree(feature.worktreePath)}</dd>
          <dt style={{ color: 'var(--color-ink-dim)' }}>Host</dt>
          {(() => {
            const h = formatHost(feature.host);
            if (h.kind === 'local') {
              return <dd style={{ margin: 0 }}>local docker</dd>;
            }
            return (
              <dd style={{ margin: 0 }}>
                <div>cluster: {h.cluster}</div>
                <div>namespace: {h.namespace}</div>
              </dd>
            );
          })()}
          <dt style={{ color: 'var(--color-ink-dim)' }}>Services</dt>
          <dd style={{ margin: 0 }}>
            {(() => {
              const services = Array.isArray(feature.services) ? feature.services : [];
              return services.length === 0
                ? <span>no services</span>
                : <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontFamily: 'var(--font-mono)' }}>
                    {services.map(s => <li key={s.name}>{s.name} → {s.port}</li>)}
                  </ul>;
            })()}
          </dd>
        </dl>
      </div>
    </div>
  );
}
