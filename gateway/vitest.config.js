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
 *
 * `include` is scoped to test/ so `npm run test:vitest` targets only the DOM
 * tests that need linkedom — the src/ unit tests run under `node --test` via
 * the primary `npm test` script and are not duplicated here.
 *
 * proxy-injection.test.js and api.services-health.test.js use node:test's
 * callback-style `afterEach((_t, done) => ...)` / `beforeEach((t, done) => ...)`
 * signatures, which vitest does not support. They are excluded here; `npm test`
 * (node --test) covers them in the primary run.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    exclude: [
      'test/proxy-injection.test.js',
      'test/api.services-health.test.js',
      'node_modules/**',
    ],
    alias: {
      'node:test': path.resolve(__dirname, 'src/node-test-shim.js'),
    },
  },
});
