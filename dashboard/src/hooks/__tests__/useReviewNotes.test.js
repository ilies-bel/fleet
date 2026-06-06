/**
 * Behaviour tests for the useReviewNotes hook.
 *
 * Verifies:
 *  - Initial state is empty (when localStorage is empty).
 *  - State is restored from localStorage on initialisation.
 *  - localStorage parse errors are treated as empty state.
 *  - State is written to localStorage on every change.
 *  - addNote stores a note under the given worktree with generated id/createdAt.
 *  - addNote keeps different worktrees isolated.
 *  - Multiple addNote calls accumulate notes.
 *  - removeNote removes only the matching note.
 *  - clearForWorktree removes all notes for one worktree, leaving others intact.
 *  - clearForWorktree removes only the target worktree's entry in localStorage.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReviewNotes } from '../useReviewNotes.js';

const STORAGE_KEY = 'fleet.reviewNotes.v1';

// localStorage may be undefined in jsdom for this vitest config; provide a
// controlled in-memory implementation so tests can inspect what was written.
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

describe('useReviewNotes', () => {
  beforeAll(() => {
    vi.stubGlobal('localStorage', localStorageMock);
  });

  beforeEach(() => {
    localStorageMock.clear();
  });

  // ── Tracer bullet: hook starts with empty state ─────────────────────────

  it('starts with empty notesByWorktree when localStorage is empty', () => {
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

  // ── localStorage persistence ────────────────────────────────────────────

  it('reads notes from localStorage on initialisation', () => {
    const seed = { 'feat-abc': [{ id: 'n1', text: 'Persisted note', createdAt: '2024-01-01T00:00:00.000Z' }] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));

    const { result } = renderHook(() => useReviewNotes());

    expect(result.current.notesByWorktree['feat-abc']).toHaveLength(1);
    expect(result.current.notesByWorktree['feat-abc'][0].text).toBe('Persisted note');
  });

  it('treats corrupt localStorage data as empty state', () => {
    localStorage.setItem(STORAGE_KEY, 'not-valid-json{{{');

    const { result } = renderHook(() => useReviewNotes());

    expect(result.current.notesByWorktree).toEqual({});
  });

  it('writes notes to localStorage when a note is added', () => {
    const { result } = renderHook(() => useReviewNotes());

    act(() => {
      result.current.addNote('feat-abc', { text: 'Saved note' });
    });

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(stored['feat-abc']).toHaveLength(1);
    expect(stored['feat-abc'][0].text).toBe('Saved note');
  });

  it('clearForWorktree removes only that worktree from localStorage, leaving others intact', () => {
    const { result } = renderHook(() => useReviewNotes());

    act(() => {
      result.current.addNote('feat-abc', { text: 'A' });
      result.current.addNote('feat-xyz', { text: 'X' });
    });

    act(() => {
      result.current.clearForWorktree('feat-abc');
    });

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(stored['feat-abc']).toBeUndefined();
    expect(stored['feat-xyz']).toHaveLength(1);
  });
});
