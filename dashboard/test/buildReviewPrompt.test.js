/**
 * Behaviour tests for buildReviewPrompt.
 *
 * Verifies:
 *  - Mix of element notes (with selector) and general notes (without selector)
 *    across two named routes produces the exact expected output string.
 *  - Named routes are sorted alphabetically with 'General' section last.
 *  - Element notes render as `- <selector> — <text>`.
 *  - General (selector-less) notes render as `- <text>` with no selector prefix.
 *  - The input notes array is not mutated by calling buildReviewPrompt.
 */

import { describe, it, expect } from 'vitest';
import { buildReviewPrompt } from '../src/lib/buildReviewPrompt.js';

describe('buildReviewPrompt', () => {
  // ── Tracer bullet: exact output for mixed notes across two routes ──────────

  it('produces the exact expected text for a mix of element and general notes across two routes', () => {
    const notes = [
      { id: '1', selector: '.btn', route: '/home', text: 'Make button bigger', refKind: 'class' },
      { id: '2', selector: '#title', route: '/settings', text: 'Change font', refKind: 'id' },
      { id: '3', selector: null, route: null, text: 'Overall layout needs work', refKind: 'general' },
      { id: '4', selector: '.nav', route: '/home', text: 'Add hover state', refKind: 'class' },
    ];

    const result = buildReviewPrompt('feat-redesign', notes);

    const expected =
      'Worktree: feat-redesign\n' +
      '\n' +
      '## /home\n' +
      '- .btn — Make button bigger\n' +
      '- .nav — Add hover state\n' +
      '\n' +
      '## /settings\n' +
      '- #title — Change font\n' +
      '\n' +
      '## General\n' +
      '- Overall layout needs work';

    expect(result).toBe(expected);
  });

  // ── Named routes are sorted alphabetically ────────────────────────────────

  it('sorts named routes alphabetically before the General section', () => {
    const notes = [
      { id: '1', selector: '.z', route: '/zebra', text: 'Z note', refKind: 'class' },
      { id: '2', selector: '.a', route: '/alpha', text: 'A note', refKind: 'class' },
    ];

    const result = buildReviewPrompt('my-tree', notes);

    const lines = result.split('\n');
    const alphaLine = lines.findIndex(l => l === '## /alpha');
    const zebraLine = lines.findIndex(l => l === '## /zebra');
    expect(alphaLine).toBeLessThan(zebraLine);
  });

  // ── General section always comes last ─────────────────────────────────────

  it('places General section after all named route sections', () => {
    const notes = [
      { id: '1', selector: '.x', route: '/page', text: 'Route note', refKind: 'class' },
      { id: '2', selector: null, route: null, text: 'General note', refKind: 'general' },
    ];

    const result = buildReviewPrompt('my-tree', notes);

    const lines = result.split('\n');
    const pageLine = lines.findIndex(l => l === '## /page');
    const generalLine = lines.findIndex(l => l === '## General');
    expect(pageLine).toBeLessThan(generalLine);
  });

  // ── Input notes array is not mutated ─────────────────────────────────────

  it('does not mutate the input notes array', () => {
    const notes = [
      { id: '1', selector: '.btn', route: '/home', text: 'Keep me', refKind: 'class' },
      { id: '2', selector: null, route: null, text: 'General', refKind: 'general' },
    ];
    const notesCopy = notes.map(n => ({ ...n }));

    buildReviewPrompt('feat-test', notes);

    expect(notes).toHaveLength(notesCopy.length);
    notes.forEach((note, i) => {
      expect(note).toEqual(notesCopy[i]);
    });
  });

  // ── Only general notes (no named routes) ─────────────────────────────────

  it('handles notes with no route correctly — all appear under General', () => {
    const notes = [
      { id: '1', selector: null, route: null, text: 'First general', refKind: 'general' },
      { id: '2', selector: null, route: null, text: 'Second general', refKind: 'general' },
    ];

    const result = buildReviewPrompt('feat-only-general', notes);

    expect(result).toBe(
      'Worktree: feat-only-general\n\n## General\n- First general\n- Second general'
    );
  });
});
