import { useRef } from 'react';

// Port 3000 is the transparent proxy — always the same URL regardless of which feature is active.
const PROXY_URL = 'http://localhost:3000/';

export default function PreviewFrame({ activePreview, branch, previewKey }) {
  const iframeRef = useRef(null);

  if (!activePreview) {
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-bg)',
        fontFamily: 'var(--font-mono)',
        color: '#333',
        fontSize: '1.1rem',
        letterSpacing: '0.05em',
      }}>
        // ACTIVATE A FEATURE TO PREVIEW
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{
        height: '40px',
        background: '#0d0d0d',
        borderBottom: '1px solid #222',
        display: 'flex',
        alignItems: 'center',
        padding: '0 0.75rem',
        gap: '1rem',
        flexShrink: 0,
      }}>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.75rem',
          color: 'var(--color-accent)',
          flex: 1,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {activePreview} // {branch}
        </span>
        <button
          onClick={() => window.open(PROXY_URL, '_blank')}
          style={toolbarBtn}
        >
          [↗ OPEN IN TAB]
        </button>
        <button
          onClick={() => { if (iframeRef.current) iframeRef.current.src = PROXY_URL; }}
          style={toolbarBtn}
        >
          [↺ REFRESH]
        </button>
      </div>

      {/* Preview iframe — key prop forces remount (full reload) when active feature changes */}
      <iframe
        key={previewKey}
        ref={iframeRef}
        src={PROXY_URL}
        style={{
          flex: 1,
          border: 'none',
          width: '100%',
          background: '#fff',
        }}
        title={`Preview: ${activePreview}`}
      />
    </div>
  );
}

const toolbarBtn = {
  background: 'transparent',
  border: '1px solid #333',
  color: '#888',
  fontFamily: 'var(--font-mono)',
  fontSize: '0.7rem',
  padding: '2px 8px',
  cursor: 'pointer',
  borderRadius: 0,
  whiteSpace: 'nowrap',
};
