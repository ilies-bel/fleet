import { useRef, useEffect } from 'react';
import { formatWorktree, formatHost } from './featurePresentation.js';

export default function FeatureConfigModal({ feature, onClose }) {
  const closeRef = useRef(null);
  const displayName = feature.title || feature.name;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    function handler(e) {
      if (e.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

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
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#1a1a1a',
          border: '1px solid #333',
          padding: '1.5rem',
          minWidth: '320px',
          maxWidth: '480px',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '1rem',
        }}>
          <h2 style={{
            margin: 0,
            fontSize: '0.9rem',
            color: '#eee',
            fontFamily: 'var(--font-mono)',
          }}>
            {displayName}
          </h2>
          <button
            ref={closeRef}
            aria-label="Close"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#aaa',
              fontSize: '1rem',
              padding: '2px 6px',
              fontFamily: 'var(--font-mono)',
            }}
          >
            ×
          </button>
        </div>
        <dl style={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '0.4rem 1rem',
          fontSize: '0.68rem',
          color: '#ccc',
        }}>
          <dt style={{ color: '#888' }}>Branch</dt>
          <dd style={{ margin: 0 }}>{feature.branch}</dd>
          <dt style={{ color: '#888' }}>Worktree</dt>
          <dd style={{ margin: 0, wordBreak: 'break-all', fontFamily: 'var(--font-mono)' }}>{formatWorktree(feature.worktreePath)}</dd>
          <dt style={{ color: '#888' }}>Host</dt>
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
          <dt style={{ color: '#888' }}>Services</dt>
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
