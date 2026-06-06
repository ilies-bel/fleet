/**
 * Unit tests for computeRef — the stable element-reference function that
 * drives the capture picker. Tests use linkedom to create real-but-synthetic
 * DOM environments so the querySelectorAll uniqueness check works correctly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { computeRef } from '../src/injected-picker.js';

test('computeRef returns id reference when element has an id', () => {
  const { document } = parseHTML('<html><body><button id="submit-btn">Submit</button></body></html>');
  const el = document.getElementById('submit-btn');
  const ref = computeRef(el);
  assert.equal(ref.refKind, 'id');
  assert.equal(ref.selector, '#submit-btn');
  assert.equal(ref.label, 'submit-btn');
});

test('computeRef returns testid reference when element has data-testid (no id)', () => {
  const { document } = parseHTML(
    '<html><body><button data-testid="close-dialog">X</button></body></html>'
  );
  const el = document.querySelector('[data-testid="close-dialog"]');
  const ref = computeRef(el);
  assert.equal(ref.refKind, 'testid');
  assert.equal(ref.selector, '[data-testid="close-dialog"]');
  assert.equal(ref.label, 'close-dialog');
});

test('computeRef returns aria reference when element has aria-label (no id, no testid)', () => {
  const { document } = parseHTML(
    '<html><body><button aria-label="Open menu">☰</button></body></html>'
  );
  const el = document.querySelector('[aria-label="Open menu"]');
  const ref = computeRef(el);
  assert.equal(ref.refKind, 'aria');
  assert.equal(ref.selector, '[aria-label="Open menu"]');
  assert.equal(ref.label, 'Open menu');
});

test('computeRef returns unique css path when element has no id, testid, or aria-label', () => {
  // Two sibling divs each with a button — button:nth-of-type(1) alone is ambiguous,
  // so the algorithm must walk up to include the parent div's nth-of-type index.
  const { document } = parseHTML(`
    <html><body>
      <div><button>First</button></div>
      <div><button>Second</button></div>
    </body></html>
  `);
  const buttons = document.querySelectorAll('button');
  const secondButton = buttons[1];
  const ref = computeRef(secondButton);
  assert.equal(ref.refKind, 'css');
  assert.equal(ref.label, 'button');
  // The selector must uniquely identify the element.
  const matches = document.querySelectorAll(ref.selector);
  assert.equal(matches.length, 1, `selector "${ref.selector}" should match exactly one element`);
  assert.equal(matches[0], secondButton);
});
