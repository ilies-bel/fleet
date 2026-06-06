/**
 * Behaviour tests for DiffPane's unavailable state.
 *
 * Verifies:
 *  - When getDiff resolves with { status: 'unavailable', reason: '...' }, the
 *    "// Diff unavailable — <reason>" message is shown.
 *  - The reason text is rendered in the panel.
 *  - No <pre> (patch content block) is rendered in the unavailable case.
 *  - The "// NO CHANGES VS main" message is NOT shown in the unavailable state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import DiffPane from '../DiffPane.jsx';

vi.mock('../../api.js', () => ({
  getDiff: vi.fn(),
}));

import { getDiff } from '../../api.js';

describe('DiffPane — unavailable state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Tracer bullet: unavailable message appears with reason ────────────────

  it('shows "// Diff unavailable" copy when getDiff resolves with status: "unavailable"', async () => {
    getDiff.mockResolvedValue({
      status: 'unavailable',
      reason: 'container not running',
      patch: '',
      isEmpty: true,
    });

    render(<DiffPane activeKey="my-feature" />);

    await waitFor(() => {
      expect(screen.getByText(/\/\/ Diff unavailable/)).toBeInTheDocument();
    });
  });

  // ── Reason text is rendered ───────────────────────────────────────────────

  it('renders the reason string in the unavailable panel', async () => {
    getDiff.mockResolvedValue({
      status: 'unavailable',
      reason: 'not a git repository',
      patch: '',
      isEmpty: true,
    });

    render(<DiffPane activeKey="my-feature" />);

    await waitFor(() => {
      expect(screen.getByText(/not a git repository/)).toBeInTheDocument();
    });
  });

  // ── No <pre> patch block in the unavailable case ──────────────────────────

  it('renders no <pre> blocks when the diff is unavailable', async () => {
    getDiff.mockResolvedValue({
      status: 'unavailable',
      reason: 'container exec failed',
      patch: '',
      isEmpty: true,
    });

    render(<DiffPane activeKey="my-feature" />);

    await waitFor(() => {
      expect(screen.getByText(/\/\/ Diff unavailable/)).toBeInTheDocument();
    });

    expect(document.querySelector('pre')).not.toBeInTheDocument();
  });

  // ── Distinct from the no-changes state ───────────────────────────────────

  it('does NOT show "// NO CHANGES VS main" in the unavailable state', async () => {
    getDiff.mockResolvedValue({
      status: 'unavailable',
      reason: 'container exec failed',
      patch: '',
      isEmpty: true,
    });

    render(<DiffPane activeKey="my-feature" />);

    await waitFor(() => {
      expect(screen.getByText(/\/\/ Diff unavailable/)).toBeInTheDocument();
    });

    expect(screen.queryByText(/\/\/ NO CHANGES VS main/)).not.toBeInTheDocument();
  });
});
