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
    command: 'npx vite --port 5174 --strictPort --host 0.0.0.0',
    url: 'http://127.0.0.1:5174/tests/browser/harness.html',
    reuseExistingServer: !process.env.CI,
    // The conformance harness pulls in the entire lab (compressor / multiband /
    // waveshaper / immersive / etc.) plus all the production DSP modules. Vite's
    // first-time cold start on a fresh ubuntu-latest runner with a cold filesystem
    // cache regularly exceeds 60 s, which surfaces as Playwright reporting
    // "Timed out waiting 60000ms from config.webServer" and skipping every test.
    // 180 s leaves margin for the cold start without masking a real hang.
    timeout: 180_000,
  },
});
