import { useState, useEffect, useCallback } from 'react';
import { addFeature } from '../api.js';

const NAME_RE = /^[a-z0-9]([a-z0-9-]*(\.[a-z0-9-]+)*)?$/;

export default function AddFeatureModal({ onClose, onAdded }) {
  const [name, setName] = useState('');
  const [branch, setBranch] = useState('');
  const [nameError, setNameError] = useState('');
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState('');

  const handleEscape = useCallback((e) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [handleEscape]);

  function handleNameChange(e) {
    const val = e.target.value;
    setName(val);
    if (val && !NAME_RE.test(val)) {
      setNameError('Lowercase alphanumerics, dots, and hyphens; no leading, trailing, or consecutive dots');
    } else {
      setNameError('');
    }
  }

  async function handleSubmit() {
    if (!name || !branch || nameError) return;
    setLoading(true);
    setApiError('');
    try {
      await addFeature(name, branch);
      onAdded(name);
      onClose();
    } catch (err) {
      setApiError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const inputStyle = {
    background: '#0a0a0a',
    border: '1px solid #333',
    color: '#eee',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.85rem',
    padding: '0.4rem 0.6rem',
    width: '100%',
    boxSizing: 'border-box',
    borderRadius: 0,
    outline: 'none',
    marginTop: '0.25rem',
  };

  const labelStyle = {
    display: 'block',
    color: 'var(--color-muted)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.7rem',
    marginBottom: '0.75rem',
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#111',
          border: '1px solid #333',
          padding: '1.5rem',
          width: '360px',
          fontFamily: 'var(--font-mono)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ color: 'var(--color-accent)', fontSize: '0.85rem', marginBottom: '1.25rem', fontWeight: 700 }}>
          // SPIN UP FEATURE
        </div>

        <label style={labelStyle}>
          FEATURE NAME
          <input
            style={{ ...inputStyle, borderColor: nameError ? 'var(--color-danger)' : '#333' }}
            value={name}
            onChange={handleNameChange}
            placeholder="my-feature"
            autoFocus
          />
          {nameError && (
            <span style={{ color: 'var(--color-danger)', fontSize: '0.65rem', marginTop: '0.2rem', display: 'block' }}>
              {nameError}
            </span>
          )}
        </label>

        <label style={labelStyle}>
          BRANCH
          <input
            style={inputStyle}
            value={branch}
            onChange={e => setBranch(e.target.value)}
            placeholder="feature/my-branch"
          />
        </label>

        <button
          onClick={handleSubmit}
          disabled={loading || !name || !branch || !!nameError}
          style={{
            width: '100%',
            background: loading ? '#1a2e1a' : 'var(--color-accent)',
            color: '#000',
            border: 'none',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.85rem',
            fontWeight: 700,
            padding: '0.5rem',
            cursor: loading ? 'not-allowed' : 'pointer',
            borderRadius: 0,
            marginTop: '0.5rem',
            opacity: (!name || !branch || !!nameError) ? 0.5 : 1,
          }}
        >
          {loading ? '...' : '[SPIN UP]'}
        </button>

        {apiError && (
          <div style={{ color: 'var(--color-danger)', fontSize: '0.75rem', marginTop: '0.5rem' }}>
            {apiError}
          </div>
        )}
      </div>
    </div>
  );
}
