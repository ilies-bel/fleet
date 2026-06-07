/**
 * Behaviour tests for the shared formatTime utilities.
 *
 * Uses fake system time so thresholds are deterministic regardless of when
 * the suite runs.  relativeTime and absoluteTime are tested through their
 * public interface only — the internal arithmetic is invisible to the tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { relativeTime, absoluteTime } from '../formatTime.js';

const NOW = 1700000000000; // 2023-11-14T22:13:20.000Z — a fixed "now"

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('relativeTime', () => {
  it('returns "—" for null', () => {
    expect(relativeTime(null)).toBe('—');
  });

  it('returns "—" for undefined', () => {
    expect(relativeTime(undefined)).toBe('—');
  });

  it('returns "—" for empty string', () => {
    expect(relativeTime('')).toBe('—');
  });

  it('returns "just now" when the timestamp is less than 60 seconds ago', () => {
    expect(relativeTime(NOW - 30_000)).toBe('just now');
  });

  it('returns "just now" for the exact current instant', () => {
    expect(relativeTime(NOW)).toBe('just now');
  });

  it('returns "1 min ago" for exactly 60 seconds ago', () => {
    expect(relativeTime(NOW - 60_000)).toBe('1 min ago');
  });

  it('returns "5 min ago" for 5 minutes ago', () => {
    expect(relativeTime(NOW - 5 * 60_000)).toBe('5 min ago');
  });

  it('returns "1 hour ago" for exactly 1 hour ago', () => {
    expect(relativeTime(NOW - 3_600_000)).toBe('1 hour ago');
  });

  it('returns "2 hours ago" for 2 hours ago', () => {
    expect(relativeTime(NOW - 2 * 3_600_000)).toBe('2 hours ago');
  });

  it('returns "1 day ago" for exactly 24 hours ago', () => {
    expect(relativeTime(NOW - 86_400_000)).toBe('1 day ago');
  });

  it('returns "3 days ago" for 3 days ago', () => {
    expect(relativeTime(NOW - 3 * 86_400_000)).toBe('3 days ago');
  });

  it('accepts a numeric epoch timestamp', () => {
    expect(relativeTime(NOW - 90_000)).toBe('1 min ago');
  });

  it('accepts an ISO string timestamp', () => {
    const iso = new Date(NOW - 120_000).toISOString();
    expect(relativeTime(iso)).toBe('2 min ago');
  });
});

describe('absoluteTime', () => {
  it('returns an empty string for null', () => {
    expect(absoluteTime(null)).toBe('');
  });

  it('returns an empty string for undefined', () => {
    expect(absoluteTime(undefined)).toBe('');
  });

  it('returns an empty string for empty string', () => {
    expect(absoluteTime('')).toBe('');
  });

  it('returns a non-empty string for a valid timestamp', () => {
    const result = absoluteTime(NOW);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes the year "2023" in the formatted string for a 2023 timestamp', () => {
    // 2023-11-14T22:13:20.000Z
    const result = absoluteTime(NOW);
    expect(result).toMatch(/2023/);
  });
});
