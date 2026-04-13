import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { getFeatures, activateFeature } from './api.js';
import StatusBar from './components/StatusBar.jsx';
import FeatureList from './components/FeatureList.jsx';
import PreviewFrame from './components/PreviewFrame.jsx';
import AddFeatureModal from './components/AddFeatureModal.jsx';
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
  const [showAddModal, setShowAddModal] = useState(false);
  const [logFeature, setLogFeature] = useState(null);
  const [startingFeatures, setStartingFeatures] = useState(new Set());

  const fetchFeatures = useCallback(async () => {
    try {
      const data = await getFeatures();
      setFeatures(data);
      setActivePreview(prev => {
        if (prev !== null) return prev;
        const gwActive = data.find(f => f.isActive);
        return gwActive ? gwActive.name : null;
      });
    } catch {
      // Gateway might be starting up — stay silent, keep polling
    }
  }, []);

  useEffect(() => {
    fetchFeatures();
    const poll = setInterval(fetchFeatures, 5000);
    return () => clearInterval(poll);
  }, [fetchFeatures]);

  function handleRemoved(name) {
    setFeatures(prev => prev.filter(f => f.name !== name));
    if (activePreview === name) setActivePreview(null);
  }

  async function handleActivate(name) {
    try {
      await activateFeature(name);
      setActivePreview(name);
      setPreviewKey(k => k + 1);
      await fetchFeatures();
    } catch (err) {
      console.error('Activate failed:', err);
      throw err;
    }
  }

  async function handleAdded(name) {
    setStartingFeatures(prev => new Set([...prev, name]));
    await fetchFeatures();
    setTimeout(() => {
      setStartingFeatures(prev => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }, 120_000);
  }

  const activeBranch = features.find(f => f.name === activePreview)?.branch ?? '';

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <FeatureList
        features={features}
        activePreview={activePreview}
        startingFeatures={startingFeatures}
        onActivate={handleActivate}
        onRemoved={handleRemoved}
        onAdd={() => setShowAddModal(true)}
        onLogs={name => setLogFeature(name)}
      />
      <PreviewFrame
        activePreview={activePreview}
        branch={activeBranch}
        previewKey={previewKey}
      />

      {showAddModal && (
        <AddFeatureModal
          onClose={() => setShowAddModal(false)}
          onAdded={handleAdded}
        />
      )}

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
