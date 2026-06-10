/**
 * Tests for gateway/src/log-parse.js and gateway/src/run-markers.js
 *
 * Verifies parsing and marker-detection behaviour through the public API.
 * Uses Node.js built-in test runner (node:test).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseLogLine, parseLogText } from '../src/log-parse.js';
import { detectRunMarkers } from '../src/run-markers.js';

// ── parseLogLine ──────────────────────────────────────────────────────────────

describe('parseLogLine', () => {
  test('parses ISO timestamp and ERROR level from a typical Spring log line', () => {
    const raw = '2026-06-10T16:08:17.123Z  ERROR  com.gustave.Foo - NullPointerException';
    const rec = parseLogLine(raw, 'backend');

    assert.equal(rec.ts, '2026-06-10T16:08:17.123Z');
    assert.equal(rec.level, 'ERROR');
    assert.equal(rec.source, 'backend');
    assert.equal(rec.isTrace, false);
    assert.equal(rec.raw, raw);
    // message has ts and level stripped
    assert.ok(rec.message.includes('NullPointerException'), `message should contain error text, got: ${rec.message}`);
    assert.ok(!rec.message.includes('ERROR'), `message should not contain level keyword, got: ${rec.message}`);
    assert.ok(!rec.message.includes('2026-06-10'), `message should not contain timestamp, got: ${rec.message}`);
  });

  test('detects WARNING and normalises it to WARN', () => {
    const raw = '2026-06-10T10:00:00Z WARNING something degraded';
    const rec = parseLogLine(raw, 'backend');

    assert.equal(rec.level, 'WARN');
    assert.ok(rec.message.includes('something degraded'));
  });

  test('parses supervisord comma-millis timestamp format', () => {
    const raw = '2026-06-10 14:22:01,456 INFO  supervisord started';
    const rec = parseLogLine(raw, 'supervisord');

    assert.equal(rec.ts, '2026-06-10 14:22:01,456');
    assert.equal(rec.level, 'INFO');
    assert.ok(rec.message.includes('supervisord started'));
  });

  test('marks a Java stack-trace "at" frame as isTrace=true', () => {
    const raw = '\tat org.springframework.web.filter.OncePerRequestFilter.doFilter(OncePerRequestFilter.java:116)';
    const rec = parseLogLine(raw, 'backend');

    assert.equal(rec.isTrace, true);
    assert.equal(rec.ts, null);
    assert.equal(rec.level, null);
    assert.equal(rec.raw, raw);
  });

  test('marks a "... N more" continuation frame as isTrace=true', () => {
    const raw = '\t... 14 more';
    const rec = parseLogLine(raw, 'backend');
    assert.equal(rec.isTrace, true);
  });

  test('marks a "Caused by:" line as isTrace=true', () => {
    const raw = 'Caused by: java.lang.NullPointerException: id was null';
    const rec = parseLogLine(raw, 'backend');
    assert.equal(rec.isTrace, true);
  });

  test('marks a "Suppressed:" line as isTrace=true', () => {
    const raw = 'Suppressed: java.lang.RuntimeException: cleanup failed';
    const rec = parseLogLine(raw, 'backend');
    assert.equal(rec.isTrace, true);
  });

  test('returns all-null fallback for a bare unstructured line and preserves raw', () => {
    const raw = 'something completely unstructured with no timestamp or level';
    const rec = parseLogLine(raw, 'nginx');

    assert.equal(rec.ts, null);
    assert.equal(rec.level, null);
    assert.equal(rec.source, 'nginx');
    assert.equal(rec.isTrace, false);
    assert.equal(rec.raw, raw);
    // message is still set (equals the trimmed raw when nothing is stripped)
    assert.equal(rec.message, raw.trim());
  });

  test('never throws on an empty string', () => {
    assert.doesNotThrow(() => parseLogLine('', 'backend'));
  });

  test('never throws on a null-ish weird input', () => {
    assert.doesNotThrow(() => parseLogLine('   \t   ', 'backend'));
  });

  test('attaches the correct source channel', () => {
    const channels = ['backend', 'nginx', 'postgresql', 'supervisord'];
    for (const ch of channels) {
      const rec = parseLogLine('plain line', ch);
      assert.equal(rec.source, ch, `source should be ${ch}`);
    }
  });
});

// ── parseLogText ──────────────────────────────────────────────────────────────

describe('parseLogText', () => {
  test('splits on newlines and returns one record per line', () => {
    const text = '2026-06-10T16:08:17Z ERROR boom\n\tat Foo.bar(Foo.java:1)';
    const records = parseLogText(text, 'backend');

    assert.equal(records.length, 2);
    assert.equal(records[0].ts, '2026-06-10T16:08:17Z');
    assert.equal(records[0].level, 'ERROR');
    assert.equal(records[0].isTrace, false);
    assert.equal(records[1].isTrace, true);
    assert.equal(records[1].ts, null);
    assert.equal(records[1].level, null);
    assert.equal(records[1].raw, '\tat Foo.bar(Foo.java:1)');
  });

  test('drops a single trailing empty line (tail output artefact)', () => {
    const text = 'line one\nline two\n';
    const records = parseLogText(text, 'backend');
    assert.equal(records.length, 2);
    assert.equal(records[0].message, 'line one');
    assert.equal(records[1].message, 'line two');
  });

  test('returns an empty array for empty text', () => {
    assert.deepEqual(parseLogText('', 'backend'), []);
  });
});

// ── detectRunMarkers ──────────────────────────────────────────────────────────

describe('detectRunMarkers', () => {
  /** Build a minimal log record for test use */
  function rec(ts, message) {
    return { ts, level: 'INFO', source: 'backend', message, isTrace: false, raw: `${ts} INFO ${message}` };
  }

  test('returns empty array when no boot signals are present', () => {
    const records = [
      rec('2026-06-10T16:08:00Z', 'Initialising application context'),
      rec('2026-06-10T16:08:01Z', 'Loading datasource configuration'),
    ];
    assert.deepEqual(detectRunMarkers(records, {}), []);
  });

  test('yields exactly one run-marker with reason=boot for a Spring Started banner', () => {
    const records = [
      rec('2026-06-10T16:08:17Z', 'Started MyApplication in 3.456 seconds (JVM running for 4.0)'),
    ];
    const markers = detectRunMarkers(records, {});

    assert.equal(markers.length, 1);
    assert.equal(markers[0].kind, 'run-marker');
    assert.equal(markers[0].run, 1);
    assert.equal(markers[0].reason, 'boot');
    assert.equal(markers[0].ts, '2026-06-10T16:08:17Z');
  });

  test('assigns incrementing run numbers: two banners ~5 s apart yield two markers', () => {
    const records = [
      rec('2026-06-10T16:08:17Z', 'Started MyApplication in 3.0 seconds (JVM running for 3.5)'),
      rec('2026-06-10T16:08:22Z', 'Started MyApplication in 2.5 seconds (JVM running for 3.0)'),
    ];
    const markers = detectRunMarkers(records, {});

    assert.equal(markers.length, 2);
    assert.equal(markers[0].run, 1);
    assert.equal(markers[1].run, 2);
  });

  test('de-duplicates two banners within 1 s into a single run-marker', () => {
    const records = [
      rec('2026-06-10T16:08:17.000Z', 'Started MyApplication in 3.0 seconds (JVM running for 3.5)'),
      rec('2026-06-10T16:08:17.500Z', 'Tomcat started on port(s): 8080 (http)'),
    ];
    const markers = detectRunMarkers(records, {});

    assert.equal(markers.length, 1);
    assert.equal(markers[0].run, 1);
  });

  test('de-duplication boundary: events exactly 2000 ms apart are separate runs', () => {
    const records = [
      rec('2026-06-10T16:08:17.000Z', 'Started MyApplication in 1.0 seconds (JVM running for 1.5)'),
      rec('2026-06-10T16:08:19.000Z', 'Started MyApplication in 1.0 seconds (JVM running for 1.5)'),
    ];
    const markers = detectRunMarkers(records, {});
    assert.equal(markers.length, 2);
  });

  test('containerStartedAt adds a reason=started marker', () => {
    const records = [];
    const markers = detectRunMarkers(records, { containerStartedAt: '2026-06-10T16:08:00.000Z' });

    assert.equal(markers.length, 1);
    assert.equal(markers[0].kind, 'run-marker');
    assert.equal(markers[0].reason, 'started');
    assert.equal(markers[0].ts, '2026-06-10T16:08:00.000Z');
    assert.equal(markers[0].run, 1);
  });

  test('containerStartedAt and a boot banner within 2 s de-duplicate to one marker', () => {
    const records = [
      rec('2026-06-10T16:08:01Z', 'Started MyApplication in 1.0 seconds (JVM running for 1.5)'),
    ];
    const markers = detectRunMarkers(records, { containerStartedAt: '2026-06-10T16:08:00Z' });
    // 1s gap < 2000ms → same run
    assert.equal(markers.length, 1);
  });

  test('supervisord spawn message triggers a boot marker', () => {
    const records = [
      rec('2026-06-10T16:08:05Z', "spawned: 'backend' with pid 42"),
    ];
    const markers = detectRunMarkers(records, {});
    assert.equal(markers.length, 1);
    assert.equal(markers[0].reason, 'boot');
  });

  test('nginx start worker process triggers a boot marker', () => {
    const records = [
      rec('2026-06-10T16:08:05Z', 'start worker process 99'),
    ];
    const markers = detectRunMarkers(records, {});
    assert.equal(markers.length, 1);
  });

  test('records without a timestamp do not produce markers (no ts to position separator)', () => {
    const records = [
      { ts: null, level: null, source: 'backend', message: 'Started MyApplication in 1.0 seconds (JVM running for 1.5)', isTrace: false, raw: '' },
    ];
    const markers = detectRunMarkers(records, {});
    assert.equal(markers.length, 0);
  });

  test('returns empty array with no records and no containerStartedAt', () => {
    assert.deepEqual(detectRunMarkers([], {}), []);
  });
});
