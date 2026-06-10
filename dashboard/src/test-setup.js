import '@testing-library/jest-dom';

// jsdom does not implement EventSource. Provide a no-op stub so components that
// use EventSource do not throw "EventSource is not defined" in the test
// environment. Individual test files that need to assert SSE behaviour replace
// this global with a richer mock via vi.stubGlobal('EventSource', ...).
if (typeof globalThis.EventSource === 'undefined') {
  globalThis.EventSource = class NoOpEventSource {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
    }
    close() {}
  };
}

// jsdom does not implement ResizeObserver. LogPanel observes its dialog width
// to switch between wide (side-panel) and narrow (inline) inspector layouts.
// Provide a no-op stub so components that use ResizeObserver do not throw
// "ResizeObserver is not defined" in the test environment.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class NoOpResizeObserver {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
