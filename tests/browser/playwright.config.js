import { defineConfig, devices } from '@playwright/test';

/**
 * Real-Web-Audio conformance lab.
 *
 * Separate from `e2e/` so UI tests and numerical DSP tests cannot block each other,
 * and so we can target Chromium, Firefox and WebKit without changing the existing
 * Playwright config Agent A does not own.
 *
 *     npx playwright install chromium firefox webkit
 *     npx playwright test --config tests/browser/playwright.config.js
 */

const autoplay = ['--autoplay-policy=no-user-gesture-required', '--mute-audio'];

/** Optional override so a sandbox without the Playwright CDN can still drive Chromium. */
const chromiumPath = process.env.SR_CHROMIUM_PATH;
const chromiumLaunch = {
  args: [
    ...autoplay,
    '--use-fake-device-for-media-stream',
    ...(chromiumPath
      ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      : []),
  ],
};
if (chromiumPath) chromiumLaunch.executablePath = chromiumPath;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [
        ['github'],
        ['list'],
        ['html', { open: 'never', outputFolder: 'playwright-report/conformance' }],
      ]
    : [['list']],
  outputDir: '../../test-results/conformance',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'on-first-retry',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: chromiumLaunch,
      },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: {
    // Resolve the vite binary directly from node_modules rather than going
    // through `npx`. npx shells out to npm which on a fresh runner can
    // spend several seconds resolving and downloading the package even when
    // it's already installed. Going direct skips that whole path and gives
    // us the same binary.
    //
    // `cwd` is set explicitly to the repo root because Playwright defaults
    // the webServer working directory to the directory of the configuration
    // file (this one, i.e. `tests/browser/`), where there is no
    // `node_modules/.bin/vite`. With the wrong cwd the command exits
    // immediately and Playwright reports the opaque
    // "Timed out waiting ... from config.webServer" message. Anchoring
    // cwd to the project root makes the path resolve the same way
    // `npx vite` would have.
    command: 'node_modules/.bin/vite --port 5174 --strictPort --host 0.0.0.0',
    cwd: '../..',
    url: 'http://127.0.0.1:5174/tests/browser/harness.html',
    // The conformance workflow's 'Warm Vite' step leaves a dev server bound to
    // 5174 with a fully populated on-disk transform cache. We want Playwright
    // to reuse that server instead of spawning a second vite and racing for
    // the port. The previous `!process.env.CI` setting was flipped so the
    // gate reuses the warmed server even in CI.
    reuseExistingServer: true,
    // The conformance harness pulls in the entire lab (compressor / multiband /
    // waveshaper / immersive / etc.) plus all the production DSP modules. Vite's
    // first-time cold start on a fresh ubuntu-latest runner with a cold filesystem
    // cache regularly exceeds 60 s, which surfaces as Playwright reporting
    // "Timed out waiting 60000ms from config.webServer" and skipping every test.
    // 180 s leaves margin for the cold start without masking a real hang.
    timeout: 180_000,
  },
});
