/**
 * Canvas helpers shared by every visualiser.
 *
 * ── The per-frame allocation problem ─────────────────────────────────────────────────
 * The audited render loop allocated six `Float32Array`s per frame (2 × 2048 twice plus
 * 8192) — roughly 1.5 MB/s of garbage at 60 fps — and re-assigned `canvas.width` every
 * frame in the waveform drawer, forcing a full backing-store reallocation and clear.
 *
 * `resizeCanvas` only touches `width`/`height` when the CSS size or device pixel ratio
 * has actually changed, and `getScratch` hands out pooled typed arrays keyed by length.
 */

/** @type {Map<string, Float32Array>} */
const scratchPool = new Map();

/**
 * A pooled `Float32Array`. The same key always returns the same array, so callers must
 * not hold on to it across frames.
 * @param {string} key
 * @param {number} length
 */
export function getScratch(key, length) {
  const existing = scratchPool.get(key);
  if (existing && existing.length === length) return existing;
  const created = new Float32Array(length);
  scratchPool.set(key, created);
  return created;
}

/** Pooled `Uint8Array` for byte-domain analyser reads. */
const byteScratch = new Map();
export function getByteScratch(key, length) {
  const existing = byteScratch.get(key);
  if (existing && existing.length === length) return existing;
  const created = new Uint8Array(length);
  byteScratch.set(key, created);
  return created;
}

/**
 * Size a canvas for the device pixel ratio, only when necessary.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} [cssHeight] override the CSS height (otherwise measured)
 * @returns {{ctx:CanvasRenderingContext2D, width:number, height:number, changed:boolean}|null}
 */
export function resizeCanvas(canvas, cssHeight) {
  if (!canvas) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2); // 3× on phones buys nothing here
  const width = canvas.clientWidth;
  const height = cssHeight ?? canvas.clientHeight;
  if (width <= 0 || height <= 0) return null;
  const targetW = Math.round(width * dpr);
  const targetH = Math.round(height * dpr);
  const changed = canvas.width !== targetW || canvas.height !== targetH;
  if (changed) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height, changed };
}

/** Read a CSS custom property from the document root. */
const cssCache = new Map();
let cssGeneration = 0;

export function invalidateCssCache() {
  cssGeneration++;
  cssCache.clear();
}

export function cssVar(name) {
  const key = `${cssGeneration}:${name}`;
  const cached = cssCache.get(key);
  if (cached !== undefined) return cached;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(key, value);
  return value;
}

/** Colour for the currently auditioned signal: cyan for original, orange for processed. */
export const signalColor = (abMode) => cssVar(abMode === 'A' ? '--orig' : '--proc');

/** Convert a hex colour to `rgba()` with the given alpha. Falls back to the input. */
export function withAlpha(color, alpha) {
  const hex = color.replace('#', '');
  if (hex.length !== 6 && hex.length !== 3) return color;
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
