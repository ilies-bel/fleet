/**
 * Behaviour tests for DiffPane's empty state.
 *
 * Verifies:
 *  - When getDiff resolves with { patch: '', isEmpty: true }, the centered
 *    "// NO CHANGES VS main" message is shown.
 *  - No <pre> (patch content block) is rendered in the empty case.
 *  - When getDiff resolves with a non-empty patch, the patch text is shown
 *    and the empty-state message is absent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import DiffPane from '../DiffPane.jsx';

vi.mock('../../api.js', () => ({
  getDiff: vi.fn(),
}));

import { getDiff } from '../../api.js';

describe('DiffPane — empty state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Tracer bullet: empty state text appears when patch is empty ───────────

  it('shows "// NO CHANGES VS main" when getDiff resolves with isEmpty: true', async () => {
    getDiff.mockResolvedValue({ patch: '', isEmpty: true });

    render(<DiffPane activeKey="my-feature" />);

    await waitFor(() => {
      expect(screen.getByText(/\/\/ NO CHANGES VS main/)).toBeInTheDocument();
    });
  });

  // ── No <pre> patch block in the empty case ────────────────────────────────

  it('renders zero <Diff> (pre) blocks when the branch has no changes', async () => {
    getDiff.mockResolvedValue({ patch: '', isEmpty: true });

    render(<DiffPane activeKey="my-feature" />);

    await waitFor(() => {
      expect(screen.getByText(/\/\/ NO CHANGES VS main/)).toBeInTheDocument();
    });

    // No <pre> element should be in the DOM when empty state is shown
    expect(document.querySelector('pre')).not.toBeInTheDocument();
  });

  // ── isEmpty: false with real patch → normal render, no empty-state ────────

  it('renders patch content and no empty-state message when getDiff returns a non-empty patch', async () => {
    getDiff.mockResolvedValue({ patch: 'diff --git a/foo.js b/foo.js\n+added line', isEmpty: false });

    render(<DiffPane activeKey="my-feature" />);

    await waitFor(() => {
      expect(screen.getByText(/diff --git/)).toBeInTheDocument();
    });

    expect(screen.queryByText(/\/\/ NO CHANGES VS main/)).not.toBeInTheDocument();
  });

  // ── getDiff called with correct key ──────────────────────────────────────

  it('calls getDiff with the provided activeKey', () => {
    getDiff.mockResolvedValue({ patch: '', isEmpty: true });

    render(<DiffPane activeKey="feature-xyz" />);

    expect(getDiff).toHaveBeenCalledTimes(1);
    expect(getDiff).toHaveBeenCalledWith('feature-xyz');
  });
});
