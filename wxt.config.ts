import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

/**
 * Page Snap build config. The manifest is generated from here.
 *
 * Modes:
 * - `production` (`pnpm build`, `pnpm zip`): store build. No host permissions, no test hooks.
 * - `development` (`pnpm dev`): WXT dev runner with HMR.
 * - `e2e` (`pnpm build:e2e`): outputs to `.output/chrome-mv3-e2e`, adds `<all_urls>` host permission
 *   so Playwright can capture without a user gesture, and enables the `__pagesnap` test hooks
 *   (gated on `import.meta.env.MODE === 'e2e'`, tree-shaken out of other builds).
 */
/**
 * Optional suffix for the output folder (e.g. `PAGESNAP_E2E_ID=a pnpm test:e2e` builds into
 * `.output/chrome-mv3-e2e-a`), so parallel workers don't overwrite each other's e2e build.
 * tests/e2e/fixtures.ts reads the same variable.
 */
const outSuffix = process.env.PAGESNAP_E2E_ID ? `-${process.env.PAGESNAP_E2E_ID}` : '';

export default defineConfig({
  srcDir: 'src',
  outDirTemplate: `{{browser}}-mv{{manifestVersion}}{{modeSuffix}}${outSuffix}`,
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  // Explicit imports everywhere (`wxt/browser`, `wxt/utils/define-background`, ...). Easier to
  // read for parallel agents and keeps Biome's undeclared-variable checks meaningful.
  imports: false,
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: ({ mode }) => ({
    name: 'Page Snap',
    short_name: 'Page Snap',
    description:
      'Full-page screenshots with an instant annotation editor. Copy the marked-up image straight into an AI chat.',
    minimum_chrome_version: '120',
    permissions: ['activeTab', 'scripting', 'storage', 'unlimitedStorage', 'contextMenus'],
    // e2e only: captureVisibleTab needs `<all_urls>` or an activeTab grant; a localhost-only host
    // permission is not enough (verified), and Playwright can't produce the activeTab gesture.
    ...(mode === 'e2e' && { host_permissions: ['<all_urls>'] }),
    // No default_popup on purpose: a toolbar click fires action.onClicked and starts the capture.
    action: {
      default_title: 'Capture full page (Alt+Shift+P)',
    },
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+P' },
        description: 'Capture full page',
      },
    },
  }),
});
