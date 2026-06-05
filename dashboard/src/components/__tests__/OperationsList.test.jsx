/**
 * Behaviour tests for OperationsList.
 *
 * Verifies that the component renders the correct column headers and displays
 * fetched operation rows, without coupling to internal implementation details.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import OperationsList from '../OperationsList.jsx';

vi.mock('../../api.js', () => ({
  fetchOperations: vi.fn().mockResolvedValue([
    {
      id: 1,
      kind: 'activate',
      key: 'proj-feat',
      startedAt: 1700000000000,
      endedAt: 1700000001000,
      outcome: 'success',
      errorMessage: null,
    },
  ]),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('OperationsList', () => {
  it('renders a table with Kind / Key / Started / Ended / Outcome column headers', () => {
    render(<OperationsList />);

    expect(screen.getByRole('columnheader', { name: /kind/i })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /key/i })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /started/i })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /ended/i })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /outcome/i })).toBeTruthy();
  });

  it('displays fetched operation rows after mount', async () => {
    render(<OperationsList />);

    await waitFor(() => {
      expect(screen.getByText('activate')).toBeTruthy();
    });

    expect(screen.getByText('proj-feat')).toBeTruthy();
    expect(screen.getByText('success')).toBeTruthy();
  });

  it('shows a placeholder row when no operations are returned', async () => {
    const { fetchOperations } = await import('../../api.js');
    fetchOperations.mockResolvedValueOnce([]);

    render(<OperationsList />);

    await waitFor(() => {
      expect(screen.getByText(/no operations recorded/i)).toBeTruthy();
    });
  });
});
