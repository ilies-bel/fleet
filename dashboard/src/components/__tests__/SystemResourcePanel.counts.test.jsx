import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SystemResourcePanel from '../SystemResourcePanel.jsx';

vi.mock('../../api.js', () => ({
  getHostStats: vi.fn(),
}));

import { getHostStats } from '../../api.js';

const HOST_STATS = {
  cpuPercent: 20.0,
  cpuCores: 4,
  memTotalMB: 8192,
  memUsedMB: 4096,
};

describe('SystemResourcePanel — instance counts roll-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHostStats.mockResolvedValue(HOST_STATS);
  });

  it('renders each count with expected numbers given a constructed features array', async () => {
    // 2 running, 1 stopped, 1 error (= failed) — total 4
    const features = [
      { key: 'a', status: 'running' },
      { key: 'b', status: 'running' },
      { key: 'c', status: 'stopped' },
      { key: 'd', status: 'error' }, // 'error' status is counted as failed
    ];
    const instanceCounts = {
      total: features.length,
      running: features.filter(f => f.status === 'running').length,
      stopped: features.filter(f => f.status === 'stopped').length,
      failed: features.filter(f => f.status === 'error').length,
    };

    render(<SystemResourcePanel instanceCounts={instanceCounts} />);

    await waitFor(() => {
      expect(screen.getByText(/TOTAL/)).toBeInTheDocument();
    });

    expect(document.querySelector('.count-total').textContent).toContain('4');
    expect(document.querySelector('.count-running').textContent).toContain('2');
    expect(document.querySelector('.count-stopped').textContent).toContain('1');
    expect(document.querySelector('.count-failed').textContent).toContain('1');
  });

  it('renders TOTAL count label', async () => {
    render(<SystemResourcePanel instanceCounts={{ total: 3, running: 2, stopped: 0, failed: 1 }} />);
    await waitFor(() => expect(screen.getByText(/TOTAL/)).toBeInTheDocument());
  });

  it('renders RUNNING count label', async () => {
    render(<SystemResourcePanel instanceCounts={{ total: 3, running: 2, stopped: 0, failed: 1 }} />);
    await waitFor(() => expect(screen.getByText(/RUNNING/)).toBeInTheDocument());
  });

  it('renders STOPPED count label', async () => {
    render(<SystemResourcePanel instanceCounts={{ total: 3, running: 2, stopped: 0, failed: 1 }} />);
    await waitFor(() => expect(screen.getByText(/STOPPED/)).toBeInTheDocument());
  });

  it('renders FAILED count label', async () => {
    render(<SystemResourcePanel instanceCounts={{ total: 3, running: 2, stopped: 0, failed: 1 }} />);
    await waitFor(() => expect(screen.getByText(/FAILED/)).toBeInTheDocument());
  });
});
