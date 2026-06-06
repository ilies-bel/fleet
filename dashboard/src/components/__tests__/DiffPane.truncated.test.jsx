/**
 * Behaviour tests for the DiffPane truncation banner.
 *
 * Verifies:
 *  - When the API returns truncated=true, a banner with the cap and original
 *    size (formatted in MB) is rendered above the file list.
 *  - When truncated is false (or absent), no banner is rendered.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import DiffPane from '../DiffPane.jsx';

vi.mock('../../api.js', () => ({
  getDiff: vi.fn(),
}));

import { getDiff } from '../../api.js';

// A minimal but valid single-file diff so the component reaches the "diff" state
const MINIMAL_PATCH = [
  'diff --git a/src/foo.js b/src/foo.js',
  'index 1234567..abcdefg 100644',
  '--- a/src/foo.js',
  '+++ b/src/foo.js',
  '@@ -1,2 +1,2 @@',
  ' const x = 1;',
  '-const y = 2;',
  '+const y = 3;',
].join('\n');

describe('DiffPane truncation banner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Tracer bullet: banner renders when truncated=true ─────────────────────

  it('renders the truncation banner when truncated is true', async () => {
    // 2 MB original; cap is 1 MB → banner should say "1.0 MB" and "2.0 MB"
    const twoMBBytes = 2 * 1_048_576;
    getDiff.mockResolvedValue({
      patch: MINIMAL_PATCH,
      isEmpty: false,
      truncated: true,
      originalBytes: twoMBBytes,
    });

    render(<DiffPane activeKey="big-feat" />);

    await waitFor(() => {
      expect(screen.getByText(/DIFF TRUNCATED/)).toBeInTheDocument();
    });

    const banner = document.querySelector('.diff-truncation-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toContain('1.0 MB');
    expect(banner.textContent).toContain('2.0 MB');
  });

  // ── Banner text format ────────────────────────────────────────────────────

  it('formats the banner text as "showing first 1.0 MB of N.N MB"', async () => {
    const originalBytes = 3 * 1_048_576; // 3 MB
    getDiff.mockResolvedValue({
      patch: MINIMAL_PATCH,
      isEmpty: false,
      truncated: true,
      originalBytes,
    });

    render(<DiffPane activeKey="large-feat" />);

    await waitFor(() => {
      const banner = document.querySelector('.diff-truncation-banner');
      expect(banner).toBeInTheDocument();
      expect(banner.textContent).toContain('showing first 1.0 MB of 3.0 MB');
    });
  });

  // ── No banner when not truncated ──────────────────────────────────────────

  it('does not render a truncation banner when truncated is false', async () => {
    getDiff.mockResolvedValue({
      patch: MINIMAL_PATCH,
      isEmpty: false,
      truncated: false,
      originalBytes: MINIMAL_PATCH.length,
    });

    render(<DiffPane activeKey="small-feat" />);

    await waitFor(() => {
      // The diff file block is present, confirming the diff state was reached
      expect(document.querySelector('.diff-file-block')).toBeInTheDocument();
    });

    expect(document.querySelector('.diff-truncation-banner')).not.toBeInTheDocument();
  });

  // ── No banner when truncated is absent ────────────────────────────────────

  it('does not render a truncation banner when truncated is absent from the response', async () => {
    getDiff.mockResolvedValue({
      patch: MINIMAL_PATCH,
      isEmpty: false,
      // truncated field intentionally omitted (older gateway version)
    });

    render(<DiffPane activeKey="legacy-feat" />);

    await waitFor(() => {
      expect(document.querySelector('.diff-file-block')).toBeInTheDocument();
    });

    expect(document.querySelector('.diff-truncation-banner')).not.toBeInTheDocument();
  });
});
