/**
 * Reference-match EQ: compare the spectral balance of two tracks and derive a
 * corrective curve.
 *
 * Changes over the original:
 *
 *  - **`getChannelData` is hoisted out of the inner loop.** It was being called
 *    once per sample per channel — 8192 * channels * frames property lookups
 *    per analysis, which dominated the runtime.
 *  - **Twiddle factors are computed from a table** rather than by repeated
 *    complex multiplication. The recurrence accumulated enough rounding error
 *    over an 8192-point transform to smear the bottom of the spectrum.
 *  - **Frames are windowed with a periodic Hann** (divisor N, not N-1), which
 *    is the correct choice for spectral analysis and avoids a small DC leak.
 */

/** Centre frequencies of the matching bands, in Hz. */
export const MATCH_FREQS = Object.freeze([60, 150, 400, 1000, 2500, 5000, 8000, 12000]);

/** Largest correction the matcher will ever suggest, in dB. */
export const MAX_MATCH_DB = 8;

/**
 * In-place radix-2 FFT.
 * @param {Float64Array} re
 * @param {Float64Array} im
 */
export function fft(re, im) {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) {
    throw new RangeError('FFT length must be a power of two');
  }

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

  // Precomputed twiddles: avoids the drift of an iterative recurrence.
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, tw = 0; k < half; k++, tw += step) {
        const wr = cos[tw];
        const wi = sin[tw];
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + half] * wr - im[i + k + half] * wi;
        const vi = re[i + k + half] * wi + im[i + k + half] * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
      }
    }
  }
}

/**
 * Average magnitude spectrum of a buffer, reduced to the matching bands.
 *
 * @param {{sampleRate:number,length:number,numberOfChannels:number,getChannelData:(i:number)=>Float32Array}} buffer
 * @param {object} [options]
 * @param {number} [options.fftSize=8192]
 * @param {number} [options.maxFrames=24]
 * @returns {number[]|null} per-band level in dB, or null if the input is too short
 */
export function spectrumFingerprint(buffer, options = {}) {
  const { fftSize: N = 8192, maxFrames = 24 } = options;
  const sr = buffer.sampleRate;
  const n = buffer.length;
  if (n < N) return null;

  // Hoisted once — this was previously re-fetched for every sample.
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const chCount = channels.length;

  // Periodic Hann.
  const window = new Float64Array(N);
  for (let i = 0; i < N; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  const frames = Math.min(maxFrames, Math.max(1, Math.floor(n / N)));
  const hop = frames > 1 ? Math.floor((n - N) / (frames - 1)) : 0;

  const mag = new Float64Array(N / 2);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let used = 0;

  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    if (off + N > n) break;
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let c = 0; c < chCount; c++) s += channels[c][off + i];
      re[i] = (s / chCount) * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) mag[k] += re[k] * re[k] + im[k] * im[k];
    used++;
  }
  if (!used) return null;

  // Average power in a +/- half-octave window around each band centre.
  return MATCH_FREQS.map((fc) => {
    const k0 = Math.max(1, Math.floor(((fc / Math.SQRT2) * N) / sr));
    const k1 = Math.min(N / 2 - 1, Math.ceil(((fc * Math.SQRT2) * N) / sr));
    let energy = 0;
    let count = 0;
    for (let k = k0; k <= k1; k++) {
      energy += mag[k];
      count++;
    }
    return 10 * Math.log10(energy / Math.max(1, count) / used + 1e-12);
  });
}

/**
 * Derive a matching EQ curve from two fingerprints.
 *
 * The mean difference is removed so the curve only changes tonal balance and
 * never overall level — otherwise "match this reference" would double as an
 * uncontrolled gain change.
 *
 * @param {number[]} source fingerprint of the track being mastered
 * @param {number[]} reference fingerprint of the reference track
 * @param {number} [limitDb]
 * @returns {number[]} per-band gain in dB, rounded to 0.1 dB
 */
export function matchCurve(source, reference, limitDb = MAX_MATCH_DB) {
  if (!source || !reference || source.length !== reference.length) return null;
  const diff = reference.map((r, i) => r - source[i]);
  const mean = diff.reduce((a, b) => a + b, 0) / diff.length;
  return diff.map((d) => {
    const centred = Math.max(-limitDb, Math.min(limitDb, d - mean));
    return Math.round(centred * 10) / 10;
  });
}
