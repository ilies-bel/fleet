import { useState, useEffect } from 'react';
import { getHostStats } from '../api.js';

const POLL_MS = 3000;
const FLEET_COLOR = '#0ea5e9';

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

  const { cpuPercent, cpuCores, memUsedMB, memTotalMB, memFreeMB } = hostStats;

  const safeFleetCpu = fleetCpuPercent ?? 0;
  const safeFleetMem = fleetMemUsedMB ?? 0;

  // CPU layering: fleet fill clamped to min(fleet, host), remainder is host-only
  const clampedFleetCpu = Math.min(safeFleetCpu, cpuPercent);
  const hostOnlyCpu = cpuPercent - clampedFleetCpu;

  const cpuColor = cpuPercent > 80
    ? 'var(--color-danger)'
    : cpuPercent > 50
      ? 'var(--color-warning)'
      : 'var(--color-accent)';

  // Memory segments: fleet / other / free
  const otherMemMB = Math.max(0, memUsedMB - safeFleetMem);
  const safeMemFree = memFreeMB ?? Math.max(0, memTotalMB - memUsedMB);

  const memPercent = memTotalMB > 0 ? (memUsedMB / memTotalMB) * 100 : 0;
  const memColor = memPercent > 80
    ? 'var(--color-danger)'
    : memPercent > 50
      ? 'var(--color-warning)'
      : 'var(--color-accent)';

  const fleetMemPct = memTotalMB > 0 ? safeFleetMem / memTotalMB * 100 : 0;
  const otherMemPct = memTotalMB > 0 ? otherMemMB / memTotalMB * 100 : 0;
  const freeMemPct = memTotalMB > 0 ? safeMemFree / memTotalMB * 100 : 0;

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
          <div style={{ display: 'flex', width: '120px', height: '6px', background: '#222', flexShrink: 0, overflow: 'hidden' }}>
            <div data-testid="cpu-fleet" style={{
              flexBasis: `${Math.min(clampedFleetCpu, 100)}%`,
              flexShrink: 0,
              height: '100%',
              background: FLEET_COLOR,
              transition: 'flex-basis 0.4s ease',
            }} />
            <div data-testid="cpu-host" style={{
              flexBasis: `${Math.min(hostOnlyCpu, 100)}%`,
              flexShrink: 0,
              height: '100%',
              background: cpuColor,
              transition: 'flex-basis 0.4s ease',
            }} />
          </div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: cpuColor }}>
            Fleet {safeFleetCpu.toFixed(1)}% / Host {cpuPercent.toFixed(1)}% of {cpuCores} cores
          </span>
        </div>
      </div>

      {/* Memory row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--color-muted)', minWidth: '90px' }}>
          MEM
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={{ display: 'flex', width: '120px', height: '6px', background: '#222', flexShrink: 0, overflow: 'hidden' }}>
            <div data-testid="mem-fleet" style={{
              flexBasis: `${fleetMemPct}%`,
              flexShrink: 0,
              height: '100%',
              background: FLEET_COLOR,
              transition: 'flex-basis 0.4s ease',
            }} />
            <div data-testid="mem-other" style={{
              flexBasis: `${otherMemPct}%`,
              flexShrink: 0,
              height: '100%',
              background: memColor,
              transition: 'flex-basis 0.4s ease',
            }} />
            <div data-testid="mem-free" style={{
              flexBasis: `${freeMemPct}%`,
              flexShrink: 0,
              height: '100%',
              background: '#333',
              transition: 'flex-basis 0.4s ease',
            }} />
          </div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: memColor }}>
            Fleet {safeFleetMem} MB / Other {otherMemMB} MB / Free {safeMemFree} MB of {memTotalMB} MB
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
