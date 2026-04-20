import { useState, useEffect } from 'react';
import { getHealth, removeFeature, openTerminal, stopFeature, startFeature, syncFeature } from '../api.js';

export default function FeatureCard({ feature, isActive, isPreview, isStarting, onActivate, onRemoved, onLogs }) {
  const { name, branch } = feature;
  const [health, setHealth] = useState('checking');
  const [confirming, setConfirming] = useState(false);
  const [activating, setActivating] = useState(false);
  const [openingTerm, setOpeningTerm] = useState(false);
  const [termDone, setTermDone] = useState(false);
  const [togglingPower, setTogglingPower] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();

    async function check() {
      try {
        const res = await getHealth(name);
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
  }, [name]);

  async function handleActivate() {
    setActivating(true);
    setActionError(null);
    try {
      await onActivate(name);
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
        await stopFeature(name);
        setHealth('down');
      } else {
        await startFeature(name);
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
      await removeFeature(name);
      onRemoved(name);
    } catch (err) {
      console.error('Kill failed:', err);
    }
    setConfirming(false);
  }

  async function handleSync() {
    setSyncing(true);
    setActionError(null);
    try {
      await syncFeature(name);
      onLogs(name);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setSyncing(false);
    }
  }

  async function handleOpenTerm() {
    setOpeningTerm(true);
    setTermDone(false);
    setActionError(null);
    try {
      await openTerminal(name);
      setTermDone(true);
      setTimeout(() => setTermDone(false), 3000);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setOpeningTerm(false);
    }
  }

  const isNotStarted = feature.status === 'not_started';
  const effectiveHealth = isStarting && health !== 'up' ? 'starting' : health;
  const healthDot = isNotStarted
    ? { color: '#555', label: '● NOT STARTED' }
    : effectiveHealth === 'up'
      ? { color: 'var(--color-accent)', label: '● UP' }
      : effectiveHealth === 'starting'
        ? { color: 'var(--color-warning)', label: '● STARTING' }
        : effectiveHealth === 'down'
          ? { color: 'var(--color-danger)', label: '● DOWN' }
          : { color: 'var(--color-warning)', label: '● ...' };

  return (
    <div
      style={{
        padding: '0.75rem',
        background: isActive || isPreview ? '#161616' : 'transparent',
        borderLeft: isActive ? '3px solid var(--color-accent)' : '3px solid transparent',
        borderBottom: '1px solid #222',
        transition: 'background 0.1s',
        opacity: isNotStarted ? 0.7 : 1,
      }}
      onMouseEnter={e => { if (!isActive && !isPreview) e.currentTarget.style.background = '#161616'; }}
      onMouseLeave={e => { if (!isActive && !isPreview) e.currentTarget.style.background = 'transparent'; }}
    >
      <div style={{
        color: isActive ? 'var(--color-accent)' : '#eee',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.9rem',
        fontWeight: 700,
        marginBottom: '0.2rem',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
        {name}
      </div>
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
          color: healthDot.color,
          fontFamily: 'var(--font-mono)',
          fontSize: '0.68rem',
          animation: !isNotStarted && (health === 'checking' || effectiveHealth === 'starting') ? 'blink 1s step-start infinite' : 'none',
        }}>
          {healthDot.label}
        </span>
      </div>

      {/* Action buttons */}
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
        <button
          onClick={handleActivate}
          disabled={activating || isActive}
          style={btn(isActive ? 'accent-fill' : 'accent', activating || isActive)}
          title={isActive ? 'Currently active on port 3000' : 'Route port 3000 to this feature'}
        >
          {activating ? '[...]' : isActive ? '[ACTIVE]' : '[ACTIVATE]'}
        </button>
        <button
          onClick={handleTogglePower}
          disabled={togglingPower || health === 'checking'}
          style={btn(health === 'up' ? 'warning' : 'accent', togglingPower || health === 'checking')}
          title={health === 'up' ? 'Stop container' : 'Start container'}
        >
          {togglingPower ? '[...]' : health === 'up' ? '[STOP]' : '[START]'}
        </button>
        <button
          onClick={handleSync}
          disabled={syncing}
          style={btn('warning', syncing)}
          title="Pull latest code, rebuild and restart backend (logs open automatically)"
        >
          {syncing ? '[...]' : '[SYNC]'}
        </button>
        <button
          onClick={handleOpenTerm}
          disabled={openingTerm}
          style={btn(termDone ? 'accent-fill' : 'accent', openingTerm)}
          title="Open Claude Code in the local worktree via iTerm2"
        >
          {openingTerm ? '[...]' : termDone ? '[DONE]' : '[GEMINI]'}
        </button>
        <button
          onClick={() => onLogs(name)}
          style={btn('accent')}
          title="View container logs"
        >
          [LOGS]
        </button>
        <button
          onClick={handleKill}
          style={btn(confirming ? 'danger-fill' : 'danger')}
        >
          {confirming ? '[CONFIRM?]' : '[KILL]'}
        </button>
      </div>
      )}

      {actionError && (
        <div style={{
          color: 'var(--color-danger)',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.65rem',
          marginTop: '0.4rem',
        }}>
          {actionError}
        </div>
      )}
    </div>
  );
}

function btn(variant, disabled = false) {
  const base = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.68rem',
    padding: '2px 7px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    borderRadius: 0,
    opacity: disabled ? 0.5 : 1,
  };

  switch (variant) {
    case 'accent':
      return { ...base, background: 'transparent', border: '1px solid var(--color-accent)', color: 'var(--color-accent)' };
    case 'accent-fill':
      return { ...base, background: 'var(--color-accent)', border: '1px solid var(--color-accent)', color: '#000' };
    case 'warning':
      return { ...base, background: 'transparent', border: '1px solid var(--color-warning)', color: 'var(--color-warning)' };
    case 'danger':
      return { ...base, background: 'transparent', border: '1px solid var(--color-danger)', color: 'var(--color-danger)' };
    case 'danger-fill':
      return { ...base, background: 'var(--color-danger)', border: '1px solid var(--color-danger)', color: '#fff' };
    default:
      return base;
  }
}
