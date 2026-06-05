/**
 * Persistent operations log store backed by SQLite (better-sqlite3).
 *
 * openLogStore()  — call once at gateway boot before mounting the router.
 * startOperation  — record the start of an operation; returns the row id.
 * endOperation    — update outcome/ended_at for a previously started row.
 * listOperations  — query recent rows in camelCase form.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** @type {import('better-sqlite3').Database | null} */
let db = null;

/**
 * Open (or re-open) the log database.
 * Reads process.env.FLEET_LOG_DB; defaults to /var/lib/fleet/log.db.
 * Safe to call multiple times (idempotent table creation via IF NOT EXISTS).
 */
export function openLogStore() {
  const dbPath = process.env.FLEET_LOG_DB ?? '/var/lib/fleet/log.db';
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS operations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      kind          TEXT    NOT NULL,
      key           TEXT    NOT NULL,
      started_at    INTEGER NOT NULL,
      ended_at      INTEGER,
      outcome       TEXT,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_operations_started_at
      ON operations(started_at DESC);
  `);
}

/**
 * Insert a new in-flight operation row.
 * @param {{ kind: string, key: string }} opts
 * @returns {number}  The inserted row id.
 */
export function startOperation({ kind, key }) {
  const startedAt = Date.now();
  const result = db
    .prepare('INSERT INTO operations (kind, key, started_at) VALUES (?, ?, ?)')
    .run(kind, key, startedAt);
  return Number(result.lastInsertRowid);
}

/**
 * Finalise an operation row with its outcome.
 * @param {number} id
 * @param {{ outcome: string, error?: Error | null }} opts
 */
export function endOperation(id, { outcome, error = null } = {}) {
  const endedAt = Date.now();
  const errorMessage = error?.message ?? null;
  db
    .prepare(
      'UPDATE operations SET ended_at = ?, outcome = ?, error_message = ? WHERE id = ?',
    )
    .run(endedAt, outcome, errorMessage, id);
}

/**
 * Return recent operations ordered by started_at DESC.
 * @param {{ limit?: number }} opts
 * @returns {Array<{id,kind,key,startedAt,endedAt,outcome,errorMessage}>}
 */
export function listOperations({ limit = 100 } = {}) {
  return db
    .prepare(
      `SELECT id, kind, key, started_at, ended_at, outcome, error_message
       FROM operations
       ORDER BY started_at DESC, id DESC
       LIMIT ?`,
    )
    .all(limit)
    .map(row => ({
      id: row.id,
      kind: row.kind,
      key: row.key,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      outcome: row.outcome,
      errorMessage: row.error_message,
    }));
}
