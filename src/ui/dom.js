/**
 * Tiny DOM helpers.
 *
 * `text()` and `el()` exist so that *no* user-controlled string is ever concatenated into
 * `innerHTML`. The audited build wrote `file.name` straight into `innerHTML` in the batch
 * list, which is a stored-XSS sink: dropping a file called
 * `<img src=x onerror=alert(1)>.wav` executed script.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Create an element.
 * @param {string} tag
 * @param {Record<string, any>} [attrs] `class`, `text`, `html` (trusted only), aria-*, data-*
 * @param {(Node|string|null|false|undefined)[]} [children]
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') {
      node.innerHTML = value;
    } // callers must pass literals only
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** Replace an element's children safely. */
export function replaceChildren(node, ...children) {
  node.replaceChildren(...children.filter(Boolean));
}

/** Format seconds as `m:ss`. */
export function formatTime(seconds) {
  const s = Math.max(0, seconds || 0);
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** Format bytes for the size warnings. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} kB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
