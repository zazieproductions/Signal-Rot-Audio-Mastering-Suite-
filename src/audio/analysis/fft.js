/**
 * Radix-2 in-place complex FFT.
 *
 * Iterative Cooley–Tukey with decimation in time. Input length must be a power of two.
 * Twiddle factors are recomputed by recurrence inside the butterfly loop, which is a
 * little less accurate than a precomputed table but keeps the module allocation-free for
 * repeated calls on the same size — the spectral-match analyser runs this hundreds of
 * times on 8192-point frames.
 */

/** @param {Float64Array|Float32Array} re @param {Float64Array|Float32Array} im */
export function fftRadix2(re, im) {
  const n = re.length;
  if (n !== im.length) throw new Error('fftRadix2: re/im length mismatch');
  if (n & (n - 1)) throw new Error(`fftRadix2: length ${n} is not a power of two`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const xr = re[i + k + half];
        const xi = im[i + k + half];
        const vr = xr * cwr - xi * cwi;
        const vi = xr * cwi + xi * cwr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  return re;
}

const windowCache = new Map();

/**
 * Periodic Hann window (`0.5 − 0.5·cos(2πn/N)`), cached by length.
 *
 * Periodic — not symmetric — because these windows are used for spectral *analysis* with
 * overlap, where the periodic form gives the correct amplitude summation. The symmetric
 * form (`/(N−1)`) is for filter design.
 */
export function hannWindow(n) {
  const cached = windowCache.get(n);
  if (cached) return cached;
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  windowCache.set(n, w);
  return w;
}

/** Coherent gain of a window — the factor by which it scales a full-scale sine. */
export function windowCoherentGain(w) {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i];
  return s / w.length;
}
