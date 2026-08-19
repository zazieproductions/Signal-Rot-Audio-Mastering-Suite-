/**
 * Signal Rot // Master — entry point.
 *
 * Deliberately tiny: it waits for the DOM and hands off to `app/bootstrap.js`. Everything
 * else is a module with a single responsibility, and every numeric routine lives under
 * `src/audio/**` where it can be unit-tested in Node without a browser.
 */

import { bootstrap } from './app/bootstrap.js';

function start() {
  try {
    const app = bootstrap();
    // Exposed for the Playwright suite and for console debugging. Read-only in practice.
    Object.defineProperty(window, '__signalRot', { value: app, writable: false });
  } catch (error) {
    console.error('[signal-rot] failed to start:', error);
    const toast = document.querySelector('#toast');
    if (toast) {
      toast.textContent = `Signal Rot failed to start: ${error.message ?? error}`;
      toast.classList.add('show', 'error');
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
