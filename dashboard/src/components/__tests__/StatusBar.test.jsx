/**
 * Behaviour tests for StatusBar.
 *
 * Verifies observable behaviour: the status bar renders gateway status and
 * feature count but does NOT render a ticking wall-clock.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatusBar from '../StatusBar.jsx';

vi.mock('../../api.js', () => ({
  getStatus: vi.fn().mockResolvedValue({ featureCount: 7, uptimeMs: 1000 }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('StatusBar', () => {
  it('renders the app label', () => {
    render(<StatusBar />);
    expect(screen.getByText('[QA FLEET v1.0]')).toBeTruthy();
  });

  it('does not render a clock (no HH:MM:SS pattern)', () => {
    render(<StatusBar />);
    // A clock would appear as two-digit:two-digit:two-digit e.g. 12:34:56
    const clockPattern = /\d{2}:\d{2}:\d{2}/;
    expect(document.body.textContent).not.toMatch(clockPattern);
  });

  it('renders FEATURES label without a trailing pipe separator', () => {
    render(<StatusBar />);
    // The features span should contain "FEATURES" but no trailing "|"
    const featuresSpan = screen.getByText(/FEATURES/);
    expect(featuresSpan.textContent).not.toContain('|');
  });
});
