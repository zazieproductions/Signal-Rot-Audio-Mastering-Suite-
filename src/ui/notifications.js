/**
 * Toasts and inline notices.
 *
 * Accessibility: the toast is a `role="status"` live region so a screen-reader user hears
 * "Exported WAV" rather than nothing at all. Errors use `role="alert"` and a longer
 * dwell — the audited build showed every message for 1.9 seconds including failures.
 */

import { $, el, replaceChildren } from './dom.js';

let timer = null;

/**
 * @param {string} message
 * @param {object} [opts]
 * @param {'info'|'error'} [opts.level]
 * @param {number} [opts.durationMs]
 */
export function toast(message, opts = {}) {
  const node = $('#toast');
  if (!node) return;
  const error = opts.level === 'error';
  node.textContent = message;
  node.classList.toggle('error', error);
  node.setAttribute('role', error ? 'alert' : 'status');
  node.classList.add('show');
  clearTimeout(timer);
  timer = setTimeout(() => node.classList.remove('show'), opts.durationMs ?? (error ? 6000 : 2200));
}

/**
 * Render a list of messages into a container as a notice block.
 * @param {HTMLElement|null} container
 * @param {{level:'ok'|'info'|'caution'|'danger', title?:string, messages:string[]}|null} notice
 */
export function renderNotice(container, notice) {
  if (!container) return;
  if (!notice || !notice.messages.length) {
    replaceChildren(container);
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const list = el(
    'ul',
    {},
    notice.messages.map((m) => el('li', { text: m })),
  );
  replaceChildren(
    container,
    el('div', { class: `notice ${notice.level}` }, [
      notice.title ? el('strong', { text: notice.title }) : null,
      notice.messages.length === 1 && !notice.title
        ? document.createTextNode(notice.messages[0])
        : list,
    ]),
  );
}

/** Announce a message to assistive technology without showing a toast. */
export function announce(message) {
  const region = $('#live-region');
  if (region) region.textContent = message;
}
