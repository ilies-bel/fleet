// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { useState, useEffect, useRef } from 'react';

/**
 * BuildLogPanel — collapsible terminal-style panel that streams docker build
 * output for a feature while it is in the building / starting / failed state.
 *
 * The panel opens an SSE connection to GET /_fleet/api/features/:name/build-log.
 * On mount the server replays buffered lines so a page refresh mid-build works.
 * Auto-collapses when status transitions to 'running'.
 */
export default function BuildLogPanel({ featureName, status }) {
  const [lines, setLines] = useState([]);
  const [collapsed, setCollapsed] = useState(false);
  const containerRef = useRef(null);
  const autoScroll = useRef(true);

  const isActive = status === 'building' || status === 'starting' || status === 'failed';

  // Open SSE connection while the feature is in an active build state.
  useEffect(() => {
    if (!isActive) return;

    const es = new EventSource(`/_fleet/api/features/${featureName}/build-log`);

    es.onmessage = (event) => {
      setLines(prev => {
        const next = [...prev, event.data];
        return next.length > 500 ? next.slice(-500) : next;
      });
    };

    es.onerror = () => {
      // SSE reconnects automatically on error; no explicit action needed.
    };

    return () => es.close();
  }, [featureName, status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to bottom whenever new lines arrive (if user hasn't scrolled up).
  useEffect(() => {
    if (autoScroll.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines]);

  // Auto-collapse when status transitions to 'running' (build succeeded).
  useEffect(() => {
    if (status === 'running') setCollapsed(true);
  }, [status]);

  // Don't render when there is nothing to show.
  if (lines.length === 0 && !isActive) return null;
  if (lines.length === 0 && status === 'building') {
    // Show an empty panel with a waiting message while no lines have arrived yet.
  }

  function handleScroll() {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    autoScroll.current = scrollTop + clientHeight >= scrollHeight - 4;
  }

  const btnStyle = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.62rem',
    padding: '1px 6px',
    cursor: 'pointer',
    borderRadius: 0,
    background: 'transparent',
    border: '1px solid #555',
    color: '#888',
    marginBottom: '0.25rem',
  };

  return (
    <div style={{ marginBottom: '0.5rem' }}>
      <button
        style={btnStyle}
        onClick={() => setCollapsed(c => !c)}
        title={collapsed ? 'Expand build log' : 'Collapse build log'}
      >
        {collapsed
          ? status === 'failed'
            ? '[SHOW LOG — build failed]'
            : '[SHOW LOG]'
          : '[HIDE LOG]'}
      </button>
      {!collapsed && (
        <div
          ref={containerRef}
          onScroll={handleScroll}
          style={{
            background: '#0d0d0d',
            color: '#33ff33',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.62rem',
            maxHeight: '300px',
            overflowY: 'auto',
            padding: '0.4rem 0.5rem',
            border: '1px solid #222',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {lines.length === 0
            ? <span style={{ color: '#555' }}>Waiting for build output...</span>
            : lines.map((line, i) => (
              <div key={i}>{line}</div>
            ))
          }
        </div>
      )}
    </div>
  );
}
