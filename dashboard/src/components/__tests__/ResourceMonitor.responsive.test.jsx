import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ResourceMonitor from '../ResourceMonitor.jsx';

vi.mock('../../api.js', () => ({
  getFeatures: vi.fn(),
  getStats: vi.fn(),
  getHostStats: vi.fn(),
}));

import { getFeatures, getStats, getHostStats } from '../../api.js';

describe('ResourceMonitor — responsive data-label attributes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('each data row td carries a data-label matching the column header (stacked mobile layout)', async () => {
    getFeatures.mockResolvedValue([
      { key: 'feat-1', name: 'auth', project: 'core', branch: 'main' },
    ]);
    getStats.mockResolvedValue({
      cpuPercent: 25,
      memUsageMB: 512,
      memLimitMB: 1024,
      netRxMB: 1.2,
      netTxMB: 0.4,
    });
    getHostStats.mockResolvedValue({
      cpuPercent: 12.5,
      cpuCores: 8,
      memUsedMB: 4096,
      memTotalMB: 16384,
    });

    render(<ResourceMonitor />);

    // Wait for feature row to render
    await waitFor(() => {
      expect(screen.getByText('auth')).toBeInTheDocument();
    });

    // Every column label must appear as a data-label attribute so the stacked
    // mobile ::before pseudo-element can render it — this guards against silent
    // regression when cells are refactored.
    const expectedLabels = ['FEATURE', 'PROJECT', 'BRANCH', 'STATUS', 'CPU', 'MEMORY', 'NETWORK'];
    for (const label of expectedLabels) {
      const tds = document.querySelectorAll(`td[data-label="${label}"]`);
      expect(tds.length, `expected at least one <td data-label="${label}">`).toBeGreaterThan(0);
    }
  });

  it('skeleton rows do not carry data-label (excluded from stacked layout rules)', () => {
    getFeatures.mockImplementation(() => new Promise(() => {})); // never resolves
    getHostStats.mockImplementation(() => new Promise(() => {})); // never resolves
    render(<ResourceMonitor />);

    const skeletonRows = screen.getAllByTestId('skeleton-row');
    expect(skeletonRows.length).toBeGreaterThan(0);

    // Skeleton tds must not have data-label so they stay unaffected by the
    // @media td[data-label] flex rule that would distort the pulse blocks.
    skeletonRows.forEach(row => {
      const tds = row.querySelectorAll('td[data-label]');
      expect(tds.length).toBe(0);
    });
  });
});
