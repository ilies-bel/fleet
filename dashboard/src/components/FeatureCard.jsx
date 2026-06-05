import { useState, useEffect, useRef } from 'react';
import { getHealth, removeFeature, stopFeature, startFeature, syncFeature } from '../api.js';
import { describeFeature } from './featurePresentation.js';
import { Button } from './Button.jsx';
import FeatureConfigModal from './FeatureConfigModal.jsx';

export default function FeatureCard({ feature, isActive, isPreview, isStarting, onActivate, onRemoved, onLogs }) {
  const { key, name, branch, title, project } = feature;
  const [health, setHealth] = useState('checking');
  const [confirming, setConfirming] = useState(false);
  const [syncConfirm, setSyncConfirm] = useState(false);
  const syncConfirmTimer = useRef(null);
  const configTriggerRef = useRef(null);
  const [activating, setActivating] = useState(false);
  const [togglingPower, setTogglingPower] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function check() {
      try {
        const res = await getHealth(key);
        setHealth(res.status);
      } catch {
        setHealth('down');
      }
    }

    check();
    const poll = setInterval(check, 8000);
    return () => {
      controller.abort();
      clearInterval(poll);
    };
  }, [key]);

  async function handleActivate() {
    setActivating(true);
    setActionError(null);
    try {
      await onActivate(key);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setActivating(false);
    }
  }

  async function handleTogglePower() {
    setTogglingPower(true);
    setActionError(null);
    try {
      if (health === 'up') {
        await stopFeature(key);
        setHealth('down');
      } else {
        await startFeature(key);
        setHealth('starting');
      }
    } catch (err) {
      setActionError(err.message);
    } finally {
      setTogglingPower(false);
    }
  }

  async function handleKill() {
    if (!confirming) { setConfirming(true); return; }
    try {
      await removeFeature(key);
      onRemoved(key);
    } catch (err) {
      console.error('Kill failed:', err);
    }
    setConfirming(false);
  }

  async function handleSync() {
    if (!syncConfirm) {
      setSyncConfirm(true);
      syncConfirmTimer.current = setTimeout(() => setSyncConfirm(false), 3000);
      return;
    }
    clearTimeout(syncConfirmTimer.current);
    setSyncConfirm(false);
    setSyncing(true);
    setActionError(null);
    try {
      await syncFeature(key);
      onLogs(key);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setSyncing(false);
    }
  }

  const isNotStarted = feature.status === 'not_started';
  const presentation = describeFeature(feature, health, isStarting);
  const displayName = title || name;

  /* Small sizing shared by all action buttons in this card */
  const cardBtnStyle = { fontSize: '0.68rem', padding: '2px 7px' };

  return (
    <div
      style={{
        padding: '0.75rem',
        background: isActive || isPreview ? '#161616' : 'transparent',
        borderLeft: isActive ? '3px solid var(--color-accent)' : '3px solid transparent',
        borderBottom: '1px solid #222',
        transition: 'background 0.1s',
        opacity: presentation.dimmed ? 0.7 : 1,
      }}
      onMouseEnter={e => { if (!isActive && !isPreview) e.currentTarget.style.background = '#161616'; }}
      onMouseLeave={e => { if (!isActive && !isPreview) e.currentTarget.style.background = 'transparent'; }}
    >
      {/* Header row: collapse/expand toggle + config menu trigger */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.25rem',
        marginBottom: collapsed ? 0 : '0.2rem',
      }}>
        <button
          onClick={() => setCollapsed(prev => !prev)}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${displayName}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            flex: 1,
            textAlign: 'left',
            fontFamily: 'var(--font-mono)',
            minWidth: 0,
          }}
        >
          <span style={{ color: '#555', fontSize: '0.75rem', flexShrink: 0, lineHeight: 1 }}>
            {collapsed ? '▸' : '▾'}
          </span>
          {/* Status chip appears in the compact header only when collapsed */}
          {collapsed && (
            <span style={{
              color: presentation.dotColor,
              fontFamily: 'var(--font-mono)',
              fontSize: '0.68rem',
              flexShrink: 0,
              animation: presentation.blink ? 'blink 1s step-start infinite' : 'none',
            }}>
              {presentation.dotLabel}
            </span>
          )}
          <span style={{
            color: isActive ? 'var(--color-accent)' : '#eee',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.9rem',
            fontWeight: 700,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            minWidth: 0,
          }}>
            {displayName}
          </span>
          {project && (
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.58rem',
              color: '#888',
              background: '#111',
              border: '1px solid #2a2a2a',
              padding: '1px 5px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}>
              {project}
            </span>
          )}
        </button>
        <button
          ref={configTriggerRef}
          aria-label={`Open ${displayName} configuration`}
          onClick={(e) => { e.stopPropagation(); setConfigOpen(true); }}
          style={{ ...cardBtnStyle, flexShrink: 0 }}
        >
          ⋯
        </button>
      </div>

      {/* Expanded body — hidden when collapsed */}
      {!collapsed && (
        <>
          <div style={{
            color: 'var(--color-muted)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.68rem',
            marginBottom: '0.5rem',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {branch}
          </div>

          <div style={{ marginBottom: '0.5rem' }}>
            <span style={{
              color: presentation.dotColor,
              fontFamily: 'var(--font-mono)',
              fontSize: '0.68rem',
              animation: presentation.blink ? 'blink 1s step-start infinite' : 'none',
            }}>
              {presentation.dotLabel}
            </span>
            {presentation.showError && feature.error && (
              <div
                role="alert"
                title={feature.error}
                style={{
                  color: '#ff4444',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.65rem',
                  marginTop: '0.3rem',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {feature.error}
              </div>
            )}
          </div>

          {/* Controls region — action buttons and not-started instructions */}
          <div data-testid="feature-controls">
            {isNotStarted ? (
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.65rem',
                color: '#555',
                marginTop: '0.25rem',
              }}>
                Start: <span style={{ color: '#888' }}>fleet add {name} {branch}</span>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                {health !== 'down' && (
                  <Button
                    tone="primary"
                    onClick={handleActivate}
                    disabled={activating || isActive}
                    style={{
                      ...cardBtnStyle,
                      ...(isActive ? { background: '#00ff88', color: '#000' } : {}),
                    }}
                    title={isActive ? 'Currently active on port 3000' : 'Route port 3000 to this feature'}
                  >
                    {activating ? '[...]' : isActive ? '[ACTIVE]' : '[ACTIVATE]'}
                  </Button>
                )}
                {/* Stop/Start: both use primary tone — stop is reversible, not destructive */}
                <Button
                  tone="primary"
                  onClick={handleTogglePower}
                  disabled={togglingPower || health === 'checking'}
                  style={cardBtnStyle}
                  title={health === 'up' ? 'Stop container' : 'Start container'}
                >
                  {togglingPower ? '[...]' : health === 'up' ? '[STOP]' : '[START]'}
                </Button>
                {/* Sync: caution tone (rebuild/restart) — escalates to a red confirm fill */}
                <Button
                  tone="caution"
                  onClick={handleSync}
                  disabled={syncing}
                  style={{
                    ...cardBtnStyle,
                    ...(syncConfirm ? { background: '#ff4444', color: '#000' } : {}),
                  }}
                  title="Pull latest code, rebuild and restart backend (logs open automatically)"
                >
                  {syncing ? '[...]' : syncConfirm ? '[CONFIRM SYNC?]' : '[SYNC]'}
                </Button>
                <Button
                  tone="primary"
                  onClick={() => onLogs(key)}
                  style={cardBtnStyle}
                  title="View container logs"
                >
                  [LOGS]
                </Button>
                {/* Kill: destructive — permanently removes the feature */}
                <Button
                  tone="destructive"
                  onClick={handleKill}
                  style={{
                    ...cardBtnStyle,
                    ...(confirming ? { background: '#ff4444', color: '#000' } : {}),
                  }}
                  aria-label={`Kill feature ${displayName}`}
                >
                  {confirming ? '[CONFIRM?]' : '[KILL]'}
                </Button>
              </div>
            )}
          </div>

          {actionError && (
            <div
              role="alert"
              style={{
                color: 'var(--color-danger)',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.65rem',
                marginTop: '0.4rem',
              }}
            >
              {actionError}
            </div>
          )}
        </>
      )}
      {configOpen && (
        <FeatureConfigModal
          feature={feature}
          onClose={() => {
            setConfigOpen(false);
            setTimeout(() => configTriggerRef.current?.focus(), 0);
          }}
        />
      )}
    </div>
  );
}
