import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    // DSP tests process real buffers; the limiter + loudness passes on a few seconds of
    // stereo audio comfortably exceed the 5 s default.
    testTimeout: 60000,
    hookTimeout: 60000,
    // UI specs opt into jsdom with a `@vitest-environment jsdom` docblock, which keeps the
    // DSP suite running in plain Node (faster, and it proves the DSP has no DOM dependency).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      exclude: ['src/main.js', 'src/app/bootstrap.js', 'src/workers/analysis.worker.js'],
      reporter: ['text', 'html'],
    },
  },
});
