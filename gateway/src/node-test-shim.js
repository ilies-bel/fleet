/**
 * Shim that maps node:test idioms onto vitest exports.
 *
 * vitest.config.js aliases 'node:test' to this file so that test files
 * written for node:test's API work with the vitest runner:
 *   - node:test's `after`  → vitest's `afterAll`
 *   - node:test's `before` → vitest's `beforeAll`
 *
 * All other exports (describe, test, it, beforeEach, afterEach) are
 * re-exported verbatim from vitest.
 */
export {
  describe,
  test,
  it,
  beforeEach,
  afterEach,
  beforeAll as before,
  afterAll as after,
} from 'vitest';
