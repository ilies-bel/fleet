/**
 * Behaviour tests for DiffPane inline error state.
 *
 * Verifies:
 *  - When getDiff rejects, the error message is shown inline.
 *  - No diff/patch content is rendered on error.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import DiffPane from '../DiffPane.jsx';

// Mock the api module so getDiff never hits the network.
vi.mock('../../api.js', () => ({
  getDiff: vi.fn(),
}));

import { getDiff } from '../../api.js';

describe('DiffPane error state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the thrown error message inline when getDiff rejects', async () => {
    getDiff.mockRejectedValue(new Error('boom'));

    render(<DiffPane activeKey="test-key" />);

    await waitFor(() => {
      expect(screen.getByText(/boom/)).toBeInTheDocument();
    });
  });

  it('renders no <Diff> blocks (no patch pre) when getDiff rejects', async () => {
    getDiff.mockRejectedValue(new Error('boom'));

    const { container } = render(<DiffPane activeKey="test-key" />);

    await waitFor(() => {
      expect(screen.getByText(/boom/)).toBeInTheDocument();
    });

    // The success-path <pre> with patch content must not be rendered.
    expect(container.querySelector('pre')).not.toBeInTheDocument();
  });
});
