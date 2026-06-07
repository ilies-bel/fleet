import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ResourceMonitor from '../ResourceMonitor.jsx';

vi.mock('../../api.js', () => ({
  getFeatures: vi.fn(),
  getStats: vi.fn(),
  getHostStats: vi.fn(),
}));

import { getFeatures, getHostStats } from '../../api.js';

describe('ResourceMonitor — empty state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders host-CPU label and no-features empty state in the same render when features is empty', async () => {
    getFeatures.mockResolvedValue([]);
    getHostStats.mockResolvedValue({
      cpuPercent: 12.5,
      cpuCores: 8,
      memUsedMB: 4096,
      memTotalMB: 16384,
    });

    render(<ResourceMonitor />);

    // Wait for both the async getFeatures and getHostStats calls to resolve
    await waitFor(() => {
      expect(screen.getByText(/CPU \(8 cores\)/)).toBeInTheDocument();
    });

    // Host-CPU label (from SystemResourcePanel) and the first-run empty state both present
    expect(screen.getByText(/CPU \(8 cores\)/)).toBeInTheDocument();
    expect(screen.getByText('0 FEATURES REGISTERED')).toBeInTheDocument();
    expect(screen.getByText('fleet add <name> <branch>')).toBeInTheDocument();
  });
});
