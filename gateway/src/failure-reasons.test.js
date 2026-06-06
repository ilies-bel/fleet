/**
 * Tests for failure-reasons.js.
 *
 * Verifies: FAILURE_REASONS object shape/immutability, tagError idempotency,
 * and return-value contract.
 *
 * Uses Node.js built-in test runner (node:test).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FAILURE_REASONS, tagError } from './failure-reasons.js';

describe('failure-reasons', () => {
  test('FAILURE_REASONS is frozen', () => {
    assert.ok(Object.isFrozen(FAILURE_REASONS), 'FAILURE_REASONS must be frozen');
  });

  test('FAILURE_REASONS contains all expected codes', () => {
    assert.equal(FAILURE_REASONS.DOCKER_SOCKET_UNAVAILABLE, 'docker:socket-unavailable');
    assert.equal(FAILURE_REASONS.DOCKER_STOP_FAILED, 'docker:stop-failed');
    assert.equal(FAILURE_REASONS.DOCKER_CONTAINER_NOT_FOUND, 'docker:container-not-found');
    assert.equal(FAILURE_REASONS.BUILD_FAILED, 'build:failed');
    assert.equal(FAILURE_REASONS.REGISTRY_NOT_REGISTERED, 'registry:not-registered');
    assert.equal(FAILURE_REASONS.SYNC_RSYNC_FAILED, 'sync:rsync-failed');
    assert.equal(FAILURE_REASONS.SYNC_CONTAINER_MISSING, 'sync:container-missing');
  });

  test('tagError sets reasonCode when not already present', () => {
    const err = new Error('something went wrong');
    tagError(err, 'build:failed');
    assert.equal(err.reasonCode, 'build:failed');
  });

  test('tagError does not overwrite an existing reasonCode', () => {
    const err = new Error('socket gone');
    err.reasonCode = 'docker:socket-unavailable';
    tagError(err, 'build:failed');
    assert.equal(err.reasonCode, 'docker:socket-unavailable', 'pre-existing code must survive');
  });

  test('tagError returns the same error object', () => {
    const err = new Error('test');
    const result = tagError(err, 'build:failed');
    assert.strictEqual(result, err);
  });
});
