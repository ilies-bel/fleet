import { useState, useEffect, useCallback, useRef } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { getFeatures, activateFeature } from './api.js';
import StatusBar from './components/StatusBar.jsx';
import FeatureList from './components/FeatureList.jsx';
import PreviewFrame from './components/PreviewFrame.jsx';
import LogPanel from './components/LogPanel.jsx';
import ResourceMonitor from './components/ResourceMonitor.jsx';

function NavBar() {
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
      <NavLink to="/features" style={linkStyle}>FEATURES</NavLink>
      <NavLink to="/monitor" style={linkStyle}>RESOURCES</NavLink>
    </div>
  );
}

function FeaturesPage() {
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
      await fetchFeatures();              // confirm against gateway (clears pending when matched)
    } catch (err) {
      pendingActivateRef.current = null;  // activation failed — let gateway truth resume
      console.error('Activate failed:', err);
      throw err;
    }
  }

const activeBranch = features.find(f => f.key === activePreview)?.branch ?? '';

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <FeatureList
        features={features}
        activePreview={activePreview}
        startingFeatures={startingFeatures}
        onActivate={handleActivate}
        onRemoved={handleRemoved}
onLogs={key => setLogFeature(key)}
      />
      <PreviewFrame
        activePreview={activePreview}
        branch={activeBranch}
        previewKey={previewKey}
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
  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: 'var(--color-bg)',
    }}>
      <StatusBar />
      <NavBar />

      <Routes>
        <Route path="/" element={<Navigate to="/features" replace />} />
        <Route path="/features" element={<FeaturesPage />} />
        <Route path="/monitor" element={<ResourceMonitor />} />
      </Routes>
    </div>
  );
}
