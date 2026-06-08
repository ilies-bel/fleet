import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the gateway package.
 *
 * All test files use Node.js built-in test runner idioms (node:test).
 * Aliasing node:test → vitest lets vitest's own runner discover and register
 * the describe/test/beforeEach/afterEach calls so `npx vitest run` works
 * alongside `node --test`.
 */
export default defineConfig({
  test: {
    alias: {
      'node:test': 'vitest',
    },
  },
});
