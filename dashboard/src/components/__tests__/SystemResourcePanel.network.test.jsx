import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SystemResourcePanel from '../SystemResourcePanel.jsx';

vi.mock('../../api.js', () => ({
  getHostStats: vi.fn(),
}));

import { getHostStats } from '../../api.js';

describe('SystemResourcePanel fleet network', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHostStats.mockResolvedValue({
      cpuPercent: 10.0,
      cpuCores: 4,
      memTotalMB: 8192,
      memFreeMB: 4096,
      memUsedMB: 4096,
    });
  });

  it('renders aggregate fleet network throughput from a constructed features array', async () => {
    const features = [
      { netRxMB: 2, netTxMB: 1 },
      { netRxMB: 3, netTxMB: 2 },
    ];
    const fleetNetRxMB = features.reduce((s, f) => s + f.netRxMB, 0); // 5
    const fleetNetTxMB = features.reduce((s, f) => s + f.netTxMB, 0); // 3

    render(<SystemResourcePanel fleetNetRxMB={fleetNetRxMB} fleetNetTxMB={fleetNetTxMB} />);

    await waitFor(() => {
      expect(screen.getByText(/FLEET NETWORK ↓5 ↑3 MB/)).toBeInTheDocument();
    });
  });

  it('renders zero values when no fleet instances are running', async () => {
    render(<SystemResourcePanel fleetNetRxMB={0} fleetNetTxMB={0} />);

    await waitFor(() => {
      expect(screen.getByText(/FLEET NETWORK ↓0 ↑0 MB/)).toBeInTheDocument();
    });
  });
});
