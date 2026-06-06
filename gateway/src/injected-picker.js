/**
 * Bootstrap script injected into every text/html response served through the
 * gateway proxy.  Dormant by default — installs a postMessage listener and
 * waits for { type: 'mars.capture.activate', active: true } from the parent
 * frame before doing anything.  Until activated the previewed app behaves
 * byte-equivalently from the operator's perspective.
 */
export const INJECTED_PICKER = String.raw`(() => {
  window.addEventListener('message', function(event) {
    if (
      event.data &&
      event.data.type === 'mars.capture.activate' &&
      event.data.active === true
    ) {
      // Element picker activation — implemented by later slices.
    }
  });
})();`;
