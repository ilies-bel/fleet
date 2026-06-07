/**
 * Behaviour tests for the PreviewFrame toolbar header.
 *
 * The header must surface the human-friendly feature title as the primary
 * label and demote the technical 'instance // branch' path to a tooltip.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PreviewFrame from '../PreviewFrame.jsx';

function renderFrame(props) {
  return render(<PreviewFrame previewKey={0} {...props} />);
}

describe('PreviewFrame toolbar header', () => {
  // ── Tracer bullet: title is the visible primary label ─────────────────────

  it('shows the feature title as the visible primary label', () => {
    renderFrame({
      activePreview: 'app-bd-app-3s9',
      branch: 'bd-app-3s9',
      title: 'BD App v3',
    });

    expect(screen.getByText('BD App v3')).toBeInTheDocument();
  });

  // ── Technical path is in the tooltip, not as prominent text ──────────────

  it('puts the technical instance//branch path in the tooltip, not as visible text', () => {
    renderFrame({
      activePreview: 'app-bd-app-3s9',
      branch: 'bd-app-3s9',
      title: 'BD App v3',
    });

    // The full technical path should NOT appear as visible text
    expect(screen.queryByText(/app-bd-app-3s9 \/\/ bd-app-3s9/)).not.toBeInTheDocument();

    // But it must be accessible via the title= tooltip so the info is not lost
    const labelSpan = screen.getByTitle('app-bd-app-3s9 // bd-app-3s9');
    expect(labelSpan).toBeInTheDocument();
  });

  // ── Title is the visible text, not the technical key ─────────────────────

  it('does not show the raw activePreview key as visible text when a title is given', () => {
    renderFrame({
      activePreview: 'app-bd-app-3s9',
      branch: 'bd-app-3s9',
      title: 'BD App v3',
    });

    // 'app-bd-app-3s9' appears only in the tooltip, not as standalone text
    expect(screen.queryByText('app-bd-app-3s9')).not.toBeInTheDocument();
  });

  // ── Fallback when no title: show activePreview ────────────────────────────

  it('falls back to activePreview when no title is provided', () => {
    renderFrame({
      activePreview: 'app-some-feature',
      branch: 'some-feature',
    });

    expect(screen.getByText('app-some-feature')).toBeInTheDocument();
  });

  // ── Tooltip is still present in the fallback case ────────────────────────

  it('tooltip still carries instance//branch in the fallback case', () => {
    renderFrame({
      activePreview: 'app-some-feature',
      branch: 'some-feature',
    });

    const labelSpan = screen.getByTitle('app-some-feature // some-feature');
    expect(labelSpan).toBeInTheDocument();
  });

  // ── Empty state: no active preview ───────────────────────────────────────

  it('renders the first-run register state when nothing is active and no features exist', () => {
    renderFrame({ activePreview: null, hasFeatures: false });
    expect(screen.getByText(/0 FEATURES REGISTERED/)).toBeInTheDocument();
    expect(screen.getByText('fleet add <name> <branch>')).toBeInTheDocument();
  });

  it('renders the activate-a-feature state when features exist but none is active', () => {
    renderFrame({ activePreview: null, hasFeatures: true });
    expect(screen.getByText(/NO FEATURE ACTIVE/)).toBeInTheDocument();
    // Past first run: prompt to activate, not to register again.
    expect(screen.queryByText('fleet add <name> <branch>')).not.toBeInTheDocument();
  });

  // ── Buttons are untouched ─────────────────────────────────────────────────

  it('always shows OPEN IN TAB and REFRESH buttons when a preview is active', () => {
    renderFrame({
      activePreview: 'app-foo',
      branch: 'foo',
      title: 'Foo Feature',
    });

    expect(screen.getByText(/OPEN IN TAB/)).toBeInTheDocument();
    expect(screen.getByText(/REFRESH/)).toBeInTheDocument();
  });
});
