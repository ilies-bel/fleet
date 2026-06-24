/**
 * Behaviour test for the handleActivate guard in FeaturesPage.
 *
 * The ⌘1–9 keyboard shortcut dispatches handleActivate unconditionally —
 * without the guard, pressing the number of the already-active feature
 * would call activateFeature(), bump previewKey, remount the iframe, and
 * scroll the previewed app back to the top.
 *
 * This test asserts the observable consequence: when the requested key is
 * already the active preview, activateFeature is NOT called a second time.
 * We mock api.js at the module boundary; everything inside App.jsx is
 * exercised end-to-end through the public React surface.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../App.jsx';

vi.mock('../api.js', () => ({
  getFeatures: vi.fn(),
  activateFeature: vi.fn(),
  removeFeature: vi.fn(),
  getHealth: vi.fn(),
  getHostStats: vi.fn(),
  getServicesHealth: vi.fn(),
}));

import { getFeatures, activateFeature, getHealth, getHostStats, getServicesHealth } from '../api.js';

const FEATURES = [
  { key: 'proj-alpha', name: 'alpha', project: 'proj', branch: 'main', title: 'Alpha', isActive: true,  status: 'up' },
  { key: 'proj-beta',  name: 'beta',  project: 'proj', branch: 'main', title: 'Beta',  isActive: false, status: 'up' },
];

describe('App handleActivate guard', () => {
  beforeEach(() => {
    getFeatures.mockResolvedValue(FEATURES);
    activateFeature.mockResolvedValue({ ok: true, active: 'proj-alpha' });
    getHealth.mockResolvedValue({ status: 'up' });
    getHostStats.mockResolvedValue({});
    getServicesHealth.mockResolvedValue({});
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('does NOT call activateFeature when ⌘N targets the already-active feature', async () => {
    render(
      <MemoryRouter initialEntries={['/features']}>
        <App />
      </MemoryRouter>
    );

    // Wait for the initial fetch to land so activePreview is populated from
    // the gateway's truth (proj-alpha is isActive=true).
    await waitFor(() => expect(getFeatures).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });

    // Sanity: no activation has happened yet (initial state comes from the
    // gateway poll, not from a user click).
    expect(activateFeature).not.toHaveBeenCalled();

    // Simulate ⌘1 — alpha is index 0 and ALREADY active. The guard must
    // short-circuit before the API call.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: '1', metaKey: true, bubbles: true,
      }));
    });

    expect(activateFeature).not.toHaveBeenCalled();
  });

  it('DOES call activateFeature when ⌘N targets a different feature', async () => {
    render(
      <MemoryRouter initialEntries={['/features']}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => expect(getFeatures).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });

    // ⌘2 — beta is index 1 and NOT currently active. Guard must not
    // short-circuit; activateFeature must be called exactly once with the
    // beta key.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: '2', metaKey: true, bubbles: true,
      }));
    });

    await waitFor(() => expect(activateFeature).toHaveBeenCalledTimes(1));
    expect(activateFeature).toHaveBeenCalledWith('proj-beta');
  });
});
