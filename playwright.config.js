import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests.
 *
 * These require a real browser with Web Audio, which is why they are separate from the
 * Vitest suite. They start the Vite dev server themselves, so `npm run test:e2e` is the
 * only command needed — but the browser binaries must be installed first:
 *
 *     npx playwright install chromium
 *
 * `--use-fake-device-for-media-stream` and the autoplay flag let the AudioContext start
 * without a real user gesture, which is what makes the audio paths testable at all.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--autoplay-policy=no-user-gesture-required',
            '--use-fake-device-for-media-stream',
            '--mute-audio',
          ],
        },
      },
    },
    {
      name: 'chromium-mobile',
      use: {
        ...devices['Pixel 7'],
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
      },
      testMatch: /responsive\.spec\.js/,
    },
  ],
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
