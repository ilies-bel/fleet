import { useState, useEffect, useRef, useCallback } from 'react';
import { getLogs } from '../api.js';
import { Button } from './Button.jsx';

const SOURCES = ['build', 'backend', 'nginx', 'postgresql', 'supervisord', 'all'];

/** Color for each named source (used in ALL timeline mode per-record) */
const SOURCE_COLOR = {
  backend:     'var(--color-accent)',
  nginx:       'var(--color-source-nginx)',
  postgresql:  'var(--color-source-postgresql)',
  supervisord: 'var(--color-muted)',
  build:       'var(--color-caution)',
};

/** Color for each log level badge */
const LEVEL_COLOR = {
  ERROR: 'var(--color-danger)',
  WARN:  'var(--color-caution)',
  INFO:  'var(--color-muted)',
  DEBUG: 'var(--color-ink-dim)',
  TRACE: 'var(--color-ink-faint)',
};

/** Severity order — lower number = more severe */
const LEVEL_ORDER = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };

const LEVEL_FILTERS = ['ALL', 'ERROR', 'WARN', 'INFO'];

// ── Client-side log-line parser for the SSE build stream ──────────────────
// Mirrors gateway/src/log-parse.js — kept inline to avoid a network import.
const _TS_RE    = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:\d{2})?)\s*/;
const _LEVEL_RE = /\b(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/;
const _TRACE_RE = /^(?:\s+at\s|\s+\.\.\. \d+ more|Caused by:|Suppressed:)/;

function parseClientLine(text) {
  try {
    let rest  = text;
    let ts    = null;
    let level = null;

    const tsMatch = _TS_RE.exec(rest);
    if (tsMatch) { ts = tsMatch[1]; rest = rest.slice(tsMatch[0].length); }

    const levelSearch = rest.slice(0, 40);
    const levelMatch  = _LEVEL_RE.exec(levelSearch);
    if (levelMatch) {
      const word = levelMatch[1];
      level = word === 'WARNING' ? 'WARN' : word;
      rest  = rest.slice(0, levelMatch.index) + rest.slice(levelMatch.index + levelMatch[0].length);
      rest  = rest.replace(/^[\s\-:|]+/, '');
    }

    return {
      ts,
      level,
      source:  'build',
      message: rest.trim(),
      isTrace: _TRACE_RE.test(text),
      raw:     text,
    };
  } catch {
    return { ts: null, level: null, source: 'build', message: text, isTrace: false, raw: text };
  }
}

/** Format an ISO / supervisord timestamp to HH:MM:SS, or '—' if null/invalid */
function formatTs(ts) {
  if (!ts) return '—';
  const slice = ts.replace(' ', 'T').slice(11, 19);
  return slice.length === 8 ? slice : '—';
}

/**
 * Group a flat record array into renderable rows.
 * Each row = { record, traces[] } — consecutive isTrace records that immediately
 * follow a non-trace record are attached to that record's trace group.
 */
function groupIntoRows(records) {
  const rows = [];
  for (const rec of records) {
    if (rec.isTrace && rows.length > 0) {
      rows[rows.length - 1].traces.push(rec);
    } else {
      rows.push({ record: rec, traces: [] });
    }
  }
  return rows;
}

/**
 * Returns true if a record passes the current level filter.
 * - ALL:          everything including null-level records.
 * - ERROR/WARN/INFO: only records at-or-above the threshold; null-level hidden.
 */
function passesFilter(record, levelFilter) {
  if (levelFilter === 'ALL') return true;
  if (record.level === null) return false;
  return (LEVEL_ORDER[record.level] ?? 99) <= (LEVEL_ORDER[levelFilter] ?? 99);
}

// ── LogRow ─────────────────────────────────────────────────────────────────

function LogRow({ record, traces, showSource, wrap }) {
  const [expanded, setExpanded] = useState(false);
  const hasTraces = traces.length > 0;

  const ts          = formatTs(record.ts);
  const levelColor  = LEVEL_COLOR[record.level] ?? 'var(--color-ink-dim)';
  const sourceColor = SOURCE_COLOR[record.source] ?? 'var(--color-muted)';

  return (
    <>
      <div style={{
        display:    'flex',
        alignItems: 'baseline',
        gap:        '0.5em',
        padding:    '1px var(--space-3)',
        fontSize:   '0.72rem',
        lineHeight: 1.5,
        fontFamily: 'var(--font-mono)',
        minWidth:   0,
      }}>
        {/* Timestamp — muted, fixed width */}
        <span style={{ color: 'var(--color-ink-dim)', flexShrink: 0, minWidth: '7ch' }}>
          {ts}
        </span>

        {/* Level badge — color-coded, fixed width so columns align */}
        <span style={{
          color:         levelColor,
          fontWeight:    700,
          flexShrink:    0,
          minWidth:      '6ch',
          fontSize:      '0.65rem',
          letterSpacing: '0.03em',
        }}>
          {record.level ?? '·'}
        </span>

        {/* Source — shown only in 'all' mode (redundant in per-source views) */}
        {showSource && (
          <span style={{
            color:      sourceColor,
            flexShrink: 0,
            minWidth:   '10ch',
            fontSize:   '0.65rem',
          }}>
            {record.source}
          </span>
        )}

        {/* Message body */}
        <span style={{
          flex:         1,
          color:        '#ccc',
          ...(wrap
            ? { whiteSpace: 'pre-wrap', wordBreak: 'normal', overflowWrap: 'anywhere', minWidth: 0 }
            : { whiteSpace: 'pre' }),
        }}>
          {record.message || record.raw}
        </span>

        {/* Stack-trace expand/collapse toggle — default collapsed */}
        {hasTraces && (
          <button
            onClick={() => setExpanded(v => !v)}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${traces.length} stack frames`}
            style={{
              flexShrink: 0,
              background: 'none',
              border:     '1px solid var(--color-border)',
              color:      'var(--color-ink-dim)',
              fontSize:   '0.62rem',
              padding:    '0 4px',
              cursor:     'pointer',
              fontFamily: 'var(--font-mono)',
              whiteSpace: 'nowrap',
            }}
          >
            {expanded ? `▾ ${traces.length} frames` : `▸ ${traces.length} frames`}
          </button>
        )}
      </div>

      {/* Stack-trace frames — hidden by default, expand inline on click */}
      {hasTraces && expanded && traces.map((frame, i) => (
        <div
          key={i}
          style={{
            paddingLeft:  'calc(var(--space-3) + 7ch + 6ch + 1em)',
            paddingRight: 'var(--space-3)',
            fontSize:     '0.68rem',
            lineHeight:   1.4,
            color:        'var(--color-ink-faint)',
            fontFamily:   'var(--font-mono)',
            ...(wrap
              ? { whiteSpace: 'pre-wrap', wordBreak: 'normal', overflowWrap: 'anywhere' }
              : { whiteSpace: 'pre' }),
          }}
        >
          {frame.raw}
        </div>
      ))}
    </>
  );
}

// ── Main LogPanel ──────────────────────────────────────────────────────────

/**
 * Format an ISO timestamp to local HH:MM:SS for display in run-marker labels.
 */
function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], {
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * A full-width run-attempt separator row.
 *   ════ run #N · HH:MM:SS · started/restarted ════
 * Rendered inline in the merged log timeline.
 */
function RunMarkerSeparator({ label, isCurrent, markerRef }) {
  return (
    <div
      ref={markerRef}
      role="separator"
      aria-label={label}
      data-run-marker
      style={{
        display:     'flex',
        alignItems:  'center',
        padding:     '4px var(--space-3)',
        userSelect:  'none',
        color:       'var(--color-accent)',
        fontFamily:  'var(--font-mono)',
        fontSize:    '0.72rem',
        fontWeight:  isCurrent ? 700 : 400,
        opacity:     isCurrent ? 1 : 0.65,
        gap:         '0.5rem',
      }}
    >
      <span style={{ flex: 1, height: '1px', background: 'var(--color-accent)', opacity: 0.4 }} />
      <span>{'════ ' + label + ' ════'}</span>
      <span style={{ flex: 1, height: '1px', background: 'var(--color-accent)', opacity: 0.4 }} />
    </div>
  );
}

export default function LogPanel({ featureName, onClose }) {
  const [source, setSource]           = useState('backend');
  const [wrap, setWrap]               = useState(false);
  // Structured format: record objects { ts, level, source, message, isTrace, raw }.
  const [records, setRecords]         = useState([]);
  // Run-attempt markers from the gateway: { kind:'run-marker', run, ts, reason }[].
  const [markers, setMarkers]         = useState([]);
  // Legacy fallback: plain-string log body (older gateway responses with { lines }).
  const [buffer, setBuffer]           = useState('');
  const [levelFilter, setLevelFilter] = useState('ALL');
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [autoTail, setAutoTail]       = useState(true);
  const [fetchedAt, setFetchedAt]     = useState(null);
  const sentinelRef  = useRef(null);
  const latestRunRef = useRef(null);
  const dialogRef    = useRef(null);
  const prevFocusRef = useRef(null);

  // Save previously-focused element and move focus into the dialog on mount.
  useEffect(() => {
    prevFocusRef.current = document.activeElement;
    dialogRef.current?.focus();
  }, []);

  // Close the panel and restore focus to whoever opened it.
  const handleClose = useCallback(() => {
    prevFocusRef.current?.focus();
    onClose();
  }, [onClose]);

  // Keyboard handler: Escape closes; Tab wraps within the dialog's focusable set.
  function handleKeyDown(e) {
    if (e.key === 'Escape') { handleClose(); return; }
    if (e.key !== 'Tab') return;

    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusable = Array.from(
      dialog.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select, textarea',
      ),
    );
    if (focusable.length === 0) return;

    const first  = focusable[0];
    const last   = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (e.shiftKey) {
      if (active === first || active === dialog) { e.preventDefault(); last.focus(); }
    } else {
      if (active === last) { e.preventDefault(); first.focus(); }
    }
  }

  // Reset records/markers/buffer when source or feature changes.
  useEffect(() => {
    setBuffer('');
    setRecords([]);
    setMarkers([]);
    setError(null);
  }, [featureName, source]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getLogs(featureName, { source, tail: 200 });
      setFetchedAt(data.fetchedAt);
      if (Array.isArray(data.records)) {
        // Structured format: record objects (+ optional run markers).
        setRecords(data.records);
        setMarkers(data.markers ?? []);
        setBuffer('');
      } else {
        // Legacy fallback: plain-string response from an older gateway.
        setBuffer(data.lines ?? '');
        setRecords([]);
        setMarkers([]);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [featureName, source]);

  // 'build' source: SSE stream — each incoming line is parsed client-side
  // into the same record shape used by the REST path.
  useEffect(() => {
    if (source !== 'build') return;
    setLoading(true);
    setError(null);
    const es = new EventSource(`/_fleet/api/features/${featureName}/build-log`);
    es.onopen = () => {
      setLoading(false);
      setError(null); // clear any previous soft hint on successful reconnect
    };
    es.onmessage = (event) => {
      const rec = parseClientLine(event.data);
      setRecords(prev => {
        const next = [...prev, rec];
        // Cap at ~500 records so the modal stays responsive
        return next.length > 500 ? next.slice(-500) : next;
      });
      setFetchedAt(Date.now());
    };
    es.onerror = (event) => {
      console.error('[LogPanel] build-log SSE error', event);
      setLoading(false);
      // Surface a soft hint without tearing down the stream; EventSource auto-reconnects.
      // Only set if not already showing to avoid state churn during rapid retry cycles.
      setError(prev => prev ? prev : 'build log stream interrupted — reconnecting…');
    };
    return () => es.close();
  }, [featureName, source]);

  // REST polling — skipped for 'build' which uses SSE above.
  useEffect(() => {
    if (source === 'build') return;
    fetchLogs();
    if (!autoTail) return;
    const id = setInterval(fetchLogs, 3000);
    return () => clearInterval(id);
  }, [fetchLogs, autoTail, source]);

  // Auto-scroll to bottom when records change.
  // block:'end', inline:'nearest' scrolls only the vertical axis when tailing,
  // so horizontal position is preserved in no-wrap mode.
  useEffect(() => {
    if (autoTail && sentinelRef.current) {
      sentinelRef.current.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    }
  }, [buffer, records, markers, autoTail]);

  // Highest run number — identifies the "current" (latest) run for emphasis.
  const maxRun = markers.length > 0 ? Math.max(...markers.map(m => m.run)) : 0;

  // lineCount = logical events (non-trace records), NOT raw physical stack frames.
  // A 60-frame Java exception counts as 1 here because it renders as one row.
  // Falls back to physical line count for legacy plain-string responses.
  const lineCount = records.length > 0
    ? records.filter(r => !r.isTrace).length
    : (buffer ? buffer.split('\n').length : 0);

  const fetchedTime = fetchedAt ? new Date(fetchedAt).toLocaleTimeString() : '—';

  function handleClear() {
    setBuffer('');
    setRecords([]);
    setMarkers([]);
  }

  // Apply level filter, then group consecutive trace lines under their parent row.
  const filteredRecords = records.filter(r => passesFilter(r, levelFilter));
  const rows            = groupIntoRows(filteredRecords);
  const showSource      = source === 'all';
  const hasMarkers      = markers.length > 0;

  // Merge grouped rows and run markers into a single ts-sorted timeline.
  // A marker sorts before a record sharing its ts (stable ordering spec).
  const timeline = [
    ...rows.map(row => ({ _type: 'row', ts: row.record.ts, row })),
    ...markers.map(m => ({ _type: 'marker', ts: m.ts, marker: m })),
  ].sort((a, b) => {
    if (a.ts < b.ts) return -1;
    if (a.ts > b.ts) return 1;
    if (a._type === 'marker' && b._type !== 'marker') return -1;
    if (a._type !== 'marker' && b._type === 'marker') return 1;
    return 0;
  });

  return (
    <div
      role="presentation"
      onClick={handleClose}
      style={{
        position:       'fixed',
        inset:          0,
        zIndex:         100,
        background:     'rgba(0,0,0,0.85)',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
      }}
    >
      {/* Panel box — stop propagation so clicks inside don't close */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Logs — ${featureName}`}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        style={{
          width:         '860px',
          maxWidth:      '95vw',
          height:        '80dvh',
          background:    'var(--color-bg)',
          border:        '1px solid var(--color-border-strong)',
          display:       'flex',
          flexDirection: 'column',
          fontFamily:    'var(--font-mono)',
        }}
      >
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div style={{
          padding:      'var(--space-2) var(--space-3)',
          borderBottom: '1px solid var(--color-border)',
          display:      'flex',
          alignItems:   'center',
          gap:          'var(--space-2)',
          flexWrap:     'wrap',
        }}>
          <span style={{
            color:       'var(--color-accent)',
            fontSize:    '0.75rem',
            fontWeight:  700,
            marginRight: 'var(--space-1)',
          }}>
            // LOGS — {featureName}
          </span>

          {/* Source tabs — active tab gets the filled accent inversion */}
          <div style={{ display: 'flex', gap: '0.3rem' /* off-scale: 0.3rem micro-gap between tab buttons */ }}>
            {SOURCES.map(s => (
              <Button
                key={s}
                tone="primary"
                onClick={() => setSource(s)}
                aria-pressed={s === source}
                style={{
                  fontSize: '0.65rem',
                  padding:  '2px 6px',
                  ...(s === source
                    ? { background: 'var(--color-accent)', color: 'var(--color-bg-black)' }
                    : {}),
                }}
              >
                [{s.toUpperCase()}]
              </Button>
            ))}
          </div>

          {/* Level filter chips — ALL / ERROR / WARN / INFO */}
          <div style={{ display: 'flex', gap: '0.3rem', marginLeft: 'var(--space-2)' }}>
            {LEVEL_FILTERS.map(lf => (
              <Button
                key={lf}
                tone="primary"
                onClick={() => setLevelFilter(lf)}
                aria-pressed={lf === levelFilter}
                style={{
                  fontSize: '0.62rem',
                  padding:  '2px 5px',
                  ...(lf === levelFilter
                    ? {
                        background: lf === 'ALL'
                          ? 'var(--color-accent)'
                          : (LEVEL_COLOR[lf] ?? 'var(--color-accent)'),
                        color: 'var(--color-bg-black)',
                      }
                    : {
                        color: lf === 'ALL'
                          ? undefined
                          : (LEVEL_COLOR[lf] ?? undefined),
                      }),
                }}
              >
                {lf}
              </Button>
            ))}
          </div>

          <div style={{ flex: 1 }} />

          {/* Auto-tail toggle — primary (tailing), caution (paused) */}
          <Button
            tone={autoTail ? 'primary' : 'caution'}
            onClick={() => setAutoTail(v => !v)}
            aria-pressed={autoTail}
            title={autoTail ? 'Pause auto-refresh' : 'Enable auto-refresh every 3s'}
            style={{
              fontSize: '0.68rem',
              padding:  '2px 7px',
              ...(autoTail
                ? { background: 'var(--color-accent)', color: 'var(--color-bg-black)' }
                : {}),
            }}
          >
            {autoTail ? '[TAIL]' : '[PAUSED]'}
          </Button>

          {/* Wrap toggle — active (wrap on) gets filled accent treatment */}
          <Button
            tone="primary"
            onClick={() => setWrap(v => !v)}
            aria-pressed={wrap}
            title={wrap ? 'Switch to no-wrap (horizontal scroll)' : 'Switch to word-wrap mode'}
            style={{
              fontSize: '0.68rem',
              padding:  '2px 7px',
              ...(wrap
                ? { background: 'var(--color-accent)', color: 'var(--color-bg-black)' }
                : {}),
            }}
          >
            {wrap ? '[WRAP]' : '[NOWRAP]'}
          </Button>

          {/* Close — restores focus to the element that opened the panel */}
          <Button
            tone="primary"
            onClick={handleClose}
            aria-label="Close log panel"
            style={{ fontSize: '0.68rem', padding: '2px 7px' }}
          >
            [CLOSE]
          </Button>
        </div>

        {/* ── Log area ────────────────────────────────────────────────────── */}
        <div style={{
          flex:          1,
          overflow:      'hidden',
          display:       'flex',
          flexDirection: 'column',
        }}>
          {error && (
            <div
              role="alert"
              style={{
                padding:      'var(--space-15) var(--space-3)',
                background:   '#1a0000',
                color:        'var(--color-danger)',
                fontSize:     '0.72rem',
                borderBottom: '1px solid #330000',
                flexShrink:   0,
              }}
            >
              {error}
            </div>
          )}
          {loading && records.length === 0 && !buffer && (
            <div
              role="status"
              aria-live="polite"
              style={{
                padding:    'var(--space-15) var(--space-3)',
                color:      'var(--color-muted)',
                fontSize:   '0.72rem',
                flexShrink: 0,
              }}
            >
              // fetching…
            </div>
          )}

          <div style={{
            flex:               1,
            overflowY:          'auto',
            overflowX:          wrap ? undefined : 'auto',
            overscrollBehavior: 'contain',
            background:         '#050505',
            border:             '1px solid var(--color-surface-header)',
            margin:             'var(--space-2) var(--space-3) 0',
          }}>
            {records.length === 0 && buffer ? (
              /* Legacy plain-string fallback (older gateway responses). */
              <pre style={{
                margin:     0,
                padding:    'var(--space-2) var(--space-3)',
                fontSize:   '0.72rem',
                lineHeight: 1.5,
                color:      '#ccc',
                ...(wrap
                  ? { whiteSpace: 'pre-wrap', wordBreak: 'normal', overflowWrap: 'anywhere' }
                  : { whiteSpace: 'pre' }),
              }}>
                {buffer}
              </pre>
            ) : (
              <>
                {rows.length === 0 && !hasMarkers && !loading && (
                  <div style={{
                    padding:    'var(--space-2) var(--space-3)',
                    fontSize:   '0.72rem',
                    color:      'var(--color-muted)',
                    fontFamily: 'var(--font-mono)',
                  }}>
                    // no output
                  </div>
                )}

                {/* Merged timeline: run-marker separators interleaved with log rows,
                    ordered by timestamp. */}
                {timeline.map((item, i) => (
                  item._type === 'marker' ? (
                    <RunMarkerSeparator
                      key={`marker-${item.marker.run}-${item.marker.ts}`}
                      label={`run #${item.marker.run} · ${formatTime(item.marker.ts)} · ${item.marker.reason === 'started' ? 'started' : 'restarted'}`}
                      isCurrent={item.marker.run === maxRun}
                      markerRef={item.marker.run === maxRun ? latestRunRef : undefined}
                    />
                  ) : (
                    <LogRow
                      key={`row-${i}`}
                      record={item.row.record}
                      traces={item.row.traces}
                      showSource={showSource}
                      wrap={wrap}
                    />
                  )
                ))}
              </>
            )}

            <div ref={sentinelRef} />
          </div>
        </div>

        {/* ── Footer ──────────────────────────────────────────────────────── */}
        <div style={{
          padding:        'var(--space-15) var(--space-3)',
          borderTop:      '1px solid var(--color-border)',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          flexShrink:     0,
        }}>
          <span style={{ color: 'var(--color-muted)', fontSize: '0.65rem' }}>
            {/* lineCount = non-trace records (logical events), not raw physical lines */}
            {lineCount} lines | fetched {fetchedTime}
            {loading && autoTail ? ' | refreshing…' : ''}
          </span>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            {/* Jump to latest run — only shown when run markers are present */}
            {hasMarkers && maxRun > 0 && (
              <Button
                tone="primary"
                onClick={() => latestRunRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                title={`Jump to run #${maxRun}`}
                style={{ fontSize: '0.65rem', padding: '1px 6px' }}
              >
                [→ run #{maxRun}]
              </Button>
            )}
            {/* Clear — caution, not destructive: only clears the display buffer */}
            <Button
              tone="caution"
              onClick={handleClear}
              aria-label="Clear log output"
              style={{ fontSize: '0.65rem', padding: '1px 6px' }}
            >
              [CLEAR]
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
