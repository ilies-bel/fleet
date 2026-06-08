/**
 * Responsive-layout tests for OperationsList.
 *
 * Verifies that every body <td> carries the correct data-label attribute
 * (used by the @media CSS ::before rule to render stacked labels) and that
 * the <table> carries the ops-table class so the media query can target it.
 *
 * These tests verify *structure* that is directly user-observable (screen-
 * reader and CSS content depend on it) — not internal implementation detail.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import OperationsList from '../OperationsList.jsx';

vi.mock('../../api.js', () => ({
  fetchOperations: vi.fn().mockResolvedValue([
    {
      id: 1,
      kind: 'activate',
      key: 'proj-feat',
      startedAt: 1700000000000,
      endedAt: 1700000001000,
      outcome: 'failure',
      reasonCode: 'docker:timeout',
      errorMessage: null,
    },
  ]),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('OperationsList — responsive layout attributes', () => {
  it('table carries the ops-table class for responsive CSS targeting', () => {
    render(<OperationsList />);
    expect(document.querySelector('table.ops-table')).toBeTruthy();
  });

  it('each data body <td> carries its data-label for stacked-row CSS labels', async () => {
    render(<OperationsList />);

    await waitFor(() => {
      expect(screen.getByText('activate')).toBeTruthy();
    });

    // Collect data-labels from all body cells that have one set
    const cells = Array.from(document.querySelectorAll('tbody td'));
    const labels = cells.map(td => td.getAttribute('data-label')).filter(Boolean);

    expect(labels).toContain('KIND');
    expect(labels).toContain('KEY');
    expect(labels).toContain('STARTED');
    expect(labels).toContain('ENDED');
    expect(labels).toContain('OUTCOME');
    expect(labels).toContain('REASON');
  });

  it('empty-state td has no data-label (spans all columns, not a labeled cell)', async () => {
    const { fetchOperations } = await import('../../api.js');
    fetchOperations.mockResolvedValueOnce([]);

    render(<OperationsList />);

    await waitFor(() => {
      expect(screen.getByText(/no operations recorded/i)).toBeTruthy();
    });

    const emptyTd = document.querySelector('tbody td[colspan]');
    expect(emptyTd).toBeTruthy();
    // Empty-state td must not carry a data-label so the ::before pseudo stays blank
    expect(emptyTd.getAttribute('data-label')).toBeNull();
  });
});
