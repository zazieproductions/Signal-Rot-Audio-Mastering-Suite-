/**
 * Deterministic, band-limited sample-rate conversion (windowed-sinc polyphase).
 *
 * This is the **only** deliberate conversion in the export pipeline (§2.8): the
 * mastering chain now always renders at the source's native rate and any requested
 * delivery-rate change is applied here, after the chain and before normalisation, so
 * the true-peak ceiling is measured and enforced on the final, converted samples.
 *
 * ── Design ───────────────────────────────────────────────────────────────────────────
 *  · Kaiser-windowed sinc, `RESAMPLE_TAPS` taps per output sample, evaluated from a
 *    precomputed phase table with linear interpolation between phases. Deterministic:
 *    identical input yields bit-identical output.
 *  · Cut-off is `0.5 × min(fsIn, fsOut)` so downsampling removes everything above the
 *    destination Nyquist (no alias content of consequence) and upsampling passes the
 *    full input band. Like any linear resampler it cannot remove the mathematical
 *    image skirt that touches `fsIn / 2` when upsampling; real masters have negligible
 *    energy within ~1 kHz of Nyquist (the mastering chain itself rolls off there), and
 *    the limitation is documented in `docs/LIMITATIONS.md`.
 *  · The kernel is renormalised per phase so DC (and therefore loudness) is preserved
 *    exactly; total group delay is `(TAPS-1) / 2` input samples and is identical for
 *    every channel, so image coherence across the stereo field is untouched.
 */

import { createAudioData } from './audio-data.js';

/**
 * Minimum taps of the interpolation kernel (per output sample). The kernel must stay
 * a fixed *length in time*, not a fixed tap count: a windowed-sinc's transition width
 * is set by its duration, so downsampling from high input rates needs proportionally
 * more taps to keep the same passband/stopband behaviour (`resampleTapCount`).
 */
export const RESAMPLE_TAPS = 96;
/** Phase-table resolution (linear interpolation between phases). */
export const RESAMPLE_PHASES = 1024;
/**
 * Kaiser window parameter. At 96 taps / ~1 ms of kernel this gives ≈ 0 dB passband
 * error below 0.85 × min(fsIn, fsOut), a transition of ≈ 1 kHz at 44.1 kHz, and
 * ≥ −60 dB suppression ~1.25 × cut-off and beyond (measured, not assumed).
 */
export const RESAMPLE_BETA = 12.5;
/** Kernel duration target for downsampling (seconds of input audio). */
const RESAMPLE_SPAN_S = 0.0012;
/** Absolute tap ceiling — beyond ~2.5 ms of kernel there is no audible gain. */
const RESAMPLE_MAX_TAPS = 512;

/**
 * Tap count for a conversion: downsampling extends the kernel in time so the filter
 * transition does not widen as the input rate rises (192 → 44.1 kHz needs the same
 * selectivity as 48 → 44.1 kHz).
 */
export function resampleTapCount(fromRate, toRate) {
  if (toRate >= fromRate) return RESAMPLE_TAPS;
  const t = Math.min(RESAMPLE_MAX_TAPS, Math.max(RESAMPLE_TAPS, Math.ceil(fromRate * RESAMPLE_SPAN_S)));
  return t % 2 === 0 ? t : t + 1; // even taps keep the kernel window symmetric
}

/** Modified Bessel function of the first kind, order 0 (series, converged). */
function besselI0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 64; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-15 * sum) break;
  }
  return sum;
}

/**
 * Build the polyphase kernel table for a conversion.
 *
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {{ table: Float64Array, phases: number, taps: number }}
 *   `table[p * taps + k]` = kernel coefficient k for phase p (phase 0 … phases-1
 *   maps linearly onto a fractional input-sample offset of 0 … 1).
 */
export function buildResampleTable(fromRate, toRate) {
  const taps = resampleTapCount(fromRate, toRate);
  const phases = RESAMPLE_PHASES;
  const beta = RESAMPLE_BETA;
  const half = taps / 2; // window half-width (row generation)
  // Absolute cut-off (Hz); expressed relative to the *input* rate for the kernel.
  const cutoff = 0.5 * Math.min(fromRate, toRate);
  const cutoffRatio = cutoff / fromRate; // ≤ 0.5
  const table = new Float64Array(phases * taps);
  const i0 = besselI0(beta);
  for (let p = 0; p < phases; p++) {
    const frac = p / phases; // fractional input-sample offset of the output position
    let sum = 0;
    const row = p * taps;
    for (let k = 0; k < taps; k++) {
      // Kernel argument: input-sample index `k - half + 1` measured from the output
      // position `-frac`, i.e. x = k - half + 1 + frac.
      const x = k - half + 1 + frac;
      const windowArg = x / half;
      const w =
        Math.abs(windowArg) < 1
          ? besselI0(beta * Math.sqrt(Math.max(0, 1 - windowArg * windowArg))) / i0
          : 0;
      const sx = 2 * cutoffRatio * x;
      const sinc = sx === 0 ? 1 : Math.sin(Math.PI * sx) / (Math.PI * sx);
      const v = 2 * cutoffRatio * sinc * w;
      table[row + k] = v;
      sum += v;
    }
    // Exact DC normalisation per phase (loudness preservation).
    const inv = 1 / sum;
    for (let k = 0; k < taps; k++) table[row + k] *= inv;
  }
  return { table, phases, taps };
}

/**
 * Convert one AudioData object to `toRate`.
 *
 * @param {import('./audio-data.js').AudioData} data
 * @param {number} toRate
 * @param {object} [opts]
 * @param {(fraction: number) => void} [opts.onProgress] 0..1
 * @returns {import('./audio-data.js').AudioData} a *new* AudioData at `toRate`
 */
export function resampleData(data, toRate, opts = {}) {
  const fromRate = data.sampleRate;
  if (toRate === fromRate) {
    const out = createAudioData(data.channels.length, data.length, toRate);
    for (let c = 0; c < data.channels.length; c++) out.channels[c].set(data.channels[c]);
    return out;
  }
  if (!(toRate > 0)) throw new Error(`resampleData: invalid target rate ${toRate}`);
  if (toRate > 384000) {
    throw new Error(`resampleData: refusing ${toRate} Hz — outside the supported range`);
  }

  const { table, phases, taps } = buildResampleTable(fromRate, toRate);
  const ratio = fromRate / toRate; // input samples per output sample
  const nIn = data.length;
  const nOut = Math.max(1, Math.round(nIn * (toRate / fromRate)));
  const out = createAudioData(data.channels.length, nOut, toRate);

  for (let c = 0; c < data.channels.length; c++) {
    const input = data.channels[c];
    const output = out.channels[c];
    for (let i = 0; i < nOut; i++) {
      const p = i * ratio; // fractional input position of output sample i
      const pos = Math.floor(p);
      const frac = p - pos;
      const phaseF = frac * phases;
      const phase = Math.min(phases - 2, Math.floor(phaseF));
      const mix = phaseF - phase;
      const row0 = phase * taps;
      const row1 = row0 + taps;
      const n0 = pos - Math.floor(taps / 2) + 1; // first input sample of the window
      let acc = 0;
      let acc1 = 0;
      for (let k = 0; k < taps; k++) {
        const idx = n0 + k;
        const x = idx >= 0 && idx < nIn ? input[idx] : 0;
        acc += x * table[row0 + k];
        acc1 += x * table[row1 + k];
      }
      output[i] = acc + mix * (acc1 - acc);
    }
    if (opts.onProgress) opts.onProgress((c + 1) / data.channels.length);
  }
  return out;
}
