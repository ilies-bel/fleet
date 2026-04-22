/**
 * Unit tests for BuildLogPanel — vitest + @testing-library/react.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import BuildLogPanel from '../BuildLogPanel.jsx';

// ── EventSource mock ─────────────────────────────────────────────────────────

/**
 * Minimal EventSource stub that records the last instance so tests can
 * simulate message delivery and connection errors.
 */
class MockEventSource {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.onerror = null;
    MockEventSource._last = this;
  }
  close() {
    this._closed = true;
  }
  /** Simulate the server delivering a data line. */
  deliver(data) {
    if (this.onmessage) this.onmessage({ data });
  }
}
MockEventSource._last = null;

beforeEach(() => {
  MockEventSource._last = null;
  vi.stubGlobal('EventSource', MockEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('BuildLogPanel', () => {
  it('renders nothing when status is running and no lines buffered', () => {
    const { container } = render(
      <BuildLogPanel featureName="foo" status="running" />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when status is stopped and no lines buffered', () => {
    const { container } = render(
      <BuildLogPanel featureName="foo" status="stopped" />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders panel and toggle button when status is building', () => {
    render(<BuildLogPanel featureName="bar" status="building" />);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('shows log lines when status is building and messages arrive', async () => {
    render(<BuildLogPanel featureName="bar" status="building" />);

    await act(async () => {
      MockEventSource._last.deliver('Step 1/10 : FROM node:20');
      MockEventSource._last.deliver('Step 2/10 : COPY package.json .');
    });

    expect(screen.getByText('Step 1/10 : FROM node:20')).toBeInTheDocument();
    expect(screen.getByText('Step 2/10 : COPY package.json .')).toBeInTheDocument();
  });

  it('opens EventSource to the correct URL for the feature name', () => {
    render(<BuildLogPanel featureName="my-feature" status="building" />);
    expect(MockEventSource._last.url).toBe('/_fleet/api/features/my-feature/build-log');
  });

  it('does NOT open EventSource when status is running', () => {
    render(<BuildLogPanel featureName="foo" status="running" />);
    expect(MockEventSource._last).toBeNull();
  });

  it('toggle button collapses and expands the log', async () => {
    render(<BuildLogPanel featureName="baz" status="building" />);

    await act(async () => {
      MockEventSource._last.deliver('hello world');
    });

    // Log is visible by default
    expect(screen.getByText('hello world')).toBeInTheDocument();

    // Click toggle → collapse
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText('hello world')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveTextContent('[SHOW LOG]');

    // Click again → expand
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('hello world')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveTextContent('[HIDE LOG]');
  });

  it('auto-collapses when status transitions to running', async () => {
    const { rerender } = render(
      <BuildLogPanel featureName="baz" status="building" />
    );

    await act(async () => {
      MockEventSource._last.deliver('building...');
    });

    expect(screen.getByText('building...')).toBeInTheDocument();

    // Transition to running → should collapse
    rerender(<BuildLogPanel featureName="baz" status="running" />);

    expect(screen.queryByText('building...')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveTextContent('[SHOW LOG]');
  });

  it('shows failed hint in toggle button when status is failed and collapsed', async () => {
    render(<BuildLogPanel featureName="baz" status="failed" />);

    await act(async () => {
      MockEventSource._last.deliver('error: build failed');
    });

    // Collapse it
    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByRole('button')).toHaveTextContent('[SHOW LOG — build failed]');
  });

  it('caps client-side lines at 500', async () => {
    render(<BuildLogPanel featureName="cap" status="building" />);

    await act(async () => {
      for (let i = 0; i < 520; i++) {
        MockEventSource._last.deliver(`line-${i}`);
      }
    });

    // Only the last 500 lines should be in the DOM (line-20 to line-519)
    expect(screen.queryByText('line-0')).not.toBeInTheDocument();
    expect(screen.queryByText('line-19')).not.toBeInTheDocument();
    expect(screen.getByText('line-519')).toBeInTheDocument();
    expect(screen.getByText('line-20')).toBeInTheDocument();
  });

  it('closes EventSource on unmount', () => {
    const { unmount } = render(<BuildLogPanel featureName="foo" status="building" />);
    const es = MockEventSource._last;
    unmount();
    expect(es._closed).toBe(true);
  });
});
