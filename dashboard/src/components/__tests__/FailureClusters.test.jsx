/**
 * Behaviour tests for FailureClusters.
 *
 * Verifies that the component renders one card per reason_code cluster,
 * displays the headline and count, shows sample keys, and shows a
 * placeholder when there are no clusters.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import FailureClusters from '../FailureClusters.jsx';

vi.mock('../../api.js', () => ({
  fetchFailureClusters: vi.fn().mockResolvedValue([
    {
      reasonCode: 'docker:socket-unavailable',
      count: 3,
      lastSeenAt: 1700000001000,
      sampleKeys: ['proj-a', 'proj-b', 'proj-c'],
    },
  ]),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('FailureClusters', () => {
  it('renders one cluster card per reason code', async () => {
    render(<FailureClusters />);

    await waitFor(() => {
      expect(screen.getByText('docker:socket-unavailable')).toBeTruthy();
    });
  });

  it('shows the count and human-readable headline in the card', async () => {
    render(<FailureClusters />);

    await waitFor(() => {
      expect(screen.getByText(/docker socket unavailable/i)).toBeTruthy();
    });

    // count = 3 appears somewhere in the headline text
    expect(screen.getByText(/3 docker failed/i)).toBeTruthy();
  });

  it('shows a lastSeenAt timestamp', async () => {
    render(<FailureClusters />);

    await waitFor(() => {
      expect(screen.getByText(/last seen/i)).toBeTruthy();
    });
  });

  it('lists sample instance keys', async () => {
    render(<FailureClusters />);

    await waitFor(() => {
      expect(screen.getByText('proj-a')).toBeTruthy();
    });

    expect(screen.getByText('proj-b')).toBeTruthy();
    expect(screen.getByText('proj-c')).toBeTruthy();
  });

  it('shows a placeholder message when no clusters are returned', async () => {
    const { fetchFailureClusters } = await import('../../api.js');
    fetchFailureClusters.mockResolvedValueOnce([]);

    render(<FailureClusters />);

    await waitFor(() => {
      expect(screen.getByText(/no failure clusters/i)).toBeTruthy();
    });
  });
});
