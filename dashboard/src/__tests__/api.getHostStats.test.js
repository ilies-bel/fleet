import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getHostStats } from '../api.js';

describe('getHostStats', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls /_fleet/api/host-stats and resolves with host metrics', async () => {
    const payload = {
      cpuPercent: 42.5,
      cpuCores: 8,
      memTotalMB: 16384,
      memFreeMB: 4096,
      memUsedMB: 12288,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(payload),
    }));

    const result = await getHostStats();

    expect(fetch).toHaveBeenCalledWith('/_fleet/api/host-stats', {});
    expect(result).toEqual(payload);
  });

  it('throws with the error message body when the server responds with 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve(JSON.stringify({ error: 'service unavailable' })),
    }));

    await expect(getHostStats()).rejects.toThrow('service unavailable');
  });
});
