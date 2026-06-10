/**
 * Run-marker separator tests for LogPanel.
 *
 * Verifies that gateway-supplied run markers render as visible "run #N"
 * separators in the log timeline, are ordered correctly by ts, emphasise
 * the latest run, and do not crash on empty or legacy responses.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import LogPanel from '../LogPanel.jsx';
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

describe('LogPanel — run-marker separators', () => {
  it('renders a separator for each marker in the timeline', async () => {
    getLogs.mockResolvedValue({
      records: [{ ts: '2024-01-01T16:07:55Z', message: 'boot complete' }],
      markers: [{ kind: 'run-marker', run: 1, ts: '2024-01-01T16:07:50Z', reason: 'started' }],
      fetchedAt: 1704067670000,
    });

    render(<LogPanel featureName="my-app" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('separator', { name: /run #1/ })).toBeInTheDocument();
    });
  });

  it('renders a separator for each of multiple run attempts', async () => {
    getLogs.mockResolvedValue({
      records: [
        { ts: '2024-01-01T16:07:55Z', message: 'first-run-log' },
        { ts: '2024-01-01T16:08:10Z', message: 'second-run-log' },
      ],
      markers: [
        { kind: 'run-marker', run: 1, ts: '2024-01-01T16:07:50Z', reason: 'started' },
        { kind: 'run-marker', run: 2, ts: '2024-01-01T16:08:05Z', reason: 'restarted' },
      ],
      fetchedAt: 1704067690000,
    });

    render(<LogPanel featureName="my-app" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('separator', { name: /run #1/ })).toBeInTheDocument();
      expect(screen.getByRole('separator', { name: /run #2/ })).toBeInTheDocument();
    });
  });

  it('labels first run as "started" and subsequent runs as "restarted"', async () => {
    getLogs.mockResolvedValue({
      records: [],
      markers: [
        { kind: 'run-marker', run: 1, ts: '2024-01-01T16:07:50Z', reason: 'started' },
        { kind: 'run-marker', run: 2, ts: '2024-01-01T16:08:05Z', reason: 'restarted' },
      ],
      fetchedAt: 1704067685000,
    });

    render(<LogPanel featureName="my-app" onClose={() => {}} />);

    await waitFor(() => screen.getAllByRole('separator'));

    const labels = screen.getAllByRole('separator').map(s => s.getAttribute('aria-label') ?? '');
    expect(labels.some(l => l.includes('started'))).toBe(true);
    expect(labels.some(l => l.includes('restarted'))).toBe(true);
  });

  it('normalises reason "boot" to "restarted" in the label', async () => {
    getLogs.mockResolvedValue({
      records: [],
      markers: [
        { kind: 'run-marker', run: 1, ts: '2024-01-01T16:07:50Z', reason: 'started' },
        { kind: 'run-marker', run: 2, ts: '2024-01-01T16:09:00Z', reason: 'boot' },
      ],
      fetchedAt: 1704067740000,
    });

    render(<LogPanel featureName="my-app" onClose={() => {}} />);

    await waitFor(() => screen.getAllByRole('separator'));

    const labels = screen.getAllByRole('separator').map(s => s.getAttribute('aria-label') ?? '');
    expect(labels.filter(l => l.includes('restarted'))).toHaveLength(1);
    // "boot" should not appear in any label
    expect(labels.every(l => !l.includes('boot'))).toBe(true);
  });

  it('renders no separators when markers array is empty', async () => {
    getLogs.mockResolvedValue({
      records: [{ ts: '2024-01-01T16:07:55Z', message: 'just a log' }],
      markers: [],
      fetchedAt: 1704067675000,
    });

    render(<LogPanel featureName="my-app" onClose={() => {}} />);

    await waitFor(() => screen.getByText('just a log'));
    expect(screen.queryAllByRole('separator')).toHaveLength(0);
  });

  it('does not crash and renders no separators on a legacy response (no markers field)', async () => {
    getLogs.mockResolvedValue({
      lines: 'legacy log output\nline two',
      fetchedAt: 1704067675000,
    });

    render(<LogPanel featureName="my-app" onClose={() => {}} />);

    await waitFor(() => screen.getByText(/legacy log output/));
    expect(screen.queryAllByRole('separator')).toHaveLength(0);
  });

  it('places the marker before the record whose ts is later', async () => {
    getLogs.mockResolvedValue({
      records: [
        { ts: '2024-01-01T16:07:45Z', message: 'early-log' },
        { ts: '2024-01-01T16:07:55Z', message: 'late-log' },
      ],
      markers: [{ kind: 'run-marker', run: 1, ts: '2024-01-01T16:07:50Z', reason: 'started' }],
      fetchedAt: 1704067675000,
    });

    render(<LogPanel featureName="my-app" onClose={() => {}} />);

    await waitFor(() => screen.getByText('late-log'));

    const earlyLog  = screen.getByText('early-log');
    const separator = screen.getByRole('separator', { name: /run #1/ });
    const lateLog   = screen.getByText('late-log');

    // DOCUMENT_POSITION_FOLLOWING (4): argument appears after the reference node
    expect(earlyLog.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(separator.compareDocumentPosition(lateLog)  & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('places a marker at end of timeline when its ts is newer than all records', async () => {
    getLogs.mockResolvedValue({
      records: [
        { ts: '2024-01-01T16:07:45Z', message: 'only-record' },
      ],
      markers: [{ kind: 'run-marker', run: 2, ts: '2024-01-01T16:08:00Z', reason: 'restarted' }],
      fetchedAt: 1704067680000,
    });

    render(<LogPanel featureName="my-app" onClose={() => {}} />);

    await waitFor(() => screen.getByRole('separator', { name: /run #2/ }));

    const record    = screen.getByText('only-record');
    const separator = screen.getByRole('separator', { name: /run #2/ });

    expect(record.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('visually emphasises the latest run (full opacity) over earlier ones (dimmed)', async () => {
    getLogs.mockResolvedValue({
      records: [],
      markers: [
        { kind: 'run-marker', run: 1, ts: '2024-01-01T16:07:50Z', reason: 'started' },
        { kind: 'run-marker', run: 2, ts: '2024-01-01T16:08:05Z', reason: 'restarted' },
      ],
      fetchedAt: 1704067685000,
    });

    render(<LogPanel featureName="my-app" onClose={() => {}} />);

    await waitFor(() => screen.getAllByRole('separator'));

    const seps = screen.getAllByRole('separator');
    const sep1 = seps.find(s => s.getAttribute('aria-label')?.includes('run #1'));
    const sep2 = seps.find(s => s.getAttribute('aria-label')?.includes('run #2'));

    expect(sep2.style.opacity).toBe('1');   // latest run — full opacity
    expect(sep1.style.opacity).not.toBe('1'); // earlier run — dimmed
  });
});
