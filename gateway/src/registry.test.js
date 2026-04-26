/**
 * Tests for registry.js — updateStatus activeFeature clearing behaviour.
 *
 * Uses Node.js built-in test runner (node:test).
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  register,
  unregister,
  getAll,
  updateStatus,
  getActiveFeature,
  setActiveFeature,
  isRegistered,
} from './registry.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function clearRegistry() {
  for (const f of getAll()) unregister(f.key);
}

// ── updateStatus activeFeature clearing ───────────────────────────────────────

describe('updateStatus — activeFeature clearing', () => {
  beforeEach(() => {
    clearRegistry();
  });

  test('updateStatus(key, "stopped") clears activeFeature when key is active', () => {
    register('p', 'a', 'main', null, 'up');
    // register auto-activates first 'up' feature
    assert.equal(getActiveFeature(), 'p-a', 'precondition: feature should be active');

    updateStatus('p-a', 'stopped');

    assert.equal(getActiveFeature(), null, 'activeFeature should be null after stopped transition');
  });

  test('updateStatus(key, "failed") clears activeFeature when key is active', () => {
    register('p', 'b', 'main', null, 'up');
    assert.equal(getActiveFeature(), 'p-b', 'precondition: feature should be active');

    updateStatus('p-b', 'failed', 'some error');

    assert.equal(getActiveFeature(), null, 'activeFeature should be null after failed transition');
  });

  test('updateStatus(key, "building") does NOT clear activeFeature', () => {
    register('p', 'c', 'main', null, 'up');
    assert.equal(getActiveFeature(), 'p-c', 'precondition: feature should be active');

    updateStatus('p-c', 'building');

    assert.equal(getActiveFeature(), 'p-c', 'activeFeature must NOT be cleared on building transition');
  });

  test('updateStatus does NOT clear activeFeature when a different key is active', () => {
    register('p', 'd', 'main', null, 'up');  // becomes active
    register('p', 'e', 'main', null, 'up');  // second one, first stays active

    assert.equal(getActiveFeature(), 'p-d', 'precondition: p-d should be active');

    // Stop p-e (which is NOT active)
    updateStatus('p-e', 'stopped');

    assert.equal(getActiveFeature(), 'p-d', 'activeFeature should remain p-d when a non-active feature stops');
  });

  test('updateStatus(key, "stopped") on non-active feature leaves activeFeature intact', () => {
    register('p', 'f', 'main', null, 'up');
    register('p', 'g', 'main', null, 'up');
    setActiveFeature('p-f');

    updateStatus('p-g', 'stopped');

    assert.equal(getActiveFeature(), 'p-f', 'activeFeature should remain unchanged when non-active feature stops');
  });
});
