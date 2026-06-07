import { useState, useEffect } from 'react';
import { getHostStats } from '../api.js';

const POLL_MS = 3000;

export default function SystemResourcePanel({ fleetNetRxMB, fleetNetTxMB, instanceCounts }) {
  const [host, setHost] = useState({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const h = await getHostStats();
        if (!cancelled) setHost({ status: 'ok', ...h });
      } catch {
        if (!cancelled) setHost({ status: 'unavailable' });
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const memPercent =
    host.status === 'ok' && host.memTotalMB > 0
      ? (host.memUsedMB / host.memTotalMB) * 100
      : 0;
  const memColor =
    memPercent > 80
      ? 'var(--color-danger)'
      : memPercent > 50
        ? 'var(--color-warning)'
        : 'var(--color-accent)';
  const cpuColor =
    host.status === 'ok'
      ? host.cpuPercent > 80
        ? 'var(--color-danger)'
        : host.cpuPercent > 50
          ? 'var(--color-warning)'
          : 'var(--color-accent)'
      : 'var(--color-muted)';
  const fleetNetWorst = Math.max(Number(fleetNetRxMB ?? 0), Number(fleetNetTxMB ?? 0));
  const fleetNetColor =
    fleetNetWorst > 500
      ? 'var(--color-danger)'
      : fleetNetWorst > 100
        ? 'var(--color-warning)'
        : 'var(--color-accent)';

  return (
    <div style={{ marginBottom: 'var(--space-6)', padding: 'var(--space-3) var(--space-4)', background: '#0d0d0d', border: '1px solid #1a1a1a' }}>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '0.65rem',
        color: 'var(--color-muted)',
        letterSpacing: '0.08em',
        marginBottom: 'var(--space-3)',
      }}>
        // HOST RESOURCES
      </div>

      {/* Instance counts roll-up — 'failed' counts status === 'error' (ResourceMonitor maps fetch errors to status:'error'; no lifecycle.failed field exists yet) */}
      {instanceCounts && (
        <div className="instance-counts" style={{ display: 'flex', gap: 'var(--space-6)', marginBottom: 'var(--space-3)' }}>
          <span className="count-total" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--color-muted)' }}>
            TOTAL {instanceCounts.total}
          </span>
          <span className="count-running" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--color-accent)' }}>
            RUNNING {instanceCounts.running}
          </span>
          <span className="count-stopped" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--color-warning)' }}>
            STOPPED {instanceCounts.stopped}
          </span>
          <span className="count-failed" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--color-danger)' }}>
            FAILED {instanceCounts.failed}
          </span>
        </div>
      )}

      {/* CPU row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', marginBottom: 'var(--space-2)' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--color-muted)', minWidth: '90px' }}>
          CPU{host.status === 'ok' ? ` (${host.cpuCores} cores)` : ''}
        </span>
        {host.status === 'ok' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <div style={{ width: '120px', height: '6px', background: '#222', flexShrink: 0 }}>
              <div style={{
                width: `${Math.min(host.cpuPercent, 100)}%`,
                height: '100%',
                background: cpuColor,
                transition: 'width 0.4s ease',
              }} />
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: cpuColor, minWidth: '48px' }}>
              {host.cpuPercent.toFixed(1)}%
            </span>
          </div>
        ) : (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--color-muted)' }}>
            {host.status === 'unavailable' ? '— unavailable' : '…'}
          </span>
        )}
      </div>

      {/* Memory row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', marginBottom: 'var(--space-2)' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--color-muted)', minWidth: '90px' }}>
          MEM
        </span>
        {host.status === 'ok' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <div style={{ width: '120px', height: '6px', background: '#222', flexShrink: 0 }}>
              <div style={{
                width: `${Math.min(memPercent, 100)}%`,
                height: '100%',
                background: memColor,
                transition: 'width 0.4s ease',
              }} />
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: memColor }}>
              {host.memUsedMB} / {host.memTotalMB} MB
            </span>
          </div>
        ) : (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--color-muted)' }}>
            {host.status === 'unavailable' ? '— unavailable' : '…'}
          </span>
        )}
      </div>

      {/* Instance counts — always rendered when provided */}
      {instanceCounts != null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', marginBottom: 'var(--space-2)' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--color-muted)', minWidth: '90px' }}>
            INSTANCES
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--color-muted)' }}>
            {instanceCounts.running ?? 0} running / {instanceCounts.total ?? 0} total
          </span>
        </div>
      )}

      {/* Fleet network row — always rendered regardless of host status */}
      <span className="fleet-net" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: fleetNetColor }}>
        FLEET NETWORK ↓{Number(fleetNetRxMB ?? 0).toFixed(1)} ↑{Number(fleetNetTxMB ?? 0).toFixed(1)} MB
      </span>
    </div>
  );
}
