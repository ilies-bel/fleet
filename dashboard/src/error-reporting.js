/**
 * Global error reporting — installs window-level handlers so unhandled
 * promise rejections and uncaught JS errors always reach the browser devtools
 * console with a clear, greppable tag.
 *
 * Idempotent: safe to call multiple times (e.g. React StrictMode double-invoke).
 */

let installed = false;

export function installGlobalErrorReporting() {
  if (installed) return;
  installed = true;

  // Re-log uncaught errors with a clear tag so they're unmistakable in devtools.
  // Browsers already log these, but this guarantees a tagged entry and a single
  // hook point for future forwarding (e.g. Sentry, LogRocket).
  window.addEventListener('error', (e) => {
    console.error('[window.error]', e.error ?? e.message, e);
  });

  // Unhandled promise rejections currently produce nothing useful in many
  // environments — this is the real fix.
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandledrejection]', e.reason);
  });
}
