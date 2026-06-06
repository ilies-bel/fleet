import { useRef, useState } from 'react';
import DiffPane from './DiffPane.jsx';

// Port 3000 is the transparent proxy — always the same URL regardless of which feature is active.
const PROXY_URL = 'http://localhost:3000/';

export default function PreviewFrame({ activePreview, branch, previewKey, title }) {
  const iframeRef = useRef(null);
  const [viewMode, setViewMode] = useState('preview');

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
        gap: '0.5rem',
        flexShrink: 0,
      }}>
        {/* View-mode tabs — left-aligned */}
        <button
          onClick={() => setViewMode('preview')}
          style={viewMode === 'preview' ? activeTabBtn : toolbarBtn}
        >
          [PREVIEW]
        </button>
        <button
          onClick={() => setViewMode('diff')}
          style={viewMode === 'diff' ? activeTabBtn : toolbarBtn}
        >
          [DIFF]
        </button>

        {/* Feature title — expands to fill available space */}
        <span
          title={`${activePreview} // ${branch}`}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.75rem',
            color: 'var(--color-accent)',
            flex: 1,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title || activePreview}
        </span>

        {/* Preview-only controls — hidden while in DIFF view */}
        {viewMode === 'preview' && (
          <>
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
          </>
        )}
      </div>

      {/* Preview iframe — always mounted; hidden in diff mode so state is preserved */}
      <iframe
        key={previewKey}
        ref={iframeRef}
        src={PROXY_URL}
        style={{
          flex: 1,
          border: 'none',
          width: '100%',
          background: '#fff',
          display: viewMode === 'preview' ? 'flex' : 'none',
        }}
        title={`Preview: ${activePreview}`}
      />

      {/* Diff pane — only mounted when diff mode is active */}
      {viewMode === 'diff' && <DiffPane activeKey={activePreview} />}
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

const activeTabBtn = {
  ...toolbarBtn,
  borderColor: 'var(--color-accent)',
  color: 'var(--color-accent)',
};
