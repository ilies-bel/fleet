import { useState, useEffect } from 'react';
import { getHostStats } from '../api.js';

const POLL_MS = 3000;

export default function SystemResourcePanel({ fleetCpuPercent, fleetMemUsedMB, fleetNetRxMB, fleetNetTxMB, instanceCounts }) {
  const [hostStats, setHostStats] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const stats = await getHostStats();
        if (!cancelled) setHostStats(stats);
      } catch {
        // silent — keep previous data, retry on next tick
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!hostStats) {
    return (
      <div style={{ marginBottom: '1.5rem', fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--color-muted)' }}>
        loading host stats…
      </div>
    );
  }

  const { cpuPercent, cpuCores, memUsedMB, memTotalMB } = hostStats;

  const cpuColor = cpuPercent > 80
    ? 'var(--color-danger)'
    : cpuPercent > 50
      ? 'var(--color-warning)'
      : 'var(--color-accent)';

  const memPercent = memTotalMB > 0 ? (memUsedMB / memTotalMB) * 100 : 0;
  const memColor = memPercent > 80
    ? 'var(--color-danger)'
    : memPercent > 50
      ? 'var(--color-warning)'
      : 'var(--color-accent)';

  return (
    <div style={{ marginBottom: '1.5rem', padding: '0.75rem 1rem', background: '#0d0d0d', border: '1px solid #1a1a1a' }}>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '0.65rem',
        color: 'var(--color-muted)',
        letterSpacing: '0.08em',
        marginBottom: '0.75rem',
      }}>
        // HOST RESOURCES
      </div>

      {/* CPU row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--color-muted)', minWidth: '90px' }}>
          CPU ({cpuCores} cores)
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={{ width: '120px', height: '6px', background: '#222', flexShrink: 0 }}>
            <div style={{
              width: `${Math.min(cpuPercent, 100)}%`,
              height: '100%',
              background: cpuColor,
              transition: 'width 0.4s ease',
            }} />
          </div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: cpuColor, minWidth: '48px' }}>
            {cpuPercent.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* Memory row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--color-muted)', minWidth: '90px' }}>
          MEM
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={{ width: '120px', height: '6px', background: '#222', flexShrink: 0 }}>
            <div style={{
              width: `${Math.min(memPercent, 100)}%`,
              height: '100%',
              background: memColor,
              transition: 'width 0.4s ease',
            }} />
          </div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: memColor }}>
            {memUsedMB} / {memTotalMB} MB
          </span>
        </div>
      </div>

      {/* Fleet network row */}
      <span className="fleet-net" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--color-muted)' }}>
        FLEET NETWORK ↓{fleetNetRxMB} ↑{fleetNetTxMB} MB
      </span>
    </div>
  );
}
