/**
 * Filter-box and multi-term highlight tests for LogPanel.
 *
 * Verifies:
 *   1. matchesFilter — pure predicate, case-insensitive substring on raw field
 *   2. applyTextFilter — trace-group preservation, AND with level filter
 *   3. Filter input hides non-matching rows and updates the footer count
 *   4. Empty-result placeholder shown when no rows match
 *   5. Highlight input adds removable chips with live occurrence counts
 *   6. Filter and highlight are independent (CloudWatch workflow)
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

describe('LogPanel — filter box', () => {
  it('renders a filter input in the header', async () => {
    getLogs.mockResolvedValue(makeLogResponse(['hello']));
    render(<LogPanel featureName="test" onClose={() => {}} />);
    expect(screen.getByPlaceholderText('filter…')).toBeInTheDocument();
  });

  it('hides rows that do not match the filter text', async () => {
    getLogs.mockResolvedValue(makeLogResponse(['connection timeout', 'request ok 200']));
    render(<LogPanel featureName="test" onClose={() => {}} />);

    await waitFor(() => screen.getByText('connection timeout'));

    const input = screen.getByPlaceholderText('filter…');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'timeout' } });
      // advance past 150ms debounce
      await new Promise(r => setTimeout(r, 200));
    });

    expect(screen.getByText('connection timeout')).toBeInTheDocument();
    expect(screen.queryByText('request ok 200')).not.toBeInTheDocument();
  });

  it('shows "N of M lines" in the footer when a filter is active', async () => {
    getLogs.mockResolvedValue(makeLogResponse(['alpha', 'beta', 'gamma']));
    render(<LogPanel featureName="test" onClose={() => {}} />);

    await waitFor(() => screen.getByText('alpha'));

    const input = screen.getByPlaceholderText('filter…');
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

    const input = screen.getByPlaceholderText('filter…');
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

    const input = screen.getByPlaceholderText('filter…');
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
});

describe('LogPanel — highlight chips', () => {
  it('renders a highlight input in the header', () => {
    getLogs.mockResolvedValue(makeLogResponse([]));
    render(<LogPanel featureName="test" onClose={() => {}} />);
    expect(screen.getByPlaceholderText('highlight…')).toBeInTheDocument();
  });

  it('adds a chip when Enter is pressed in the highlight input', async () => {
    getLogs.mockResolvedValue(makeLogResponse(['timeout error occurred']));
    render(<LogPanel featureName="test" onClose={() => {}} />);

    await waitFor(() => screen.getByText('timeout error occurred'));

    const input = screen.getByPlaceholderText('highlight…');
    fireEvent.change(input, { target: { value: 'timeout' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // The chip shows "term ×count" — match on that pattern to distinguish from the highlighted row text.
    expect(screen.getByText(/timeout ×/)).toBeInTheDocument();
  });

  it('chip shows a live occurrence count', async () => {
    getLogs.mockResolvedValue(makeLogResponse(['timeout', 'another timeout here', 'ok']));
    render(<LogPanel featureName="test" onClose={() => {}} />);

    await waitFor(() => screen.getByText('another timeout here'));

    const input = screen.getByPlaceholderText('highlight…');
    fireEvent.change(input, { target: { value: 'timeout' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Chip should show "timeout ×2" (appears in 2 of the 3 lines)
    expect(screen.getByText(/×2/)).toBeInTheDocument();
  });

  it('removes a chip when its × button is clicked', async () => {
    getLogs.mockResolvedValue(makeLogResponse(['error 404']));
    render(<LogPanel featureName="test" onClose={() => {}} />);

    await waitFor(() => screen.getByText('error 404'));

    const hlInput = screen.getByPlaceholderText('highlight…');
    fireEvent.change(hlInput, { target: { value: 'error' } });
    fireEvent.keyDown(hlInput, { key: 'Enter' });

    // A remove button should appear
    const removeBtn = screen.getByRole('button', { name: /remove highlight.*error/i });
    fireEvent.click(removeBtn);

    expect(screen.queryByRole('button', { name: /remove highlight.*error/i })).not.toBeInTheDocument();
  });

  it('filter and highlight are independent — both can be active simultaneously', async () => {
    getLogs.mockResolvedValue(makeLogResponse([
      'Error: connection timeout',
      'GET /api 404 not found',
      'Success: request completed',
    ]));
    render(<LogPanel featureName="test" onClose={() => {}} />);

    await waitFor(() => screen.getByText('Success: request completed'));

    // Apply filter: only Error lines
    const filterInput = screen.getByPlaceholderText('filter…');
    await act(async () => {
      fireEvent.change(filterInput, { target: { value: 'Error' } });
      await new Promise(r => setTimeout(r, 200));
    });

    // Apply highlight: 404
    const hlInput = screen.getByPlaceholderText('highlight…');
    fireEvent.change(hlInput, { target: { value: '404' } });
    fireEvent.keyDown(hlInput, { key: 'Enter' });

    // Filter should hide the 404 row (doesn't contain "Error")
    expect(screen.queryByText('GET /api 404 not found')).not.toBeInTheDocument();
    // Highlight chip for "404" still present (highlight is independent)
    expect(screen.getByText(/×0/)).toBeInTheDocument(); // 0 occurrences in filtered set
  });
});
