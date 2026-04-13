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

export default function FeatureList({ features, activePreview, startingFeatures, onActivate, onRemoved, onAdd, onLogs }) {
  const groups = groupByProject(features);
  const isMultiProject = groups.length > 1 || (groups.length === 1 && groups[0][0] !== '');

  const cardProps = f => ({
    key: f.name,
    feature: f,
    isActive: f.isActive,
    isPreview: activePreview === f.name,
    isStarting: startingFeatures.has(f.name),
    onActivate,
    onRemoved,
    onLogs,
  });

  return (
    <div style={{
      width: '280px',
      flexShrink: 0,
      borderRight: '1px solid #222',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '0.6rem 0.75rem',
        borderBottom: '1px solid #222',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.65rem',
        color: 'var(--color-muted)',
        letterSpacing: '0.08em',
      }}>
        // FEATURES
      </div>

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

      <div style={{ padding: '0.75rem', borderTop: '1px solid #222' }}>
        <button
          onClick={onAdd}
          style={{
            width: '100%',
            background: 'transparent',
            border: '1px solid var(--color-accent)',
            color: 'var(--color-accent)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.8rem',
            fontWeight: 700,
            padding: '0.4rem',
            cursor: 'pointer',
            borderRadius: 0,
          }}
        >
          + ADD
        </button>
      </div>
    </div>
  );
}
