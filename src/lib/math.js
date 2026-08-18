/**
 * Signal Rot — shared numeric and text utilities.
 * Pure functions only (no DOM, no Web Audio). Unit-tested in tests/math.test.js.
 */

/** Clamp `v` into the inclusive range [a, b]. */
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Convert a decibel value to a linear amplitude gain. */
export const dbToGain = (db) => Math.pow(10, db / 20);

/** Convert a linear amplitude gain to decibels (floored at -180 dB to avoid -Infinity). */
export const gainToDb = (g) => 20 * Math.log10(Math.max(1e-9, g));

/** Format seconds as m:ss. */
export function fmtTime(s) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/**
 * Deterministic 32-bit PRNG (mulberry32). Returns a function yielding floats in [0, 1).
 * Used for repeatable texture generation (tape hiss, vinyl crackle, dither, etc.).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a string hash → unsigned int. Used to seed noise from arbitrary text. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Sanitize a user filename stem for safe cross-platform download names.
 * Replaces path separators and reserved characters, trims, and caps length.
 */
export function sanitizeFileName(name) {
  let s = String(name ?? 'master');
  // Strip control characters first (avoids a control-character regex), then
  // replace path separators / reserved characters, collapse whitespace, trim.
  s = [...s].filter((ch) => ch.charCodeAt(0) >= 0x20).join('');
  s = s
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 120);
  return s || 'master';
}

/** Strip a file extension and sanitize the stem, e.g. "My Song.wav" → "My Song". */
export function baseName(label) {
  return sanitizeFileName(String(label ?? 'master').replace(/\.[^.]+$/, ''));
}

/** Linearly interpolate between two samples (reconstruction helper). */
export const lerp = (a, b, t) => a + (b - a) * t;

/** True if a value is a finite number (NaN/Infinity guard used across the DSP). */
export const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
