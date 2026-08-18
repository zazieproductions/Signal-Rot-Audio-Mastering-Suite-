/**
 * Reference matching — a broad tonal-balance assistant.
 *
 * ── What this is ─────────────────────────────────────────────────────────────────────
 * It measures the long-term average spectrum of your track and of a reference master,
 * expresses both as a loudness-independent tonal *shape*, and derives a small number of
 * gentle EQ moves that pull your shape toward the reference's.
 *
 * ── What this is not ─────────────────────────────────────────────────────────────────
 * It cannot reproduce another master. Eight (or even eighty) EQ bands cannot transfer
 * arrangement, performance, dynamics, stereo image, saturation or the specific decisions
 * of the engineer who made the reference. Two tracks with different instrumentation have
 * genuinely different correct tonal balances, and forcing one onto the other makes both
 * worse. The confidence score exists to say so out loud.
 *
 * ── Improvements over the naive version ──────────────────────────────────────────────
 *  1. **Frames spread across the whole track**, not just the first 24·8192 samples.
 *  2. **Silence and near-silence rejected** — a frame below the track's own −30 dB
 *     relative threshold contributes nothing, so intros and fades stop dragging the
 *     average down.
 *  3. **Loudness-independent comparison** — both spectra are normalised to zero mean in
 *     the log domain before differencing, so a louder reference does not become a
 *     broadband boost.
 *  4. **Correction smoothing across bands**, so the curve is a tonal tilt rather than a
 *     comb of independent bumps.
 *  5. **Boundary handling** — corrections are tapered to zero below `lowLimit` and above
 *     `highLimit`, because the bottom two octaves and the top octave are where two
 *     different masters legitimately differ most and where EQ does the most damage.
 *  6. **Confidence score** from spectral similarity and duration ratio.
 *  7. **Three modes** — broad / balanced / precise — trading correction detail against
 *     the risk of chasing arrangement differences.
 */

import { MATCH_FREQS } from '../../app/constants.js';
import { clamp } from '../dsp/math.js';
import { fftRadix2, hannWindow } from './fft.js';

/** @typedef {'broad'|'balanced'|'precise'} MatchMode */

/**
 * Mode presets. `smoothing` is the neighbour-averaging weight applied across bands;
 * `maxDb` bounds a single band's correction.
 */
export const MATCH_MODES = Object.freeze({
  broad: { smoothing: 0.55, maxDb: 3, label: 'Broad — tilt only' },
  balanced: { smoothing: 0.3, maxDb: 5, label: 'Balanced' },
  precise: { smoothing: 0.12, maxDb: 8, label: 'Precise — follows detail' },
});

const FFT_SIZE = 8192;
const MAX_FRAMES = 96;

/**
 * @typedef {object} Fingerprint
 * @property {number[]} bandsDb     level per MATCH_FREQS band, dB, mean-removed
 * @property {number} framesUsed
 * @property {number} framesRejected
 * @property {number} sampleRate
 * @property {number} durationSeconds
 */

/**
 * Long-term average spectrum of a buffer, reduced to the mastering bands.
 *
 * Frames are taken at even intervals across the entire programme. Each frame is
 * mono-summed (tonal balance is a mono property; stereo width is handled elsewhere),
 * Hann-windowed and transformed. Frames whose broadband energy sits more than 30 dB below
 * the loudest frame are discarded as silence or fade.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data
 * @returns {Fingerprint|null} null when the programme is shorter than one frame
 */
export function spectralFingerprint(data) {
  const { sampleRate: sr, length: n, channels } = data;
  if (n < FFT_SIZE) return null;

  const hann = hannWindow(FFT_SIZE);
  const nCh = channels.length;

  // Spread frames evenly over the whole file, capped so a 20-minute file is not slower
  // than a 3-minute one.
  const maxStart = n - FFT_SIZE;
  const frameCount = Math.min(MAX_FRAMES, Math.max(4, Math.floor(n / FFT_SIZE)));
  const step = frameCount > 1 ? maxStart / (frameCount - 1) : 0;

  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  /** @type {Float64Array[]} */
  const framePower = [];
  const frameEnergy = [];

  for (let f = 0; f < frameCount; f++) {
    const off = Math.round(f * step);
    let energy = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      let s = 0;
      for (let c = 0; c < nCh; c++) s += channels[c][off + i];
      s /= nCh;
      energy += s * s;
      re[i] = s * hann[i];
      im[i] = 0;
    }
    fftRadix2(re, im);
    const mags = new Float64Array(FFT_SIZE / 2);
    for (let k = 0; k < FFT_SIZE / 2; k++) mags[k] = re[k] * re[k] + im[k] * im[k];
    framePower.push(mags);
    frameEnergy.push(energy / FFT_SIZE);
  }

  // Silence rejection, relative to the loudest frame in this programme. A programme with
  // no energy at all has no tonal balance to measure, so it fingerprints as null rather
  // than as an arbitrary shape derived from denormals.
  const loudest = Math.max(...frameEnergy);
  if (!(loudest > 1e-16)) return null;
  const threshold = loudest * Math.pow(10, -30 / 10);
  const accum = new Float64Array(FFT_SIZE / 2);
  let used = 0;
  for (let f = 0; f < framePower.length; f++) {
    if (frameEnergy[f] < threshold) continue;
    const m = framePower[f];
    for (let k = 0; k < accum.length; k++) accum[k] += m[k];
    used++;
  }
  if (used === 0) return null;

  // Reduce to bands. Each band is a ±½-octave window around its centre, which gives
  // roughly constant-Q resolution and matches how the corrective filters are shaped.
  const bandsDb = MATCH_FREQS.map((fc) => {
    const k0 = Math.max(1, Math.floor(((fc / Math.SQRT2) * FFT_SIZE) / sr));
    const k1 = Math.min(accum.length - 1, Math.ceil((fc * Math.SQRT2 * FFT_SIZE) / sr));
    if (k1 < k0) return -120;
    let e = 0;
    for (let k = k0; k <= k1; k++) e += accum[k];
    return 10 * Math.log10(e / (k1 - k0 + 1) / used + 1e-20);
  });

  // Remove the mean: what remains is *shape*, independent of level.
  const mean = bandsDb.reduce((a, b) => a + b, 0) / bandsDb.length;

  return {
    bandsDb: bandsDb.map((d) => d - mean),
    framesUsed: used,
    framesRejected: framePower.length - used,
    sampleRate: sr,
    durationSeconds: n / sr,
  };
}

/**
 * @typedef {object} MatchResult
 * @property {number[]} gainsDb        per-band correction, same order as MATCH_FREQS
 * @property {number[]} sourceShapeDb
 * @property {number[]} referenceShapeDb
 * @property {number} confidence       0..1
 * @property {string[]} warnings
 * @property {MatchMode} mode
 */

/**
 * Derive a correction curve from two fingerprints.
 *
 * @param {Fingerprint} source
 * @param {Fingerprint} reference
 * @param {object} [opts]
 * @param {MatchMode} [opts.mode]
 * @param {number} [opts.lowLimitHz]  below this, corrections taper to zero
 * @param {number} [opts.highLimitHz] above this, corrections taper to zero
 * @returns {MatchResult}
 */
export function computeMatchCurve(source, reference, opts = {}) {
  const mode = opts.mode && MATCH_MODES[opts.mode] ? opts.mode : 'balanced';
  const cfg = MATCH_MODES[mode];
  const lowLimit = opts.lowLimitHz ?? 40;
  const highLimit = opts.highLimitHz ?? 14000;
  const warnings = [];

  // Raw difference of two mean-removed shapes → already loudness independent.
  let diff = reference.bandsDb.map((r, i) => r - source.bandsDb[i]);

  // Remove any residual net tilt bias so the curve never changes overall level.
  const mean = diff.reduce((a, b) => a + b, 0) / diff.length;
  diff = diff.map((d) => d - mean);

  // Smooth across bands: a weighted 3-point average. This is what turns a jagged
  // band-by-band difference into something an engineer would actually dial in.
  const s = cfg.smoothing;
  const smoothed = diff.map((d, i) => {
    const prev = i > 0 ? diff[i - 1] : d;
    const next = i < diff.length - 1 ? diff[i + 1] : d;
    return d * (1 - s) + (prev + next) * (s / 2);
  });

  // Frequency-boundary taper. Below `lowLimit` and above `highLimit` the correction is
  // scaled down: those regions are where arrangement differences dominate and where a
  // wrong move is most audible.
  const tapered = smoothed.map((d, i) => {
    const f = MATCH_FREQS[i];
    let taper = 1;
    if (f < lowLimit * 2) taper *= clamp((f - lowLimit) / lowLimit, 0, 1);
    if (f > highLimit / 2) taper *= clamp((highLimit - f) / (highLimit / 2), 0, 1);
    return d * taper;
  });

  // Tapering is asymmetric, so it can reintroduce net gain. Remove the mean again *after*
  // tapering, then clamp. (Clamping can leave a small residual; it is bounded by maxDb
  // and asserted under 1.5 dB in the tests.)
  const taperedMean = tapered.reduce((a, b) => a + b, 0) / tapered.length;
  const gainsDb = tapered.map(
    (d) => Math.round(clamp(d - taperedMean, -cfg.maxDb, cfg.maxDb) * 10) / 10,
  );

  // ── Confidence ────────────────────────────────────────────────────────────────────
  // Spectral similarity: RMS band difference mapped through a soft curve. 0 dB RMS
  // difference → 1.0; 12 dB RMS difference → ~0.
  const rmsDiff = Math.sqrt(diff.reduce((a, d) => a + d * d, 0) / diff.length);
  let confidence = clamp(1 - rmsDiff / 12, 0, 1);

  // Duration mismatch: a 30-second loop is a poor reference for a 6-minute piece.
  const ratio =
    Math.min(source.durationSeconds, reference.durationSeconds) /
    Math.max(source.durationSeconds, reference.durationSeconds);
  if (ratio < 0.35) {
    confidence *= 0.6;
    warnings.push(
      `Durations differ by more than 3× (${source.durationSeconds.toFixed(0)} s vs ` +
        `${reference.durationSeconds.toFixed(0)} s). The reference may not represent a full arrangement.`,
    );
  }

  if (reference.framesUsed < 8) {
    confidence *= 0.7;
    warnings.push(`Only ${reference.framesUsed} usable frames in the reference.`);
  }
  if (rmsDiff > 8) {
    warnings.push(
      `Source and reference differ by ${rmsDiff.toFixed(1)} dB RMS across the band set — ` +
        'these are tonally very different pieces. Treat the curve as a suggestion, not a target.',
    );
  }
  if (source.sampleRate !== reference.sampleRate) {
    warnings.push(
      `Sample rates differ (${source.sampleRate} vs ${reference.sampleRate} Hz). ` +
        'Band energies are still comparable, but top-octave content may not be.',
    );
  }

  return {
    gainsDb,
    sourceShapeDb: source.bandsDb.slice(),
    referenceShapeDb: reference.bandsDb.slice(),
    confidence: Math.round(confidence * 100) / 100,
    warnings,
    mode,
  };
}
