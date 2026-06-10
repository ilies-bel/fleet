/**
 * Log line parser for Fleet feature container logs.
 *
 * Parses raw supervisor log text into structured records with timestamp,
 * log level, source channel, message (with ts/level stripped), stack-trace
 * flag, and the unmodified original line.
 *
 * Both exports are PURE: no I/O, no side effects, never throws.
 */

// Matches ISO-8601 timestamps at the start of a line:
//   YYYY-MM-DDTHH:MM:SS          (bare)
//   YYYY-MM-DDTHH:MM:SS.fff      (millis, dot separator)
//   YYYY-MM-DD HH:MM:SS,mmm      (supervisord format, space+comma separator)
//   ...optionally followed by Z or ±HH:MM timezone offset
// The trailing \s* consumes any whitespace that separates the ts from the rest.
const TS_RE = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:\d{2})?)\s*/;

// Level keyword search.  Only inspect the first 40 chars of the post-ts
// remainder to avoid false positives deep inside a message body.
// WARNING is normalised to WARN.
const LEVEL_RE = /\b(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/;

// Stack-trace continuation frame patterns (Java / Node.js):
//   "  at org.Foo.bar(Foo.java:12)"
//   "  ... 5 more"
//   "Caused by: java.lang.SomeException"
//   "Suppressed: ..."
const TRACE_RE = /^(?:\s+at\s|\s+\.\.\. \d+ more|Caused by:|Suppressed:)/;

/**
 * Parse a single raw log line into a structured record.
 *
 * @param {string} rawLine  - the original unmodified log line
 * @param {string} source   - the channel name (backend|nginx|postgresql|supervisord)
 * @returns {{
 *   ts:      string|null,
 *   level:   'ERROR'|'WARN'|'INFO'|'DEBUG'|'TRACE'|null,
 *   source:  string,
 *   message: string,
 *   isTrace: boolean,
 *   raw:     string,
 * }}
 */
export function parseLogLine(rawLine, source) {
  try {
    let rest = rawLine;
    let ts = null;
    let level = null;

    // 1. Extract timestamp from line start
    const tsMatch = TS_RE.exec(rest);
    if (tsMatch) {
      ts = tsMatch[1];
      rest = rest.slice(tsMatch[0].length);
    }

    // 2. Extract level from first 40 chars of the remaining text
    const levelSearch = rest.slice(0, 40);
    const levelMatch = LEVEL_RE.exec(levelSearch);
    if (levelMatch) {
      const word = levelMatch[1];
      level = word === 'WARNING' ? 'WARN' : word;
      // Remove the level token from rest (levelSearch is a prefix of rest so
      // indices match directly)
      rest = rest.slice(0, levelMatch.index) + rest.slice(levelMatch.index + levelMatch[0].length);
      // Strip leading whitespace / common log separators that surrounded the token
      rest = rest.replace(/^[\s\-:|]+/, '');
    }

    // 3. Detect stack-trace continuation lines
    const isTrace = TRACE_RE.test(rawLine);

    // 4. Message is whatever remains after ts/level removal, trimmed
    const message = rest.trim();

    return { ts, level, source, message, isTrace, raw: rawLine };
  } catch {
    // Never throw on a weird line — fall back to a null-everything record
    return { ts: null, level: null, source, message: rawLine, isTrace: false, raw: rawLine };
  }
}

/**
 * Parse a block of log text into an array of structured records.
 * Splits on newlines and drops a single trailing empty line (tail artefact).
 *
 * @param {string} text   - raw log text (newline-separated lines)
 * @param {string} source - the channel name
 * @returns {ReturnType<parseLogLine>[]}
 */
export function parseLogText(text, source) {
  const lines = text.split('\n');
  // Drop a single trailing empty line produced by `tail -n N`
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.map(line => parseLogLine(line, source));
}
