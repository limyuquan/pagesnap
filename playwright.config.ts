import { defineConfig } from '@playwright/test';

export const FIXTURE_PORT = Number(process.env.FIXTURE_PORT ?? 4321);
export const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;

/**
 * E2E: the extension (built by `pnpm build:e2e` into .output/chrome-mv3-e2e) is loaded into
 * Playwright's bundled Chromium. `pnpm test:e2e` builds first; `playwright test` alone reuses the
 * last build. Set HEADED=1 to watch.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: `test-results${process.env.PAGESNAP_E2E_ID ? `-${process.env.PAGESNAP_E2E_ID}` : ''}`,
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/serve-fixtures.mjs',
    url: `${FIXTURE_ORIGIN}/`,
    reuseExistingServer: !process.env.CI,
    env: { FIXTURE_PORT: String(FIXTURE_PORT) },
  },
});
