import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import SystemResourcePanel from '../SystemResourcePanel.jsx';

vi.mock('../../api.js', () => ({
  getHostStats: vi.fn(),
}));

import { getHostStats } from '../../api.js';

describe('SystemResourcePanel — graceful degradation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows "— unavailable" on fetch failure then restores live data on recovery', async () => {
    getHostStats
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValue({
        cpuPercent: 55.0,
        cpuCores: 4,
        memTotalMB: 8192,
        memFreeMB: 2048,
        memUsedMB: 6144,
      });

    render(
      <SystemResourcePanel
        instanceCounts={{ running: 3, total: 5 }}
        fleetNetRxMB={1.2}
        fleetNetTxMB={0.5}
      />,
    );

    // Flush the initial poll() call (which rejects) without advancing the interval
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // CPU and MEM rows must show the unavailable placeholder
    const unavailableLabels = screen.getAllByText('— unavailable');
    expect(unavailableLabels).toHaveLength(2);

    // Instance counts render regardless of host status
    expect(screen.getByText(/3 running/)).toBeInTheDocument();

    // No bar fill should exist (no live host data)
    expect(screen.queryByText(/55\.0%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/6144/)).not.toBeInTheDocument();

    // Advance past one interval tick to trigger the recovery poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    // Live data must replace the unavailable labels
    expect(screen.getByText('55.0%')).toBeInTheDocument();
    expect(screen.getByText(/6144 \/ 8192 MB/)).toBeInTheDocument();
    expect(screen.queryByText('— unavailable')).not.toBeInTheDocument();
  });
});
