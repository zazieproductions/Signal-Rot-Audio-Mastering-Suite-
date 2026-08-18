/**
 * File download and filename hygiene.
 *
 * ── Filename sanitisation ────────────────────────────────────────────────────────────
 * The source of every generated filename is `file.name`, which is fully attacker- (or
 * accident-) controlled. `sanitizeFilename` removes path separators, control characters,
 * the Windows reserved characters `<>:"/\|?*`, leading dots, and reserved device names
 * (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…`LPT9`), then truncates to a length every common
 * filesystem accepts. This is defence against a corrupt download, not just against XSS —
 * although the audited code did also interpolate `file.name` into `innerHTML`.
 *
 * ── Object URL lifetime ──────────────────────────────────────────────────────────────
 * The old code revoked the object URL after a fixed 2 s, which can cancel a download the
 * browser has not finished reading. Here the URL is revoked on the next `pagehide`, or
 * after a generous delay, whichever comes first — and every URL is tracked so nothing
 * leaks if the user exports fifty files in a session.
 */

/** Windows reserved device names, case-insensitive, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Make a string safe to use as a download filename.
 *
 * @param {string} name
 * @param {object} [opts]
 * @param {string} [opts.fallback] used when nothing usable remains
 * @param {number} [opts.maxLength] default 120
 */
export function sanitizeFilename(name, opts = {}) {
  const fallback = opts.fallback ?? 'master';
  const maxLength = opts.maxLength ?? 120;

  let s = String(name ?? '');
  // Strip any directory component first — both separators, on every platform.
  s = s.split(/[/\\]/).pop() ?? '';
  // Control characters and the Windows-forbidden set.
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '');
  // Collapse whitespace, trim, drop leading dots (hidden files) and trailing dots/spaces
  // (which Windows silently strips, producing surprising names).
  s = s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');

  if (!s || RESERVED.test(s)) s = fallback;
  if (s.length > maxLength) {
    const dot = s.lastIndexOf('.');
    if (dot > 0 && s.length - dot <= 8) {
      s = s.slice(0, maxLength - (s.length - dot)) + s.slice(dot);
    } else {
      s = s.slice(0, maxLength);
    }
  }
  return s;
}

/** Strip a file extension, then sanitise. Used to build `<name>_master.wav`. */
export function baseNameOf(name, fallback = 'master') {
  return sanitizeFilename(String(name ?? '').replace(/\.[^.]+$/, ''), { fallback });
}

/** Track live object URLs so they can all be revoked on teardown. */
const liveUrls = new Set();

function revoke(url) {
  if (!liveUrls.has(url)) return;
  liveUrls.delete(url);
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* already revoked */
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const url of [...liveUrls]) revoke(url);
  });
}

/**
 * Trigger a browser download.
 *
 * A fresh, detached `<a>` is created per download rather than reusing one element: a
 * reused anchor whose `href` changes while a previous download is still being read is a
 * documented source of truncated files in Chromium.
 *
 * @param {Blob} blob
 * @param {string} filename already sanitised, or it will be
 * @param {object} [opts]
 * @param {number} [opts.revokeAfterMs] default 60 000
 * @returns {{ok: boolean, error?: Error}}
 */
export function downloadBlob(blob, filename, opts = {}) {
  const name = sanitizeFilename(filename);
  try {
    const url = URL.createObjectURL(blob);
    liveUrls.add(url);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Long delay: large files can take a while for the browser to commit to disk, and a
    // premature revoke truncates them.
    setTimeout(() => revoke(url), opts.revokeAfterMs ?? 60000);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: /** @type {Error} */ (error) };
  }
}

/** Download a JavaScript value as pretty-printed JSON. */
export function downloadJson(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  return downloadBlob(blob, filename);
}

/** Download a string as UTF-8 text. */
export function downloadText(text, filename, mime = 'text/plain') {
  return downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}
