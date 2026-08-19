/**
 * Deterministic pseudo-random number generation.
 *
 * The analogue-character engines (hiss, crackle, rumble, dither) need randomness, but a
 * mastering tool that renders a different file every time you press export is not a
 * mastering tool. Every noise source in Signal Rot draws from a seeded generator so that
 * *the same project with the same texture seed renders byte-identical output*.
 *
 * `mulberry32` is a 32-bit generator with a full 2³² period, excellent avalanche and a
 * two-line implementation. It is not cryptographically secure and is not used for
 * anything that needs to be.
 *
 * Reference: Tommy Ettinger's mulberry32 (public domain).
 */

/**
 * @param {number} seed 32-bit unsigned
 * @returns {() => number} generator producing uniform [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform in [−1, 1). */
export function bipolar(rng) {
  return rng() * 2 - 1;
}

/**
 * Gaussian sample via the Box–Muller transform, mean 0, unit variance.
 * Used for hiss, which should be Gaussian rather than uniform: real tape noise is the sum
 * of very many independent magnetic-domain events, so the central limit theorem applies.
 */
export function gaussian(rng) {
  // u must be strictly > 0 for log().
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Derive a stable child seed from a parent seed and a string tag, so that (for example)
 * the left hiss channel, the right hiss channel and the crackle bed all get independent
 * streams that are still fully determined by the one seed the user sees.
 *
 * FNV-1a over the tag, mixed with the parent seed.
 */
export function deriveSeed(seed, tag) {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A fresh random seed for the "randomise texture" control. */
export function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}
