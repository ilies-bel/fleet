import { useState, useEffect } from 'react';
import { getStatus } from '../api.js';

function pad(n) {
  return String(n).padStart(2, '0');
}

function clock() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function StatusBar() {
  const [time, setTime] = useState(clock());
  const [status, setStatus] = useState(null);

  useEffect(() => {
    const tick = setInterval(() => setTime(clock()), 1000);
    return () => clearInterval(tick);
  }, []);

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
    ? '● GATEWAY ...'
    : status.up
      ? '● GATEWAY UP'
      : '● GATEWAY UNREACHABLE';

  const gwColor = status === null
    ? 'var(--color-warning)'
    : status.up
      ? 'var(--color-accent)'
      : 'var(--color-danger)';

  return (
    <div style={{
      height: '40px',
      background: '#000',
      borderBottom: '1px solid #222',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 1rem',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.75rem',
      flexShrink: 0,
    }}>
      <span style={{ color: 'var(--color-accent)', fontWeight: 700 }}>[QA FLEET v1.0]</span>
      <span style={{ color: gwColor }}>{gwLabel}</span>
      <span style={{ color: 'var(--color-muted)' }}>
        {status?.featureCount ?? 0} FEATURES &nbsp;|&nbsp; {time}
      </span>
    </div>
  );
}
