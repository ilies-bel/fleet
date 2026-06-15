import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from 'react';
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

/** Sparkline block chars — index 0=lightest (▁), 7=full (█) */
const SPARK_CHARS         = '▁▂▃▄▅▆▇█';
/** Number of 30-second buckets in the error-rate sparkline (10 × 30 s = 5 min) */
const SPARKLINE_BUCKETS   = 10;
const SPARKLINE_BUCKET_MS = 30_000;
/** Rolling window for ev/s (milliseconds) */
const INGEST_WINDOW_MS    = 10_000;

/**
 * Five-slot highlight palette. Each entry references CSS vars declared in
 * index.css — background tint + accessible foreground for the #050505 log area.
 */
const HIGHLIGHT_PALETTE = [
  { bg: 'var(--log-hl-1-bg)', fg: 'var(--log-hl-1-fg)' },
  { bg: 'var(--log-hl-2-bg)', fg: 'var(--log-hl-2-fg)' },
  { bg: 'var(--log-hl-3-bg)', fg: 'var(--log-hl-3-fg)' },
  { bg: 'var(--log-hl-4-bg)', fg: 'var(--log-hl-4-fg)' },
  { bg: 'var(--log-hl-5-bg)', fg: 'var(--log-hl-5-fg)' },
];

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

/**
 * Tokenise a filter query string into raw tokens, handling:
 *   - "quoted phrases" (spaces preserved)
 *   - /regex/flags tokens
 *   - plain words (which may carry a - or ? prefix)
 *
 * @param {string} str
 * @returns {string[]}
 */
function tokenizeQuery(str) {
  const tokens = [];
  let i = 0;
  const len = str.length;

  while (i < len) {
    // Skip whitespace
    while (i < len && /\s/.test(str[i])) i++;
    if (i >= len) break;

    if (str[i] === '"') {
      // Quoted phrase: "..."
      const start = i;
      i++; // skip opening "
      while (i < len && str[i] !== '"') i++;
      if (i < len) i++; // skip closing "
      tokens.push(str.slice(start, i));
    } else if (str[i] === '/') {
      // Regex: /pattern/ or /pattern/flags
      const start = i;
      i++; // skip opening /
      while (i < len) {
        if (str[i] === '\\') { i += 2; continue; } // skip escape sequence
        if (str[i] === '/') break;
        i++;
      }
      if (i < len) {
        i++; // skip closing /
        // Consume regex flags (g, i, m, s, u, y)
        while (i < len && /[gimsuy]/.test(str[i])) i++;
      }
      tokens.push(str.slice(start, i));
    } else {
      // Plain word token (may carry - or ? prefix)
      const start = i;
      while (i < len && !/\s/.test(str[i])) i++;
      tokens.push(str.slice(start, i));
    }
  }

  return tokens;
}

/**
 * Parse a CloudWatch-style filter query string into a structured term list.
 *
 * Supported syntax:
 *   - `a b`          — AND: record must contain BOTH "a" and "b" (space-separated)
 *   - `?x ?y`        — OR:  if any ?-prefixed tokens present, at least one must match
 *   - `-x`           — EXCLUDE: record must NOT contain "x"
 *   - `/regex/flags` — REGEX: tested as a JS RegExp (defaults to case-insensitive)
 *   - `"exact phrase"` — AND: the literal phrase including spaces
 *   - Mixed: bare tokens are ANDed; ?-tokens form one OR set; -tokens are excluded.
 *
 * An invalid regex never throws — it degrades to a literal substring match.
 *
 * @param {string} str
 * @returns {{ type: 'and'|'or'|'exclude'|'regex', value: string, re?: RegExp|null }[]}
 */
export function parseFilterQuery(str) {
  if (!str || !str.trim()) return [];

  const tokens = tokenizeQuery(str.trim());
  const terms = [];

  for (const token of tokens) {
    if (!token) continue;

    if (token.startsWith('/') && token.length > 1) {
      // Regex token: /pattern/ or /pattern/flags
      // Use lastIndexOf so that escaped slashes inside the pattern don't mislead.
      const lastSlash = token.lastIndexOf('/');
      if (lastSlash > 0) {
        const pattern = token.slice(1, lastSlash);
        const flagsStr = token.slice(lastSlash + 1);
        // Default to case-insensitive when no flags are specified.
        const effectiveFlags = flagsStr || 'i';
        let re = null;
        try {
          re = new RegExp(pattern, effectiveFlags);
        } catch {
          // Invalid pattern or flags — re stays null; matchesFilter falls back to literal.
        }
        terms.push({ type: 'regex', value: token, re });
      } else {
        // Single leading slash with no closing slash — treat as a literal AND term.
        terms.push({ type: 'and', value: token });
      }

    } else if (token.startsWith('-') && token.length > 1) {
      // Exclusion: -term or -"phrase"
      const raw = token.slice(1);
      const value = raw.startsWith('"') && raw.endsWith('"') && raw.length > 2
        ? raw.slice(1, -1)
        : raw;
      terms.push({ type: 'exclude', value });

    } else if (token.startsWith('?') && token.length > 1) {
      // OR group: ?term or ?"phrase"
      const raw = token.slice(1);
      const value = raw.startsWith('"') && raw.endsWith('"') && raw.length > 2
        ? raw.slice(1, -1)
        : raw;
      terms.push({ type: 'or', value });

    } else if (token.startsWith('"')) {
      // Quoted phrase (AND semantics)
      const value = token.endsWith('"') && token.length > 2
        ? token.slice(1, -1)
        : token.slice(1);
      if (value) terms.push({ type: 'and', value });

    } else {
      // Plain AND term
      terms.push({ type: 'and', value: token });
    }
  }

  return terms;
}

/**
 * Returns true if a record matches the text filter query.
 * Supports CloudWatch-style operator syntax via parseFilterQuery:
 *   - space = AND, ?prefix = OR group, -prefix = exclude, /re/ = regex, "..." = phrase
 *
 * Falls back to simple substring matching for plain single-word queries,
 * preserving exact backward-compatibility with the previous implementation.
 *
 * @param {{ raw?: string, message?: string }} record
 * @param {string | undefined | null} query
 */
export function matchesFilter(record, query) {
  if (!query) return true;
  const trimmed = query.trim();
  if (!trimmed) return true;

  const terms = parseFilterQuery(trimmed);
  if (terms.length === 0) return true;

  const raw = record.raw ?? record.message ?? '';
  const text = raw.toLowerCase();

  // AND terms: every one must be present.
  for (const term of terms) {
    if (term.type === 'and' && !text.includes(term.value.toLowerCase())) {
      return false;
    }
  }

  // OR terms: if any exist, at least one must match.
  const orTerms = terms.filter(t => t.type === 'or');
  if (orTerms.length > 0) {
    if (!orTerms.some(t => text.includes(t.value.toLowerCase()))) {
      return false;
    }
  }

  // EXCLUDE terms: none may match.
  for (const term of terms) {
    if (term.type === 'exclude' && text.includes(term.value.toLowerCase())) {
      return false;
    }
  }

  // REGEX terms (AND semantics): each must match the original (un-lowercased) text.
  for (const term of terms) {
    if (term.type === 'regex') {
      if (term.re !== null) {
        term.re.lastIndex = 0; // reset stateful (g/y) regexes before test
        if (!term.re.test(raw)) return false;
      } else {
        // Invalid regex — fall back to case-insensitive literal substring.
        if (!text.includes(term.value.toLowerCase())) return false;
      }
    }
  }

  return true;
}

/**
 * Apply text filter to a level-filtered record array.
 * Trace records pass through iff their immediately preceding parent record
 * matched — so filtering by an error message keeps that error's stack frames
 * available to expand.
 *
 * @param {object[]} records
 * @param {string} query
 */
export function applyTextFilter(records, query) {
  const trimmed = (query ?? '').trim();
  if (!trimmed) return records;
  const result = [];
  let lastParentMatched = false;
  for (const rec of records) {
    if (rec.isTrace) {
      if (lastParentMatched) result.push(rec);
    } else {
      lastParentMatched = matchesFilter(rec, trimmed);
      if (lastParentMatched) result.push(rec);
    }
  }
  return result;
}

/**
 * Split text into React nodes, wrapping each highlight match in a colored
 * <mark> span. compiledHighlights is an array of { term, colorIndex, re }
 * produced by useMemo — re.lastIndex is reset before each use.
 *
 * Returns the original string (unchanged) when there are no highlights or no
 * matches, avoiding unnecessary node creation.
 *
 * @param {string} text
 * @param {{ term: string, colorIndex: number, re: RegExp }[]} compiledHighlights
 */
function highlightText(text, compiledHighlights) {
  if (!text || compiledHighlights.length === 0) return text;

  // Collect all match intervals from all terms.
  const intervals = [];
  for (const h of compiledHighlights) {
    h.re.lastIndex = 0;
    let m;
    while ((m = h.re.exec(text)) !== null) {
      intervals.push({ start: m.index, end: m.index + m[0].length, colorIndex: h.colorIndex, matched: m[0] });
      if (m[0].length === 0) { h.re.lastIndex++; break; } // guard against zero-width matches
    }
  }
  if (intervals.length === 0) return text;

  // Sort by start position; resolve overlaps by keeping the first match.
  intervals.sort((a, b) => a.start - b.start || b.end - a.end);
  const noOverlap = [];
  let lastEnd = 0;
  for (const iv of intervals) {
    if (iv.start >= lastEnd) {
      noOverlap.push(iv);
      lastEnd = iv.end;
    }
  }

  // Build the React node array — plain strings interspersed with <mark> spans.
  const nodes = [];
  let pos = 0;
  for (const { start, end, colorIndex, matched } of noOverlap) {
    if (start > pos) nodes.push(text.slice(pos, start));
    const { bg, fg } = HIGHLIGHT_PALETTE[colorIndex % HIGHLIGHT_PALETTE.length];
    nodes.push(
      <mark key={`hl-${start}`} style={{ background: bg, color: fg }}>
        {matched}
      </mark>
    );
    pos = end;
  }
  if (pos < text.length) nodes.push(text.slice(pos));

  return nodes;
}

// ── EventInspector ─────────────────────────────────────────────────────────

/**
 * Detail panel for a pinned log record.
 *
 * Two layouts:
 *   inline=false (default) → full-width bottom drawer in the log area, with a
 *     drag handle on its top edge to resize height. The log list keeps its full
 *     horizontal width above it, so wide stack traces are readable.
 *   inline=true            → inline block rendered directly below the selected
 *     row (narrow-width fallback when there isn't room for a drawer).
 *
 * @param {object}   props
 * @param {object}   props.record   Parent log record { ts, level, source, message, raw }.
 * @param {object[]} props.traces   Attached stack-frame records.
 * @param {() => void} props.onClose
 * @param {boolean}  [props.inline]   Render the narrow inline variant.
 * @param {number}   [props.height]   Drawer pixel height (drawer variant only).
 * @param {(e: React.PointerEvent) => void} [props.onResizeStart] Drag-handle pointerdown.
 */
function EventInspector({ record, traces, onClose, inline, height, onResizeStart }) {
  const closeButtonRef = useRef(null);

  // Focus the close button whenever a new record is selected.
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, [record]);

  function handleCopy() {
    if (!navigator.clipboard) {
      console.warn('[EventInspector] clipboard API unavailable');
      return;
    }
    // Copy the full event: parent line plus every attached stack frame.
    const text = [record.raw, ...(traces ?? []).map(t => t.raw)].join('\n');
    navigator.clipboard.writeText(text).catch(err => {
      console.warn('[EventInspector] copy failed', err);
    });
  }

  // Format full local timestamp (date + time) for the inspector header.
  let fullTs = '—';
  if (record.ts) {
    try {
      fullTs = new Date(record.ts.replace(' ', 'T')).toLocaleString(undefined, {
        year:   'numeric',
        month:  'short',
        day:    'numeric',
        hour:   '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      fullTs = record.ts;
    }
  }

  const levelColor  = LEVEL_COLOR[record.level]  ?? 'var(--color-ink-dim)';
  const sourceColor = SOURCE_COLOR[record.source] ?? 'var(--color-muted)';

  // Header summary line: LEVEL · source · full timestamp. The message itself is
  // shown verbatim in the raw block below, so it is not duplicated as a field.
  const header = (
    <div style={{
      display:       'flex',
      alignItems:    'center',
      gap:           '0.6em',
      flexShrink:    0,
      paddingBottom: '0.45em',
      borderBottom:  '1px solid var(--color-border)',
      marginBottom:  '0.55em',
    }}>
      <span style={{
        color:         levelColor,
        fontWeight:    700,
        flexShrink:    0,
        fontSize:      '0.7rem',
        letterSpacing: '0.04em',
      }}>
        {record.level ?? '·'}
      </span>
      <span style={{ color: 'var(--color-ink-faint)', flexShrink: 0 }}>·</span>
      <span style={{ color: sourceColor, flexShrink: 0, fontSize: '0.68rem' }}>
        {record.source}
      </span>
      <span style={{ color: 'var(--color-ink-faint)', flexShrink: 0 }}>·</span>
      <span style={{
        color:        'var(--color-ink-dim)',
        flex:         1,
        overflow:     'hidden',
        textOverflow: 'ellipsis',
        whiteSpace:   'nowrap',
        fontSize:     '0.68rem',
      }}>
        {fullTs}
      </span>
      <button
        onClick={handleCopy}
        title="Copy event + stack frames"
        style={{
          flexShrink: 0,
          background: 'none',
          border:     '1px solid var(--color-border)',
          color:      'var(--color-ink-dim)',
          cursor:     'pointer',
          fontSize:   '0.62rem',
          padding:    '1px 7px',
          fontFamily: 'var(--font-mono)',
        }}
      >
        [copy]
      </button>
      <button
        ref={closeButtonRef}
        onClick={onClose}
        aria-label="Close inspector"
        style={{
          flexShrink: 0,
          background: 'none',
          border:     'none',
          color:      'var(--color-ink-dim)',
          cursor:     'pointer',
          fontSize:   '1rem',
          padding:    '0 2px',
          lineHeight: 1,
          fontFamily: 'var(--font-mono)',
        }}
      >
        ×
      </button>
    </div>
  );

  // The raw event line — the primary message text, selectable.
  const rawBlock = (
    <pre style={{
      margin:     '0 0 0.55em',
      padding:    '0.45em 0.6em',
      background: 'rgba(0,0,0,0.4)',
      border:     '1px solid var(--color-border)',
      fontSize:   '0.7rem',
      lineHeight: 1.45,
      color:      'var(--color-ink)',
      whiteSpace: 'pre-wrap',
      wordBreak:  'break-word',
      userSelect: 'text',
      flexShrink: 0,
    }}>
      {record.raw}
    </pre>
  );

  // Stack frames — the part that most needs horizontal room. In the drawer it
  // scrolls in both axes; in the inline fallback it wraps.
  const traceBlock = traces && traces.length > 0 && (
    <div style={{
      flex:      1,
      minHeight: 0,
      overflowY: 'auto',
      overflowX: inline ? undefined : 'auto',
      border:    '1px solid var(--color-border)',
      background: 'rgba(0,0,0,0.25)',
    }}>
      <div style={{
        position:     'sticky',
        top:          0,
        zIndex:       1,
        background:   '#0c0c14',
        color:        'var(--color-ink-dim)',
        fontSize:     '0.62rem',
        padding:      '0.25em 0.6em',
        borderBottom: '1px solid var(--color-border)',
      }}>
        {traces.length} stack frame{traces.length !== 1 ? 's' : ''}
      </div>
      {traces.map((frame, i) => (
        <div
          key={i}
          style={{
            fontSize:   '0.68rem',
            lineHeight: 1.45,
            color:      'var(--color-muted)',
            padding:    '0 0.6em',
            userSelect: 'text',
            fontFamily: 'var(--font-mono)',
            ...(inline
              ? { whiteSpace: 'pre-wrap', wordBreak: 'break-all' }
              : { whiteSpace: 'pre' }),
          }}
        >
          {frame.raw}
        </div>
      ))}
    </div>
  );

  if (inline) {
    return (
      <div style={{
        borderTop:     '1px solid var(--color-border)',
        background:    'rgba(20,20,40,0.6)',
        padding:       '0.5em var(--space-3)',
        fontFamily:    'var(--font-mono)',
        fontSize:      '0.7rem',
        display:       'flex',
        flexDirection: 'column',
        maxHeight:     '50vh',
      }}>
        {header}
        {rawBlock}
        {traceBlock}
      </div>
    );
  }

  // Drawer variant — docked along the bottom, full width, resizable height.
  return (
    <div style={{
      height:        height,
      flexShrink:    0,
      borderTop:     '1px solid var(--color-border-strong)',
      background:    '#090912',
      fontFamily:    'var(--font-mono)',
      fontSize:      '0.7rem',
      display:       'flex',
      flexDirection: 'column',
      minHeight:     0,
    }}>
      {/* Drag handle — pointer-driven vertical resize of the drawer. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize event detail"
        onPointerDown={onResizeStart}
        style={{
          flexShrink:  0,
          height:      '9px',
          cursor:      'ns-resize',
          display:     'flex',
          alignItems:  'center',
          justifyContent: 'center',
          background:  'var(--color-surface-header)',
          borderBottom: '1px solid var(--color-border)',
          userSelect:  'none',
          touchAction: 'none',
        }}
      >
        <span style={{ color: 'var(--color-ink-faint)', fontSize: '0.6rem', lineHeight: 1 }}>
          ⋯
        </span>
      </div>
      <div style={{
        flex:          1,
        minHeight:     0,
        display:       'flex',
        flexDirection: 'column',
        padding:       'var(--space-2) var(--space-3)',
      }}>
        {header}
        {rawBlock}
        {traceBlock}
      </div>
    </div>
  );
}

// ── LogRow ─────────────────────────────────────────────────────────────────

function LogRow({ record, traces, showSource, wrap, compiledHighlights, onSelect, isSelected }) {
  const [expanded, setExpanded] = useState(false);
  const hasTraces = traces.length > 0;

  const ts          = formatTs(record.ts);
  const levelColor  = LEVEL_COLOR[record.level] ?? 'var(--color-ink-dim)';
  const sourceColor = SOURCE_COLOR[record.source] ?? 'var(--color-muted)';

  const messageText     = record.message || record.raw;
  const renderedMessage = highlightText(messageText, compiledHighlights);

  function handleClick() {
    onSelect?.(record);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      onSelect?.(record);
    }
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        aria-label={`Inspect log event: ${(record.message || record.raw).slice(0, 80)}`}
        aria-pressed={isSelected}
        style={{
        display:    'flex',
        alignItems: 'baseline',
        gap:        '0.5em',
        padding:    '1px var(--space-3)',
        fontSize:   '0.72rem',
        lineHeight: 1.5,
        fontFamily: 'var(--font-mono)',
        minWidth:   0,
        cursor:     'pointer',
        outline:    'none',
        borderLeft: isSelected
          ? '2px solid var(--color-accent)'
          : '2px solid transparent',
        background: isSelected
          ? 'rgba(100,200,255,0.06)'
          : 'transparent',
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
          {renderedMessage}
        </span>

        {/* Stack-trace expand/collapse toggle — stopPropagation so the row click does NOT fire */}
        {hasTraces && (
          <button
            onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
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
          {highlightText(frame.raw, compiledHighlights)}
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
  const [autoTail, setAutoTail]       = useState(false);
  const [fetchedAt, setFetchedAt]     = useState(null);

  // ── Throughput / error-rate tracking ─────────────────────────────────────
  /** Smoothed events/sec figure shown in the footer (pre-filter ingest) */
  const [evPerSec, setEvPerSec]         = useState(0);
  /**
   * ERROR counts per SPARKLINE_BUCKET_MS bucket, oldest→newest.
   * Tracks pre-filter ingest (unaffected by active filter).
   */
  const [errorBuckets, setErrorBuckets] = useState(() => Array(SPARKLINE_BUCKETS).fill(0));

  // ── Filter / highlight state ──────────────────────────────────────────────
  /** Raw value of the filter text input (debounced before applying) */
  const [filterInput, setFilterInput]         = useState('');
  /** Debounced filter — 150ms delay to avoid filtering on every keystroke */
  const [debouncedFilter, setDebouncedFilter] = useState('');
  /** Controlled value of the "type to add" highlight input */
  const [highlightInput, setHighlightInput]   = useState('');
  /**
   * Active highlight terms: [{ term: string, colorIndex: number }]
   * colorIndex cycles through HIGHLIGHT_PALETTE (0–4 wrapping).
   */
  const [highlightTerms, setHighlightTerms]   = useState([]);
  /** Monotonically-incrementing counter — drives palette cycling on add */
  const nextColorRef = useRef(0);

  // ── Ingest-tracking refs ────────────────────────────────────────────────
  /**
   * Rolling window entries for ev/s: [{ t: performance.now(), count: number }].
   * Entries older than INGEST_WINDOW_MS are culled on each 1 s tick.
   */
  const ingestWindowRef   = useRef([]);
  /**
   * Map<bucketKey, errorCount> — bucketKey = floor(wallMs / SPARKLINE_BUCKET_MS).
   * Keys older than SPARKLINE_BUCKETS are pruned on each ingest.
   */
  const errorBucketMapRef = useRef(new Map());
  /**
   * REST-polling watermark — how many records the previous fetch returned.
   * -1 = uninitialized (first fetch: skip to avoid bulk-load spike).
   */
  const restWatermarkRef  = useRef(-1);

  // Inspector: { record, traces } snapshot pinned by clicking a row; null = closed.
  const [selectedRow, setSelectedRow] = useState(null);
  // isNarrow: dialog width < 560px → inline fallback instead of bottom drawer.
  const [isNarrow, setIsNarrow]       = useState(false);
  // Bottom-drawer height in px (drawer variant). Clamped on drag to [120, area-120].
  const [drawerHeight, setDrawerHeight] = useState(260);

  const sentinelRef  = useRef(null);
  const latestRunRef = useRef(null);
  const dialogRef    = useRef(null);
  const prevFocusRef = useRef(null);
  // Live geometry for the drawer drag — captured on pointerdown.
  const logAreaRef   = useRef(null);
  const dragRef      = useRef(null);

  // Drawer resize: pointer-driven, pinned to window so the drag survives a
  // fast cursor leaving the handle. Clamps so neither pane collapses below 120px.
  const handleDrawerResizeStart = useCallback((e) => {
    e.preventDefault();
    const areaH = logAreaRef.current?.getBoundingClientRect().height ?? 0;
    dragRef.current = { startY: e.clientY, startH: drawerHeight, areaH };
    const onMove = (ev) => {
      const d = dragRef.current;
      if (!d) return;
      // Drag up (smaller clientY) grows the drawer.
      const next = d.startH + (d.startY - ev.clientY);
      const max  = Math.max(120, d.areaH - 120);
      setDrawerHeight(Math.min(max, Math.max(120, next)));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [drawerHeight]);

  // Save previously-focused element and move focus into the dialog on mount.
  useEffect(() => {
    prevFocusRef.current = document.activeElement;
    dialogRef.current?.focus();
  }, []);

  // Track dialog width via ResizeObserver for narrow/wide layout switching.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0;
      setIsNarrow(w < 560);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Close the panel and restore focus to whoever opened it.
  const handleClose = useCallback(() => {
    prevFocusRef.current?.focus();
    onClose();
  }, [onClose]);

  // Keyboard handler:
  //   Escape → close inspector first (if open), then close the modal.
  //   Tab    → wrap within the dialog's focusable set.
  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      if (selectedRow) { setSelectedRow(null); return; }
      handleClose();
      return;
    }
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

  // Reset records/markers/buffer/selection when source or feature changes.
  useEffect(() => {
    setBuffer('');
    setRecords([]);
    setMarkers([]);
    setError(null);
    setSelectedRow(null);
    ingestWindowRef.current   = [];
    errorBucketMapRef.current = new Map();
    restWatermarkRef.current  = -1;
    setEvPerSec(0);
    setErrorBuckets(Array(SPARKLINE_BUCKETS).fill(0));
  }, [featureName, source]);

  // Debounce filter input — 150ms
  useEffect(() => {
    const id = setTimeout(() => setDebouncedFilter(filterInput), 150);
    return () => clearTimeout(id);
  }, [filterInput]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getLogs(featureName, { source, tail: 200 });
      setFetchedAt(data.fetchedAt);
      if (Array.isArray(data.records)) {
        // Structured format: record objects (+ optional run markers).
        // Track ingest delta vs previous fetch; skip the initial bulk load.
        const prevWatermark = restWatermarkRef.current;
        restWatermarkRef.current = data.records.length;
        if (prevWatermark >= 0) {
          const delta = Math.max(0, data.records.length - prevWatermark);
          if (delta > 0) {
            const newNonTrace = data.records.slice(-delta).filter(r => !r.isTrace);
            if (newNonTrace.length > 0) {
              ingestWindowRef.current.push({ t: performance.now(), count: newNonTrace.length });
              const errCount = newNonTrace.filter(r => r.level === 'ERROR').length;
              if (errCount > 0) {
                const nowMs = performance.timeOrigin + performance.now();
                const bucketKey = Math.floor(nowMs / SPARKLINE_BUCKET_MS);
                const map = errorBucketMapRef.current;
                map.set(bucketKey, (map.get(bucketKey) ?? 0) + errCount);
                const oldestKey = bucketKey - SPARKLINE_BUCKETS + 1;
                for (const k of [...map.keys()]) {
                  if (k < oldestKey) map.delete(k);
                }
              }
            }
          }
        }
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
      // Track ingest: pre-filter, non-trace records only.
      if (!rec.isTrace) {
        ingestWindowRef.current.push({ t: performance.now(), count: 1 });
        if (rec.level === 'ERROR') {
          const nowMs = performance.timeOrigin + performance.now();
          const bucketKey = Math.floor(nowMs / SPARKLINE_BUCKET_MS);
          const map = errorBucketMapRef.current;
          map.set(bucketKey, (map.get(bucketKey) ?? 0) + 1);
          const oldestKey = bucketKey - SPARKLINE_BUCKETS + 1;
          for (const k of [...map.keys()]) {
            if (k < oldestKey) map.delete(k);
          }
        }
      }
      setRecords(prev => {
        const next = [...prev, rec];
        // Cap at ~500 records so the modal stays responsive
        return next.length > 500 ? next.slice(-500) : next;
      });
      setFetchedAt(performance.timeOrigin + performance.now());
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

  // 1-second tick — recompute ev/s and error sparkline from ingest refs.
  useEffect(() => {
    const id = setInterval(() => {
      const now = performance.now();
      // Cull entries that have aged out of the rolling window.
      ingestWindowRef.current = ingestWindowRef.current.filter(
        e => now - e.t < INGEST_WINDOW_MS,
      );
      // ev/s = total events in window / window duration (seconds).
      const total = ingestWindowRef.current.reduce((s, e) => s + e.count, 0);
      setEvPerSec(Math.round((total / (INGEST_WINDOW_MS / 1000)) * 10) / 10);

      // Rebuild sparkline: most-recent bucket is rightmost.
      const nowMs = performance.timeOrigin + performance.now();
      const nowBucket = Math.floor(nowMs / SPARKLINE_BUCKET_MS);
      const buckets = Array.from({ length: SPARKLINE_BUCKETS }, (_, i) => {
        const key = nowBucket - (SPARKLINE_BUCKETS - 1 - i);
        return errorBucketMapRef.current.get(key) ?? 0;
      });
      setErrorBuckets(buckets);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Auto-scroll to bottom when records change.
  // block:'end', inline:'nearest' scrolls only the vertical axis when tailing,
  // so horizontal position is preserved in no-wrap mode.
  useEffect(() => {
    if (autoTail && sentinelRef.current) {
      sentinelRef.current.scrollIntoView({ behavior: 'auto', block: 'end', inline: 'nearest' });
    }
  }, [buffer, records, markers, autoTail]);

  // Highest run number — identifies the "current" (latest) run for emphasis.
  const maxRun = markers.length > 0 ? Math.max(...markers.map(m => m.run)) : 0;

  function handleClear() {
    setBuffer('');
    setRecords([]);
    setMarkers([]);
    setSelectedRow(null);
    ingestWindowRef.current   = [];
    errorBucketMapRef.current = new Map();
    restWatermarkRef.current  = -1;
    setEvPerSec(0);
    setErrorBuckets(Array(SPARKLINE_BUCKETS).fill(0));
  }

  function addHighlightTerm(term) {
    const trimmed = term.trim();
    if (!trimmed) return;
    // Deduplicate case-insensitively
    if (highlightTerms.some(h => h.term.toLowerCase() === trimmed.toLowerCase())) return;
    const colorIndex = nextColorRef.current;
    nextColorRef.current++;
    setHighlightTerms(prev => [...prev, { term: trimmed, colorIndex }]);
    setHighlightInput('');
  }

  function removeHighlightTerm(term) {
    setHighlightTerms(prev => prev.filter(h => h.term !== term));
  }

  // ── Derived filtered state ────────────────────────────────────────────────

  // Level filter applied first.
  const levelFiltered = useMemo(
    () => records.filter(r => passesFilter(r, levelFilter)),
    [records, levelFilter],
  );

  // Text filter applied second (AND with level filter).
  // Trace records follow their parent — they pass iff the parent matched.
  const textFiltered = useMemo(
    () => applyTextFilter(levelFiltered, debouncedFilter),
    [levelFiltered, debouncedFilter],
  );

  // Group consecutive trace lines under their parent row.
  const rows = useMemo(() => groupIntoRows(textFiltered), [textFiltered]);

  /**
   * Precomputed highlight regexes — stable per term-set; one object per term.
   * re.lastIndex is reset before each use in highlightText/termCounts.
   */
  const compiledHighlights = useMemo(() =>
    highlightTerms
      .filter(({ term }) => term.trim().length > 0)
      .map(({ term, colorIndex }) => ({
        term,
        colorIndex,
        re: new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
      })),
    [highlightTerms],
  );

  /**
   * Per-term occurrence count across the currently-visible (filtered) records.
   * Recomputed only when the term set or visible records change.
   */
  const termCounts = useMemo(() => {
    if (compiledHighlights.length === 0) return [];
    return compiledHighlights.map(({ term, colorIndex, re }) => {
      let count = 0;
      for (const rec of textFiltered) {
        const text = rec.raw || rec.message || '';
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          count++;
          if (m[0].length === 0) { re.lastIndex++; break; }
        }
      }
      return { term, colorIndex, count };
    });
  }, [compiledHighlights, textFiltered]);

  // Merge grouped rows and run markers into a single ts-sorted timeline.
  // A marker sorts before a record sharing its ts (stable ordering spec).
  const showSource = source === 'all';
  const hasMarkers = markers.length > 0;

  const timeline = useMemo(() => [
    ...rows.map(row => ({ _type: 'row', ts: row.record.ts, row })),
    ...markers.map(m => ({ _type: 'marker', ts: m.ts, marker: m })),
  ].sort((a, b) => {
    if (a.ts < b.ts) return -1;
    if (a.ts > b.ts) return 1;
    if (a._type === 'marker' && b._type !== 'marker') return -1;
    if (a._type !== 'marker' && b._type === 'marker') return 1;
    return 0;
  }), [rows, markers]);

  // Footer counts — total = all records before text filter (pre-filter baseline).
  // Falls back to physical line count for legacy plain-string responses.
  const totalLineCount    = records.length > 0
    ? records.filter(r => !r.isTrace).length
    : (buffer ? buffer.split('\n').length : 0);
  const filteredLineCount = textFiltered.filter(r => !r.isTrace).length;

  const fetchedTime = fetchedAt ? new Date(fetchedAt).toLocaleTimeString() : '—';

  // ── Footer throughput / sparkline derived values ──────────────────────────
  // ev/s shows pre-filter ingest rate; '—' when autoTail is paused.
  const displayEvPerSec = autoTail
    ? (evPerSec < 0.05
        ? '0 ev/s'
        : `${evPerSec < 10 ? evPerSec.toFixed(1) : Math.round(evPerSec)} ev/s`)
    : '—';

  const hasAnyErrors = errorBuckets.some(v => v > 0);
  const _errMax      = Math.max(...errorBuckets, 1);
  // Sparkline: space for zero-count buckets; block char scaled to max bucket value.
  // Pre-filter ERROR ingest (counts before level/text filter).
  const sparklineStr = errorBuckets
    .map(v => v === 0 ? ' ' : SPARK_CHARS[Math.max(0, Math.round((v / _errMax) * 8) - 1)])
    .join('');

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
          width:         '1100px',
          maxWidth:      '96vw',
          height:        '88dvh',
          background:    'var(--color-bg)',
          border:        '1px solid var(--color-border-strong)',
          display:       'flex',
          flexDirection: 'column',
          fontFamily:    'var(--font-mono)',
        }}
      >
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div style={{
          padding:       'var(--space-2) var(--space-3)',
          borderBottom:  '1px solid var(--color-border)',
          display:       'flex',
          flexDirection: 'column',
          gap:           'var(--space-15)',
        }}>
          {/* Row 1: title · source tabs · level filters · spacer · TAIL · CLOSE */}
          <div style={{
            display:    'flex',
            alignItems: 'center',
            gap:        'var(--space-2)',
            flexWrap:   'wrap',
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
            <div style={{ display: 'flex', gap: '0.3rem' }}>
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

          {/* Row 2: filter input · highlight chip area + input */}
          <div style={{
            display:    'flex',
            alignItems: 'center',
            gap:        'var(--space-2)',
            flexWrap:   'wrap',
          }}>
            {/* Filter text input — debounced 150ms */}
            <input
              type="text"
              placeholder="filter…"
              value={filterInput}
              onChange={e => setFilterInput(e.target.value)}
              aria-label="Filter log lines"
              style={{
                background: 'transparent',
                border:     '1px solid var(--color-border)',
                color:      'var(--color-ink)',
                fontFamily: 'var(--font-mono)',
                fontSize:   '0.68rem',
                padding:    '2px 6px',
                width:      '220px',
                outline:    'none',
              }}
            />

            {/* Highlight chip area + "highlight…" input */}
            <div style={{
              display:    'flex',
              alignItems: 'center',
              gap:        '0.3rem',
              flexWrap:   'wrap',
              flex:       1,
            }}>
              {/* Removable chips — one per active highlight term */}
              {termCounts.map(({ term, colorIndex, count }) => {
                const { bg, fg } = HIGHLIGHT_PALETTE[colorIndex % HIGHLIGHT_PALETTE.length];
                return (
                  <span
                    key={term}
                    style={{
                      display:    'inline-flex',
                      alignItems: 'center',
                      gap:        '0.25em',
                      background: bg,
                      color:      fg,
                      fontFamily: 'var(--font-mono)',
                      fontSize:   '0.62rem',
                      padding:    '1px 4px',
                      border:     `1px solid ${fg}`,
                    }}
                  >
                    <span>{term} ×{count}</span>
                    <button
                      onClick={() => removeHighlightTerm(term)}
                      aria-label={`Remove highlight: ${term}`}
                      style={{
                        background: 'none',
                        border:     'none',
                        color:      'inherit',
                        cursor:     'pointer',
                        fontFamily: 'inherit',
                        fontSize:   'inherit',
                        padding:    '0 1px',
                        lineHeight: 1,
                      }}
                    >
                      ×
                    </button>
                  </span>
                );
              })}

              {/* "highlight…" input — press Enter to add a term */}
              <input
                type="text"
                placeholder="highlight…"
                value={highlightInput}
                onChange={e => setHighlightInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.stopPropagation(); // prevent dialog-level keyDown from firing
                    addHighlightTerm(highlightInput);
                  }
                }}
                aria-label="Add highlight term, press Enter to add"
                style={{
                  background: 'transparent',
                  border:     '1px solid var(--color-border)',
                  color:      'var(--color-ink)',
                  fontFamily: 'var(--font-mono)',
                  fontSize:   '0.68rem',
                  padding:    '2px 6px',
                  width:      '160px',
                  outline:    'none',
                }}
              />
            </div>
          </div>
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

          {/* ── List + inspector split ────────────────────────────────────── */}
          {/* On wide widths: full-width list above, detail in a bottom drawer.*/}
          {/* On narrow widths: full-width list; inspector appears inline.     */}
          <div
            ref={logAreaRef}
            style={{
              flex:       1,
              overflow:   'hidden',
              display:    'flex',
              flexDirection: 'column',
              background: '#050505',
              border:     '1px solid var(--color-surface-header)',
              margin:     'var(--space-2) var(--space-3) 0',
            }}
          >
            {/* Scrollable log list */}
            <div style={{
              flex:               1,
              overflowY:          'auto',
              overflowX:          wrap ? undefined : 'auto',
              overscrollBehavior: 'contain',
              minWidth:           0,
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
                      {debouncedFilter
                        ? `// no lines match ${debouncedFilter}`
                        : '// no output'}
                    </div>
                  )}

                  {/* Merged timeline: run-marker separators interleaved with log rows,
                      ordered by timestamp. */}
                  {timeline.map((item, i) => {
                    if (item._type === 'marker') {
                      return (
                        <RunMarkerSeparator
                          key={`marker-${item.marker.run}-${item.marker.ts}`}
                          label={`run #${item.marker.run} · ${formatTime(item.marker.ts)} · ${item.marker.reason === 'started' ? 'started' : 'restarted'}`}
                          isCurrent={item.marker.run === maxRun}
                          markerRef={item.marker.run === maxRun ? latestRunRef : undefined}
                        />
                      );
                    }

                    // Pin by object identity — stable across SSE appends.
                    const isSelected = selectedRow !== null &&
                      item.row.record === selectedRow.record;

                    return (
                      <Fragment key={`row-${i}`}>
                        <LogRow
                          record={item.row.record}
                          traces={item.row.traces}
                          showSource={showSource}
                          wrap={wrap}
                          compiledHighlights={compiledHighlights}
                          isSelected={isSelected}
                          onSelect={rec => setSelectedRow({ record: rec, traces: item.row.traces })}
                        />
                        {/* Narrow fallback: inline inspector below the selected row */}
                        {isSelected && isNarrow && selectedRow && (
                          <EventInspector
                            record={selectedRow.record}
                            traces={selectedRow.traces}
                            onClose={() => setSelectedRow(null)}
                            inline
                          />
                        )}
                      </Fragment>
                    );
                  })}
                </>
              )}

              <div ref={sentinelRef} />
            </div>

            {/* Wide-mode bottom drawer — only when an event is selected and not narrow */}
            {selectedRow && !isNarrow && (
              <EventInspector
                record={selectedRow.record}
                traces={selectedRow.traces}
                onClose={() => setSelectedRow(null)}
                height={drawerHeight}
                onResizeStart={handleDrawerResizeStart}
              />
            )}
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
          {/* Left: line count · ev/s · optional sparkline · fetched time */}
          <span style={{
            color:      'var(--color-muted)',
            fontSize:   '0.65rem',
            display:    'flex',
            alignItems: 'center',
            gap:        '0.5em',
            minWidth:   0,
          }}>
            <span>
              {/* "N of M lines" when text-filter active; plain "N lines" otherwise */}
              {debouncedFilter
                ? `${filteredLineCount} of ${totalLineCount} lines`
                : `${totalLineCount} lines`
              }
              {' | '}
              {/* ev/s: pre-filter ingest rate. Shows "—" when tail is paused. */}
              {displayEvPerSec}
              {' | fetched '}{fetchedTime}
              {loading && autoTail ? ' | refreshing…' : ''}
            </span>
            {/* Error-rate sparkline — hidden on narrow widths.
                ERROR count per 30 s bucket, last 5 min (pre-filter ingest).
                Tints var(--color-danger) on errors; muted/faint when quiet. */}
            {!isNarrow && (
              <span
                title={`ERROR count per 30 s, last ${SPARKLINE_BUCKETS * 30} s — pre-filter ingest`}
                aria-label={`Error sparkline: ${errorBuckets.join(',')}`}
                style={{
                  fontFamily:    'var(--font-mono)',
                  letterSpacing: 0,
                  color:         hasAnyErrors ? 'var(--color-danger)' : 'var(--color-muted)',
                  opacity:       hasAnyErrors ? 1 : 0.3,
                  minWidth:      '10ch',
                  display:       'inline-block',
                  userSelect:    'none',
                }}
              >
                {sparklineStr}
              </span>
            )}
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
