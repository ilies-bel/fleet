import { useState, useEffect } from 'react';
import { getStatus } from '../api.js';

export default function StatusBar() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    async function check() {
      try {
        const s = await getStatus();
        setStatus({ up: true, featureCount: s.featureCount });
      } catch {
        setStatus({ up: false, featureCount: 0 });
      }
    }

    check();
    const poll = setInterval(check, 10000);
    return () => clearInterval(poll);
  }, []);

  const gwLabel = status === null
    ? '● GATEWAY · CONNECTING'
    : status.up
      ? '● GATEWAY UP'
      : '● GATEWAY UNREACHABLE';

  const gwColor = status === null
    ? 'var(--color-muted)'
    : status.up
      ? 'var(--color-accent)'
      : 'var(--color-danger)';

  // Connecting is a transient state — blink it like every other in-flight
  // lifecycle indicator. Unreachable is terminal-until-fixed: steady red, and
  // the recovery command rides along as a tooltip so a fresh operator who never
  // started the gateway has somewhere to go without bloating the status line.
  const gwBlink = status === null;
  const gwTitle = status && !status.up
    ? 'Gateway not responding on :4000. Start it with `fleet up`.'
    : undefined;

  return (
    <div
      className="status-bar"
      style={{
        minHeight: '40px',
        background: '#000',
        borderBottom: '1px solid #222',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 var(--space-4)',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.75rem',
        flexShrink: 0,
      }}
    >
      <span style={{ color: 'var(--color-accent)', fontWeight: 700 }}>[QA FLEET v1.0]</span>
      <span
        style={{ color: gwColor, animation: gwBlink ? 'blink 1s step-start infinite' : undefined }}
        title={gwTitle}
      >
        {gwLabel}
      </span>
      <span style={{ color: 'var(--color-muted)' }}>
        {status?.featureCount ?? 0} FEATURES
      </span>
    </div>
  );
}
