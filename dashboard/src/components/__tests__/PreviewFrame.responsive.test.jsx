/**
 * Behaviour tests for PreviewFrame responsive/accessibility concerns.
 *
 * These tests verify that the right CSS hooks are in place for:
 *   1. Flex-wrap at narrow viewports (preview-toolbar class on container)
 *   2. Touch-target sizing (toolbar-btn class on every action button)
 *   3. Title ellipsis (preview-toolbar__title class on the feature-title span)
 *
 * CSS media-query behaviour (pointer:coarse, max-width:767px) cannot be
 * asserted in JSDOM. What we CAN assert is that the HTML contracts the
 * responsive CSS rules depend on are satisfied.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PreviewFrame from '../PreviewFrame.jsx';

function renderActive(props = {}) {
  return render(
    <PreviewFrame
      previewKey={0}
      activePreview="app-foo"
      branch="foo"
      title="Foo Feature"
      {...props}
    />
  );
}

describe('PreviewFrame responsive hooks', () => {
  // ── Tracer bullet: toolbar container is CSS-targetable for flex-wrap ────────

  it('toolbar container carries the preview-toolbar class for responsive CSS', () => {
    const { container } = renderActive();
    expect(container.querySelector('.preview-toolbar')).toBeTruthy();
  });

  // ── Title span is CSS-targetable so min-width:0 can be applied ──────────────

  it('feature title span carries preview-toolbar__title class for ellipsis CSS', () => {
    const { container } = renderActive();
    expect(container.querySelector('.preview-toolbar__title')).toBeTruthy();
  });

  it('feature title span contains the feature title text', () => {
    renderActive({ title: 'My Feature' });
    const titleEl = screen.getByTitle('app-foo // foo');
    expect(titleEl).toHaveClass('preview-toolbar__title');
    expect(titleEl).toHaveTextContent('My Feature');
  });

  // ── Every toolbar button carries toolbar-btn for pointer:coarse touch targets

  it('PREVIEW tab button carries toolbar-btn class', () => {
    renderActive();
    expect(screen.getByRole('button', { name: /PREVIEW/ })).toHaveClass('toolbar-btn');
  });

  it('DIFF tab button carries toolbar-btn class', () => {
    renderActive();
    expect(screen.getByRole('button', { name: /DIFF/ })).toHaveClass('toolbar-btn');
  });

  it('CAPTURE button carries toolbar-btn class', () => {
    renderActive();
    expect(screen.getByRole('button', { name: /CAPTURE/ })).toHaveClass('toolbar-btn');
  });

  it('OPEN IN TAB button carries toolbar-btn class', () => {
    renderActive();
    expect(screen.getByRole('button', { name: /OPEN IN TAB/ })).toHaveClass('toolbar-btn');
  });

  it('REFRESH button carries toolbar-btn class', () => {
    renderActive();
    expect(screen.getByRole('button', { name: /REFRESH/ })).toHaveClass('toolbar-btn');
  });

  // ── toolbar-btn class is absent when no activePreview (empty state) ─────────

  it('no toolbar-btn buttons rendered when there is no active preview', () => {
    const { container } = render(
      <PreviewFrame previewKey={0} activePreview={null} />
    );
    expect(container.querySelectorAll('.toolbar-btn')).toHaveLength(0);
  });
});
