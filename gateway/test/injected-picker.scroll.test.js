/**
 * Behaviour tests for the always-on scroll-persistence block in
 * INJECTED_PICKER.
 *
 * The dashboard remounts the preview iframe on every feature switch, which
 * would otherwise scroll the previewed app back to the top.  The picker runs
 * same-origin inside the previewed app and persists window.scrollY to
 * sessionStorage so a subsequent reload of the same route restores the
 * operator's scroll position.
 *
 * These tests stand up a fresh linkedom window per case, stub a tiny
 * sessionStorage and window.scrollTo, evaluate the picker script, and assert
 * the observable behaviour: writes on scroll/beforeunload/pagehide,
 * restore-on-load keyed by pathname+search, and silent swallowing of
 * sessionStorage failures.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { INJECTED_PICKER } from '../src/injected-picker.js';

/**
 * Stand up a linkedom window with the minimal browser surface the picker
 * needs, evaluate INJECTED_PICKER inside it, and return inspection helpers.
 *
 * @param {{
 *   pathname?: string,
 *   search?: string,
 *   storage?: 'ok'|'throw-get'|'throw-set'|'throw-all',
 *   readyState?: 'loading'|'complete',
 *   preloadedScroll?: string|null,
 *   initialScrollY?: number,
 * }} [opts]
 */
function setupPicker(opts = {}) {
  const {
    pathname = '/',
    search = '',
    storage = 'ok',
    readyState = 'complete',
    preloadedScroll = null,
    initialScrollY = 0,
  } = opts;

  const { window, document } = parseHTML(
    '<!DOCTYPE html><html><body><p>app</p></body></html>',
  );

  // sessionStorage stub with configurable failure modes.
  const backing = new Map();
  if (preloadedScroll != null) {
    backing.set('mars.scroll:' + pathname + search, preloadedScroll);
  }
  const sessionStorage = {
    getItem(k) {
      if (storage === 'throw-get' || storage === 'throw-all') {
        throw new Error('storage disabled');
      }
      return backing.has(k) ? backing.get(k) : null;
    },
    setItem(k, v) {
      if (storage === 'throw-set' || storage === 'throw-all') {
        throw new Error('storage disabled');
      }
      backing.set(k, String(v));
    },
    _backing: backing,
  };

  // window.scrollTo stub — record every call so tests can verify restore.
  const scrollToCalls = [];
  window.scrollTo = (x, y) => { scrollToCalls.push([x, y]); };

  // Synchronous rAF so the restore-retry runs inline within the test.
  window.requestAnimationFrame = fn => { fn(); return 0; };
  window.cancelAnimationFrame = () => {};

  // Mutable scrollY so tests can simulate scrolling.
  let scrollY = initialScrollY;
  Object.defineProperty(window, 'scrollY', {
    configurable: true,
    get: () => scrollY,
    set: (v) => { scrollY = v; },
  });
  // Some linkedom builds reach for window.location.search via location alias.
  window.location = { pathname, search, ancestorOrigins: { 0: '' } };
  window.parent = { postMessage() {} };

  // document.readyState — linkedom defaults to 'complete'; allow override.
  Object.defineProperty(document, 'readyState', {
    configurable: true,
    get: () => readyState,
  });

  // eslint-disable-next-line no-new-func
  new Function(
    'window', 'document', 'location', 'sessionStorage',
    'requestAnimationFrame', 'cancelAnimationFrame',
    INJECTED_PICKER,
  )(
    window, document, window.location, sessionStorage,
    window.requestAnimationFrame, window.cancelAnimationFrame,
  );

  return {
    window,
    document,
    sessionStorage,
    scrollToCalls,
    setScrollY: (v) => { scrollY = v; },
    dispatchDOMContentLoaded() {
      document.dispatchEvent(new window.Event('DOMContentLoaded'));
    },
    dispatchScroll() {
      window.dispatchEvent(new window.Event('scroll'));
    },
    dispatchBeforeUnload() {
      window.dispatchEvent(new window.Event('beforeunload'));
    },
    dispatchPageHide() {
      window.dispatchEvent(new window.Event('pagehide'));
    },
  };
}

describe('INJECTED_PICKER — scroll persistence', () => {

  // ── Tracer bullet: restore on load when a saved offset exists ──────────────

  test('restores saved scrollY on load when sessionStorage holds an offset for this route', () => {
    const { scrollToCalls } = setupPicker({
      pathname: '/dashboard',
      search: '?tab=preview',
      preloadedScroll: '742',
    });

    assert.ok(
      scrollToCalls.some(([, y]) => y === 742),
      'window.scrollTo should be called with the saved offset (got: ' +
      JSON.stringify(scrollToCalls) + ')',
    );
  });

  // ── No saved offset → no restore ───────────────────────────────────────────

  test('does not call scrollTo when there is no saved offset for this route', () => {
    const { scrollToCalls } = setupPicker({ pathname: '/fresh' });
    assert.equal(
      scrollToCalls.length, 0,
      'no scrollTo calls expected when storage has no entry for this route',
    );
  });

  // ── Key is scoped to pathname+search ───────────────────────────────────────

  test('saved offset for a different route does not restore on the current route', () => {
    // Preload an offset under /other but load the picker for /current.
    const { window, document } = parseHTML('<!DOCTYPE html><html><body></body></html>');
    const backing = new Map([['mars.scroll:/other', '500']]);
    const sessionStorage = {
      getItem: k => (backing.has(k) ? backing.get(k) : null),
      setItem: (k, v) => backing.set(k, String(v)),
    };
    const scrollToCalls = [];
    window.scrollTo = (x, y) => scrollToCalls.push([x, y]);
    window.requestAnimationFrame = fn => { fn(); return 0; };
    window.cancelAnimationFrame = () => {};
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => 0 });
    window.location = { pathname: '/current', search: '', ancestorOrigins: { 0: '' } };
    window.parent = { postMessage() {} };

    // eslint-disable-next-line no-new-func
    new Function(
      'window', 'document', 'location', 'sessionStorage',
      'requestAnimationFrame', 'cancelAnimationFrame',
      INJECTED_PICKER,
    )(window, document, window.location, sessionStorage, window.requestAnimationFrame, window.cancelAnimationFrame);

    assert.equal(
      scrollToCalls.length, 0,
      'must not restore an offset that was saved for a different route',
    );
  });

  // ── Persist on scroll ──────────────────────────────────────────────────────

  test('persists window.scrollY to sessionStorage on scroll', () => {
    const t = setupPicker({ pathname: '/' });

    t.setScrollY(321);
    t.dispatchScroll();

    assert.equal(
      t.sessionStorage._backing.get('mars.scroll:/'),
      '321',
      'sessionStorage should hold the latest scrollY after a scroll event',
    );
  });

  // ── Persist on beforeunload + pagehide ─────────────────────────────────────

  test('persists window.scrollY on beforeunload', () => {
    const t = setupPicker({ pathname: '/x' });
    t.setScrollY(999);
    t.dispatchBeforeUnload();
    assert.equal(t.sessionStorage._backing.get('mars.scroll:/x'), '999');
  });

  test('persists window.scrollY on pagehide', () => {
    const t = setupPicker({ pathname: '/y' });
    t.setScrollY(1234);
    t.dispatchPageHide();
    assert.equal(t.sessionStorage._backing.get('mars.scroll:/y'), '1234');
  });

  // ── sessionStorage failures are swallowed silently ─────────────────────────

  test('getItem throwing during load does not throw or crash the picker', () => {
    assert.doesNotThrow(() => {
      setupPicker({ pathname: '/', storage: 'throw-get' });
    }, 'storage.getItem failure during restore must be swallowed silently');
  });

  test('setItem throwing on scroll does not throw or crash the picker', () => {
    const t = setupPicker({ pathname: '/', storage: 'throw-set' });
    t.setScrollY(50);
    assert.doesNotThrow(() => t.dispatchScroll(),
      'storage.setItem failure on scroll must be swallowed silently');
  });

  test('setItem throwing on beforeunload does not throw', () => {
    const t = setupPicker({ pathname: '/', storage: 'throw-set' });
    t.setScrollY(50);
    assert.doesNotThrow(() => t.dispatchBeforeUnload());
  });

  // ── Restore deferred to DOMContentLoaded when readyState is 'loading' ──────

  test('when readyState is "loading", restore happens after DOMContentLoaded', () => {
    const t = setupPicker({
      pathname: '/late',
      readyState: 'loading',
      preloadedScroll: '88',
    });

    assert.equal(
      t.scrollToCalls.length, 0,
      'restore must wait — no scrollTo before DOMContentLoaded',
    );

    t.dispatchDOMContentLoaded();

    assert.ok(
      t.scrollToCalls.some(([, y]) => y === 88),
      'restore should happen after DOMContentLoaded',
    );
  });

  // ── Capture-mode reposition listener is not displaced ──────────────────────

  test('scroll-persistence listeners do not interfere with capture-mode activation', () => {
    // Activating capture mode should still work normally — i.e. installing
    // the scroll-persistence scroll listener at IIFE init time must not
    // prevent the capture activate path from running.
    const t = setupPicker({ pathname: '/' });

    assert.doesNotThrow(() => {
      const ev = new t.window.Event('message');
      Object.defineProperty(ev, 'data', {
        value: { type: 'mars.capture.activate', active: true, notes: [] },
      });
      Object.defineProperty(ev, 'origin', { value: '' });
      t.window.dispatchEvent(ev);
    });
  });
});
