import { Component } from 'react';

/**
 * React ErrorBoundary — catches render-time errors so the app shows a
 * minimal fallback instead of a blank white screen, and ensures the error
 * + component stack land in devtools (tagged for easy filtering).
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const message = this.state.error?.message ?? String(this.state.error);

    return (
      <div style={{
        fontFamily: 'var(--font-mono, monospace)',
        padding: '2rem',
        color: 'var(--color-error, #ff6b6b)',
        background: 'var(--color-bg, #0d0d0d)',
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
      }}>
        <pre style={{ margin: 0 }}>// something went wrong</pre>
        <pre style={{ margin: 0, color: 'var(--color-text, #ccc)', whiteSpace: 'pre-wrap' }}>
          {message}
        </pre>
        <button
          onClick={() => window.location.reload()}
          style={{
            alignSelf: 'flex-start',
            fontFamily: 'inherit',
            cursor: 'pointer',
            background: 'none',
            border: '1px solid currentColor',
            color: 'inherit',
            padding: '0.25rem 0.75rem',
          }}
        >
          [reload]
        </button>
      </div>
    );
  }
}
