/**
 * Bootstrap script injected into every text/html response served through the
 * gateway proxy.  Dormant by default — installs a postMessage listener and
 * waits for { type: 'mars.capture.activate', active: true } from the parent
 * frame before doing anything.  Until activated the previewed app behaves
 * byte-equivalently from the operator's perspective.
 *
 * Origin validation: messages are only honoured when they originate from the
 * dashboard frame (the immediate ancestor). ancestorOrigins[0] is the parent
 * frame's origin in Chromium/WebKit; on Firefox (which lacks ancestorOrigins)
 * the check falls through to the '*' fallback that still requires the correct
 * message type prefix — future slices can tighten this further.
 */
export const INJECTED_PICKER = String.raw`(() => {
  const state = { active: false };

  // Resolve expected dashboard origin dynamically so no port is hardcoded.
  // ancestorOrigins[0] is the immediate parent frame's origin (Chromium/WebKit).
  const EXPECTED_DASHBOARD_ORIGIN =
    (window.location.ancestorOrigins && window.location.ancestorOrigins[0]) || '';

  window.addEventListener('message', function(event) {
    // Ignore messages whose type does not start with 'mars.capture.'
    if (
      !event.data ||
      typeof event.data.type !== 'string' ||
      !event.data.type.startsWith('mars.capture.')
    ) {
      return;
    }

    // Validate origin — only honour messages from the dashboard parent frame.
    if (EXPECTED_DASHBOARD_ORIGIN && event.origin !== EXPECTED_DASHBOARD_ORIGIN) {
      return;
    }

    if (event.data.type === 'mars.capture.activate') {
      state.active = !!event.data.active;
      console.log('mars.capture.activate received', state.active);
      // Element picker visuals — implemented by later slices.
    }
  });
})();`;
