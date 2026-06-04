/**
 * Behaviour tests for the responsive off-canvas feature drawer.
 *
 * Verifies observable behaviour through the public interface only:
 * what the user sees and can do at narrow vs. wide viewport widths.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../../App.jsx';

// Mock every API boundary used by components rendered under App.
vi.mock('../../api.js', () => ({
  getFeatures: vi.fn().mockResolvedValue([]),
  getStatus: vi.fn().mockResolvedValue({
    uptimeMs: 1000,
    featureCount: 0,
    activeFeature: null,
    nodeVersion: '20.0.0',
  }),
  activateFeature: vi.fn().mockResolvedValue({ ok: true }),
  getHealth: vi.fn().mockResolvedValue({ status: 'up' }),
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

/**
 * Stub window.matchMedia to simulate narrow (<768px) or wide (>=768px) viewport.
 * jsdom does not implement matchMedia, so every test that renders App must call
 * one of these helpers before rendering.
 */
function stubMatchMedia(narrow) {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: narrow,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
}

function renderApp(path = '/features') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

describe('App — responsive off-canvas drawer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // ── Tracer bullet: toggle visible on narrow viewport ─────────────────────

  it('shows the drawer toggle button when the viewport is narrow', () => {
    stubMatchMedia(true);
    renderApp();
    expect(screen.getByRole('button', { name: 'Toggle feature drawer' })).toBeInTheDocument();
  });

  // ── Toggle hidden on wide viewport ────────────────────────────────────────

  it('hides the drawer toggle button when the viewport is wide', () => {
    stubMatchMedia(false);
    renderApp();
    expect(screen.queryByRole('button', { name: 'Toggle feature drawer' })).not.toBeInTheDocument();
  });

  // ── Drawer is closed by default ───────────────────────────────────────────

  it('drawer starts closed (data-open=false) on a narrow viewport', () => {
    stubMatchMedia(true);
    renderApp();
    const drawer = screen.getByRole('complementary', { name: 'Feature list drawer' });
    expect(drawer).toHaveAttribute('data-open', 'false');
  });

  // ── Clicking toggle opens the drawer ─────────────────────────────────────

  it('opens the drawer when the toggle button is clicked', () => {
    stubMatchMedia(true);
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle feature drawer' }));
    const drawer = screen.getByRole('complementary', { name: 'Feature list drawer' });
    expect(drawer).toHaveAttribute('data-open', 'true');
  });

  // ── Clicking toggle again closes the drawer ───────────────────────────────

  it('closes the drawer when the toggle is clicked a second time', () => {
    stubMatchMedia(true);
    renderApp();
    const toggle = screen.getByRole('button', { name: 'Toggle feature drawer' });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    const drawer = screen.getByRole('complementary', { name: 'Feature list drawer' });
    expect(drawer).toHaveAttribute('data-open', 'false');
  });
});
