import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ResourceMonitor from '../ResourceMonitor.jsx';

vi.mock('../../api.js', () => ({
  getFeatures: vi.fn(),
  getStats: vi.fn(),
}));

import { getFeatures } from '../../api.js';

describe('ResourceMonitor — fetch states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading indicator on initial render before fetch resolves', () => {
    getFeatures.mockImplementation(() => new Promise(() => {})); // never resolves
    render(<ResourceMonitor />);
    expect(screen.getByText('loading resources…')).toBeInTheDocument();
  });

  it('shows inline error block matching FeatureCard error style when getFeatures rejects', async () => {
    getFeatures.mockRejectedValue(new Error('network failure'));
    render(<ResourceMonitor />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByText('network failure')).toBeInTheDocument();
  });

  it('shows "no features registered" only after a successful fetch that returns empty array', async () => {
    getFeatures.mockResolvedValue([]);
    render(<ResourceMonitor />);
    // Must not appear during loading
    expect(screen.queryByText('no features registered')).not.toBeInTheDocument();
    // Must appear after the resolved-empty fetch
    await waitFor(() => {
      expect(screen.getByText('no features registered')).toBeInTheDocument();
    });
  });
});
