/**
 * Behaviour tests for OperationDetail.
 *
 * Verifies that the component renders the operation header and event timeline
 * through its public interface, without coupling to internal implementation.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import OperationDetail from '../OperationDetail.jsx';
import { fetchOperation } from '../../api.js';

vi.mock('../../api.js', () => ({
  fetchOperation: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const SAMPLE_OPERATION = {
  id: 42,
  kind: 'sync',
  key: 'proj-feat',
  startedAt: 1700000000000,
  endedAt: 1700000005000,
  outcome: 'success',
  errorMessage: null,
};

const SAMPLE_EVENTS = [
  { id: 1, ts: 1700000000050, level: 'info', message: 'sync started' },
  { id: 2, ts: 1700000002000, level: 'info', message: 'running rsync: git pull and build' },
  { id: 3, ts: 1700000004900, level: 'info', message: 'sync complete' },
];

describe('OperationDetail', () => {
  it('shows a loading indicator before data arrives', () => {
    fetchOperation.mockReturnValue(new Promise(() => {})); // never resolves

    render(<OperationDetail id={42} onBack={() => {}} />);

    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  it('renders operation header data after fetch resolves', async () => {
    fetchOperation.mockResolvedValue({ operation: SAMPLE_OPERATION, events: SAMPLE_EVENTS });

    render(<OperationDetail id={42} onBack={() => {}} />);

    // The header shows "sync — proj-feat" in one element
    await waitFor(() => {
      expect(screen.getByText(/sync — proj-feat/)).toBeTruthy();
    });

    expect(screen.getByText(/success/)).toBeTruthy();
  });

  it('renders the event timeline in order', async () => {
    fetchOperation.mockResolvedValue({ operation: SAMPLE_OPERATION, events: SAMPLE_EVENTS });

    render(<OperationDetail id={42} onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('sync started')).toBeTruthy();
    });

    expect(screen.getByText('running rsync: git pull and build')).toBeTruthy();
    expect(screen.getByText('sync complete')).toBeTruthy();

    // Events appear in an ordered list (ol)
    const listItems = document.querySelectorAll('ol li');
    expect(listItems.length).toBe(3);
  });

  it('shows relative timestamps for events', async () => {
    fetchOperation.mockResolvedValue({ operation: SAMPLE_OPERATION, events: SAMPLE_EVENTS });

    render(<OperationDetail id={42} onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('sync started')).toBeTruthy();
    });

    // First event at +50ms from start
    expect(screen.getByText('+50ms')).toBeTruthy();
  });

  it('shows an empty-events message when events array is empty', async () => {
    fetchOperation.mockResolvedValue({ operation: SAMPLE_OPERATION, events: [] });

    render(<OperationDetail id={42} onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/no events recorded/i)).toBeTruthy();
    });
  });

  it('shows an error message when fetch rejects', async () => {
    fetchOperation.mockRejectedValue(new Error('Operation not found'));

    render(<OperationDetail id={999} onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/operation not found/i)).toBeTruthy();
    });
  });

  it('calls onBack when the Back button is clicked', () => {
    fetchOperation.mockReturnValue(new Promise(() => {}));

    const onBack = vi.fn();
    render(<OperationDetail id={42} onBack={onBack} />);

    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('fetches the operation with the correct id', async () => {
    fetchOperation.mockResolvedValue({ operation: SAMPLE_OPERATION, events: [] });

    render(<OperationDetail id={42} onBack={() => {}} />);

    await waitFor(() => {
      expect(fetchOperation).toHaveBeenCalledWith(42);
    });
  });
});
