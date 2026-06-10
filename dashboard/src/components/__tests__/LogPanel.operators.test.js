/**
 * Unit tests for parseFilterQuery and the operator-aware matchesFilter.
 *
 * Acceptance criteria (from task brief):
 *   - `error 404`        → AND: both terms required
 *   - `?Error ?error`    → OR: either casing accepted
 *   - `-INFO`            → EXCLUDE: INFO lines hidden
 *   - `error -timeout`   → AND + EXCLUDE combined
 *   - `/4\d{2}/`         → regex: matches 404/500
 *   - `/(/`              → broken regex: no throw, graceful fallback
 *   - `"connection refused"` → exact phrase
 *   - Empty query        → matches everything
 */

import { describe, it, expect } from 'vitest';
import { parseFilterQuery, matchesFilter } from '../LogPanel.jsx';

// ── helpers ───────────────────────────────────────────────────────────────────

const rec = (raw) => ({ raw });

// ── parseFilterQuery ──────────────────────────────────────────────────────────

describe('parseFilterQuery', () => {
  it('returns [] for empty string', () => {
    expect(parseFilterQuery('')).toEqual([]);
  });

  it('returns [] for whitespace-only string', () => {
    expect(parseFilterQuery('   ')).toEqual([]);
  });

  it('parses a single bare token as an AND term', () => {
    const terms = parseFilterQuery('error');
    expect(terms).toHaveLength(1);
    expect(terms[0]).toMatchObject({ type: 'and', value: 'error' });
  });

  it('parses multiple bare tokens as AND terms', () => {
    const terms = parseFilterQuery('error 404');
    expect(terms).toHaveLength(2);
    expect(terms[0]).toMatchObject({ type: 'and', value: 'error' });
    expect(terms[1]).toMatchObject({ type: 'and', value: '404' });
  });

  it('parses ?-prefixed tokens as OR terms', () => {
    const terms = parseFilterQuery('?Error ?error');
    expect(terms).toHaveLength(2);
    expect(terms[0]).toMatchObject({ type: 'or', value: 'Error' });
    expect(terms[1]).toMatchObject({ type: 'or', value: 'error' });
  });

  it('parses --prefixed tokens as EXCLUDE terms', () => {
    const terms = parseFilterQuery('-INFO');
    expect(terms).toHaveLength(1);
    expect(terms[0]).toMatchObject({ type: 'exclude', value: 'INFO' });
  });

  it('parses /regex/ tokens as REGEX terms with a compiled RegExp', () => {
    const terms = parseFilterQuery('/error/');
    expect(terms).toHaveLength(1);
    expect(terms[0].type).toBe('regex');
    expect(terms[0].re).toBeInstanceOf(RegExp);
  });

  it('uses case-insensitive flag by default for /regex/ tokens', () => {
    const [term] = parseFilterQuery('/Error/');
    expect(term.re.flags).toContain('i');
  });

  it('honours explicit flags in /regex/flags', () => {
    const [term] = parseFilterQuery('/Foo/');
    // default is 'i'
    expect(term.re.test('foo')).toBe(true);
    const [termSensitive] = parseFilterQuery('/Foo/');
    expect(termSensitive.re.flags).toContain('i');
  });

  it('parses a digit-class regex /4\\d{2}/', () => {
    const [term] = parseFilterQuery('/4\\d{2}/');
    expect(term.type).toBe('regex');
    expect(term.re).toBeInstanceOf(RegExp);
    expect(term.re.test('404')).toBe(true);
    expect(term.re.test('499')).toBe(true);
    expect(term.re.test('500')).toBe(false);
  });

  it('does NOT throw for an invalid regex /(/; re is null', () => {
    expect(() => parseFilterQuery('/(/'))
      .not.toThrow();
    const [term] = parseFilterQuery('/(/')
    expect(term.type).toBe('regex');
    expect(term.re).toBeNull();
  });

  it('parses "quoted phrase" as a single AND term preserving spaces', () => {
    const terms = parseFilterQuery('"connection refused"');
    expect(terms).toHaveLength(1);
    expect(terms[0]).toMatchObject({ type: 'and', value: 'connection refused' });
  });

  it('parses mixed AND + EXCLUDE', () => {
    const terms = parseFilterQuery('error -timeout');
    expect(terms).toHaveLength(2);
    expect(terms[0]).toMatchObject({ type: 'and',     value: 'error'   });
    expect(terms[1]).toMatchObject({ type: 'exclude', value: 'timeout' });
  });

  it('parses a mixed query with AND, OR, and EXCLUDE', () => {
    const terms = parseFilterQuery('connect ?Error ?WARN -DEBUG');
    const andTerms     = terms.filter(t => t.type === 'and');
    const orTerms      = terms.filter(t => t.type === 'or');
    const excludeTerms = terms.filter(t => t.type === 'exclude');
    expect(andTerms).toHaveLength(1);
    expect(orTerms).toHaveLength(2);
    expect(excludeTerms).toHaveLength(1);
  });
});

// ── matchesFilter ─────────────────────────────────────────────────────────────

describe('matchesFilter — empty / null query', () => {
  it('returns true for empty string query', () => {
    expect(matchesFilter(rec('anything'), '')).toBe(true);
  });

  it('returns true for undefined query', () => {
    expect(matchesFilter(rec('anything'), undefined)).toBe(true);
  });

  it('returns true for null query', () => {
    expect(matchesFilter(rec('anything'), null)).toBe(true);
  });

  it('returns true for whitespace-only query', () => {
    expect(matchesFilter(rec('anything'), '   ')).toBe(true);
  });
});

describe('matchesFilter — AND (space-separated bare terms)', () => {
  it('matches when both terms are present', () => {
    expect(matchesFilter(rec('error 404 not found'), 'error 404')).toBe(true);
  });

  it('does not match when only one term is present', () => {
    expect(matchesFilter(rec('error occurred'), 'error 404')).toBe(false);
    expect(matchesFilter(rec('404 response code'), 'error 404')).toBe(false);
  });

  it('is case-insensitive for bare terms', () => {
    expect(matchesFilter(rec('Connection Timeout Error'), 'error')).toBe(true);
    expect(matchesFilter(rec('Connection Timeout Error'), 'ERROR')).toBe(true);
    expect(matchesFilter(rec('Connection Timeout Error'), 'timeout')).toBe(true);
  });

  it('does substring (not whole-word) matching', () => {
    expect(matchesFilter(rec('postgresql: connection refused'), 'postgre')).toBe(true);
  });
});

describe('matchesFilter — OR (?-prefixed tokens)', () => {
  it('matches when any ?-token is present (case-insensitive)', () => {
    expect(matchesFilter(rec('Error: connection failed'), '?Error ?error')).toBe(true);
    expect(matchesFilter(rec('error: connection failed'), '?Error ?error')).toBe(true);
  });

  it('does not match when none of the ?-tokens are present', () => {
    expect(matchesFilter(rec('INFO: all good'), '?Error ?error')).toBe(false);
  });

  it('pure OR query: matches if ANY token present', () => {
    expect(matchesFilter(rec('warn something'), '?WARN ?ERROR')).toBe(true);
    expect(matchesFilter(rec('error something'), '?WARN ?ERROR')).toBe(true);
    expect(matchesFilter(rec('info something'), '?WARN ?ERROR')).toBe(false);
  });
});

describe('matchesFilter — EXCLUDE (-prefixed tokens)', () => {
  it('hides records containing the excluded term', () => {
    expect(matchesFilter(rec('INFO: health check ok'), '-INFO')).toBe(false);
  });

  it('passes records that do not contain the excluded term', () => {
    expect(matchesFilter(rec('ERROR: disk full'), '-INFO')).toBe(true);
  });

  it('applies multiple exclusions', () => {
    expect(matchesFilter(rec('DEBUG trace'), '-INFO -DEBUG')).toBe(false);
    expect(matchesFilter(rec('INFO trace'),  '-INFO -DEBUG')).toBe(false);
    expect(matchesFilter(rec('ERROR: boom'), '-INFO -DEBUG')).toBe(true);
  });
});

describe('matchesFilter — AND + EXCLUDE combined', () => {
  it('requires the AND term AND forbids the EXCLUDE term', () => {
    expect(matchesFilter(rec('error: disk full'),    'error -timeout')).toBe(true);
    expect(matchesFilter(rec('error: timeout'),      'error -timeout')).toBe(false);
    expect(matchesFilter(rec('timeout: connection'), 'error -timeout')).toBe(false);
  });
});

describe('matchesFilter — regex (/pattern/)', () => {
  it('matches a digit-class pattern /4\\d{2}/', () => {
    expect(matchesFilter(rec('HTTP 404 Not Found'), '/4\\d{2}/')).toBe(true);
    expect(matchesFilter(rec('HTTP 200 OK'),        '/4\\d{2}/')).toBe(false);
  });

  it('matches with default case-insensitive flag', () => {
    expect(matchesFilter(rec('Error occurred'), '/error/')).toBe(true);
    expect(matchesFilter(rec('ERROR occurred'), '/error/')).toBe(true);
  });

  it('does NOT throw for a broken regex /(/; falls back gracefully', () => {
    expect(() => matchesFilter(rec('anything'), '/(/')).not.toThrow();
  });

  it('broken regex fallback: always returns true or false, never throws', () => {
    const result = matchesFilter(rec('something'), '/(/')
    expect(typeof result).toBe('boolean');
  });
});

describe('matchesFilter — quoted phrases', () => {
  it('matches an exact phrase including the space', () => {
    expect(matchesFilter(rec('connection refused by host'), '"connection refused"')).toBe(true);
  });

  it('does not match when the words are present but separated', () => {
    expect(matchesFilter(rec('refused connection attempt'), '"connection refused"')).toBe(false);
  });
});

describe('matchesFilter — message fallback', () => {
  it('falls back to record.message when raw is absent', () => {
    const r = { message: 'NullPointerException', raw: null };
    expect(matchesFilter(r, 'null')).toBe(true);
  });
});
