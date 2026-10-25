import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

/**
 * Two projects:
 * - `unit`: Node, fast. `wxt/browser` is WXT's in-memory fake browser, IndexedDB is fake-indexeddb.
 *   Files: tests/unit/**\/*.test.ts
 * - `browser`: real Chromium (Vitest browser mode, headless) for canvas/OffscreenCanvas/IDB code.
 *   Files: tests/browser/**\/*.test.ts. WXT's Vitest plugin doesn't work in browser mode, so this
 *   project only gets the `@/` alias: code under test there must not use `wxt/browser`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [WxtVitest()],
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          setupFiles: ['tests/unit/setup.ts'],
        },
      },
      {
        resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
        // Pre-bundle up front, so Vite doesn't discover them mid-run and reload the page
        // (which fails the first browser test with "Vite unexpectedly reloaded a test").
        optimizeDeps: { include: ['perfect-freehand', 'idb'] },
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
            screenshotFailures: false,
          },
        },
      },
    ],
  },
});
