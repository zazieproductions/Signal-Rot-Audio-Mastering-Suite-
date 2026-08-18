/** Small shared numeric helpers used across DSP and export modules. */

/** Clamp `v` into [a, b]. */
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Convert decibels to a linear gain factor. */
export const dbToGain = (db) => Math.pow(10, db / 20);

/** Convert a linear gain factor to decibels, floored to avoid -Infinity. */
export const gainToDb = (g) => 20 * Math.log10(Math.max(1e-9, g));

/** Format seconds as m:ss. */
export function formatTime(seconds) {
  const s = Math.max(0, seconds || 0);
  const m = Math.floor(s / 60);
  return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}
