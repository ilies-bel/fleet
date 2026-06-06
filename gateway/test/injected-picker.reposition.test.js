/**
 * Behaviour tests for tint-overlay reposition on scroll and resize.
 *
 * Verifies that blue tint divs tracking review-noted elements stay aligned
 * to their elements as the viewport scrolls or the window resizes, and that
 * the reposition listeners are torn down cleanly when capture mode ends.
 *
 * Uses linkedom + node:test so no browser is required.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { INJECTED_PICKER } from '../src/injected-picker.js';

/**
 * Stand up a fresh linkedom window, evaluate the picker script, and return
 * helpers for sending activation messages, dispatching DOM events, and
 * inspecting the shadow DOM.
 *
 * @param {string} html
 * @param {{ pathname?: string }} [opts]
 * @returns {{
 *   window: Window,
 *   document: Document,
 *   activate(active: boolean, notes?: object[]): void,
 *   getShadow(): ShadowRoot|null
 * }}
 */
function setupPicker(html, { pathname = '/' } = {}) {
  const { window, document } = parseHTML(html);

  let capturedShadow = null;
  const origAttachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function(opts) {
    capturedShadow = origAttachShadow.call(this, { ...opts, mode: 'open' });
    return capturedShadow;
  };

  window.location = { pathname, search: '' };
  window.parent = { postMessage() {} };
  window.requestAnimationFrame = fn => { fn(); return 0; };
  window.cancelAnimationFrame = () => {};

  // eslint-disable-next-line no-new-func
  new Function(
    'window', 'document', 'location', 'requestAnimationFrame', 'cancelAnimationFrame',
    INJECTED_PICKER,
  )(window, document, window.location, window.requestAnimationFrame, window.cancelAnimationFrame);

  function activate(active, notes = []) {
    const base = new window.Event('message');
    Object.defineProperty(base, 'data', {
      value: { type: 'mars.capture.activate', active, notes },
    });
    Object.defineProperty(base, 'origin', { value: '' });
    window.dispatchEvent(base);
  }

  return { window, document, activate, getShadow: () => capturedShadow };
}

/** CSS substring that uniquely identifies a note-tint div (the blue fill). */
const TINT_SELECTOR = '[style*="rgba(59,130,246"]';

describe('INJECTED_PICKER — tint reposition on scroll and resize', () => {

  // ── Tracer bullet: scroll event repositions tint ──────────────────────────

  test('scroll event repositions tint to match updated getBoundingClientRect', () => {
    const { window, document, activate, getShadow } = setupPicker(
      '<!DOCTYPE html><html><body><button id="btn">Click</button></body></html>',
      { pathname: '/' },
    );

    const button = document.getElementById('btn');
    button.getBoundingClientRect = () => ({ left: 10, top: 100, width: 80, height: 40 });

    activate(true, [{ id: 'n1', route: '/', selector: '#btn' }]);

    const tintDiv = getShadow().querySelector(TINT_SELECTOR);
    assert.ok(tintDiv, 'tint div must exist after activation');
    assert.ok(
      tintDiv.style.transform.includes('100px'),
      'initial tint top should be 100px',
    );

    // Simulate page scroll — element moves up in viewport
    button.getBoundingClientRect = () => ({ left: 10, top: 20, width: 80, height: 40 });
    document.dispatchEvent(new window.Event('scroll'));

    assert.ok(
      tintDiv.style.transform.includes('20px'),
      'tint top should update to 20px after scroll',
    );
  });

  // ── Resize event repositions tint ─────────────────────────────────────────

  test('resize event repositions tint when element reflows to a new position', () => {
    const { window, document, activate, getShadow } = setupPicker(
      '<!DOCTYPE html><html><body><section id="hero">Hero</section></body></html>',
      { pathname: '/home' },
    );

    const section = document.getElementById('hero');
    section.getBoundingClientRect = () => ({ left: 0, top: 50, width: 300, height: 200 });

    activate(true, [{ id: 'n1', route: '/home', selector: '#hero' }]);

    // After resize the element reflows: wider, shifted down
    section.getBoundingClientRect = () => ({ left: 0, top: 80, width: 600, height: 200 });
    window.dispatchEvent(new window.Event('resize'));

    const tintDiv = getShadow().querySelector(TINT_SELECTOR);
    assert.ok(
      tintDiv.style.transform.includes('80px'),
      'tint top should update to 80px after resize',
    );
    assert.equal(tintDiv.style.width, '600px', 'tint width should update to 600px after resize');
  });

  // ── Element outside viewport scrolled into view ───────────────────────────

  test('element scrolled into view gets tint painted at its updated viewport position', () => {
    const { window, document, activate, getShadow } = setupPicker(
      '<!DOCTYPE html><html><body><footer id="footer">Footer</footer></body></html>',
      { pathname: '/' },
    );

    const footer = document.getElementById('footer');
    // Initially below the fold
    footer.getBoundingClientRect = () => ({ left: 0, top: 2000, width: 300, height: 50 });

    activate(true, [{ id: 'n1', route: '/', selector: '#footer' }]);

    // Operator scrolls down — footer enters the viewport
    footer.getBoundingClientRect = () => ({ left: 0, top: 500, width: 300, height: 50 });
    document.dispatchEvent(new window.Event('scroll'));

    const tintDiv = getShadow().querySelector(TINT_SELECTOR);
    assert.ok(
      tintDiv.style.transform.includes('500px'),
      'tint should be at viewport position 500px after scroll',
    );
  });

  // ── Reposition fires exactly once per event (no duplicate listeners) ──────

  test('reposition fires exactly once per scroll after activate→deactivate→activate cycle', () => {
    const { window, document, activate } = setupPicker(
      '<!DOCTYPE html><html><body><button id="btn">Btn</button></body></html>',
      { pathname: '/' },
    );

    const button = document.getElementById('btn');
    button.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 30 });

    // Cycle: activate → deactivate → activate again
    activate(true, [{ id: 'n1', route: '/', selector: '#btn' }]);
    activate(false);
    activate(true, [{ id: 'n1', route: '/', selector: '#btn' }]);

    // Count getBoundingClientRect calls triggered only by the scroll event
    let callCount = 0;
    button.getBoundingClientRect = () => {
      callCount++;
      return { left: 0, top: 0, width: 100, height: 30 };
    };

    document.dispatchEvent(new window.Event('scroll'));

    assert.equal(
      callCount,
      1,
      'reposition should fire exactly once per scroll — duplicate listeners indicate a leak',
    );
  });

  // ── Listeners are removed on deactivation (idempotent teardown) ───────────

  test('deactivating twice does not throw (idempotent teardown)', () => {
    const { activate } = setupPicker(
      '<!DOCTYPE html><html><body><button id="btn">Btn</button></body></html>',
      { pathname: '/' },
    );

    activate(true, [{ id: 'n1', route: '/', selector: '#btn' }]);

    assert.doesNotThrow(() => {
      activate(false);
      activate(false); // second deactivation must be safe
    });
  });

  // ── Reposition not called after deactivation ──────────────────────────────

  test('scroll and resize events do not reposition after deactivation', () => {
    const { window, document, activate } = setupPicker(
      '<!DOCTYPE html><html><body><button id="btn">Btn</button></body></html>',
      { pathname: '/' },
    );

    const button = document.getElementById('btn');
    button.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 30 });

    activate(true, [{ id: 'n1', route: '/', selector: '#btn' }]);
    activate(false);

    // Replace mock AFTER deactivation to detect any post-deactivation calls
    let callsAfterDeactivate = 0;
    button.getBoundingClientRect = () => {
      callsAfterDeactivate++;
      return { left: 999, top: 999, width: 1, height: 1 };
    };

    document.dispatchEvent(new window.Event('scroll'));
    window.dispatchEvent(new window.Event('resize'));

    assert.equal(
      callsAfterDeactivate,
      0,
      'reposition listeners must be removed — no getBoundingClientRect calls after deactivation',
    );
  });

  // ── Multiple tinted elements all reposition together ──────────────────────

  test('all tint divs reposition when scroll fires with multiple noted elements', () => {
    const { window, document, activate, getShadow } = setupPicker(
      '<!DOCTYPE html><html><body>' +
      '<h1 id="title">Title</h1>' +
      '<p id="para">Paragraph</p>' +
      '</body></html>',
      { pathname: '/article' },
    );

    const h1 = document.getElementById('title');
    const p  = document.getElementById('para');
    h1.getBoundingClientRect = () => ({ left: 0, top: 50,  width: 400, height: 40 });
    p.getBoundingClientRect  = () => ({ left: 0, top: 100, width: 400, height: 60 });

    activate(true, [
      { id: 'n1', route: '/article', selector: '#title' },
      { id: 'n2', route: '/article', selector: '#para'  },
    ]);

    // Both elements move after scroll
    h1.getBoundingClientRect = () => ({ left: 0, top: 10, width: 400, height: 40 });
    p.getBoundingClientRect  = () => ({ left: 0, top: 60, width: 400, height: 60 });
    document.dispatchEvent(new window.Event('scroll'));

    const tintDivs = [...getShadow().querySelectorAll(TINT_SELECTOR)];
    assert.equal(tintDivs.length, 2, 'two tint divs must exist');
    assert.ok(
      tintDivs[0].style.transform.includes('10px'),
      'first tint should be at top:10px after scroll',
    );
    assert.ok(
      tintDivs[1].style.transform.includes('60px'),
      'second tint should be at top:60px after scroll',
    );
  });
});
