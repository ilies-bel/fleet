import { useState } from 'react';
import FeatureCard from './FeatureCard.jsx';

/**
 * Group features by project. Returns an ordered array of [projectName, features[]] pairs.
 * Features without a project land in a '' bucket rendered last.
 */
function groupByProject(features) {
  const map = {};
  features.forEach(f => {
    const key = f.project ?? '';
    if (!map[key]) map[key] = [];
    map[key].push(f);
  });
  const named = Object.keys(map).filter(k => k !== '').sort();
  const unnamed = map[''] ? [''] : [];
  return [...named, ...unnamed].map(k => [k, map[k]]);
}

export default function FeatureList({ features, activePreview, startingFeatures, onActivate, onRemoved, onLogs }) {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('sidebar-collapsed') === 'true'
  );

  function toggleCollapsed() {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem('sidebar-collapsed', String(next));
      return next;
    });
  }

  const groups = groupByProject(features);
  const isMultiProject = groups.length > 1 || (groups.length === 1 && groups[0][0] !== '');

  const cardProps = f => ({
    key: f.key,
    feature: f,
    isActive: f.isActive,
    isPreview: activePreview === f.key,
    isStarting: startingFeatures.has(f.key),
    onActivate,
    onRemoved,
    onLogs,
  });

  return (
    <div style={{
      width: collapsed ? '48px' : '280px',
      flexShrink: 0,
      borderRight: '1px solid #222',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      transition: 'width 200ms ease',
    }}>
      <div style={{
        padding: '0.6rem 0.75rem',
        borderBottom: '1px solid #222',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.65rem',
        color: 'var(--color-muted)',
        letterSpacing: '0.08em',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}>
        <span style={{ opacity: collapsed ? 0 : 1, transition: 'opacity 150ms ease' }}>
          // FEATURES
        </span>
        <button
          onClick={toggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '0 2px',
            color: 'var(--color-muted)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.75rem',
            lineHeight: 1,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '20px',
            height: '20px',
            borderRadius: '2px',
            transition: 'color 0.1s, background 0.1s',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.background = '#161616'; }}
          onMouseLeave={e => { e.currentTarget.style.color = ''; e.currentTarget.style.background = ''; }}
        >
          {collapsed ? '›' : '‹'}
        </button>
      </div>

      {!collapsed && (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {features.length === 0 && (
            <div style={{
              padding: '1rem 0.75rem',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.75rem',
              color: '#333',
            }}>
              no features registered
            </div>
          )}

          {isMultiProject ? (
            groups.map(([proj, groupFeatures]) => (
              <div key={proj || '__ungrouped__'}>
                <div style={{
                  padding: '0.5rem 0.75rem 0.3rem',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.6rem',
                  color: '#555',
                  letterSpacing: '0.08em',
                  borderBottom: '1px solid #1a1a1a',
                  background: '#080808',
                }}>
                  // {proj || 'unknown'}
                </div>
                {groupFeatures.map(f => (
                  <FeatureCard {...cardProps(f)} />
                ))}
              </div>
            ))
          ) : (
            features.map(f => (
              <FeatureCard {...cardProps(f)} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
