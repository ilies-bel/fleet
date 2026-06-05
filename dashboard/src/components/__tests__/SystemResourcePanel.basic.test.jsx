import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SystemResourcePanel from '../SystemResourcePanel.jsx';

vi.mock('../../api.js', () => ({
  getHostStats: vi.fn(),
}));

import { getHostStats } from '../../api.js';

describe('SystemResourcePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders host CPU percent with core count after getHostStats resolves', async () => {
    getHostStats.mockResolvedValue({
      cpuPercent: 42.5,
      cpuCores: 8,
      memTotalMB: 16384,
      memFreeMB: 8192,
      memUsedMB: 8192,
    });

    render(<SystemResourcePanel />);

    await waitFor(() => {
      expect(screen.getByText('42.5%')).toBeInTheDocument();
      expect(screen.getByText(/8 cores/)).toBeInTheDocument();
    });
  });

  it('renders host memory used/total after getHostStats resolves', async () => {
    getHostStats.mockResolvedValue({
      cpuPercent: 10.0,
      cpuCores: 4,
      memTotalMB: 8192,
      memFreeMB: 4096,
      memUsedMB: 4096,
    });

    render(<SystemResourcePanel />);

    await waitFor(() => {
      expect(screen.getByText(/4096\s*\/\s*8192\s*MB/)).toBeInTheDocument();
    });
  });
});
