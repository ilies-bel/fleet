/**
 * Shared timestamp formatting utilities for the Operations UI.
 *
 * Dependency-free — uses only the built-in Date API so there is no extra
 * bundle weight.  Both functions are pure (no side effects) and safe to call
 * with any falsy value.
 */

/**
 * Format a timestamp as a human-relative string suitable for display.
 *
 * Thresholds:
 *   < 60 s   → "just now"
 *   < 60 min → "N min ago"  (singular: "1 min ago")
 *   < 24 h   → "N hour(s) ago"
 *   else     → "N day(s) ago"
 *
 * @param {string|number|null|undefined} ts - ISO string or epoch milliseconds.
 * @returns {string} Human-readable relative time, or '—' for falsy input.
 */
export function relativeTime(ts) {
  if (!ts) return '—';
  const deltaSecs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (deltaSecs < 60) return 'just now';
  const mins = Math.floor(deltaSecs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/**
 * Format a timestamp as a full absolute datetime string for use in a
 * `title` attribute (tooltip on hover).
 *
 * Uses the browser/Node locale so the exact format adapts to the user's
 * locale settings, e.g. "11/14/2023, 10:13:20 PM".
 *
 * @param {string|number|null|undefined} ts - ISO string or epoch milliseconds.
 * @returns {string} Locale-formatted absolute timestamp, or '' for falsy input.
 */
export function absoluteTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}
