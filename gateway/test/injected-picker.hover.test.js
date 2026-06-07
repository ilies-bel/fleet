/**
 * Behaviour tests for the hover-highlight persistence fix.
 *
 * Verifies that the green #mars-hover overlay stays visible when the cursor
 * rests on a valid element — even if a subsequent mousemove causes
 * elementFromPoint to transiently return null (e.g. due to edge/gap between
 * pixels) — and that it clears when the pointer leaves the document.
 *
 * Uses linkedom + node:test so no browser is required.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { INJECTED_PICKER } from '../src/injected-picker.js';

/**
 * Stand up a fresh linkedom window, evaluate the picker script inside it, and
 * return helpers for sending activation messages, simulating mouse events, and
 * inspecting the shadow DOM.
 *
 * elementFromPointImpl lets each test control what elementFromPoint returns
 * so we can simulate transient nulls without needing a real browser layout.
 *
 * @param {string} html
 * @param {{ pathname?: string }} [opts]
 * @returns {{
 *   window: Window,
 *   document: Document,
 *   activate(active: boolean, notes?: object[]): void,
 *   getShadow(): ShadowRoot|null,
 *   setElementFromPoint(fn: (x:number,y:number) => Element|null): void,
 *   fireMousemove(x: number, y: number): void,
 *   fireMouseleave(): void,
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
  // Run rAF synchronously so hover logic executes inline.
  window.requestAnimationFrame = fn => { fn(); return 0; };
  window.cancelAnimationFrame = () => {};

  // Default: elementFromPoint returns null (override per test).
  let _efpImpl = () => null;
  document.elementFromPoint = (x, y) => _efpImpl(x, y);

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

  function setElementFromPoint(fn) {
    _efpImpl = fn;
  }

  function fireMousemove(x, y) {
    const ev = new window.Event('mousemove');
    Object.defineProperty(ev, 'clientX', { value: x });
    Object.defineProperty(ev, 'clientY', { value: y });
    document.dispatchEvent(ev);
  }

  function fireMouseleave() {
    const ev = new window.Event('mouseleave');
    document.dispatchEvent(ev);
  }

  return { window, document, activate, getShadow: () => capturedShadow, setElementFromPoint, fireMousemove, fireMouseleave };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('INJECTED_PICKER — hover highlight persistence', () => {
  // ── Tracer bullet: highlight shows when elementFromPoint resolves ──────────

  test('hover div becomes visible when mousemove resolves a valid element', () => {
    const { document, getShadow, activate, setElementFromPoint, fireMousemove } = setupPicker(
      '<!DOCTYPE html><html><body><button id="btn">Click</button></body></html>',
    );

    activate(true, []);

    const btn = document.querySelector('#btn');
    btn.getBoundingClientRect = () => ({ left: 10, top: 20, width: 80, height: 30 });

    setElementFromPoint(() => btn);
    fireMousemove(50, 35);

    const hoverDiv = getShadow().querySelector('#mars-hover');
    assert.ok(hoverDiv, '#mars-hover must exist in shadow DOM');
    assert.notEqual(hoverDiv.style.display, 'none', 'hover div must be visible after valid mousemove');
  });

  // ── Core fix: transient null does not hide the highlight ──────────────────

  test('hover div stays visible when elementFromPoint transiently returns null after a valid hit', () => {
    const { document, getShadow, activate, setElementFromPoint, fireMousemove } = setupPicker(
      '<!DOCTYPE html><html><body><button id="btn">Click</button></body></html>',
    );

    activate(true, []);

    const btn = document.querySelector('#btn');
    btn.getBoundingClientRect = () => ({ left: 10, top: 20, width: 80, height: 30 });

    // First move: valid hit — highlight shows.
    setElementFromPoint(() => btn);
    fireMousemove(50, 35);

    // Second move: elementFromPoint returns null (gap/edge).
    setElementFromPoint(() => null);
    fireMousemove(51, 35);

    const hoverDiv = getShadow().querySelector('#mars-hover');
    assert.notEqual(hoverDiv.style.display, 'none',
      'hover div must remain visible when elementFromPoint transiently returns null');
  });

  // ── Highlight updates when a new valid element is resolved ────────────────

  test('hover div repositions when the cursor moves to a different valid element', () => {
    const { document, getShadow, activate, setElementFromPoint, fireMousemove } = setupPicker(
      '<!DOCTYPE html><html><body><button id="a">A</button><button id="b">B</button></body></html>',
    );

    activate(true, []);

    const a = document.querySelector('#a');
    const b = document.querySelector('#b');
    a.getBoundingClientRect = () => ({ left: 0,  top: 0, width: 50, height: 30 });
    b.getBoundingClientRect = () => ({ left: 60, top: 0, width: 50, height: 30 });

    setElementFromPoint(() => a);
    fireMousemove(25, 15);

    const hoverDiv = getShadow().querySelector('#mars-hover');
    assert.ok(hoverDiv.style.transform.includes('0px'), 'initially positioned over element A');

    setElementFromPoint(() => b);
    fireMousemove(85, 15);

    assert.ok(hoverDiv.style.transform.includes('60px'), 'repositioned over element B');
  });

  // ── mouseleave on document clears the highlight ───────────────────────────

  test('hover div hides when the pointer leaves the document', () => {
    const { document, getShadow, activate, setElementFromPoint, fireMousemove, fireMouseleave } = setupPicker(
      '<!DOCTYPE html><html><body><button id="btn">Click</button></body></html>',
    );

    activate(true, []);

    const btn = document.querySelector('#btn');
    btn.getBoundingClientRect = () => ({ left: 10, top: 20, width: 80, height: 30 });

    setElementFromPoint(() => btn);
    fireMousemove(50, 35);

    const hoverDiv = getShadow().querySelector('#mars-hover');
    assert.notEqual(hoverDiv.style.display, 'none', 'highlight shows before mouseleave');

    fireMouseleave();

    assert.equal(hoverDiv.style.display, 'none', 'hover div must be hidden after mouseleave');
  });

  // ── mouseleave listener is torn down on deactivation ─────────────────────

  test('mouseleave after deactivation does not affect DOM', () => {
    const { document, getShadow, activate, setElementFromPoint, fireMousemove, fireMouseleave } = setupPicker(
      '<!DOCTYPE html><html><body><button id="btn">Click</button></body></html>',
    );

    activate(true, []);

    const btn = document.querySelector('#btn');
    btn.getBoundingClientRect = () => ({ left: 10, top: 20, width: 80, height: 30 });

    setElementFromPoint(() => btn);
    fireMousemove(50, 35);

    // Deactivate — this should tear down the hover listener.
    activate(false);

    // Shadow is emptied on deactivation; firing mouseleave must not throw.
    assert.doesNotThrow(() => fireMouseleave(), 'mouseleave after deactivation must not throw');
  });

  // ── No prior valid element: null still hides (or keeps hidden) ───────────

  test('hover div stays hidden when elementFromPoint always returns null', () => {
    const { getShadow, activate, setElementFromPoint, fireMousemove } = setupPicker(
      '<!DOCTYPE html><html><body><button id="btn">Click</button></body></html>',
    );

    activate(true, []);

    setElementFromPoint(() => null);
    fireMousemove(50, 35);

    const hoverDiv = getShadow().querySelector('#mars-hover');
    assert.equal(hoverDiv.style.display, 'none',
      'hover div must stay hidden when no valid element was ever resolved');
  });
});
