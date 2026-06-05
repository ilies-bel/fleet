import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('os', () => ({
  default: {
    cpus: vi.fn(),
    totalmem: vi.fn(),
    freemem: vi.fn(),
  },
}));

import os from 'os';
import { getHostMetrics } from './host-metrics.js';

// Two-core snapshots where each core accumulates 100 total ticks between samples,
// of which 30 are idle — so aggregate CPU load is 70%.
const SNAPSHOT_1 = [
  { times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
  { times: { user: 200, nice: 0, sys: 100, idle: 700, irq: 0 } },
];
const SNAPSHOT_2 = [
  { times: { user: 150, nice: 0, sys: 70, idle: 880, irq: 0 } },
  { times: { user: 250, nice: 0, sys: 120, idle: 730, irq: 0 } },
];

beforeEach(() => {
  vi.clearAllMocks();
  os.cpus.mockReturnValueOnce(SNAPSHOT_1).mockReturnValueOnce(SNAPSHOT_2);
  os.totalmem.mockReturnValue(8 * 1024 * 1024 * 1024); // 8192 MB
  os.freemem.mockReturnValue(2 * 1024 * 1024 * 1024);  // 2048 MB
});

describe('getHostMetrics', () => {
  it('returns an object with the expected five keys', async () => {
    const result = await getHostMetrics();
    expect(result).toHaveProperty('cpuPercent');
    expect(result).toHaveProperty('cpuCores');
    expect(result).toHaveProperty('memTotalMB');
    expect(result).toHaveProperty('memFreeMB');
    expect(result).toHaveProperty('memUsedMB');
  });

  it('computes cpuPercent from idle vs total tick deltas across all cores', async () => {
    const result = await getHostMetrics();
    // totalIdle = 30+30 = 60, totalTicks = 100+100 = 200 → 100*(1-60/200) = 70
    expect(result.cpuPercent).toBe(70);
  });

  it('cpuPercent is never NaN and stays in 0..100', async () => {
    const result = await getHostMetrics();
    expect(Number.isNaN(result.cpuPercent)).toBe(false);
    expect(result.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(result.cpuPercent).toBeLessThanOrEqual(100);
  });

  it('reports the number of CPU cores from the first snapshot', async () => {
    const result = await getHostMetrics();
    expect(result.cpuCores).toBe(2);
  });

  it('converts totalmem / freemem to whole MB and derives memUsedMB', async () => {
    const result = await getHostMetrics();
    expect(result.memTotalMB).toBe(8192);
    expect(result.memFreeMB).toBe(2048);
    expect(result.memUsedMB).toBe(6144);
  });

  it('rounds MB values to the nearest whole number', async () => {
    os.cpus.mockReset();
    os.cpus.mockReturnValueOnce(SNAPSHOT_1).mockReturnValueOnce(SNAPSHOT_2);
    // 1.5 GB + 0.4 MB  →  should round correctly
    os.totalmem.mockReturnValue(1536 * 1024 * 1024 + 400 * 1024); // ~1536.4 MB
    os.freemem.mockReturnValue(512 * 1024 * 1024 + 600 * 1024);   // ~512.6 MB

    const result = await getHostMetrics();
    expect(Number.isInteger(result.memTotalMB)).toBe(true);
    expect(Number.isInteger(result.memFreeMB)).toBe(true);
    expect(Number.isInteger(result.memUsedMB)).toBe(true);
    expect(result.memUsedMB).toBe(result.memTotalMB - result.memFreeMB);
  });

  it('returns 0 for cpuPercent when tick deltas are zero (no change between samples)', async () => {
    os.cpus.mockReset();
    os.cpus.mockReturnValueOnce(SNAPSHOT_1).mockReturnValueOnce(SNAPSHOT_1); // identical snapshots

    const result = await getHostMetrics();
    expect(result.cpuPercent).toBe(0);
    expect(Number.isNaN(result.cpuPercent)).toBe(false);
  });
});
