import { useState } from 'react';
import FeatureCard from './FeatureCard.jsx';
import EmptyState from './EmptyState.jsx';

const STATUS_CHIPS = [
  { key: 'up', label: 'UP' },
  { key: 'failed', label: 'FAILED' },
  { key: 'stopped', label: 'STOPPED' },
];

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

function readCollapsed() {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem('fleet.sidebar.collapsed') === 'true';
  } catch {
    return false;
  }
}

export default function FeatureList({ features, activePreview, startingFeatures, onActivate, onRemoved, onLogs }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeStatuses, setActiveStatuses] = useState(() => new Set());

  function toggleCollapsed() {
    setCollapsed(prev => {
      const next = !prev;
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('fleet.sidebar.collapsed', String(next));
        }
      } catch {
        /* ignore persistence errors (e.g. SSR / disabled storage) */
      }
      return next;
    });
  }

  function toggleStatus(key) {
    setActiveStatuses(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function clearFilters() {
    setSearchQuery('');
    setActiveStatuses(new Set());
  }

  const hasActiveFilter = searchQuery !== '' || activeStatuses.size > 0;

  const filteredFeatures = features.filter(f => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const title = (f.title ?? f.name ?? '').toLowerCase();
      const name = (f.name ?? '').toLowerCase();
      const branch = (f.branch ?? '').toLowerCase();
      if (!title.includes(q) && !name.includes(q) && !branch.includes(q)) return false;
    }
    if (activeStatuses.size > 0) {
      const norm = f.status === 'running' ? 'up' : (f.status ?? '');
      if (!activeStatuses.has(norm)) return false;
    }
    return true;
  });

  const groups = groupByProject(filteredFeatures);
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
      borderRight: '1px solid var(--color-border)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      transition: 'width 200ms ease',
    }}>
      <div style={{
        padding: 'var(--space-2)',
        borderBottom: '1px solid var(--color-border)',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.65rem',
        color: 'var(--color-muted)',
        letterSpacing: '0.08em',
        display: 'flex',
        alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'space-between',
        flexShrink: 0,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}>
        {!collapsed && <span>// FEATURES</span>}
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
            transition: 'color 0.1s, background 0.1s',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.background = 'var(--surface-hover)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = ''; e.currentTarget.style.background = ''; }}
        >
          {collapsed ? '›' : '‹'}
        </button>
      </div>

      {!collapsed && (
        <>
          <div style={{
            padding: 'var(--space-15) var(--space-2)',
            borderBottom: '1px solid var(--color-surface-header)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.35rem', /* off-scale: 0.35rem micro-gap has no exact token */
            flexShrink: 0,
          }}>
            <input
              type="text"
              aria-label="Search features"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="search…"
              style={{
                background: '#0d0d0d',
                border: '1px solid #2a2a2a',
                color: '#ccc',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.65rem',
                padding: 'var(--space-1) var(--space-15)',
                width: '100%',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-05)' }}>
              {STATUS_CHIPS.map(({ key, label }) => {
                const active = activeStatuses.has(key);
                return (
                  <button
                    key={key}
                    aria-pressed={active}
                    onClick={() => toggleStatus(key)}
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.58rem',
                      padding: '1px 4px',
                      background: active ? '#0e1f0e' : 'transparent',
                      color: active ? 'var(--color-accent)' : 'var(--color-ink-dim)',
                      border: `1px solid ${active ? 'var(--color-accent)' : '#2a2a2a'}`,
                      cursor: 'pointer',
                      letterSpacing: '0.05em',
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {features.length === 0 && (
              <EmptyState
                variant="sidebar"
                status="0 REGISTERED"
                statusColor="var(--color-accent)"
                lead="No feature branches yet. Register one and it lands here, ready to activate."
                command="fleet add <name> <branch>"
              />
            )}

            {features.length > 0 && filteredFeatures.length === 0 && (
              <div style={{
                padding: 'var(--space-4) var(--space-3)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2)',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.65rem',
                color: 'var(--color-muted)',
              }}>
                <span>No features match the current filter.</span>
                {hasActiveFilter && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="empty-state-copy"
                    style={{
                      alignSelf: 'flex-start',
                      background: 'transparent',
                      border: '1px solid #2a2a2a',
                      color: 'var(--color-ink-dim)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.6rem',
                      letterSpacing: '0.05em',
                      padding: '1px 6px',
                      cursor: 'pointer',
                    }}
                  >
                    [CLEAR FILTERS]
                  </button>
                )}
              </div>
            )}

            {filteredFeatures.length > 0 && (
              isMultiProject ? (
                groups.map(([proj, groupFeatures], idx) => (
                  <div key={proj || '__ungrouped__'}>
                    <div style={{
                      /* E-item rhythm: generous separation between groups; first group stays tight against search bar */
                      paddingTop: idx === 0 ? 'var(--space-2)' : 'var(--space-4)',
                      paddingRight: 'var(--space-3)',
                      paddingBottom: 'var(--space-1)',
                      paddingLeft: 'var(--space-3)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.6rem',
                      color: 'var(--color-ink-dim)',
                      letterSpacing: '0.08em',
                      borderBottom: '1px solid var(--color-surface-header)',
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
                filteredFeatures.map(f => (
                  <FeatureCard {...cardProps(f)} />
                ))
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}
