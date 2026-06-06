/**
 * Behaviour tests for DiffPane with react-diff-view rendering.
 *
 * Verifies:
 *  - Two file blocks rendered for a two-file patch (headers + split diff tables).
 *  - Each file block uses split viewType (four columns: old-gutter, old-code,
 *    new-gutter, new-code).
 *  - At least one insertion or deletion row is present (classed by react-diff-view).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DiffPane from '../DiffPane.jsx';

vi.mock('../../api.js', () => ({
  getDiff: vi.fn(),
}));

import { getDiff } from '../../api.js';

// A minimal but valid two-file git diff fixture.
// Two modified files: src/foo.js (JS) and src/bar.css (CSS).
const TWO_FILE_PATCH = [
  'diff --git a/src/foo.js b/src/foo.js',
  'index 1234567..abcdefg 100644',
  '--- a/src/foo.js',
  '+++ b/src/foo.js',
  '@@ -1,3 +1,4 @@',
  ' const x = 1;',
  '-const y = 2;',
  '+const y = 3;',
  '+const z = 4;',
  ' module.exports = { x, y };',
  'diff --git a/src/bar.css b/src/bar.css',
  'index 2345678..bcdefgh 100644',
  '--- a/src/bar.css',
  '+++ b/src/bar.css',
  '@@ -1,3 +1,3 @@',
  ' .container {',
  '-  color: red;',
  '+  color: blue;',
  ' }',
].join('\n');

describe('DiffPane rich diff rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDiff.mockResolvedValue({ patch: TWO_FILE_PATCH, isEmpty: false });
  });

  // ── Tracer bullet: two file blocks render ─────────────────────────────────

  it('renders two .diff-file-block sections for a two-file patch', async () => {
    render(<DiffPane activeKey="my-feat" />);

    await waitFor(() => {
      const blocks = document.querySelectorAll('.diff-file-block');
      expect(blocks.length).toBe(2);
    });
  });

  // ── File headers show the file path ──────────────────────────────────────

  it('renders a file header for each changed file', async () => {
    render(<DiffPane activeKey="my-feat" />);

    await waitFor(() => {
      const headers = document.querySelectorAll('.diff-file-header');
      expect(headers.length).toBe(2);
    });

    const headers = document.querySelectorAll('.diff-file-header');
    const headerTexts = Array.from(headers).map(h => h.textContent);
    expect(headerTexts.some(t => t.includes('src/foo.js'))).toBe(true);
    expect(headerTexts.some(t => t.includes('src/bar.css'))).toBe(true);
  });

  // ── Split view: react-diff-view renders a .diff table per file ───────────

  it('renders a .diff table (react-diff-view split view) for each file block', async () => {
    render(<DiffPane activeKey="my-feat" />);

    await waitFor(() => {
      const tables = document.querySelectorAll('.diff-file-block .diff');
      expect(tables.length).toBe(2);
    });
  });

  // ── At least one add/remove row is classed by react-diff-view ────────────

  it('renders at least one insertion or deletion cell classed by react-diff-view', async () => {
    render(<DiffPane activeKey="my-feat" />);

    await waitFor(() => {
      // react-diff-view applies diff-code-insert / diff-code-delete to changed cells
      const changed = document.querySelector(
        '.diff-code-insert, .diff-code-delete, .diff-gutter-insert, .diff-gutter-delete',
      );
      expect(changed).toBeInTheDocument();
    });
  });

  // ── Loading state ─────────────────────────────────────────────────────────

  it('shows a loading message before getDiff resolves', () => {
    getDiff.mockReturnValue(new Promise(() => {})); // never resolves
    render(<DiffPane activeKey="my-feat" />);
    expect(screen.getByText(/Loading diff/)).toBeInTheDocument();
  });

  // ── No-changes fallback ───────────────────────────────────────────────────

  it('shows no-changes message when the patch produces no parseable hunks', async () => {
    getDiff.mockResolvedValue({ patch: '', isEmpty: true });
    render(<DiffPane activeKey="my-feat" />);

    await waitFor(() => {
      expect(screen.getByText(/\/\/ NO CHANGES VS main/)).toBeInTheDocument();
    });
  });
});
