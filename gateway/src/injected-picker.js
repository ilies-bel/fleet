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

  // Closed shadow root — cached in closure; attachShadow may only be called once
  // per element, so we hold the reference here for subsequent activate/deactivate
  // calls.
  let _shadow = null;

  function ensureRoot() {
    if (_shadow) return _shadow;
    let host = document.getElementById('mars-capture-root');
    if (!host) {
      host = document.createElement('div');
      host.id = 'mars-capture-root';
      document.documentElement.appendChild(host);
    }
    _shadow = host.attachShadow({ mode: 'closed' });
    return _shadow;
  }

  function renderBanner(shadow) {
    shadow.innerHTML =
      '<div style="position:fixed;top:0;left:0;right:0;background:#0b3;color:#fff;' +
      'font:14px system-ui;padding:6px 10px;pointer-events:none;z-index:2147483647">' +
      'Capture mode — click an element to mark it</div>';
  }

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
      const shadow = ensureRoot();
      if (state.active) {
        renderBanner(shadow);
      } else {
        shadow.innerHTML = '';
      }
    }
  });
})();`;
