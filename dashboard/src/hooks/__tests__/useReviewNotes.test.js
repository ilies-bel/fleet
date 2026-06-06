/**
 * Behaviour tests for the useReviewNotes hook.
 *
 * Verifies:
 *  - Initial state is empty.
 *  - addNote stores a note under the given worktree with generated id/createdAt.
 *  - addNote keeps different worktrees isolated.
 *  - Multiple addNote calls accumulate notes.
 *  - removeNote removes only the matching note.
 *  - clearForWorktree removes all notes for one worktree, leaving others intact.
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReviewNotes } from '../useReviewNotes.js';

describe('useReviewNotes', () => {
  // ── Tracer bullet: hook starts with empty state ─────────────────────────

  it('starts with empty notesByWorktree', () => {
    const { result } = renderHook(() => useReviewNotes());
    expect(result.current.notesByWorktree).toEqual({});
  });

  // ── addNote stores note with id and createdAt ───────────────────────────

  it('addNote stores a note under the given worktree with generated id and createdAt', () => {
    const { result } = renderHook(() => useReviewNotes());

    act(() => {
      result.current.addNote('feat-abc', {
        selector: '#login-button',
        route: '/login',
        refKind: 'id',
        label: 'Login button',
        text: 'Make it more prominent',
      });
    });

    const notes = result.current.notesByWorktree['feat-abc'];
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      selector: '#login-button',
      route: '/login',
      refKind: 'id',
      label: 'Login button',
      text: 'Make it more prominent',
    });
    expect(typeof notes[0].id).toBe('string');
    expect(notes[0].id.length).toBeGreaterThan(0);
    expect(typeof notes[0].createdAt).toBe('string');
    expect(notes[0].createdAt.length).toBeGreaterThan(0);
  });

  // ── addNote keeps different worktrees isolated ──────────────────────────

  it('addNote keeps notes from different worktrees separate', () => {
    const { result } = renderHook(() => useReviewNotes());

    act(() => {
      result.current.addNote('feat-abc', { text: 'Note A' });
      result.current.addNote('feat-xyz', { text: 'Note B' });
    });

    expect(result.current.notesByWorktree['feat-abc']).toHaveLength(1);
    expect(result.current.notesByWorktree['feat-abc'][0].text).toBe('Note A');
    expect(result.current.notesByWorktree['feat-xyz']).toHaveLength(1);
    expect(result.current.notesByWorktree['feat-xyz'][0].text).toBe('Note B');
  });

  // ── Multiple notes accumulate ───────────────────────────────────────────

  it('multiple addNote calls accumulate notes for the same worktree', () => {
    const { result } = renderHook(() => useReviewNotes());

    act(() => {
      result.current.addNote('feat-abc', { text: 'First' });
      result.current.addNote('feat-abc', { text: 'Second' });
    });

    expect(result.current.notesByWorktree['feat-abc']).toHaveLength(2);
  });

  // ── removeNote removes only the matching note ───────────────────────────

  it('removeNote removes only the note with the matching id', () => {
    const { result } = renderHook(() => useReviewNotes());

    act(() => {
      result.current.addNote('feat-abc', { text: 'Keep me' });
      result.current.addNote('feat-abc', { text: 'Remove me' });
    });

    const idToRemove = result.current.notesByWorktree['feat-abc'].find(
      n => n.text === 'Remove me'
    ).id;

    act(() => {
      result.current.removeNote('feat-abc', idToRemove);
    });

    const remaining = result.current.notesByWorktree['feat-abc'];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].text).toBe('Keep me');
  });

  // ── clearForWorktree removes all notes for one worktree only ───────────

  it('clearForWorktree removes all notes for the given worktree while leaving others intact', () => {
    const { result } = renderHook(() => useReviewNotes());

    act(() => {
      result.current.addNote('feat-abc', { text: 'A1' });
      result.current.addNote('feat-abc', { text: 'A2' });
      result.current.addNote('feat-xyz', { text: 'X1' });
    });

    act(() => {
      result.current.clearForWorktree('feat-abc');
    });

    expect(result.current.notesByWorktree['feat-abc']).toBeUndefined();
    expect(result.current.notesByWorktree['feat-xyz']).toHaveLength(1);
  });
});
