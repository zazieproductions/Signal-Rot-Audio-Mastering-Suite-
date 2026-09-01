/**
 * Dither for fixed-point export.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────────────
 * Rounding a 32-bit float master to 16-bit integers produces a rounding error that is
 * *correlated with the signal*. On a reverb tail or a fade the error becomes a
 * signal-dependent distortion — the "gritty tail" that gives cheap CD masters away.
 * Adding a small, correctly-shaped random signal before rounding decorrelates the error,
 * turning distortion into a steady, benign noise floor. That is the whole trick.
 *
 * ── What is implemented ──────────────────────────────────────────────────────────────
 *  · `none`   — plain rounding. Correct for 32-bit float, where the quantiser step is
 *               already far below any dither we could add.
 *  · `tpdf`   — triangular probability density function, ±1 LSB, generated as the sum of
 *               two independent uniform variates. TPDF is the standard choice: it fully
 *               eliminates both the first and second moments of the quantisation error's
 *               dependence on the signal, at the cost of 4.77 dB of noise-floor rise over
 *               undithered (1.76 dB over RPDF).
 *  · `shaped` — TPDF plus **psychoacoustically weighted error-feedback noise shaping**.
 *               At 44.1 and 48 kHz the feedback filter is the 9-coefficient F-weighted
 *               minimum-audibility design published by Lipshitz, Vanderkooy and
 *               Wannamaker (*Minimally Audible Noise Shaping*, JAES 39(11), 1991). Its
 *               noise transfer function tracks the inverse of the ear's threshold curve:
 *               error energy is pushed out of the 1–6 kHz sensitivity trough and parked
 *               above 15 kHz, for roughly 15 dB of perceived noise reduction relative to
 *               flat TPDF. At other sample rates — where those coefficients are not
 *               valid — the shaper falls back to a plain second-order
 *               `H(z) = 2z⁻¹ − z⁻²`, which pushes noise toward Nyquist without making
 *               psychoacoustic claims it cannot keep.
 *
 * ── Honesty about `shaped` ───────────────────────────────────────────────────────────
 * The F-weighted curve is a published minimum-audibility design and the UI may call it
 * psychoacoustic *at 44.1/48 kHz only* — the coefficients are rate-specific. It is not
 * POW-R and not UV22; no such claim is made. The fallback at other rates is labelled for
 * what it is: 2nd-order shaping. `report.json` records which shaper actually ran.
 *
 * ── Never dither 32-bit float ────────────────────────────────────────────────────────
 * `applyDither` refuses. A 32-bit float has ~144 dB of dynamic range with a *relative*
 * quantiser step; adding absolute-scaled noise would only degrade it.
 */

import { mulberry32, deriveSeed } from '../dsp/prng.js';

/** @typedef {'none'|'tpdf'|'shaped'} DitherMode */

export const DITHER_MODES = Object.freeze({
  none: { label: 'None', description: 'Plain rounding. Correct for 32-bit float.' },
  tpdf: {
    label: 'TPDF',
    description: '±1 LSB triangular dither. The safe default for 16-bit delivery.',
  },
  shaped: {
    label: 'TPDF + weighted shaping',
    description:
      'TPDF with F-weighted 9th-order minimum-audibility noise shaping ' +
      '(Lipshitz–Vanderkooy–Wannamaker) at 44.1/48 kHz; 2nd-order shaping elsewhere.',
  },
});

/**
 * F-weighted minimum-audibility error-feedback coefficients for 44.1 kHz, from
 * Lipshitz, Vanderkooy & Wannamaker (JAES 39(11), 1991), applied as
 * `v[n] = x[n] − Σ hₖ·e[n−k]`. Also used at 48 kHz, where the weighting curve shifts by
 * under a tenth of an octave — well inside the design's tolerance. Not used at any other
 * rate.
 */
export const FWEIGHTED_9 = Object.freeze([
  2.412, -3.37, 3.937, -4.174, 3.353, -2.205, 1.281, -0.569, 0.0847,
]);

/** Sample-rate window in which the F-weighted coefficients are valid. */
const fWeightingApplies = (sampleRate) => sampleRate >= 43000 && sampleRate <= 50000;

/**
 * Create a dither generator for one channel.
 *
 * Returns a function `(sample, quantisedPrevError) => ditheredSample` — but the stateful
 * shaping means the generator owns its own history, so the returned function must be
 * called once per sample in order.
 *
 * @param {DitherMode} mode
 * @param {number} lsb    quantiser step in normalised units (e.g. 1/32768 for 16-bit)
 * @param {number} seed
 * @param {number} [sampleRate] selects the shaping filter; defaults to 48 kHz
 */
export function createDitherer(mode, lsb, seed, sampleRate = 48000) {
  if (mode === 'none' || lsb <= 0) {
    return {
      /** @param {number} x @returns {number} */
      process: (x) => x,
      mode: 'none',
    };
  }

  const rng = mulberry32(seed >>> 0);

  if (mode === 'shaped' && fWeightingApplies(sampleRate)) {
    // F-weighted 9th-order error feedback: v[n] = x[n] − Σ hₖ·e[n−k]. The error history
    // is a small ring buffer; the fed-back error is the *quantisation* error only,
    // excluding the dither we deliberately added, so the shaper never fights its own
    // dither.
    const h = FWEIGHTED_9;
    const order = h.length;
    const e = new Float64Array(order); // e[0] newest
    return {
      process(x) {
        let fb = 0;
        for (let k = 0; k < order; k++) fb += h[k] * e[k];
        const shaped = x - fb;
        const d = (rng() + rng() - 1) * lsb; // TPDF, ±1 LSB
        const dithered = shaped + d;
        const q = Math.round(dithered / lsb) * lsb;
        for (let k = order - 1; k > 0; k--) e[k] = e[k - 1];
        e[0] = q - shaped;
        return dithered;
      },
      mode: 'shaped',
      shaper: 'f-weighted-9',
    };
  }

  let e1 = 0;
  let e2 = 0;

  if (mode === 'shaped') {
    return {
      process(x) {
        // Error feedback. With v[n] = x[n] − Σ hₖ·e[n−k] and e[n] = y[n] − v[n], the
        // output is Y = X + E·(1 − H(z)). To get the noise transfer function
        // (1 − z⁻¹)² = 1 − 2z⁻¹ + z⁻², which pushes error energy toward Nyquist, the
        // feedback filter must be H(z) = 2z⁻¹ − z⁻² and it must be **subtracted**.
        const shaped = x - 2 * e1 + e2;
        const d = (rng() + rng() - 1) * lsb; // TPDF, ±1 LSB
        const dithered = shaped + d;
        const q = Math.round(dithered / lsb) * lsb;
        // The error we feed back is the *quantisation* error, excluding the dither we
        // deliberately added; otherwise the shaper fights its own dither.
        e2 = e1;
        e1 = q - shaped;
        return dithered;
      },
      mode: 'shaped',
      shaper: 'second-order',
    };
  }

  return {
    process(x) {
      return x + (rng() + rng() - 1) * lsb;
    },
    mode: 'tpdf',
  };
}

/**
 * Quantiser step for a bit depth, in normalised full-scale units.
 * 16-bit → 1/32768, 24-bit → 1/8388608.
 */
export const lsbFor = (bitDepth) => (bitDepth >= 32 ? 0 : 1 / Math.pow(2, bitDepth - 1));

/**
 * Apply dither to every channel of an `AudioData`, in place.
 *
 * Each channel gets an independent noise stream derived from the same seed, so the dither
 * is uncorrelated between channels (correlated dither would sit dead-centre in the stereo
 * image) while the export stays fully reproducible.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data
 * @param {DitherMode} mode
 * @param {number} bitDepth 16 | 24 | 32
 * @param {number} seed
 * @returns {{applied:boolean, mode:DitherMode, reason?:string}}
 */
export function applyDither(data, mode, bitDepth, seed) {
  if (bitDepth >= 32) {
    return { applied: false, mode: 'none', reason: 'float output — dither would only add noise' };
  }
  if (mode === 'none') return { applied: false, mode: 'none' };

  const lsb = lsbFor(bitDepth);
  let shaper;
  for (let c = 0; c < data.channels.length; c++) {
    const d = createDitherer(mode, lsb, deriveSeed(seed, `dither:${c}`), data.sampleRate);
    shaper = d.shaper;
    const ch = data.channels[c];
    for (let i = 0; i < ch.length; i++) ch[i] = d.process(ch[i]);
  }
  return shaper ? { applied: true, mode, shaper } : { applied: true, mode };
}
