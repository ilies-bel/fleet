import { useState, useEffect } from 'react';
import { fetchFailureClusters } from '../api.js';
import { headlineFor } from './failureHeadlines.js';

/**
 * Renders one card per failure reason_code cluster, ordered by count DESC.
 * Polls GET /operations/failures/clustered every 5 s.
 */
export default function FailureClusters() {
  const [clusters, setClusters] = useState([]);

  useEffect(() => {
    function load() {
      fetchFailureClusters()
        .then(setClusters)
        .catch(() => {/* gateway may be starting — stay silent */});
    }
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  if (clusters.length === 0) {
    return (
      <div style={{
        flex: 1,
        padding: 'var(--space-6) var(--space-4)',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.75rem',
        color: '#555',
        textAlign: 'center',
      }}>
        no failure clusters
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {clusters.map(cluster => (
        <div key={cluster.reasonCode} className="cluster-card" style={{
          background: '#111',
          border: '1px solid #2a2a2a',
          borderRadius: '4px',
          padding: 'var(--space-3) var(--space-4)',
          fontFamily: 'var(--font-mono)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-15)', flexWrap: 'wrap' }}>
            <span style={reasonBadgeStyle(cluster.reasonCode)}>{cluster.reasonCode}</span>
            <span style={{ color: 'var(--color-text)', fontSize: '0.8rem' }}>
              {cluster.count} {kindGuess(cluster.reasonCode)} failed: {headlineFor(cluster.reasonCode)}
            </span>
          </div>
          <div style={{ color: 'var(--color-muted)', fontSize: '0.65rem', marginBottom: cluster.sampleKeys.length ? 'var(--space-15)' : 0 }}>
            last seen {cluster.lastSeenAt ? new Date(cluster.lastSeenAt).toISOString() : '—'}
          </div>
          {cluster.sampleKeys.length > 0 && (
            <ul style={{ margin: 0, padding: '0 0 0 var(--space-4)', fontSize: '0.7rem', color: '#888' }}>
              {cluster.sampleKeys.slice(0, 5).map(k => <li key={k}>{k}</li>)}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

const REASON_PREFIX_COLORS = { docker: '#ff9800', build: '#f44336', registry: '#9c27b0', sync: '#2196f3' };

function reasonBadgeStyle(reasonCode) {
  const prefix = reasonCode?.split(':')[0];
  return {
    display: 'inline-block',
    padding: '0.1rem var(--space-15)', /* off-scale: 0.1rem vertical micro-gap */
    borderRadius: '3px',
    fontSize: '0.65rem',
    fontWeight: '600',
    background: REASON_PREFIX_COLORS[prefix] ?? '#555',
    color: '#fff',
    letterSpacing: '0.03em',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  };
}

function kindGuess(reasonCode) {
  const prefix = reasonCode?.split(':')[0];
  const MAP = { docker: 'docker', build: 'build', registry: 'registry', sync: 'sync' };
  return MAP[prefix] ?? 'operation';
}
