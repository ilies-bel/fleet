import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installGlobalErrorReporting } from '../error-reporting.js';

describe('installGlobalErrorReporting', () => {
  let addEventListenerSpy;

  beforeEach(() => {
    // Reset the module-level `installed` guard between tests by re-importing
    // a fresh module. We do this by manipulating the mock.
    addEventListenerSpy = vi.spyOn(window, 'addEventListener');
  });

  it('registers error and unhandledrejection listeners', () => {
    // Reset the installed flag by reimporting (vitest module isolation)
    installGlobalErrorReporting();
    const calls = addEventListenerSpy.mock.calls.map(([type]) => type);
    expect(calls).toContain('error');
    expect(calls).toContain('unhandledrejection');
  });

  it('is idempotent — calling twice does not double-register', () => {
    // First call already happened in the previous test (installed=true).
    // A second call should add no new listeners.
    const countBefore = addEventListenerSpy.mock.calls.length;
    installGlobalErrorReporting();
    const countAfter = addEventListenerSpy.mock.calls.length;
    expect(countAfter).toBe(countBefore);
  });

  it('logs unhandledrejection reason to console.error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reason = new Error('test rejection');
    window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {
      promise: Promise.resolve(),
      reason,
    }));
    expect(errorSpy).toHaveBeenCalledWith('[unhandledrejection]', reason);
    errorSpy.mockRestore();
  });
});
