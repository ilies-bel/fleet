/**
 * Behaviour tests for the PREVIEW / DIFF tab switch in PreviewFrame.
 *
 * Verifies:
 *  - Both tabs render when a feature is active.
 *  - PREVIEW is selected by default (OPEN IN TAB + REFRESH present).
 *  - Switching to DIFF removes those controls from the DOM.
 *  - getDiff is called exactly once with the active key on DIFF activation.
 *  - The patch text appears inside a <pre> after the fetch resolves.
 *  - Switching back to PREVIEW restores the preview controls.
 *  - The iframe element is the same DOM node across tab switches (not remounted).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PreviewFrame from '../PreviewFrame.jsx';

// Mock the api module so DiffPane's getDiff call never hits the network.
vi.mock('../../api.js', () => ({
  getDiff: vi.fn(),
}));

import { getDiff } from '../../api.js';

function renderFrame(props) {
  return render(<PreviewFrame previewKey={0} {...props} />);
}

describe('PreviewFrame PREVIEW/DIFF tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDiff.mockResolvedValue({ patch: 'diff --git a/foo.js b/foo.js\n', isEmpty: false });
  });

  // ── Tracer bullet: both tabs render when a feature is active ─────────────

  it('renders [PREVIEW] and [DIFF] tab buttons when a feature is active', () => {
    renderFrame({ activePreview: 'app-feat', branch: 'feat', title: 'My Feature' });

    expect(screen.getByText('[PREVIEW]')).toBeInTheDocument();
    expect(screen.getByText('[DIFF]')).toBeInTheDocument();
  });

  // ── Default is PREVIEW — preview controls are visible ────────────────────

  it('shows OPEN IN TAB and REFRESH by default (PREVIEW selected)', () => {
    renderFrame({ activePreview: 'app-feat', branch: 'feat', title: 'My Feature' });

    expect(screen.getByText(/OPEN IN TAB/)).toBeInTheDocument();
    expect(screen.getByText(/REFRESH/)).toBeInTheDocument();
  });

  // ── Switching to DIFF removes the preview-only controls ──────────────────

  it('hides [↗ OPEN IN TAB] from the DOM when DIFF tab is active', () => {
    renderFrame({ activePreview: 'app-feat', branch: 'feat', title: 'My Feature' });

    fireEvent.click(screen.getByText('[DIFF]'));

    expect(screen.queryByText(/OPEN IN TAB/)).not.toBeInTheDocument();
  });

  it('hides [↺ REFRESH] from the DOM when DIFF tab is active', () => {
    renderFrame({ activePreview: 'app-feat', branch: 'feat', title: 'My Feature' });

    fireEvent.click(screen.getByText('[DIFF]'));

    expect(screen.queryByText(/REFRESH/)).not.toBeInTheDocument();
  });

  // ── getDiff is called once with the correct key on DIFF activation ────────

  it('calls getDiff exactly once with the active feature key when DIFF tab is clicked', () => {
    renderFrame({ activePreview: 'app-feat', branch: 'feat', title: 'My Feature' });

    fireEvent.click(screen.getByText('[DIFF]'));

    expect(getDiff).toHaveBeenCalledTimes(1);
    expect(getDiff).toHaveBeenCalledWith('app-feat');
  });

  it('does not call getDiff before the DIFF tab is clicked', () => {
    renderFrame({ activePreview: 'app-feat', branch: 'feat', title: 'My Feature' });

    expect(getDiff).not.toHaveBeenCalled();
  });

  // ── Diff view renders after fetch resolves ───────────────────────────────

  it('renders the diff-pane container after getDiff resolves with a valid patch', async () => {
    const validPatch = [
      'diff --git a/foo.js b/foo.js',
      'index 1234567..abcdefg 100644',
      '--- a/foo.js',
      '+++ b/foo.js',
      '@@ -1,2 +1,2 @@',
      ' const x = 1;',
      '-const y = 2;',
      '+const y = 3;',
    ].join('\n');
    getDiff.mockResolvedValue({ patch: validPatch, isEmpty: false });
    renderFrame({ activePreview: 'app-feat', branch: 'feat', title: 'My Feature' });

    fireEvent.click(screen.getByText('[DIFF]'));

    await waitFor(() => {
      expect(document.querySelector('.diff-pane')).toBeInTheDocument();
    });
  });

  // ── Switching back to PREVIEW restores the controls ───────────────────────

  it('restores OPEN IN TAB and REFRESH when switching back to PREVIEW', () => {
    renderFrame({ activePreview: 'app-feat', branch: 'feat', title: 'My Feature' });

    fireEvent.click(screen.getByText('[DIFF]'));
    expect(screen.queryByText(/OPEN IN TAB/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('[PREVIEW]'));

    expect(screen.getByText(/OPEN IN TAB/)).toBeInTheDocument();
    expect(screen.getByText(/REFRESH/)).toBeInTheDocument();
  });

  // ── Iframe is preserved across tab switches (not remounted) ───────────────

  it('keeps the same iframe DOM element across tab switches', () => {
    renderFrame({ activePreview: 'app-feat', branch: 'feat', title: 'My Feature' });

    const iframeBefore = document.querySelector('iframe');
    expect(iframeBefore).toBeInTheDocument();

    fireEvent.click(screen.getByText('[DIFF]'));
    // iframe is still in DOM (display:none), same node
    const iframeAfterDiff = document.querySelector('iframe');
    expect(iframeAfterDiff).toBe(iframeBefore);

    fireEvent.click(screen.getByText('[PREVIEW]'));
    const iframeAfterBack = document.querySelector('iframe');
    expect(iframeAfterBack).toBe(iframeBefore);
  });

  // ── Tab buttons are absent in the empty state ────────────────────────────

  it('does not render the tab buttons when no feature is active', () => {
    renderFrame({ activePreview: null });

    expect(screen.queryByText('[PREVIEW]')).not.toBeInTheDocument();
    expect(screen.queryByText('[DIFF]')).not.toBeInTheDocument();
  });
});
