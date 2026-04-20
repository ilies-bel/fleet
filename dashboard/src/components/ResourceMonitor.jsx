import { useState, useEffect, useCallback } from 'react';
import { getFeatures, getStats } from '../api.js';

const POLL_MS = 3000;

function fmtMem(usedMB, limitMB) {
  if (limitMB === 0) return `${usedMB} MB`;
  return `${usedMB} / ${limitMB} MB`;
}

function fmtNet(rxMB, txMB) {
  return `↓${rxMB} ↑${txMB} MB`;
}

function CpuBar({ percent }) {
  const color = percent > 80
    ? 'var(--color-danger)'
    : percent > 50
      ? 'var(--color-warning)'
      : 'var(--color-accent)';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <div style={{
        width: '80px',
        height: '6px',
        background: '#222',
        flexShrink: 0,
      }}>
        <div style={{
          width: `${Math.min(percent, 100)}%`,
          height: '100%',
          background: color,
          transition: 'width 0.4s ease',
        }} />
      </div>
      <span style={{ color, fontFamily: 'var(--font-mono)', fontSize: '0.72rem', minWidth: '42px' }}>
        {percent.toFixed(1)}%
      </span>
    </div>
  );
}

export default function ResourceMonitor() {
  const [rows, setRows] = useState([]);

  const refresh = useCallback(async () => {
    let features;
    try {
      features = await getFeatures();
    } catch {
      return;
    }

    const updated = await Promise.all(
      features.map(async (f) => {
        try {
          const stats = await getStats(f.name);
          return { name: f.name, branch: f.branch, status: 'running', ...stats };
        } catch (err) {
          const stopped = err.message?.includes('not running') || err.message?.includes('409');
          return {
            name: f.name,
            branch: f.branch,
            status: stopped ? 'stopped' : 'error',
            cpuPercent: 0,
            memUsageMB: 0,
            memLimitMB: 0,
            netRxMB: 0,
            netTxMB: 0,
          };
        }
      }),
    );

    setRows(updated);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const col = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.72rem',
    padding: '0.6rem 0.75rem',
    borderBottom: '1px solid #1a1a1a',
    verticalAlign: 'middle',
  };

  const th = {
    ...col,
    color: 'var(--color-muted)',
    fontSize: '0.65rem',
    letterSpacing: '0.06em',
    borderBottom: '1px solid #222',
    background: '#000',
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '0.65rem',
        color: 'var(--color-muted)',
        letterSpacing: '0.08em',
        marginBottom: '0.75rem',
      }}>
        // RESOURCE MONITOR &nbsp;— auto-refresh {POLL_MS / 1000}s
      </div>

      {rows.length === 0 ? (
        <div style={{ color: '#333', fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>
          no features registered
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>FEATURE</th>
              <th style={{ ...th, textAlign: 'left' }}>BRANCH</th>
              <th style={{ ...th, textAlign: 'left' }}>STATUS</th>
              <th style={{ ...th, textAlign: 'left' }}>CPU</th>
              <th style={{ ...th, textAlign: 'left' }}>MEMORY</th>
              <th style={{ ...th, textAlign: 'left' }}>NETWORK</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const statusColor = r.status === 'running'
                ? 'var(--color-accent)'
                : r.status === 'stopped'
                  ? 'var(--color-warning)'
                  : 'var(--color-danger)';

              return (
                <tr key={r.name} style={{ background: '#0d0d0d' }}>
                  <td style={{ ...col, color: '#eee', fontWeight: 700 }}>{r.name}</td>
                  <td style={{ ...col, color: 'var(--color-muted)', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.branch}</td>
                  <td style={{ ...col, color: statusColor }}>{r.status.toUpperCase()}</td>
                  <td style={col}>
                    {r.status === 'running'
                      ? <CpuBar percent={r.cpuPercent} />
                      : <span style={{ color: '#333' }}>—</span>}
                  </td>
                  <td style={{ ...col, color: r.status === 'running' ? '#ccc' : '#333' }}>
                    {r.status === 'running' ? fmtMem(r.memUsageMB, r.memLimitMB) : '—'}
                  </td>
                  <td style={{ ...col, color: r.status === 'running' ? '#ccc' : '#333' }}>
                    {r.status === 'running' ? fmtNet(r.netRxMB, r.netTxMB) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
