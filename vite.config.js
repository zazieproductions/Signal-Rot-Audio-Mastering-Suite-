import { defineConfig } from 'vite';

/**
 * Vite configuration.
 *
 * `base: './'` so the built site works from a subdirectory (GitHub Pages project sites,
 * an itch.io upload, a USB stick) without rewriting asset paths.
 *
 * The analysis Web Worker is referenced with `new URL(..., import.meta.url)` and is picked
 * up automatically; `worker.format: 'es'` keeps it an ES module so it can import the same
 * DSP code as the main thread rather than duplicating it.
 */
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
  worker: {
    format: 'es',
  },
  server: {
    host: true,
    // The preview environment proxies through an arbitrary *.e2b.app hostname.
    allowedHosts: true,
  },
  preview: {
    host: true,
    allowedHosts: true,
  },
});
