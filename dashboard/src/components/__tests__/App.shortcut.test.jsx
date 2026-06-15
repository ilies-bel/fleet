/**
 * Keyboard shortcut tests: Cmd/Ctrl+1..9 activates the Nth feature.
 *
 * Renders the full App (with a MemoryRouter) and dispatches keydown events
 * against window, asserting that activateFeature is called with the correct
 * feature key — the same outcome as clicking [ACTIVATE] on a FeatureCard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../../App.jsx';
import * as api from '../../api.js';

vi.mock('../../api.js', () => ({
  getFeatures: vi.fn(),
  activateFeature: vi.fn(),
  getStatus: vi.fn(),
  getHealth: vi.fn(),
  getServicesHealth: vi.fn(),
  getLogs: vi.fn(),
  getStats: vi.fn(),
  stopFeature: vi.fn(),
  startFeature: vi.fn(),
  syncFeature: vi.fn(),
  removeFeature: vi.fn(),
}));

const FEATURES = [
  {
    key: 'proj-feat-a',
    name: 'feat-a',
    branch: 'main',
    project: 'proj',
    isActive: false,
    status: 'running',
    services: [],
  },
  {
    key: 'proj-feat-b',
    name: 'feat-b',
    branch: 'dev',
    project: 'proj',
    isActive: false,
    status: 'running',
    services: [],
  },
];

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/features']}>
      <App />
    </MemoryRouter>
  );
}

describe('App keyboard shortcuts (Cmd/Ctrl+1..9)', () => {
  beforeEach(() => {
    api.getFeatures.mockResolvedValue(FEATURES);
    api.activateFeature.mockResolvedValue({ ok: true });
    api.getStatus.mockResolvedValue({ featureCount: FEATURES.length });
    api.getHealth.mockResolvedValue({ status: 'up' });
    api.getServicesHealth.mockResolvedValue({ services: [] });
    api.getLogs.mockResolvedValue({ lines: '' });
    api.getStats.mockResolvedValue({});
    api.stopFeature.mockResolvedValue({});
    api.startFeature.mockResolvedValue({});
    api.syncFeature.mockResolvedValue({ ok: true });
    api.removeFeature.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('Cmd+1 calls activateFeature with the first feature key', async () => {
    renderApp();
    // Wait until getFeatures has resolved and React has applied the state update.
    await waitFor(() => expect(api.getFeatures).toHaveBeenCalled());
    // Flush any remaining async work (pending state updates, effect re-runs).
    await act(async () => {});

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '1', metaKey: true, bubbles: true })
    );

    await waitFor(() =>
      expect(api.activateFeature).toHaveBeenCalledWith('proj-feat-a')
    );
  });

  it('Ctrl+1 also activates the first feature', async () => {
    renderApp();
    await waitFor(() => expect(api.getFeatures).toHaveBeenCalled());
    await act(async () => {});

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true })
    );

    await waitFor(() =>
      expect(api.activateFeature).toHaveBeenCalledWith('proj-feat-a')
    );
  });

  it('Cmd+2 activates the second feature', async () => {
    renderApp();
    await waitFor(() => expect(api.getFeatures).toHaveBeenCalled());
    await act(async () => {});

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '2', metaKey: true, bubbles: true })
    );

    await waitFor(() =>
      expect(api.activateFeature).toHaveBeenCalledWith('proj-feat-b')
    );
  });

  it('Cmd+3 is a no-op when fewer than 3 features exist', async () => {
    renderApp();
    await waitFor(() => expect(api.getFeatures).toHaveBeenCalled());
    await act(async () => {});

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '3', metaKey: true, bubbles: true })
    );

    // Give React time to process in case the handler fires anything unexpected.
    await act(async () => {});

    expect(api.activateFeature).not.toHaveBeenCalled();
  });

  it('keystroke without metaKey/ctrlKey is ignored', async () => {
    renderApp();
    await waitFor(() => expect(api.getFeatures).toHaveBeenCalled());
    await act(async () => {});

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '1', bubbles: true })
    );

    await act(async () => {});

    expect(api.activateFeature).not.toHaveBeenCalled();
  });
});
