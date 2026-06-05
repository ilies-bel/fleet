import { useRef, useEffect } from 'react';
import { formatWorktree } from './featurePresentation.js';

export default function FeatureConfigModal({ feature, onClose }) {
  const closeRef = useRef(null);
  const displayName = feature.title || feature.name;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${displayName} configuration`}
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
        </dl>
      </div>
    </div>
  );
}
