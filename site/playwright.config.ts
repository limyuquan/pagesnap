import { defineConfig, devices } from '@playwright/test';

/**
 * Website e2e (`pnpm site:test`): builds the site, serves the build with `vite preview` and drives
 * the demo in headless Chromium, on a desktop and a phone. Separate from the extension's suite.
 */
const PORT = Number(process.env.SITE_PORT ?? 4183);

export default defineConfig({
  testDir: 'e2e',
  outputDir: '../test-results-site',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}/`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    {
      name: 'phone',
      use: {
        ...devices['Pixel 7'],
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    command: `pnpm site:build && pnpm exec vite preview --config site/vite.config.ts --host 127.0.0.1 --port ${PORT} --strictPort`,
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
