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

  it('renders aggregate fleet network throughput rounded to one decimal place', async () => {
    const features = [
      { netRxMB: 2, netTxMB: 1 },
      { netRxMB: 3, netTxMB: 2 },
    ];
    const fleetNetRxMB = features.reduce((s, f) => s + f.netRxMB, 0); // 5
    const fleetNetTxMB = features.reduce((s, f) => s + f.netTxMB, 0); // 3

    render(<SystemResourcePanel fleetNetRxMB={fleetNetRxMB} fleetNetTxMB={fleetNetTxMB} />);

    await waitFor(() => {
      expect(screen.getByText(/FLEET NETWORK ↓5\.0 ↑3\.0 MB/)).toBeInTheDocument();
    });
  });

  it('renders zero values as 0.0 when no fleet instances are running', async () => {
    render(<SystemResourcePanel fleetNetRxMB={0} fleetNetTxMB={0} />);

    await waitFor(() => {
      expect(screen.getByText(/FLEET NETWORK ↓0\.0 ↑0\.0 MB/)).toBeInTheDocument();
    });
  });

  it('rounds floating-point noise to one decimal place', async () => {
    render(<SystemResourcePanel fleetNetRxMB={400.16999999999996} fleetNetTxMB={102.59} />);

    await waitFor(() => {
      expect(screen.getByText(/FLEET NETWORK ↓400\.2 ↑102\.6 MB/)).toBeInTheDocument();
    });
  });

  it('colors the fleet-net span green when worst value is at or below 100 MB', async () => {
    render(<SystemResourcePanel fleetNetRxMB={50} fleetNetTxMB={30} />);

    await waitFor(() => {
      const span = document.querySelector('.fleet-net');
      expect(span.getAttribute('style')).toContain('var(--color-accent)');
    });
  });

  it('colors the fleet-net span green at the boundary of exactly 100 MB', async () => {
    render(<SystemResourcePanel fleetNetRxMB={100} fleetNetTxMB={10} />);

    await waitFor(() => {
      const span = document.querySelector('.fleet-net');
      expect(span.getAttribute('style')).toContain('var(--color-accent)');
    });
  });

  it('colors the fleet-net span orange when the worse value exceeds 100 MB but not 500 MB', async () => {
    render(<SystemResourcePanel fleetNetRxMB={200} fleetNetTxMB={50} />);

    await waitFor(() => {
      const span = document.querySelector('.fleet-net');
      expect(span.getAttribute('style')).toContain('var(--color-warning)');
    });
  });

  it('colors the fleet-net span red when the worse value exceeds 500 MB', async () => {
    render(<SystemResourcePanel fleetNetRxMB={600} fleetNetTxMB={50} />);

    await waitFor(() => {
      const span = document.querySelector('.fleet-net');
      expect(span.getAttribute('style')).toContain('var(--color-danger)');
    });
  });

  it('uses the worse of RX and TX to determine color', async () => {
    // TX is worse: 600 > 500, should be red even though RX is within orange range
    render(<SystemResourcePanel fleetNetRxMB={200} fleetNetTxMB={600} />);

    await waitFor(() => {
      const span = document.querySelector('.fleet-net');
      expect(span.getAttribute('style')).toContain('var(--color-danger)');
    });
  });
});
