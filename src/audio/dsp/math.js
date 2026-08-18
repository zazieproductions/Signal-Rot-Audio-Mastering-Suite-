/**
 * Scalar maths shared by every DSP module. Pure, dependency-free, unit-tested.
 *
 * All decibel conversions here are *amplitude* decibels (20·log10), which is what a
 * mastering chain deals in. Power decibels (10·log10) appear only inside the loudness
 * meter, where they are written out explicitly.
 */

/** Smallest amplitude treated as non-zero. −180 dBFS, comfortably below 32-bit float noise. */
export const EPS = 1e-9;

/** @param {number} v @param {number} lo @param {number} hi */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Amplitude ratio from decibels. `dbToGain(-6) ≈ 0.501` */
export const dbToGain = (db) => Math.pow(10, db / 20);

/** Decibels from amplitude ratio, floored at −180 dB so silence never yields −Infinity. */
export const gainToDb = (g) => 20 * Math.log10(Math.max(EPS, Math.abs(g)));

/** Linear interpolation. */
export const lerp = (a, b, t) => a + (b - a) * t;

/** Hermite smoothstep on [0,1]; C¹ continuous, used for limiter knees and UI easing. */
export const smoothstep = (t) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/**
 * One-pole coefficient for a time constant expressed in seconds.
 * Returns `exp(-1 / (sampleRate * seconds))`, the per-sample decay of an RC follower.
 * Guards against zero/negative times, which would otherwise produce NaN.
 */
export const onePoleCoeff = (seconds, sampleRate) => {
  if (!(seconds > 0)) return 0;
  return Math.exp(-1 / Math.max(1, sampleRate * seconds));
};

/** True when `v` is a finite number (rejects NaN, ±Infinity, and non-numbers). */
export const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Round to a fixed number of decimals without floating-point display noise.
 * `round(0.1 + 0.2, 2) === 0.3`
 */
export const round = (v, decimals = 0) => {
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
};

/** Percentile of an already-sorted ascending array, with linear interpolation. */
export const percentileSorted = (sorted, p) => {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = clamp(p, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : lerp(sorted[lo], sorted[hi], idx - lo);
};
