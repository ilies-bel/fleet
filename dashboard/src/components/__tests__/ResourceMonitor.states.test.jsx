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

  it('shows muted loading row inside the table region on initial render before fetch resolves', () => {
    getFeatures.mockImplementation(() => new Promise(() => {})); // never resolves
    render(<ResourceMonitor />);
    // Loading row is inside the table
    expect(screen.getByText('loading instances…')).toBeInTheDocument();
    // Table column headers are visible alongside the loading row
    expect(screen.getByText('FEATURE')).toBeInTheDocument();
    // The resource monitor header is unaffected
    expect(screen.getByText(/RESOURCE MONITOR/)).toBeInTheDocument();
  });

  it('shows inline error chip with message and retry hint when getFeatures rejects', async () => {
    getFeatures.mockRejectedValue(new Error('network failure'));
    render(<ResourceMonitor />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    const chip = screen.getByRole('alert');
    expect(chip).toHaveClass('resource-error-chip');
    expect(chip).toHaveTextContent('network failure');
    expect(chip).toHaveTextContent('auto-retry pending');
    // The resource monitor header continues to render (panel above unaffected)
    expect(screen.getByText(/RESOURCE MONITOR/)).toBeInTheDocument();
  });

  it('shows the first-run empty state only after a successful fetch that returns empty array', async () => {
    getFeatures.mockResolvedValue([]);
    render(<ResourceMonitor />);
    // Must not appear during loading
    expect(screen.queryByText('0 FEATURES REGISTERED')).not.toBeInTheDocument();
    // Must appear after the resolved-empty fetch
    await waitFor(() => {
      expect(screen.getByText('0 FEATURES REGISTERED')).toBeInTheDocument();
    });
  });
});
