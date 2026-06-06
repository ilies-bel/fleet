/**
 * Persistent operations log store backed by SQLite (better-sqlite3).
 *
 * openLogStore()  — call once at gateway boot before mounting the router.
 * startOperation  — record the start of an operation; returns the row id.
 * endOperation    — update outcome/ended_at/reason_code for a previously started row.
 * listOperations  — query recent rows in camelCase form.
 * getOperation    — fetch a single row by id, or null if not found.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** @type {import('better-sqlite3').Database | null} */
let db = null;

let retentionDays = 30;
let lastPruneAt = 0;
const PRUNE_INTERVAL_MS = 60_000;

/** @internal — counts prune executions since last __resetPruneClock(); test use only. */
export let __pruneCount = 0;

/**
 * Open (or re-open) the log database.
 * Reads process.env.FLEET_LOG_DB; defaults to /var/lib/fleet/log.db.
 * Reads process.env.FLEET_LOG_RETENTION_DAYS as a positive number; defaults to 30.
 * Safe to call multiple times (idempotent table creation via IF NOT EXISTS).
 * Runs a forward-compatible migration to add the reason_code column when
 * opening a database that predates this change.
 */
export function openLogStore() {
  const dbPath = process.env.FLEET_LOG_DB ?? '/var/lib/fleet/log.db';
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);

  const parsed = Number(process.env.FLEET_LOG_RETENTION_DAYS);
  retentionDays = (Number.isFinite(parsed) && parsed > 0) ? parsed : 30;

  db.exec(`
    CREATE TABLE IF NOT EXISTS operations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      kind          TEXT    NOT NULL,
      key           TEXT    NOT NULL,
      started_at    INTEGER NOT NULL,
      ended_at      INTEGER,
      outcome       TEXT,
      error_message TEXT,
      reason_code   TEXT
    );
    CREATE TABLE IF NOT EXISTS operation_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id INTEGER NOT NULL,
      ts           INTEGER NOT NULL,
      type         TEXT    NOT NULL,
      data         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_operations_started_at
      ON operations(started_at DESC);
  `);

  // Forward-compatible migration: add reason_code to databases created before
  // this column existed. PRAGMA table_info is the safest way to detect the gap.
  const cols = db.prepare('PRAGMA table_info(operations)').all();
  const hasReasonCode = cols.some(c => c.name === 'reason_code');
  if (!hasReasonCode) {
    db.exec('ALTER TABLE operations ADD COLUMN reason_code TEXT');
  }
}

/**
 * Insert a new in-flight operation row.
 * Rate-limited pruning (at most once per 60 s) deletes rows older than
 * retentionDays inside the same transaction as the INSERT.
 * @param {{ kind: string, key: string }} opts
 * @returns {number}  The inserted row id.
 */
export function startOperation({ kind, key }) {
  if (Date.now() - lastPruneAt > PRUNE_INTERVAL_MS) {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    db.transaction(() => {
      db.prepare(
        'DELETE FROM operation_events WHERE operation_id IN (SELECT id FROM operations WHERE started_at < ?)',
      ).run(cutoff);
      db.prepare('DELETE FROM operations WHERE started_at < ?').run(cutoff);
    })();
    lastPruneAt = Date.now();
    __pruneCount += 1;
  }

  const startedAt = Date.now();
  const result = db
    .prepare('INSERT INTO operations (kind, key, started_at) VALUES (?, ?, ?)')
    .run(kind, key, startedAt);
  return Number(result.lastInsertRowid);
}

/**
 * Finalise an operation row with its outcome.
 * Reads err.reasonCode (set by DockerSocketError/DockerContainerError constructors
 * or by tagError()) and persists it to the reason_code column.
 *
 * @param {number} id
 * @param {{ outcome: string, error?: Error | null }} opts
 */
export function endOperation(id, { outcome, error = null } = {}) {
  const endedAt = Date.now();
  const errorMessage = error?.message ?? null;
  const reasonCode = error?.reasonCode ?? null;
  db
    .prepare(
      'UPDATE operations SET ended_at = ?, outcome = ?, error_message = ?, reason_code = ? WHERE id = ?',
    )
    .run(endedAt, outcome, errorMessage, reasonCode, id);
}

/**
 * Map a raw SQLite row to the public camelCase shape.
 * @param {object} row
 */
function rowToOperation(row) {
  return {
    id: row.id,
    kind: row.kind,
    key: row.key,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
    errorMessage: row.error_message,
    reasonCode: row.reason_code,
  };
}

/**
 * Return recent operations ordered by started_at DESC.
 * @param {{ limit?: number }} opts
 * @returns {Array<{id,kind,key,startedAt,endedAt,outcome,errorMessage,reasonCode}>}
 */
export function listOperations({ limit = 100 } = {}) {
  return db
    .prepare(
      `SELECT id, kind, key, started_at, ended_at, outcome, error_message, reason_code
       FROM operations
       ORDER BY started_at DESC, id DESC
       LIMIT ?`,
    )
    .all(limit)
    .map(rowToOperation);
}

/**
 * Return failure clusters grouped by reason_code for the given look-back window.
 * Rows with NULL ended_at (still in-flight) are excluded.
 * @param {{ sinceMs?: number }} opts   sinceMs defaults to 24 h ago.
 * @returns {Array<{reasonCode,count,lastSeenAt,sampleKeys}>}
 */
export function listFailureClusters({ sinceMs } = {}) {
  const since = sinceMs ?? (Date.now() - 24 * 60 * 60 * 1000);
  return db
    .prepare(
      `SELECT reason_code                  AS reasonCode,
              COUNT(*)                     AS count,
              MAX(ended_at)                AS lastSeenAt,
              GROUP_CONCAT(DISTINCT key)   AS sampleKeys
       FROM operations
       WHERE outcome = 'failure' AND ended_at >= ?
       GROUP BY reason_code
       ORDER BY count DESC`,
    )
    .all(since)
    .map(row => ({
      reasonCode: row.reasonCode,
      count: Number(row.count),
      lastSeenAt: row.lastSeenAt,
      sampleKeys: row.sampleKeys ? row.sampleKeys.split(',').slice(0, 5) : [],
    }));
}

/**
 * Fetch a single operation by id.
 * @param {number} id
 * @returns {{id,kind,key,startedAt,endedAt,outcome,errorMessage,reasonCode} | null}
 */
export function getOperation(id) {
  const row = db
    .prepare(
      'SELECT id, kind, key, started_at, ended_at, outcome, error_message, reason_code FROM operations WHERE id = ?',
    )
    .get(id);
  return row ? rowToOperation(row) : null;
}

/** @internal — resets prune rate-limit clock and counter; call in test beforeEach. */
export function __resetPruneClock() {
  lastPruneAt = 0;
  __pruneCount = 0;
}

/** @internal — returns the raw DB handle; test use only. */
export function __getDb() {
  return db;
}
