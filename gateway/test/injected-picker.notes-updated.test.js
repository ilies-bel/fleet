/**
 * Behaviour tests for reactive note-tint repainting in INJECTED_PICKER.
 *
 * Verifies that, while capture mode is active, sending a
 * `mars.capture.notesUpdated` message causes the picker to replace the
 * contents of its noteTintLayer with the new set of tint rects — no
 * re-initialisation of the capture UI, no orphaned overlays.
 *
 * Strategy: same linkedom + node:test harness as injected-picker.tint.test.js.
 * A `notesUpdated` helper mirrors the `activate` helper for dispatch.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { INJECTED_PICKER } from '../src/injected-picker.js';

const TINT_SELECTOR = '[style*="rgba(59,130,246"]';

/**
 * Stand up a fresh linkedom window with the picker evaluated inside it.
 *
 * Returns helpers for activation, notesUpdated dispatch, and shadow inspection.
 */
function setupPicker(html, { pathname = '/' } = {}) {
  const { window, document } = parseHTML(html);

  let capturedShadow = null;
  const origAttachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (opts) {
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

  function dispatch(data) {
    const ev = new window.Event('message');
    Object.defineProperty(ev, 'data', { value: data });
    Object.defineProperty(ev, 'origin', { value: '' });
    window.dispatchEvent(ev);
  }

  function activate(active, notes = []) {
    dispatch({ type: 'mars.capture.activate', active, notes });
  }

  function notesUpdated(notes = []) {
    dispatch({ type: 'mars.capture.notesUpdated', notes });
  }

  return { document, activate, notesUpdated, getShadow: () => capturedShadow };
}

// ── Tracer bullet: notesUpdated while active paints the new tint ─────────────

describe('INJECTED_PICKER — mars.capture.notesUpdated reactive repaint', () => {
  test('notesUpdated while capture is active paints a tint for the new note', () => {
    const { getShadow, activate, notesUpdated } = setupPicker(
      '<!DOCTYPE html><html><body><button id="ok">OK</button></body></html>',
      { pathname: '/page' },
    );

    activate(true, []);  // start capture with no notes
    assert.equal(getShadow().querySelectorAll(TINT_SELECTOR).length, 0, 'no tints initially');

    notesUpdated([{ id: 'n1', route: '/page', selectors: ['#ok'] }]);

    assert.equal(getShadow().querySelectorAll(TINT_SELECTOR).length, 1,
      'one tint after notesUpdated');
  });

  // ── Delete removes the tint ───────────────────────────────────────────────

  test('notesUpdated with empty array removes the existing tint', () => {
    const { getShadow, activate, notesUpdated } = setupPicker(
      '<!DOCTYPE html><html><body><button id="ok">OK</button></body></html>',
      { pathname: '/page' },
    );

    activate(true, [{ id: 'n1', route: '/page', selectors: ['#ok'] }]);
    assert.ok(getShadow().querySelectorAll(TINT_SELECTOR).length > 0, 'tint present');

    notesUpdated([]);

    assert.equal(getShadow().querySelectorAll(TINT_SELECTOR).length, 0,
      'no tints after removing note');
  });

  // ── Add then delete same note leaves zero tints ───────────────────────────

  test('add then delete the same note leaves zero blue tints in the shadow', () => {
    const note = { id: 'n1', route: '/checkout', selectors: ['#btn'] };
    const { getShadow, activate, notesUpdated } = setupPicker(
      '<!DOCTYPE html><html><body><button id="btn">Buy</button></body></html>',
      { pathname: '/checkout' },
    );

    activate(true, []);

    notesUpdated([note]);
    assert.equal(getShadow().querySelectorAll(TINT_SELECTOR).length, 1, 'one tint after add');

    notesUpdated([]);
    assert.equal(getShadow().querySelectorAll(TINT_SELECTOR).length, 0, 'zero tints after delete');
  });

  // ── Repaint replaces the full set (no orphans) ────────────────────────────

  test('second notesUpdated replaces the tint set — only the current notes appear', () => {
    const { getShadow, activate, notesUpdated } = setupPicker(
      '<!DOCTYPE html><html><body><button id="a">A</button><button id="b">B</button></body></html>',
      { pathname: '/dash' },
    );

    activate(true, []);

    notesUpdated([{ id: 'n1', route: '/dash', selectors: ['#a'] }]);
    assert.equal(getShadow().querySelectorAll(TINT_SELECTOR).length, 1, 'one tint after first update');

    notesUpdated([{ id: 'n2', route: '/dash', selectors: ['#b'] }]);
    assert.equal(getShadow().querySelectorAll(TINT_SELECTOR).length, 1,
      'still exactly one tint — no orphan from prior set');
  });

  // ── Non-matching route is filtered out ────────────────────────────────────

  test('notesUpdated with a note from a different route does not add a tint', () => {
    const { getShadow, activate, notesUpdated } = setupPicker(
      '<!DOCTYPE html><html><body><button id="ok">OK</button></body></html>',
      { pathname: '/page-a' },
    );

    activate(true, []);

    notesUpdated([{ id: 'n1', route: '/page-b', selectors: ['#ok'] }]);

    assert.equal(getShadow().querySelectorAll(TINT_SELECTOR).length, 0,
      'no tint for note from different route');
  });

  // ── Ignored while capture mode is inactive ───────────────────────────────

  test('notesUpdated while capture is off is silently ignored (no shadow root)', () => {
    const { getShadow, notesUpdated } = setupPicker(
      '<!DOCTYPE html><html><body><button id="ok">OK</button></body></html>',
      { pathname: '/page' },
    );

    // Never activated — sending notesUpdated must not throw and must not create DOM.
    assert.doesNotThrow(() => {
      notesUpdated([{ id: 'n1', route: '/page', selectors: ['#ok'] }]);
    });

    assert.equal(getShadow(), null, 'shadow root not created for inactive picker');
  });

  // ── Deactivating after mutations leaves zero tints ────────────────────────

  test('deactivating after add/delete sequence leaves the shadow empty', () => {
    const note = { id: 'n1', route: '/flow', selectors: ['#x'] };
    const { getShadow, activate, notesUpdated } = setupPicker(
      '<!DOCTYPE html><html><body><div id="x"></div></body></html>',
      { pathname: '/flow' },
    );

    activate(true, []);
    notesUpdated([note]);
    notesUpdated([]);
    notesUpdated([note]);

    activate(false);

    assert.equal(getShadow().childNodes.length, 0,
      'shadow must be empty after deactivation');
  });

  // ── notesUpdated while capture is off after being on ─────────────────────

  test('notesUpdated after deactivation does not repaint', () => {
    const { getShadow, activate, notesUpdated } = setupPicker(
      '<!DOCTYPE html><html><body><button id="ok">OK</button></body></html>',
      { pathname: '/page' },
    );

    activate(true, [{ id: 'n1', route: '/page', selectors: ['#ok'] }]);
    activate(false);

    // Shadow is cleared. Now send notesUpdated — must remain empty.
    assert.doesNotThrow(() => {
      notesUpdated([{ id: 'n1', route: '/page', selectors: ['#ok'] }]);
    });

    assert.equal(getShadow().childNodes.length, 0,
      'no repaint after capture mode was deactivated');
  });
});
