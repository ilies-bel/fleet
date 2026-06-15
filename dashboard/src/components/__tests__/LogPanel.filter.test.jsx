/**
 * Filter / highlight tests for LogPanel.
 *
 * Verifies:
 *   1. matchesFilter — pure predicate, case-insensitive substring on raw field
 *   2. applyTextFilter — trace-group preservation, AND with level filter
 *   3. The single combined input filters visible rows and updates the footer
 *   4. Empty-result placeholder shown when no rows match
 *   5. The same input also highlights the typed text inside surviving rows
 *      (single term, single colour — the "filter + highlight the same text"
 *      behaviour).
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import LogPanel, { matchesFilter, applyTextFilter } from '../LogPanel.jsx';
import { getLogs } from '../../api.js';

// jsdom does not implement scrollIntoView — stub it.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock('../../api.js', () => ({
  getLogs: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

// ── Pure-function unit tests ──────────────────────────────────────────────────

const makeRecord = (overrides = {}) => ({
  ts:      '2024-01-01T00:00:00Z',
  level:   'INFO',
  source:  'backend',
  message: 'hello world',
  isTrace: false,
  raw:     'hello world',
  ...overrides,
});

describe('matchesFilter', () => {
  it('returns true when query is empty string', () => {
    expect(matchesFilter(makeRecord(), '')).toBe(true);
  });

  it('returns true when query is undefined/null', () => {
    expect(matchesFilter(makeRecord(), undefined)).toBe(true);
    expect(matchesFilter(makeRecord(), null)).toBe(true);
  });

  it('matches case-insensitively against the raw field', () => {
    const rec = makeRecord({ raw: 'Connection timeout Error' });
    expect(matchesFilter(rec, 'error')).toBe(true);
    expect(matchesFilter(rec, 'ERROR')).toBe(true);
    expect(matchesFilter(rec, 'TIMEOUT')).toBe(true);
  });

  it('returns false when raw does not contain the query', () => {
    const rec = makeRecord({ raw: 'hello world' });
    expect(matchesFilter(rec, 'timeout')).toBe(false);
  });

  it('falls back to message when raw is absent', () => {
    const rec = { ...makeRecord(), raw: null, message: 'NullPointerException' };
    expect(matchesFilter(rec, 'null')).toBe(true);
  });

  it('performs substring (not whole-word) matching', () => {
    const rec = makeRecord({ raw: 'postgresql: connection refused' });
    expect(matchesFilter(rec, 'postgre')).toBe(true);
    expect(matchesFilter(rec, 'refused')).toBe(true);
  });
});

describe('applyTextFilter', () => {
  it('returns all records when query is empty', () => {
    const records = [makeRecord(), makeRecord({ raw: 'foo' })];
    expect(applyTextFilter(records, '')).toEqual(records);
  });

  it('returns all records when query is whitespace only', () => {
    const records = [makeRecord(), makeRecord({ raw: 'bar' })];
    expect(applyTextFilter(records, '   ')).toEqual(records);
  });

  it('hides records that do not match the query', () => {
    const rec1 = makeRecord({ raw: 'connection timeout' });
    const rec2 = makeRecord({ raw: 'request completed 200' });
    expect(applyTextFilter([rec1, rec2], 'timeout')).toEqual([rec1]);
  });

  it('keeps trace records whose parent matched', () => {
    const parent = makeRecord({ raw: 'ERROR: NullPointerException', isTrace: false });
    const frame1 = makeRecord({ raw: '\tat com.example.Foo.bar(Foo.java:42)', isTrace: true });
    const frame2 = makeRecord({ raw: '\tat com.example.Main.main(Main.java:10)', isTrace: true });
    const result = applyTextFilter([parent, frame1, frame2], 'NullPointerException');
    expect(result).toEqual([parent, frame1, frame2]);
  });

  it('drops trace records whose parent did not match', () => {
    const parent = makeRecord({ raw: 'DEBUG: heartbeat ok', isTrace: false });
    const frame  = makeRecord({ raw: '\tat com.example.Foo.bar(Foo.java:42)', isTrace: true });
    expect(applyTextFilter([parent, frame], 'ERROR')).toEqual([]);
  });

  it('correctly handles mixed matching: matched parent keeps its traces, non-matching parent drops its traces', () => {
    const p1 = makeRecord({ raw: 'ERROR: boom', isTrace: false });
    const t1 = makeRecord({ raw: '\tat Foo.bar', isTrace: true });
    const p2 = makeRecord({ raw: 'INFO: all good', isTrace: false });
    const t2 = makeRecord({ raw: '\tat Bar.baz', isTrace: true });
    expect(applyTextFilter([p1, t1, p2, t2], 'ERROR')).toEqual([p1, t1]);
  });
});

// ── Component integration tests ───────────────────────────────────────────────

function makeLogResponse(messages) {
  return {
    records: messages.map((msg, i) => ({
      ts:      `2024-01-01T00:00:${String(i).padStart(2, '0')}Z`,
      level:   'INFO',
      source:  'backend',
      message: msg,
      isTrace: false,
      raw:     msg,
    })),
    markers:   [],
    fetchedAt: 1704067200000,
  };
}

const FILTER_PLACEHOLDER = 'filter & highlight';

describe('LogPanel — combined filter + highlight input', () => {
  it('renders a single combined filter + highlight input in the header', async () => {
    getLogs.mockResolvedValue(makeLogResponse(['hello']));
    render(<LogPanel featureName="test" onClose={() => {}} />);
    expect(screen.getByPlaceholderText(FILTER_PLACEHOLDER)).toBeInTheDocument();
    // The old separate "highlight…" input must be gone.
    expect(screen.queryByPlaceholderText('highlight…')).not.toBeInTheDocument();
  });

  it('hides rows that do not match the filter text', async () => {
    getLogs.mockResolvedValue(makeLogResponse(['connection timeout', 'request ok 200']));
    render(<LogPanel featureName="test" onClose={() => {}} />);

    await waitFor(() => screen.getByText(/connection timeout/));

    const input = screen.getByPlaceholderText(FILTER_PLACEHOLDER);
    await act(async () => {
      fireEvent.change(input, { target: { value: 'timeout' } });
      // advance past 150ms debounce
      await new Promise(r => setTimeout(r, 200));
    });

    expect(screen.getByText(/connection/)).toBeInTheDocument();
    expect(screen.queryByText(/request ok 200/)).not.toBeInTheDocument();
  });

  it('shows "N of M lines" in the footer when a filter is active', async () => {
    getLogs.mockResolvedValue(makeLogResponse(['alpha', 'beta', 'gamma']));
    render(<LogPanel featureName="test" onClose={() => {}} />);

    await waitFor(() => screen.getByText('alpha'));

    const input = screen.getByPlaceholderText(FILTER_PLACEHOLDER);
    await act(async () => {
      fireEvent.change(input, { target: { value: 'alpha' } });
      await new Promise(r => setTimeout(r, 200));
    });

    expect(screen.getByText(/1 of 3 lines/)).toBeInTheDocument();
  });

  it('shows the empty-result placeholder when no rows match', async () => {
    getLogs.mockResolvedValue(makeLogResponse(['hello world']));
    render(<LogPanel featureName="test" onClose={() => {}} />);

    await waitFor(() => screen.getByText('hello world'));

    const input = screen.getByPlaceholderText(FILTER_PLACEHOLDER);
    await act(async () => {
      fireEvent.change(input, { target: { value: 'xxxxxxxx' } });
      await new Promise(r => setTimeout(r, 200));
    });

    expect(screen.getByText(/no lines match/i)).toBeInTheDocument();
  });

  it('restores all rows when the filter is cleared', async () => {
    getLogs.mockResolvedValue(makeLogResponse(['alpha', 'beta']));
    render(<LogPanel featureName="test" onClose={() => {}} />);

    await waitFor(() => screen.getByText('beta'));

    const input = screen.getByPlaceholderText(FILTER_PLACEHOLDER);
    await act(async () => {
      fireEvent.change(input, { target: { value: 'alpha' } });
      await new Promise(r => setTimeout(r, 200));
    });
    expect(screen.queryByText('beta')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.change(input, { target: { value: '' } });
      await new Promise(r => setTimeout(r, 200));
    });
    expect(screen.getByText('beta')).toBeInTheDocument();
  });

  it('highlights the typed text inside surviving rows via <mark>', async () => {
    getLogs.mockResolvedValue(makeLogResponse(['connection timeout error', 'request ok 200']));
    const { container } = render(<LogPanel featureName="test" onClose={() => {}} />);

    await waitFor(() => screen.getByText(/connection timeout error/));

    const input = screen.getByPlaceholderText(FILTER_PLACEHOLDER);
    await act(async () => {
      fireEvent.change(input, { target: { value: 'timeout' } });
      await new Promise(r => setTimeout(r, 200));
    });

    // Surviving row should contain a <mark> wrapping the matched text.
    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
    const matchedText = Array.from(marks).map(m => m.textContent).join('');
    expect(matchedText.toLowerCase()).toContain('timeout');
  });

  it('matches the highlight case-insensitively', async () => {
    getLogs.mockResolvedValue(makeLogResponse(['Connection TIMEOUT Error']));
    const { container } = render(<LogPanel featureName="test" onClose={() => {}} />);

    await waitFor(() => screen.getByText(/Connection TIMEOUT Error/));

    const input = screen.getByPlaceholderText(FILTER_PLACEHOLDER);
    await act(async () => {
      fireEvent.change(input, { target: { value: 'timeout' } });
      await new Promise(r => setTimeout(r, 200));
    });

    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
    // The literal match preserves the source casing.
    expect(Array.from(marks).some(m => m.textContent === 'TIMEOUT')).toBe(true);
  });

  it('removes highlights when the input is cleared', async () => {
    getLogs.mockResolvedValue(makeLogResponse(['connection timeout']));
    const { container } = render(<LogPanel featureName="test" onClose={() => {}} />);

    await waitFor(() => screen.getByText(/connection timeout/));

    const input = screen.getByPlaceholderText(FILTER_PLACEHOLDER);
    await act(async () => {
      fireEvent.change(input, { target: { value: 'timeout' } });
      await new Promise(r => setTimeout(r, 200));
    });
    expect(container.querySelectorAll('mark').length).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.change(input, { target: { value: '' } });
      await new Promise(r => setTimeout(r, 200));
    });
    expect(container.querySelectorAll('mark').length).toBe(0);
  });
});
