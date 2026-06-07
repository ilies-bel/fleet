import { useRef, useState, useEffect } from 'react';
import DiffPane from './DiffPane.jsx';
import ReviewCaptureLayer from './ReviewCaptureLayer.jsx';
import EmptyState from './EmptyState.jsx';
import { Button } from './Button.jsx';
import { PROXY_ORIGIN } from '../lib/captureProtocol.js';

// Port 3000 is the transparent proxy — always the same URL regardless of which feature is active.
const PROXY_URL = 'http://localhost:3000/';

export default function PreviewFrame({ activePreview, branch, previewKey, title, isCapture, onToggleCapture, addNote, notes, hasFeatures = false }) {
  const iframeRef = useRef(null);
  const [viewMode, setViewMode] = useState('preview');

  // Sync capture state (and current route notes) into the iframe.
  // notes is sent so the picker can paint blue tint overlays for existing review notes.
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'mars.capture.activate', active: isCapture, notes: notes ?? [] },
      PROXY_URL
    );
  }, [isCapture, notes]);

  // Forward keyboard shortcut fired inside the iframe back into the toggle path.
  useEffect(() => {
    function onMessage(event) {
      if (event.origin !== PROXY_ORIGIN) return;
      if (!event.data || event.data.type !== 'mars.capture.keydown') return;
      onToggleCapture?.();
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onToggleCapture]);

  if (!activePreview) {
    // Two distinct first-run states. Before any `fleet add`, teach the one
    // command that makes a feature appear. Once features exist, point at the
    // [ACTIVATE] click that drives the aha moment: branch live on :3000.
    return hasFeatures ? (
      <EmptyState
        status="NO FEATURE ACTIVE"
        statusColor="var(--color-warning)"
        lead="Activate a feature from the list to load it here. The branch runs live behind localhost:3000, so you review it without checking it out or restarting a server."
        hint="Click [ACTIVATE] on a card, or press ⌘1–9 to switch by position. Only one feature holds the preview port at a time."
      />
    ) : (
      <EmptyState
        status="0 FEATURES REGISTERED"
        statusColor="var(--color-accent)"
        lead="Fleet keeps every feature branch alive behind one preview port. Register a branch and it shows up in the list on the left. Click it and review it here: no checkout, no rebuild."
        command="fleet add <name> <branch>"
        hint="Run that in your project, then watch the feature appear in the list. Build progress: docker logs -f fleet-<name>."
      />
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      {/* Toolbar */}
      <div style={{
        height: '40px',
        background: '#0d0d0d',
        borderBottom: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 var(--space-3)',
        gap: 'var(--space-2)',
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
            <Button
              tone="primary"
              aria-pressed={isCapture}
              onClick={onToggleCapture}
              style={isCapture
                ? { ...toolbarBtn, background: 'var(--color-accent)', color: 'var(--color-bg-black)', borderColor: 'var(--color-accent)' }
                : toolbarBtn
              }
            >
              [CAPTURE]
            </Button>
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

      {/* Inline note input — appears when the operator picks an element in capture mode */}
      <ReviewCaptureLayer activeWorktree={activePreview} addNote={addNote} />
    </div>
  );
}

const toolbarBtn = {
  background: 'transparent',
  border: '1px solid var(--color-border-strong)',
  color: 'var(--color-ink-dim)',
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

