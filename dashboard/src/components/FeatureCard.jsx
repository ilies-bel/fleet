import { useState, useEffect, useRef } from 'react';
import { getHealth, getServicesHealth, removeFeature, stopFeature, startFeature, syncFeature, renameFeature } from '../api.js';
import { describeFeature } from './featurePresentation.js';
import { Button } from './Button.jsx';
import FeatureConfigModal from './FeatureConfigModal.jsx';
import ConfirmModal from './ConfirmModal.jsx';

export default function FeatureCard({ feature, isActive, isPreview, isStarting, onActivate, onRemoved, onLogs }) {
  const { key, name, branch, title } = feature;
  const [health, setHealth] = useState('checking');
  const [killConfirmOpen, setKillConfirmOpen] = useState(false);
  const [syncConfirm, setSyncConfirm] = useState(false);
  const syncConfirmTimer = useRef(null);
  const configTriggerRef = useRef(null);
  const [activating, setActivating] = useState(false);
  const [togglingPower, setTogglingPower] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  // Optimistic title override — null means "use feature.title from props"
  const [titleOverride, setTitleOverride] = useState(null);
  const editInputRef = useRef(null);
  // Tracks whether the current edit was cancelled (Escape) so the blur handler
  // skips submission when the input is removed from the DOM.
  const editCancelledRef = useRef(false);

  useEffect(() => {
    async function check() {
      try {
        const res = await getServicesHealth(key);
        const services = res.services;
        if (!services || services.length === 0) {
          // Empty services list — fall back to the root probe (cluster-hosted
          // features or local features with no registered services).
          const rootRes = await getHealth(key);
          setHealth(rootRes.status);
          return;
        }
        const upCount = services.filter(s => s.status === 'up').length;
        if (upCount === services.length) {
          setHealth('up');
        } else if (upCount > 0) {
          setHealth('degraded');
        } else {
          setHealth('down');
        }
      } catch {
        setHealth('down');
      }
    }

    check();
    const poll = setInterval(check, 8000);
    return () => {
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

  function handleKill() {
    setKillConfirmOpen(true);
  }

  async function handleKillConfirm() {
    setKillConfirmOpen(false);
    try {
      await removeFeature(key);
      onRemoved(key);
    } catch (err) {
      console.error('Kill failed:', err);
    }
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

  // Auto-focus and select-all when the inline edit input appears.
  useEffect(() => {
    if (editing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editing]);

  function handleTitleDoubleClick(e) {
    e.stopPropagation();
    const currentDisplay = (titleOverride !== null ? titleOverride : title) || name;
    setEditValue(currentDisplay);
    setEditing(true);
  }

  function handleRenameKeyDown(e) {
    if (e.key === 'Enter') {
      // Let blur handle submission so there is a single submit path.
      editInputRef.current.blur();
    } else if (e.key === 'Escape') {
      editCancelledRef.current = true;
      setEditing(false);
    }
  }

  function handleRenameBlur() {
    if (editCancelledRef.current) {
      editCancelledRef.current = false;
      return;
    }
    const trimmed = editValue.trim();
    const currentDisplay = (titleOverride !== null ? titleOverride : title) || name;
    if (!trimmed || trimmed === currentDisplay) {
      setEditing(false);
      return;
    }
    const prevOverride = titleOverride;
    setTitleOverride(trimmed);
    setEditing(false);
    renameFeature(key, trimmed).catch(err => {
      setTitleOverride(prevOverride);
      setActionError(err.message);
    });
  }

  const isNotStarted = feature.status === 'not_started';
  const presentation = describeFeature(feature, health, isStarting);
  const displayName = (titleOverride !== null ? titleOverride : title) || name;
  const isDirectMount = typeof feature.worktreePath !== 'string' || feature.worktreePath.length === 0;

  /* Small sizing shared by all action buttons in this card */
  const cardBtnStyle = { fontSize: '0.68rem', padding: '2px 7px' };

  return (
    <div
      style={{
        padding: 'var(--space-3)',
        background: isActive || isPreview ? 'var(--surface-selected)' : 'transparent',
        borderLeft: isActive ? '3px solid var(--color-accent)' : '3px solid transparent',
        borderBottom: '1px solid var(--color-border)',
        transition: 'background 0.1s',
        opacity: presentation.dimmed ? 0.7 : 1,
      }}
      onMouseEnter={e => { if (!isActive && !isPreview) e.currentTarget.style.background = 'var(--surface-hover)'; }}
      onMouseLeave={e => { if (!isActive && !isPreview) e.currentTarget.style.background = 'transparent'; }}
    >
      {/* Header row: collapse/expand toggle + title (editable) + config menu trigger */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        marginBottom: collapsed ? 0 : 'var(--space-1)',
      }}>
        {/* Collapse/expand button — narrowed to chevron+dot only so the title
            can be a separate click/dblclick target without triggering collapse. */}
        <button
          onClick={() => setCollapsed(prev => !prev)}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${displayName}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-15)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            flexShrink: 0,
            fontFamily: 'var(--font-mono)',
          }}
        >
          <span style={{ color: 'var(--color-ink-dim)', fontSize: '0.75rem', flexShrink: 0, lineHeight: 1 }}>
            {collapsed ? '▸' : '▾'}
          </span>
          {/* Status chip always visible beside the title */}
          <span style={{
            color: presentation.dotColor,
            fontFamily: 'var(--font-mono)',
            fontSize: '0.68rem',
            flexShrink: 0,
            animation: presentation.blink ? 'blink 1s step-start infinite' : 'none',
          }}>
            {'●'}
          </span>
        </button>

        {/* Title — double-click to rename inline */}
        {editing ? (
          <input
            ref={editInputRef}
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameBlur}
            aria-label="Rename feature"
            style={{
              flex: 1,
              minWidth: 0,
              color: presentation.dotColor,
              fontFamily: 'var(--font-mono)',
              fontSize: '0.9rem',
              fontWeight: 700,
              background: 'transparent',
              border: 'none',
              borderBottom: '1px solid var(--color-accent)',
              padding: 0,
            }}
          />
        ) : (
          <span
            onDoubleClick={handleTitleDoubleClick}
            title="Double-click to rename"
            style={{
              flex: 1,
              color: presentation.dotColor,
              fontFamily: 'var(--font-mono)',
              fontSize: '0.9rem',
              fontWeight: 700,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
              cursor: 'text',
            }}
          >
            {displayName}
          </span>
        )}
        {!editing && isDirectMount && (
          <span style={{
            display: 'inline-block',
            marginLeft: '0.4rem',
            padding: '0.1rem var(--space-15)',
            fontSize: '0.65rem',
            fontWeight: 600,
            background: 'var(--color-border)',
            color: 'var(--color-accent)',
            letterSpacing: '0.03em',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}>
            direct
          </span>
        )}

        <button
          ref={configTriggerRef}
          className="card-config-trigger"
          aria-label={`Open ${displayName} configuration`}
          onClick={(e) => { e.stopPropagation(); setConfigOpen(true); }}
          style={{ flexShrink: 0 }}
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
            marginBottom: 'var(--space-1)', /* tight identity cluster: branch→status */
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {branch}
          </div>

          <div style={{ marginBottom: 'var(--space-2)' }}> {/* error cluster: branch→error→controls */}
            {presentation.showError && feature.error && (
              <div
                role="alert"
                title={feature.error}
                style={{
                  color: 'var(--color-danger)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.65rem',
                  marginTop: '0.3rem', /* off-scale: 0.3rem has no exact token */
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
                color: 'var(--color-muted)',
                marginTop: 'var(--space-1)',
              }}>
                Start: <span style={{ color: 'var(--color-muted)' }}>fleet add {name} {branch}</span>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 'var(--space-15)', flexWrap: 'wrap' }}>
                {health !== 'down' && (
                  <Button
                    tone="primary"
                    onClick={handleActivate}
                    disabled={activating || isActive}
                    style={{
                      ...cardBtnStyle,
                      ...(isActive ? { background: 'var(--color-accent)', color: 'var(--color-bg-black)' } : {}),
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
                    ...(syncConfirm ? { background: 'var(--color-danger)', color: 'var(--color-bg-black)' } : {}),
                  }}
                  title="Rebuild and restart backend from bind-mounted source (logs open automatically)"
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
                  style={cardBtnStyle}
                  aria-label={`Kill feature ${displayName}`}
                >
                  [KILL]
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
                marginTop: 'var(--space-15)',
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
      <ConfirmModal
        open={killConfirmOpen}
        title={`Kill ${displayName}`}
        message={`Permanently removes the container and worktree for ${displayName}. This cannot be undone.`}
        confirmLabel="[KILL]"
        onConfirm={handleKillConfirm}
        onCancel={() => setKillConfirmOpen(false)}
        destructive
      />
    </div>
  );
}
