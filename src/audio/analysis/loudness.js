/**
 * Loudness measurement following ITU-R BS.1770-4 and EBU R 128 / Tech 3341 / Tech 3342.
 *
 * ── What is implemented ──────────────────────────────────────────────────────────────
 *  · K-weighting: the two-stage filter of BS.1770-4 Table 1/2, designed by bilinear
 *    transform at the source sample rate (see `designKWeighting`).
 *  · Mean-square per 400 ms block with 75 % overlap (Tech 3341 §2.1).
 *  · Channel weighting G: 1.0 for L/R/C, 0 for LFE, 1.41 for surrounds (BS.1770-4 §3).
 *  · Two-stage gating: absolute −70 LUFS, then relative at −10 LU below the
 *    absolute-gated mean (BS.1770-4 §5.3).
 *  · Momentary (400 ms) and short-term (3 s) loudness time series (Tech 3341 §3).
 *  · Loudness range from the short-term series, absolute gate −70 LUFS, relative gate
 *    −20 LU, 10th–95th percentile (Tech 3342 §2).
 *
 * ── What is NOT implemented, and why it matters ──────────────────────────────────────
 *  · This is **not a certified broadcast meter**. It has not been validated against the
 *    EBU Tech 3341 compliance material, and this project makes no compliance claim.
 *    See `docs/LOUDNESS-ANALYSIS.md` for the exact set of tests that are run.
 *  · The K-weighting is *designed* at the source rate rather than *resampled to 48 kHz*.
 *    BS.1770-4 tabulates coefficients at 48 kHz only and is silent on other rates; the
 *    universal practice (ffmpeg's `ebur128`, libebur128, pyloudnorm) is bilinear design at
 *    the working rate, which is what is done here. At 48 kHz the coefficients produced by
 *    `designKWeighting` reproduce the tabulated values to ~1e-6 — this is asserted by
 *    `tests/dsp/loudness.test.js`.
 *  · Gating uses the strict inequality `l > threshold` as specified. Blocks exactly at the
 *    threshold are excluded.
 */

import { clamp, percentileSorted } from '../dsp/math.js';
import { processBiquadCascade } from '../dsp/biquad.js';

/** The −0.691 dB offset in BS.1770 that aligns LKFS with the 0 LU reference. */
const LUFS_OFFSET = -0.691;
/** Absolute gate, LUFS (BS.1770-4 §5.3, Tech 3342 §2). */
export const ABSOLUTE_GATE_LUFS = -70;
/** Relative gate below the absolute-gated loudness — integrated (LU). */
export const RELATIVE_GATE_LU = -10;
/** Relative gate below the absolute-gated loudness — loudness range (LU). */
export const LRA_RELATIVE_GATE_LU = -20;

/**
 * Per-channel weighting coefficients G from BS.1770-4 §3.
 * Index by the channel role, not by channel number.
 */
export const CHANNEL_WEIGHTS = Object.freeze({
  L: 1.0,
  R: 1.0,
  C: 1.0,
  LFE: 0.0,
  Ls: 1.41,
  Rs: 1.41,
  Lss: 1.41,
  Rss: 1.41,
  Lrs: 1.41,
  Rrs: 1.41,
  Lw: 1.0,
  Rw: 1.0,
  // BS.1770-4 does not define weights for height channels. BS.2051-derived practice and
  // the ITU-R BS.1770-4 Annex 5 guidance is to weight them at 1.0; that is what is used
  // here and it is an assumption, not a specification.
  Ltf: 1.0,
  Rtf: 1.0,
  Ltm: 1.0,
  Rtm: 1.0,
  Ltr: 1.0,
  Rtr: 1.0,
});

/**
 * Design the two K-weighting stages at an arbitrary sample rate.
 *
 * BS.1770-4 tabulates coefficients at 48 kHz only. These filter *parameters* are the ones
 * that reproduce the tabulated values exactly under the bilinear transform, and they are
 * the same parameters used by libebur128 — the de-facto reference implementation — so
 * that this meter agrees with `ffmpeg -filter:a ebur128` and `loudness-scanner`.
 *
 * Two details matter and are easy to get wrong:
 *
 *  1. The stage-1 shelf is *not* an RBJ high-shelf. RBJ parameterises shelf gain as
 *     `A = 10^(G/40)`; BS.1770's shelf uses `Vh = 10^(G/20)` with a mid-band term
 *     `Vb = Vh^0.4996667741545416`. Designing it as an RBJ shelf gets every coefficient
 *     wrong in the third decimal place.
 *  2. The stage-2 RLB high-pass has numerator `[1, −2, 1]` **not normalised for unity
 *     high-frequency gain** — the tabulated filter has +0.0433 dB of pass-band gain. That
 *     gain is baked into the −0.691 dB offset, so "fixing" it biases every reading low.
 *
 * `tests/dsp/loudness.test.js` asserts both stages against BS.1770-4 Tables 1 and 2.
 *
 * @param {number} sampleRate
 * @returns {import('../dsp/biquad.js').BiquadCoeffs[]}
 */
export function designKWeighting(sampleRate) {
  // ── Stage 1: high-frequency shelving filter (BS.1770-4 Table 1) ──
  const f0s = 1681.974450955533;
  const G = 3.999843853973347;
  const Qs = 0.7071752369554196;
  const Ks = Math.tan((Math.PI * f0s) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0s = 1 + Ks / Qs + Ks * Ks;
  const stage1 = {
    b0: (Vh + (Vb * Ks) / Qs + Ks * Ks) / a0s,
    b1: (2 * (Ks * Ks - Vh)) / a0s,
    b2: (Vh - (Vb * Ks) / Qs + Ks * Ks) / a0s,
    a1: (2 * (Ks * Ks - 1)) / a0s,
    a2: (1 - Ks / Qs + Ks * Ks) / a0s,
  };

  // ── Stage 2: RLB high-pass filter (BS.1770-4 Table 2) ──
  const f0h = 38.13547087602444;
  const Qh = 0.5003270373238773;
  const Kh = Math.tan((Math.PI * f0h) / sampleRate);
  const a0h = 1 + Kh / Qh + Kh * Kh;
  const stage2 = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (Kh * Kh - 1)) / a0h,
    a2: (1 - Kh / Qh + Kh * Kh) / a0h,
  };

  return [stage1, stage2];
}

/**
 * Apply K-weighting to a copy of `channel`.
 * @param {Float32Array} channel
 * @param {number} sampleRate
 * @returns {Float32Array} new array; input untouched
 */
export function kWeight(channel, sampleRate) {
  const out = Float32Array.from(channel);
  return processBiquadCascade(out, designKWeighting(sampleRate));
}

/**
 * Compute the gated-block loudness series for a given block length.
 *
 * @param {import('./audio-data.js').AudioData} data
 * @param {number} blockSeconds  0.4 for momentary/integrated, 3.0 for short-term
 * @param {number} overlap       fraction of the block advanced per step (0.25 = 75 % overlap)
 * @param {number[]} [weights]   per-channel G; defaults to stereo-safe 1.0
 * @returns {{loudness: Float64Array, hopSamples: number, blockSamples: number}}
 */
export function blockLoudness(data, blockSeconds, overlap, weights) {
  const sr = data.sampleRate;
  const blockSamples = Math.max(1, Math.round(blockSeconds * sr));
  const hopSamples = Math.max(1, Math.round(blockSamples * overlap));
  const nCh = data.channels.length;
  const g = weights && weights.length === nCh ? weights : new Array(nCh).fill(1);

  // K-weight every channel once, up front. This is the dominant cost of the whole meter.
  const weighted = data.channels.map((ch) => kWeight(ch, sr));

  if (data.length < blockSamples) {
    return { loudness: new Float64Array(0), hopSamples, blockSamples };
  }

  const nBlocks = Math.floor((data.length - blockSamples) / hopSamples) + 1;
  const out = new Float64Array(nBlocks);

  for (let b = 0; b < nBlocks; b++) {
    const start = b * hopSamples;
    let z = 0;
    for (let c = 0; c < nCh; c++) {
      if (g[c] === 0) continue;
      const w = weighted[c];
      let sum = 0;
      for (let i = 0; i < blockSamples; i++) {
        const v = w[start + i];
        sum += v * v;
      }
      z += g[c] * (sum / blockSamples);
    }
    // 10·log10 because z is a mean *square* (a power), not an amplitude.
    out[b] = LUFS_OFFSET + 10 * Math.log10(Math.max(1e-30, z));
  }

  return { loudness: out, hopSamples, blockSamples };
}

/** Mean of block loudnesses in the linear (power) domain, returned in LUFS. */
function meanLoudness(values) {
  if (!values.length) return -Infinity;
  let sum = 0;
  for (const l of values) sum += Math.pow(10, (l - LUFS_OFFSET) / 10);
  return LUFS_OFFSET + 10 * Math.log10(Math.max(1e-30, sum / values.length));
}

/**
 * Integrated loudness with the BS.1770-4 two-stage gate.
 *
 * @param {Float64Array|number[]} blocks 400 ms block loudnesses in LUFS
 * @returns {{integrated:number, threshold:number, gatedBlocks:number}}
 */
export function gateIntegrated(blocks) {
  const absGated = [];
  for (const l of blocks) if (l > ABSOLUTE_GATE_LUFS) absGated.push(l);
  if (!absGated.length) {
    return { integrated: -Infinity, threshold: ABSOLUTE_GATE_LUFS, gatedBlocks: 0 };
  }
  const threshold = meanLoudness(absGated) + RELATIVE_GATE_LU;
  const relGated = absGated.filter((l) => l > threshold);
  if (!relGated.length) {
    return { integrated: -Infinity, threshold, gatedBlocks: 0 };
  }
  return { integrated: meanLoudness(relGated), threshold, gatedBlocks: relGated.length };
}

/**
 * Loudness range per EBU Tech 3342.
 * @param {Float64Array|number[]} shortTermBlocks 3 s block loudnesses in LUFS
 */
export function loudnessRange(shortTermBlocks) {
  const absGated = [];
  for (const l of shortTermBlocks) if (l > ABSOLUTE_GATE_LUFS) absGated.push(l);
  if (absGated.length < 2) return 0;
  const threshold = meanLoudness(absGated) + LRA_RELATIVE_GATE_LU;
  const gated = absGated.filter((l) => l > threshold).sort((a, b) => a - b);
  if (gated.length < 2) return 0;
  return Math.max(0, percentileSorted(gated, 0.95) - percentileSorted(gated, 0.1));
}

/**
 * @typedef {object} LoudnessResult
 * @property {number} integrated   LUFS, or −Infinity when nothing survived the gate
 * @property {number} lra          LU
 * @property {number} threshold    relative gate actually used, LUFS
 * @property {number} maxMomentary LUFS
 * @property {number} maxShortTerm LUFS
 * @property {Float64Array} momentary   400 ms series, 75 % overlap
 * @property {Float64Array} shortTerm   3 s series, 1 s hop
 * @property {number} momentaryHopSeconds
 * @property {number} shortTermHopSeconds
 * @property {boolean} tooShort    true when the programme is under 400 ms
 * @property {boolean} silent      true when nothing exceeded the absolute gate
 */

/**
 * Full loudness analysis of a buffer.
 *
 * @param {import('./audio-data.js').AudioData} data
 * @param {object} [opts]
 * @param {number[]} [opts.weights] per-channel BS.1770 G coefficients
 * @returns {LoudnessResult}
 */
export function analyseLoudness(data, opts = {}) {
  const empty = {
    integrated: -Infinity,
    lra: 0,
    threshold: ABSOLUTE_GATE_LUFS,
    maxMomentary: -Infinity,
    maxShortTerm: -Infinity,
    momentary: new Float64Array(0),
    shortTerm: new Float64Array(0),
    momentaryHopSeconds: 0.1,
    shortTermHopSeconds: 1,
    tooShort: true,
    silent: true,
  };

  if (!data || !data.channels.length || data.length === 0) return empty;

  const sr = data.sampleRate;
  // BS.1770 is undefined for programmes shorter than one 400 ms block.
  if (data.length < 0.4 * sr) return empty;

  const mom = blockLoudness(data, 0.4, 0.25, opts.weights);
  const { integrated, threshold, gatedBlocks } = gateIntegrated(mom.loudness);

  // Tech 3342: 3 s window, 1 s hop (i.e. overlap fraction 1/3).
  const st =
    data.length >= 3 * sr
      ? blockLoudness(data, 3, 1 / 3, opts.weights)
      : { loudness: new Float64Array(0), hopSamples: sr, blockSamples: 3 * sr };

  let maxMom = -Infinity;
  for (const l of mom.loudness) if (l > maxMom) maxMom = l;
  let maxSt = -Infinity;
  for (const l of st.loudness) if (l > maxSt) maxSt = l;

  return {
    integrated,
    lra: loudnessRange(st.loudness),
    threshold,
    maxMomentary: maxMom,
    maxShortTerm: maxSt,
    momentary: mom.loudness,
    shortTerm: st.loudness,
    momentaryHopSeconds: mom.hopSamples / sr,
    shortTermHopSeconds: st.hopSamples / sr,
    tooShort: false,
    silent: gatedBlocks === 0,
  };
}

/**
 * Gain in dB required to move `measured` to `target`, bounded so that a silent or
 * pathological measurement can never produce an enormous gain.
 *
 * @param {number} measuredLufs
 * @param {number} targetLufs
 * @param {number} [maxAbsDb] safety bound
 */
export function normalizationGainDb(measuredLufs, targetLufs, maxAbsDb = 40) {
  if (!Number.isFinite(measuredLufs)) return 0;
  return clamp(targetLufs - measuredLufs, -maxAbsDb, maxAbsDb);
}
