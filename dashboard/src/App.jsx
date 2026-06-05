import { useState, useEffect, useCallback, useRef } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { getFeatures, activateFeature } from './api.js';
import StatusBar from './components/StatusBar.jsx';
import FeatureList from './components/FeatureList.jsx';
import PreviewFrame from './components/PreviewFrame.jsx';
import LogPanel from './components/LogPanel.jsx';
import ResourceMonitor from './components/ResourceMonitor.jsx';
import OperationsList from './components/OperationsList.jsx';

function NavBar({ onDrawerToggle, isNarrow }) {
  const linkStyle = ({ isActive }) => ({
    fontFamily: 'var(--font-mono)',
    fontSize: '0.72rem',
    letterSpacing: '0.06em',
    padding: '0 1rem',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    textDecoration: 'none',
    borderBottom: isActive ? '2px solid var(--color-accent)' : '2px solid transparent',
    color: isActive ? 'var(--color-accent)' : 'var(--color-muted)',
    transition: 'color 0.1s',
  });

  return (
    <div style={{
      height: '34px',
      background: '#000',
      borderBottom: '1px solid #222',
      display: 'flex',
      alignItems: 'stretch',
      flexShrink: 0,
    }}>
      {isNarrow && (
        <button
          onClick={onDrawerToggle}
          aria-label="Toggle feature drawer"
          style={{
            background: 'none',
            border: 'none',
            borderRight: '1px solid #222',
            cursor: 'pointer',
            padding: '0 0.75rem',
            color: 'var(--color-muted)',
            fontFamily: 'var(--font-mono)',
            fontSize: '1.1rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = ''; }}
        >
          ☰
        </button>
      )}
      <NavLink to="/features" style={linkStyle}>FEATURES</NavLink>
      <NavLink to="/monitor" style={linkStyle}>RESOURCES</NavLink>
      <NavLink to="/operations" style={linkStyle}>OPERATIONS</NavLink>
    </div>
  );
}

function FeaturesPage({ drawerOpen, onDrawerClose }) {
  const [features, setFeatures] = useState([]);
  const [activePreview, setActivePreview] = useState(null);
  const [previewKey, setPreviewKey] = useState(0);
const [logFeature, setLogFeature] = useState(null);
  const [startingFeatures, setStartingFeatures] = useState(new Set());

  // Key the user just clicked [ACTIVATE] on; suppresses poll-driven
  // reconciliation until the gateway confirms this is the active feature.
  const pendingActivateRef = useRef(null);

  const fetchFeatures = useCallback(async () => {
    try {
      const data = await getFeatures();
      setFeatures(data);

      // The gateway is the single source of truth for which feature is active.
      const gwActive = data.find(f => f.isActive)?.key ?? null;
      const pending = pendingActivateRef.current;

      if (pending !== null) {
        // Gateway has confirmed our just-clicked activation — stop overriding.
        if (gwActive === pending) pendingActivateRef.current = null;
        // While unconfirmed, keep the optimistic selection so a racing poll
        // can't snap us back to the previously active feature.
        else return;
      }

      setActivePreview(gwActive);
    } catch {
      // Gateway might be starting up — stay silent, keep polling
    }
  }, []);

  useEffect(() => {
    fetchFeatures();
    const poll = setInterval(fetchFeatures, 5000);
    return () => clearInterval(poll);
  }, [fetchFeatures]);

  useEffect(() => {
    function onKey(e) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const n = e.key >= '1' && e.key <= '9' ? Number(e.key) : 0;
      if (!n) return;
      const target = features[n - 1];
      if (!target) return;
      e.preventDefault();
      handleActivate(target.key);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [features]);

  function handleRemoved(key) {
    if (pendingActivateRef.current === key) pendingActivateRef.current = null;
    setFeatures(prev => prev.filter(f => f.key !== key));
    if (activePreview === key) setActivePreview(null);
  }

  async function handleActivate(key) {
    try {
      pendingActivateRef.current = key;   // protect this selection from racing polls
      await activateFeature(key);
      setActivePreview(key);              // instant, optimistic highlight
      setPreviewKey(k => k + 1);          // force iframe reload
      onDrawerClose();                    // close the off-canvas drawer (no-op on wide viewports)
      await fetchFeatures();              // confirm against gateway (clears pending when matched)
    } catch (err) {
      pendingActivateRef.current = null;  // activation failed — let gateway truth resume
      console.error('Activate failed:', err);
      throw err;
    }
  }

const activeFeature = features.find(f => f.key === activePreview);
const activeBranch = activeFeature?.branch ?? '';
const activeTitle = activeFeature?.title || activeFeature?.name || '';

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <aside
        className="feature-drawer"
        data-open={String(drawerOpen)}
        aria-label="Feature list drawer"
      >
        <FeatureList
          features={features}
          activePreview={activePreview}
          startingFeatures={startingFeatures}
          onActivate={handleActivate}
          onRemoved={handleRemoved}
          onLogs={key => setLogFeature(key)}
        />
      </aside>
      <PreviewFrame
        activePreview={activePreview}
        branch={activeBranch}
        previewKey={previewKey}
        title={activeTitle}
      />

      {logFeature && (
        <LogPanel
          featureName={logFeature}
          onClose={() => setLogFeature(null)}
        />
      )}
    </div>
  );
}

export default function App() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(max-width: 767px)').matches
  );

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (e) => {
      setIsNarrow(e.matches);
      if (!e.matches) setDrawerOpen(false);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: 'var(--color-bg)',
    }}>
      <StatusBar />
      <NavBar
        onDrawerToggle={() => setDrawerOpen(o => !o)}
        isNarrow={isNarrow}
      />

      <Routes>
        <Route path="/" element={<Navigate to="/features" replace />} />
        <Route path="/features" element={
          <FeaturesPage
            drawerOpen={drawerOpen}
            onDrawerClose={() => setDrawerOpen(false)}
          />
        } />
        <Route path="/monitor" element={<ResourceMonitor />} />
        <Route path="/operations" element={<OperationsList />} />
      </Routes>
    </div>
  );
}
