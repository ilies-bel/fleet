/**
 * Run-attempt boundary marker detection for Fleet feature container logs.
 *
 * Detects container (re)start events from log records and emits synthetic
 * marker objects that the UI renders as visual separators
 * ("════ run #N ════").
 *
 * This module is PURE: it takes records + optional container metadata in
 * and returns marker objects out — no I/O, no side effects, never throws.
 */

// Boot signature patterns (ordered most-specific first).
// Any match in a record's message starts a new run.
const BOOT_PATTERNS = [
  // Spring Boot application ready banner
  /Started \S+Application in [\d.]+ seconds/,
  // Tomcat connector ready
  /Tomcat started on port/,
  // supervisord spawning a managed process
  /spawned: '[^']+' with pid \d+/,
  // nginx worker startup
  /start worker process/,
  // Generic "=== … starting ===" banner (case-insensitive)
  /={3,}.*starting.*={3,}/i,
];

// Two signals whose timestamps are within this window are treated as the
// same boot event and de-duplicated.
const DEDUP_WINDOW_MS = 2000;

/**
 * Detect run-attempt boundaries in a stream of log records.
 *
 * @param {Array<{ ts: string|null, message: string }>} records
 * @param {{ containerStartedAt?: string|null }} [opts]
 * @returns {Array<{ kind: 'run-marker', run: number, ts: string, reason: string }>}
 */
export function detectRunMarkers(records, { containerStartedAt } = {}) {
  /** @type {Array<{ ts: number|null, isoTs: string|null, reason: string }>} */
  const events = [];

  // Signal 1: container-level start time from `docker inspect`
  if (containerStartedAt) {
    const t = Date.parse(containerStartedAt);
    if (!isNaN(t)) {
      events.push({ ts: t, isoTs: containerStartedAt, reason: 'started' });
    }
  }

  // Signal 2: boot banners found in log message text
  for (const rec of records) {
    if (!rec.message) continue;
    for (const pat of BOOT_PATTERNS) {
      if (pat.test(rec.message)) {
        const t = rec.ts ? Date.parse(rec.ts) : null;
        // Only emit a marker when we have a usable timestamp to position it
        if (t !== null && !isNaN(t)) {
          events.push({ ts: t, isoTs: rec.ts, reason: 'boot' });
        }
        break; // one match per record
      }
    }
  }

  if (events.length === 0) return [];

  // Sort ascending by epoch ms (events without a numeric ts sort last)
  events.sort((a, b) => {
    if (a.ts === null && b.ts === null) return 0;
    if (a.ts === null) return 1;
    if (b.ts === null) return -1;
    return a.ts - b.ts;
  });

  // De-duplicate: consecutive events within DEDUP_WINDOW_MS → same run
  const deduped = [];
  for (const ev of events) {
    if (deduped.length === 0) {
      deduped.push(ev);
      continue;
    }
    const prev = deduped[deduped.length - 1];
    const gap = (ev.ts !== null && prev.ts !== null) ? ev.ts - prev.ts : Infinity;
    if (gap >= DEDUP_WINDOW_MS) {
      deduped.push(ev);
    }
    // else: same run — discard
  }

  // Assign ascending run numbers and build the final marker objects
  return deduped.map((ev, i) => ({
    kind: 'run-marker',
    run: i + 1,
    ts: ev.isoTs ?? new Date(ev.ts).toISOString(),
    reason: ev.reason,
  }));
}
