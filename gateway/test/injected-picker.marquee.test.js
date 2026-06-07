/**
 * Behaviour tests for the rectangle marquee multi-select gesture in INJECTED_PICKER.
 *
 * Verifies:
 *  - A drag past the 4px threshold posts one multi-element message with all
 *    leaf selectors that intersect the marquee rectangle.
 *  - A drag below the threshold (< 4px movement) does NOT post a message;
 *    the existing single-click path stays intact.
 *  - A drag that covers an area with zero leaf elements posts nothing.
 *  - Elements inside #mars-capture-root (the overlay host) are excluded.
 *  - Deactivation removes marquee listeners so no messages are posted after
 *    deactivate(false).
 *
 * Uses linkedom + node:test (same approach as other gateway tests).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { INJECTED_PICKER } from '../src/injected-picker.js';

/**
 * Stand up a fresh linkedom window with the picker IIFE, and return helpers
 * for activation, mouse events, and message inspection.
 *
 * @param {string} html
 * @param {{ pathname?: string }} [opts]
 */
function setupPicker(html, { pathname = '/' } = {}) {
  const { window, document } = parseHTML(html);

  // Intercept attachShadow so we can query the shadow DOM.
  let capturedShadow = null;
  const origAttachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function(opts) {
    capturedShadow = origAttachShadow.call(this, { ...opts, mode: 'open' });
    return capturedShadow;
  };

  window.location = { pathname, search: '' };
  const messages = [];
  window.parent = { postMessage(data) { messages.push(data); } };
  window.requestAnimationFrame = fn => { fn(); return 0; };
  window.cancelAnimationFrame = () => {};

  // The hover-highlight handler calls document.elementFromPoint inside a rAF.
  // Stub it to return null so it exits early and doesn't interfere with drag tests.
  document.elementFromPoint = () => null;

  // eslint-disable-next-line no-new-func
  new Function(
    'window', 'document', 'location', 'requestAnimationFrame', 'cancelAnimationFrame',
    INJECTED_PICKER,
  )(window, document, window.location, window.requestAnimationFrame, window.cancelAnimationFrame);

  function activate(active, notes = []) {
    const e = new window.Event('message');
    Object.defineProperty(e, 'data', { value: { type: 'mars.capture.activate', active, notes } });
    Object.defineProperty(e, 'origin', { value: '' });
    window.dispatchEvent(e);
  }

  /**
   * Dispatch a synthetic mouse event directly on document (the level where the
   * marquee handlers are registered).
   */
  function fireMouseEvent(type, x, y) {
    const e = new window.Event(type, { bubbles: false, cancelable: true });
    Object.defineProperty(e, 'clientX', { value: x, configurable: true });
    Object.defineProperty(e, 'clientY', { value: y, configurable: true });
    document.dispatchEvent(e);
  }

  return {
    document,
    window,
    activate,
    fireMouseEvent,
    messages,
    getShadow: () => capturedShadow,
  };
}

describe('INJECTED_PICKER — marquee multi-select', () => {
  // ── Tracer bullet: drag selects intersecting leaves ───────────────────────

  test('drag past 4px threshold posts one multi message with all intersecting leaf selectors', () => {
    const { document, activate, fireMouseEvent, messages } = setupPicker(
      '<!DOCTYPE html><html><body><button id="b1">B1</button><button id="b2">B2</button></body></html>',
      { pathname: '/team' },
    );

    // Mock getBoundingClientRect so both buttons sit inside the drag area (0,0)→(100,100).
    document.getElementById('b1').getBoundingClientRect = () =>
      ({ top: 20, left: 10, bottom: 40, right: 60, width: 50, height: 20 });
    document.getElementById('b2').getBoundingClientRect = () =>
      ({ top: 55, left: 10, bottom: 75, right: 60, width: 50, height: 20 });

    activate(true, []);

    fireMouseEvent('mousedown', 0, 0);
    fireMouseEvent('mousemove', 100, 100);  // 100px movement, well past 4px threshold
    fireMouseEvent('mouseup', 100, 100);

    assert.equal(messages.length, 1, 'exactly one message must be posted');
    const msg = messages[0];
    assert.equal(msg.type, 'mars.capture.elementPicked');
    assert.equal(msg.refKind, 'multi');
    assert.ok(Array.isArray(msg.selectors), 'selectors must be an array');
    assert.ok(msg.selectors.includes('#b1'), 'selectors must include #b1');
    assert.ok(msg.selectors.includes('#b2'), 'selectors must include #b2');
    assert.equal(msg.label, '2 elements');
    assert.equal(msg.route, '/team');
  });

  // ── Sub-threshold movement does NOT trigger marquee ───────────────────────

  test('movement below 4px threshold does not post a multi message', () => {
    const { document, activate, fireMouseEvent, messages } = setupPicker(
      '<!DOCTYPE html><html><body><button id="btn">Click</button></body></html>',
      { pathname: '/' },
    );

    document.getElementById('btn').getBoundingClientRect = () =>
      ({ top: 0, left: 0, bottom: 50, right: 100, width: 100, height: 50 });

    activate(true, []);

    // 2px movement in both axes — below the 4px threshold
    fireMouseEvent('mousedown', 50, 50);
    fireMouseEvent('mousemove', 52, 52);
    fireMouseEvent('mouseup', 52, 52);

    assert.equal(messages.length, 0, 'no message for sub-threshold drag');
  });

  // ── Drag with zero intersecting leaves posts nothing ─────────────────────

  test('drag that covers an area with no leaf elements posts nothing', () => {
    const { activate, fireMouseEvent, messages } = setupPicker(
      '<!DOCTYPE html><html><body><button id="far">Far away</button></body></html>',
      { pathname: '/' },
    );

    // Do NOT mock getBoundingClientRect — linkedom returns all-zero rects,
    // so the button appears outside any drag area and gets filtered out.

    activate(true, []);

    fireMouseEvent('mousedown', 0, 0);
    fireMouseEvent('mousemove', 100, 100);
    fireMouseEvent('mouseup', 100, 100);

    assert.equal(messages.length, 0, 'no message when no leaves intersect the marquee');
  });

  // ── Only elements outside #mars-capture-root are included ────────────────

  test('elements inside #mars-capture-root are excluded from marquee selection', () => {
    const { document, activate, fireMouseEvent, messages } = setupPicker(
      '<!DOCTYPE html><html><body><span id="real">Real</span></body></html>',
      { pathname: '/' },
    );

    const real = document.getElementById('real');
    real.getBoundingClientRect = () =>
      ({ top: 10, left: 10, bottom: 30, right: 50, width: 40, height: 20 });

    activate(true, []);

    // Also mock getBoundingClientRect on any element inside capture-root
    // (the root itself will be excluded by the captureRoot check).
    const captureRoot = document.getElementById('mars-capture-root');
    if (captureRoot) {
      captureRoot.getBoundingClientRect = () =>
        ({ top: 10, left: 10, bottom: 30, right: 50, width: 40, height: 20 });
    }

    fireMouseEvent('mousedown', 0, 0);
    fireMouseEvent('mousemove', 100, 100);
    fireMouseEvent('mouseup', 100, 100);

    assert.equal(messages.length, 1);
    // captureRoot itself must not appear in selectors
    assert.ok(!messages[0].selectors.some(s => s.includes('mars-capture-root')),
      'mars-capture-root must be excluded');
    // The real element should be included
    assert.ok(messages[0].selectors.includes('#real'), '#real must be selected');
  });

  // ── No message after deactivation ────────────────────────────────────────

  test('marquee listeners are removed on deactivation — no message after deactivate', () => {
    const { document, activate, fireMouseEvent, messages } = setupPicker(
      '<!DOCTYPE html><html><body><button id="btn">B</button></body></html>',
      { pathname: '/' },
    );

    document.getElementById('btn').getBoundingClientRect = () =>
      ({ top: 10, left: 10, bottom: 40, right: 60, width: 50, height: 30 });

    activate(true, []);
    activate(false);   // deactivate — listeners should be torn down

    fireMouseEvent('mousedown', 0, 0);
    fireMouseEvent('mousemove', 100, 100);
    fireMouseEvent('mouseup', 100, 100);

    assert.equal(messages.length, 0, 'no message after deactivation');
  });

  // ── label counts the selected leaves ─────────────────────────────────────

  test('label field reports the correct element count', () => {
    const { document, activate, fireMouseEvent, messages } = setupPicker(
      '<!DOCTYPE html><html><body>' +
      '<span id="s1">1</span><span id="s2">2</span><span id="s3">3</span>' +
      '</body></html>',
      { pathname: '/' },
    );

    ['s1', 's2', 's3'].forEach((id, i) => {
      document.getElementById(id).getBoundingClientRect = () =>
        ({ top: 10 + i * 20, left: 5, bottom: 25 + i * 20, right: 80, width: 75, height: 15 });
    });

    activate(true, []);
    fireMouseEvent('mousedown', 0, 0);
    fireMouseEvent('mousemove', 100, 100);
    fireMouseEvent('mouseup', 100, 100);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].label, '3 elements');
    assert.equal(messages[0].selectors.length, 3);
  });
});
