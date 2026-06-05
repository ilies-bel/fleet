import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SystemResourcePanel from '../SystemResourcePanel.jsx';

vi.mock('../../api.js', () => ({
  getHostStats: vi.fn(),
}));

import { getHostStats } from '../../api.js';

describe('SystemResourcePanel — Fleet/Other memory layering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sizes Fleet memory segment to fleetMemUsedMB / memTotalMB', async () => {
    getHostStats.mockResolvedValue({
      cpuPercent: 20,
      cpuCores: 4,
      memTotalMB: 8000,
      memUsedMB: 5000,
      memFreeMB: 3000,
    });

    render(<SystemResourcePanel fleetCpuPercent={10} fleetMemUsedMB={2000} />);

    await waitFor(() => {
      // 2000 / 8000 * 100 = 25%
      expect(screen.getByTestId('mem-fleet')).toHaveStyle('flex-basis: 25%');
    });
  });

  it('sizes Other memory segment to max(0, memUsedMB - fleetMemUsedMB) / memTotalMB', async () => {
    getHostStats.mockResolvedValue({
      cpuPercent: 20,
      cpuCores: 4,
      memTotalMB: 8000,
      memUsedMB: 5000,
      memFreeMB: 3000,
    });

    render(<SystemResourcePanel fleetCpuPercent={10} fleetMemUsedMB={2000} />);

    await waitFor(() => {
      // max(0, 5000 - 2000) / 8000 * 100 = 37.5%
      expect(screen.getByTestId('mem-other')).toHaveStyle('flex-basis: 37.5%');
    });
  });

  it('clamps Other segment to 0% when fleetMemUsedMB exceeds memUsedMB', async () => {
    getHostStats.mockResolvedValue({
      cpuPercent: 20,
      cpuCores: 4,
      memTotalMB: 8000,
      memUsedMB: 1000,
      memFreeMB: 7000,
    });

    render(<SystemResourcePanel fleetCpuPercent={10} fleetMemUsedMB={2000} />);

    await waitFor(() => {
      // max(0, 1000 - 2000) = 0 → 0%
      expect(screen.getByTestId('mem-other')).toHaveStyle('flex-basis: 0%');
    });
  });
});
