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
 *  · `shaped` — TPDF plus a **second-order error-feedback noise shaper**. The error from
 *               the previous two samples is fed back through `H(z) = 2z⁻¹ − z⁻²`, which
 *               pushes noise energy out of the ear's most sensitive region and up toward
 *               Nyquist. Total noise *power* rises; perceived noise falls.
 *
 * ── Honesty about `shaped` ───────────────────────────────────────────────────────────
 * This is a plain second-order error-feedback shaper. It is **not** a psychoacoustically
 * optimised curve — not POW-R, not UV22, not the Lipshitz/Vanderkooy E-weighted
 * minimum-audibility filter. It gives roughly 6–8 dB of perceived improvement over flat
 * TPDF, not the ~15 dB a high-order optimised curve achieves. The UI labels it
 * "2nd-order noise shaping", never "psychoacoustic".
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
    label: 'TPDF + 2nd-order shaping',
    description: 'TPDF with error feedback that moves noise toward Nyquist.',
  },
});

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
 */
export function createDitherer(mode, lsb, seed) {
  if (mode === 'none' || lsb <= 0) {
    return {
      /** @param {number} x @returns {number} */
      process: (x) => x,
      mode: 'none',
    };
  }

  const rng = mulberry32(seed >>> 0);
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
  for (let c = 0; c < data.channels.length; c++) {
    const d = createDitherer(mode, lsb, deriveSeed(seed, `dither:${c}`));
    const ch = data.channels[c];
    for (let i = 0; i < ch.length; i++) ch[i] = d.process(ch[i]);
  }
  return { applied: true, mode };
}
