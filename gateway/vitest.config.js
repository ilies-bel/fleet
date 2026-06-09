import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vitest configuration for the gateway package.
 *
 * All test files use Node.js built-in test runner idioms (node:test).
 * Aliasing node:test → the shim lets vitest's own runner discover and register
 * the describe/test/beforeEach/afterEach/after calls so `npx vitest run` works
 * alongside `node --test`.
 *
 * The shim maps:
 *   node:test `after`  → vitest `afterAll`
 *   node:test `before` → vitest `beforeAll`
 */
export default defineConfig({
  test: {
    alias: {
      'node:test': path.resolve(__dirname, 'src/node-test-shim.js'),
    },
  },
});
