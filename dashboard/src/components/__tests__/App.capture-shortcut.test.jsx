/**
 * Behaviour tests for the Cmd/Ctrl+Shift+K capture shortcut in App/FeaturesPage.
 *
 * Verifies:
 *  - Pressing Cmd+Shift+K (or Ctrl+Shift+K) flips the Capture button's
 *    aria-pressed when a feature is active in the preview.
 *  - The shortcut does not interfere with the Cmd/Ctrl+1–9 feature shortcuts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../../App.jsx';

vi.mock('../../api.js', () => ({
  getFeatures: vi.fn().mockResolvedValue([
    { key: 'feat-a', title: 'Feature A', branch: 'branch-a', isActive: true },
  ]),
  getStatus: vi.fn().mockResolvedValue({
    uptimeMs: 0,
    featureCount: 1,
    activeFeature: 'feat-a',
    nodeVersion: '22.0.0',
  }),
  activateFeature: vi.fn().mockResolvedValue({ ok: true }),
  getHealth: vi.fn().mockResolvedValue({ status: 'up' }),
  getServicesHealth: vi.fn().mockResolvedValue({ services: [] }),
  removeFeature: vi.fn().mockResolvedValue({}),
  stopFeature: vi.fn().mockResolvedValue({}),
  startFeature: vi.fn().mockResolvedValue({}),
  syncFeature: vi.fn().mockResolvedValue({ ok: true, message: 'syncing' }),
  addFeature: vi.fn().mockResolvedValue({}),
  getLogs: vi.fn().mockResolvedValue({ lines: '', fetchedAt: 0 }),
  getStats: vi.fn().mockResolvedValue({
    cpuPercent: 0, memUsageMB: 0, memLimitMB: 0, netRxMB: 0, netTxMB: 0,
  }),
}));

function stubMatchMedia(narrow = false) {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: narrow,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
}

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/features']}>
      <App />
    </MemoryRouter>
  );
}

describe('App — Cmd/Ctrl+Shift+K capture shortcut', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // ── Tracer bullet: shortcut toggles capture on ────────────────────────────

  it('flips the Capture button aria-pressed to true on Cmd+Shift+K', async () => {
    stubMatchMedia(false);
    renderApp();

    // Wait for the async feature load so PreviewFrame renders with an activePreview
    const captureBtn = await screen.findByRole('button', { name: /capture/i });
    expect(captureBtn).toHaveAttribute('aria-pressed', 'false');

    fireEvent.keyDown(window, { key: 'K', shiftKey: true, metaKey: true });

    expect(captureBtn).toHaveAttribute('aria-pressed', 'true');
  });

  // ── Second press toggles it back off ─────────────────────────────────────

  it('returns aria-pressed to false after a second Cmd+Shift+K', async () => {
    stubMatchMedia(false);
    renderApp();

    const captureBtn = await screen.findByRole('button', { name: /capture/i });

    fireEvent.keyDown(window, { key: 'K', shiftKey: true, metaKey: true });
    fireEvent.keyDown(window, { key: 'K', shiftKey: true, metaKey: true });

    expect(captureBtn).toHaveAttribute('aria-pressed', 'false');
  });

  // ── Does not collide with Cmd+1–9 feature shortcuts ──────────────────────

  it('does not toggle capture on Cmd+1 (feature shortcut)', async () => {
    stubMatchMedia(false);
    renderApp();

    const captureBtn = await screen.findByRole('button', { name: /capture/i });

    fireEvent.keyDown(window, { key: '1', metaKey: true });

    expect(captureBtn).toHaveAttribute('aria-pressed', 'false');
  });

  // ── Ctrl variant works too ────────────────────────────────────────────────

  it('flips the Capture button aria-pressed to true on Ctrl+Shift+K', async () => {
    stubMatchMedia(false);
    renderApp();

    const captureBtn = await screen.findByRole('button', { name: /capture/i });

    fireEvent.keyDown(window, { key: 'K', shiftKey: true, ctrlKey: true });

    expect(captureBtn).toHaveAttribute('aria-pressed', 'true');
  });
});
