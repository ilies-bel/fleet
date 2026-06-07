/**
 * Behaviour tests for the first-run EmptyState primitive.
 *
 * Covers the three things the onboarding pass promises: the true state shows as
 * color + label, the command is rendered for copy/typing, and the copy button
 * gives honest in-place feedback ([COPY] -> [COPIED]) when the clipboard works.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import EmptyState from '../EmptyState.jsx';

describe('EmptyState', () => {
  it('renders the status line, lead, command, and hint', () => {
    render(
      <EmptyState
        status="0 FEATURES REGISTERED"
        lead="Register a branch and it shows up here."
        command="fleet add <name> <branch>"
        hint="Build progress: docker logs."
      />,
    );
    expect(screen.getByText('0 FEATURES REGISTERED')).toBeTruthy();
    expect(screen.getByText('Register a branch and it shows up here.')).toBeTruthy();
    expect(screen.getByText('fleet add <name> <branch>')).toBeTruthy();
    expect(screen.getByText('Build progress: docker logs.')).toBeTruthy();
  });

  it('omits the command block when no command is given', () => {
    render(<EmptyState status="NO FEATURE ACTIVE" lead="Pick one from the list." />);
    expect(screen.queryByRole('button', { name: /Copy command/ })).toBeNull();
  });

  describe('copy button', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('copies the command and flips to [COPIED], then back', async () => {
      vi.useFakeTimers();
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });

      render(<EmptyState status="x" lead="y" command="fleet add a b" />);
      const btn = screen.getByRole('button', { name: 'Copy command: fleet add a b' });
      expect(btn.textContent).toBe('[COPY]');

      // Async timer advance flushes the awaited clipboard promise so [COPIED] lands.
      await act(async () => {
        fireEvent.click(btn);
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(writeText).toHaveBeenCalledWith('fleet add a b');
      expect(btn.textContent).toBe('[COPIED]');

      // The 1.5s revert timer was scheduled under the same fake clock.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });
      expect(btn.textContent).toBe('[COPY]');
    });

    it('does not crash when the clipboard is unavailable', async () => {
      // No navigator.clipboard and execCommand absent -> silent no-op, command stays visible.
      vi.stubGlobal('navigator', {});
      render(<EmptyState status="x" lead="y" command="fleet add a b" />);
      const btn = screen.getByRole('button', { name: 'Copy command: fleet add a b' });

      await act(async () => {
        fireEvent.click(btn);
      });

      // Stays [COPY] (no false success), command still on screen to type by hand.
      expect(btn.textContent).toBe('[COPY]');
      expect(screen.getByText('fleet add a b')).toBeTruthy();
    });
  });
});
