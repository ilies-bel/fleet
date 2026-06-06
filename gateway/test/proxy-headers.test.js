/**
 * Tests for stripFramingHeaders — the proxy hook that removes X-Frame-Options
 * and Content-Security-Policy headers so previewed apps can be iframed in the
 * dashboard and the picker script can be injected inline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripFramingHeaders } from '../src/proxy.js';

test('removes X-Frame-Options: DENY so the app can be embedded', () => {
  const headers = { 'x-frame-options': 'DENY', 'content-type': 'text/html' };
  stripFramingHeaders(headers);
  assert.equal(headers['x-frame-options'], undefined);
  assert.equal(headers['content-type'], 'text/html'); // unrelated header preserved
});

test('removes X-Frame-Options: SAMEORIGIN', () => {
  const headers = { 'x-frame-options': 'SAMEORIGIN' };
  stripFramingHeaders(headers);
  assert.equal(headers['x-frame-options'], undefined);
});

test('removes X-Frame-Options case-insensitively', () => {
  const headers = { 'X-Frame-Options': 'DENY' };
  stripFramingHeaders(headers);
  assert.equal(headers['X-Frame-Options'], undefined);
});

test('removes Content-Security-Policy so frame-ancestors restriction is gone', () => {
  const headers = {
    'content-security-policy': "frame-ancestors 'none'; script-src 'self'",
  };
  stripFramingHeaders(headers);
  assert.equal(headers['content-security-policy'], undefined);
});

test('removes Content-Security-Policy-Report-Only', () => {
  const headers = {
    'content-security-policy-report-only': "frame-ancestors 'none'",
  };
  stripFramingHeaders(headers);
  assert.equal(headers['content-security-policy-report-only'], undefined);
});

test('removes all three framing headers in one call — mirrors the proxy hook', () => {
  // This mirrors the exact upstream response the acceptance criterion describes:
  // X-Frame-Options: DENY + CSP with frame-ancestors + script-src 'self'
  const headers = {
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'; script-src 'self'",
    'content-security-policy-report-only': "frame-ancestors 'none'",
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  };
  stripFramingHeaders(headers);
  assert.equal(headers['x-frame-options'], undefined);
  assert.equal(headers['content-security-policy'], undefined);
  assert.equal(headers['content-security-policy-report-only'], undefined);
  // Unrelated headers must survive untouched
  assert.equal(headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(headers['cache-control'], 'no-store');
});

test('leaves headers unchanged when none of the framing headers are present', () => {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  stripFramingHeaders(headers);
  assert.deepEqual(headers, { 'content-type': 'application/json', 'cache-control': 'no-store' });
});
