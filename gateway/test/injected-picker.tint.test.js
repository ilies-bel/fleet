/**
 * Behaviour tests for the note tint overlay rendered by INJECTED_PICKER.
 *
 * Verifies that, when capture mode is activated with a list of review notes,
 * the picker paints blue tint <div>s into the shadow DOM for every note whose
 * route matches the current pathname — and removes them on deactivation.
 *
 * Uses linkedom + node:test so no browser is required.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { INJECTED_PICKER } from '../src/injected-picker.js';

/**
 * Stand up a fresh linkedom window, evaluate the picker script inside it, and
 * return helpers for sending activation messages and inspecting the shadow DOM.
 *
 * The shadow root is forced to 'open' mode so the test can query its children;
 * production uses 'closed' but the behaviour is identical.
 *
 * @param {string} html        - Page markup (elements the picker will target).
 * @param {{ pathname?: string }} [opts]
 * @returns {{ document, activate(active: boolean, notes?: object[]): void, getShadow(): ShadowRoot|null }}
 */
function setupPicker(html, { pathname = '/' } = {}) {
  const { window, document } = parseHTML(html);

  // Spy on attachShadow so we can hold the shadow root reference even when
  // the picker opens it in 'closed' mode.
  let capturedShadow = null;
  const origAttachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (opts) {
    capturedShadow = origAttachShadow.call(this, { ...opts, mode: 'open' });
    return capturedShadow;
  };

  // Minimal browser globals the picker needs.
  window.location = { pathname, search: '' };
  window.parent = { postMessage() {} };
  // Run rAF callbacks synchronously so render logic completes inline.
  window.requestAnimationFrame = fn => { fn(); return 0; };
  window.cancelAnimationFrame = () => {};

  // Evaluate the picker IIFE inside a function where window/document/etc. are
  // the linkedom objects, not Node.js globals.
  // eslint-disable-next-line no-new-func
  new Function(
    'window', 'document', 'location', 'requestAnimationFrame', 'cancelAnimationFrame',
    INJECTED_PICKER,
  )(window, document, window.location, window.requestAnimationFrame, window.cancelAnimationFrame);

  /**
   * Dispatch a mars.capture.activate message to the picker's window listener.
   *
   * @param {boolean} active
   * @param {Array<{id:string, route:string, selector:string}>} [notes]
   */
  function activate(active, notes = []) {
    // Build a minimal event object with the data/origin fields the picker reads.
    const base = new window.Event('message');
    Object.defineProperty(base, 'data', {
      value: { type: 'mars.capture.activate', active, notes },
    });
    Object.defineProperty(base, 'origin', { value: '' });
    window.dispatchEvent(base);
  }

  return { document, activate, getShadow: () => capturedShadow };
}

/** CSS substring that uniquely identifies a note-tint div (the blue fill). */
const TINT_SELECTOR = '[style*="rgba(59,130,246"]';

// ── Tracer bullet: capture mode + matching note → one tint div ───────────────

describe('INJECTED_PICKER — note tint overlay', () => {
  test('paints exactly one tint div when capture activates with one matching note', () => {
    const { getShadow, activate } = setupPicker(
      '<!DOCTYPE html><html><body><button id="save">Save</button></body></html>',
      { pathname: '/checkout' },
    );

    activate(true, [{ id: 'n1', route: '/checkout', selector: '#save' }]);

    const shadow = getShadow();
    assert.ok(shadow, 'shadow root must be created on activation');

    const tintDivs = [...shadow.querySelectorAll(TINT_SELECTOR)];
    assert.equal(tintDivs.length, 1, 'exactly one tint div should be painted');
  });

  // ── Correct fill and border style values ─────────────────────────────────

  test('tint div has rgba(59,130,246,0.12) fill and inset rgba(59,130,246,0.35) border', () => {
    const { getShadow, activate } = setupPicker(
      '<!DOCTYPE html><html><body><button id="save">Save</button></body></html>',
      { pathname: '/checkout' },
    );

    activate(true, [{ id: 'n1', route: '/checkout', selector: '#save' }]);

    const tintDiv = getShadow().querySelector(TINT_SELECTOR);
    assert.ok(tintDiv, 'tint div must exist');

    const css = tintDiv.style.cssText;
    assert.ok(css.includes('rgba(59,130,246,0.12)'), 'fill must be rgba(59,130,246,0.12)');
    assert.ok(css.includes('rgba(59,130,246,0.35)'), 'border must use rgba(59,130,246,0.35)');
  });

  // ── pointer-events:none (separate overlay layer, not mutating target) ─────

  test('tint div is pointer-events:none so it does not intercept interactions', () => {
    const { getShadow, activate } = setupPicker(
      '<!DOCTYPE html><html><body><p id="p">text</p></body></html>',
      { pathname: '/' },
    );

    activate(true, [{ id: 'n2', route: '/', selector: '#p' }]);

    const tintDiv = getShadow().querySelector(TINT_SELECTOR);
    assert.ok(tintDiv, 'tint div must exist');
    const css = tintDiv.style.cssText;
    assert.ok(
      css.includes('pointer-events:none') || css.includes('pointer-events: none'),
      'tint must be pointer-events:none',
    );
  });

  // ── Green hover div and blue tint div coexist ─────────────────────────────

  test('green hover div and blue tint div are both present in the shadow root', () => {
    const { getShadow, activate } = setupPicker(
      '<!DOCTYPE html><html><body><button id="save">Save</button></body></html>',
      { pathname: '/checkout' },
    );

    activate(true, [{ id: 'n1', route: '/checkout', selector: '#save' }]);

    const shadow = getShadow();
    assert.ok(shadow.querySelector('#mars-hover'), 'green hover div must be in shadow root');
    assert.ok(shadow.querySelector(TINT_SELECTOR), 'blue tint div must be in shadow root');
  });

  // ── Non-matching route ────────────────────────────────────────────────────

  test('does not paint for a note whose route does not match the current pathname', () => {
    const { getShadow, activate } = setupPicker(
      '<!DOCTYPE html><html><body><button id="save">Save</button></body></html>',
      { pathname: '/checkout' },
    );

    activate(true, [{ id: 'n1', route: '/other-page', selector: '#save' }]);

    const shadow = getShadow();
    const tintDivs = shadow ? [...shadow.querySelectorAll(TINT_SELECTOR)] : [];
    assert.equal(tintDivs.length, 0, 'no tint divs for non-matching route');
  });

  // ── Unresolvable selector silently skipped ────────────────────────────────

  test('silently skips a note whose selector matches zero elements (no error, no div)', () => {
    const { getShadow, activate } = setupPicker(
      '<!DOCTYPE html><html><body></body></html>',
      { pathname: '/page1' },
    );

    // Must not throw.
    assert.doesNotThrow(() => {
      activate(true, [{ id: 'n1', route: '/page1', selector: '#nonexistent' }]);
    });

    const shadow = getShadow();
    const tintDivs = shadow ? [...shadow.querySelectorAll(TINT_SELECTOR)] : [];
    assert.equal(tintDivs.length, 0, 'no placeholder for unresolvable selector');
  });

  // ── Deactivation removes all tints ────────────────────────────────────────

  test('deactivating capture mode empties the shadow root including all tint divs', () => {
    const { getShadow, activate } = setupPicker(
      '<!DOCTYPE html><html><body><button id="save">Save</button></body></html>',
      { pathname: '/checkout' },
    );

    activate(true, [{ id: 'n1', route: '/checkout', selector: '#save' }]);

    const shadow = getShadow();
    assert.ok(shadow.querySelectorAll(TINT_SELECTOR).length > 0, 'tints present before deactivation');

    activate(false);

    assert.equal(shadow.childNodes.length, 0, 'shadow DOM must be empty after deactivation');
  });

  // ── No tint when capture mode is never activated ──────────────────────────

  test('shadow root is not created when capture mode is never activated', () => {
    const { getShadow } = setupPicker(
      '<!DOCTYPE html><html><body><button id="save">Save</button></body></html>',
      { pathname: '/checkout' },
    );

    // Never send an activate message.
    assert.equal(getShadow(), null, 'shadow root must not exist before activation');
  });

  // ── Multiple notes, mixed routes ──────────────────────────────────────────

  test('only paints notes matching the current route when multiple notes are passed', () => {
    const { getShadow, activate } = setupPicker(
      '<!DOCTYPE html><html><body><button id="a">A</button><button id="b">B</button></body></html>',
      { pathname: '/page' },
    );

    activate(true, [
      { id: 'n1', route: '/page',  selector: '#a' },   // matches
      { id: 'n2', route: '/other', selector: '#b' },   // does not match
    ]);

    const tintDivs = [...getShadow().querySelectorAll(TINT_SELECTOR)];
    assert.equal(tintDivs.length, 1, 'only the matching note should be painted');
  });
});
