import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    // Preview/sandbox hosts (e.g. *.e2b.app) must be able to reach the dev server.
    allowedHosts: true,
  },
  preview: {
    host: true,
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    coverage: { provider: 'v8', include: ['src/**/*.js'], reporter: ['text', 'lcov'] },
  },
});
