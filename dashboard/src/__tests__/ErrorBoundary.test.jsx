import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ErrorBoundary from '../components/ErrorBoundary.jsx';

// A child that throws during render when the `shouldThrow` prop is true
function Bomb({ shouldThrow }) {
  if (shouldThrow) throw new Error('render kaboom');
  return <div>ok</div>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // Suppress React's own console.error noise for caught render errors
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText('ok')).toBeTruthy();
  });

  it('shows fallback UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText(/something went wrong/i)).toBeTruthy();
    expect(screen.getByText(/render kaboom/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /reload/i })).toBeTruthy();
  });

  it('logs error and component stack to console.error with [ErrorBoundary] tag', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>
    );
    const errorCalls = console.error.mock.calls;
    const boundaryCall = errorCalls.find(([tag]) => tag === '[ErrorBoundary]');
    expect(boundaryCall).toBeTruthy();
    expect(boundaryCall[1]).toBeInstanceOf(Error);
    expect(boundaryCall[1].message).toBe('render kaboom');
  });
});
