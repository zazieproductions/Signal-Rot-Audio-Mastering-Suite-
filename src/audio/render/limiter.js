/**
 * Look-ahead true-peak limiter.
 *
 * ── Design ───────────────────────────────────────────────────────────────────────────
 * The limiter is a *gain-computer* + *gain-smoother* + *applier*, in that order, operating
 * on the whole buffer offline. Nothing here can run in real time, and the UI says so.
 *
 *  1. **Detection** — the required gain is computed from an oversampled, band-limited
 *     reconstruction of the signal (`analysis/true-peak.js`), not from the sample values.
 *     Detection is stereo/multichannel *linked*: one gain curve for all channels, so the
 *     stereo image never moves. Optional `lfeChannels` are excluded from *detection* so
 *     that sub content does not duck the rest of the bed, but they are still *gained*.
 *
 *  2. **Look-ahead** — a sliding minimum over the look-ahead window. This makes the
 *     required reduction known before the transient arrives.
 *
 *  3. **Smoothing — the part the previous implementation got wrong.** Taking a sliding
 *     minimum and applying it directly produces a *step* in the gain signal on every
 *     transient. Multiplying audio by a step is multiplying by a rectangular window:
 *     broadband splatter. Here the sliding minimum is convolved with a Hann window of the
 *     same length. Because the minimum was taken over a window at least as wide as the
 *     smoothing kernel, the smoothed curve is guaranteed to be ≤ the required gain at
 *     every sample — the gain reduction is *anticipated*, continuous, and provably
 *     sufficient. This is the classic "smoothed minimum" construction.
 *
 *  4. **Program-dependent release** — after the smoother, an asymmetric one-pole lets the
 *     gain recover with a fast constant immediately after an attack and a slow constant
 *     once reduction has been sustained, which is what stops a dense mix from pumping.
 *     The release stage can only *lower* the gain relative to the smoothed curve, never
 *     raise it, so it cannot reintroduce overs.
 *
 *  5. **Verification** — `limitTruePeak` re-measures the result and, if the ceiling was
 *     still exceeded (possible on pathological material, or because a short FIR cannot
 *     see the true peak of a slowly-converging signal), applies a bounded corrective pass
 *     and reports what happened. Overs are never hidden.
 *
 * ── Oversampled detection vs oversampled processing ──────────────────────────────────
 * This limiter oversamples *detection* only. The gain is applied at the base rate. That
 * means the gain curve itself is band-limited to the base Nyquist, which is exactly what
 * we want (a gain signal with content above Nyquist would alias), but it also means the
 * limiter cannot fix an inter-sample peak that exists *between* two samples whose own
 * values are far below the ceiling — it reduces the surrounding region instead. That is
 * how every non-clipping true-peak limiter works and it is why the safety margin below
 * exists.
 */

import { clamp, dbToGain, gainToDb, smoothstep } from '../dsp/math.js';
import {
  analysePeaks,
  truePeakChannel,
  oversamplingFactorFor,
  buildPolyphaseFilter,
} from '../analysis/true-peak.js';

/**
 * The limiter is the final safety/polish stage, not the sound of the master. Its defaults
 * are tuned for transparency: a wide soft knee so gain reduction begins gradually, a
 * generous look-ahead so transients are anticipated rather than chopped, and a slow,
 * program-dependent release that recovers without pumping. Routine masters should show
 * modest activity here — if reaching the target needs constant heavy limiting, the
 * normalisation loop (`render/normalize.js`) backs the target down instead of crushing.
 *
 * @typedef {object} LimiterOptions
 * @property {number} ceilingDb        target true-peak ceiling, dBTP
 * @property {number} [lookaheadMs]    default 3 ms
 * @property {number} [releaseFastMs]  default 25 ms
 * @property {number} [releaseSlowMs]  default 220 ms
 * @property {number} [kneeDb]         soft-knee width below the ceiling, default 1.5 dB
 * @property {number[]} [lfeChannels]  channel indices excluded from peak detection
 * @property {boolean} [verify]        run the post-render verification pass, default true
 */

/**
 * @typedef {object} LimiterResult
 * @property {number} maxGainReductionDb  most negative gain applied, dB (≤ 0)
 * @property {number} averageGainReductionDb over samples where reduction occurred
 * @property {number} reducedSampleRatio  fraction of samples with any reduction
 * @property {number} achievedTruePeakDb  measured after limiting
 * @property {number} ceilingDb
 * @property {boolean} ceilingRespected
 * @property {number} correctionTrimDb    extra static trim applied by the verify pass
 */

/**
 * Sliding minimum over a centred window of `2·half + 1` samples, computed with the
 * ascending-minima (monotone deque) algorithm in O(n).
 *
 * @param {Float32Array} src
 * @param {number} half
 * @returns {Float32Array}
 */
export function slidingMinimum(src, half) {
  const n = src.length;
  const out = new Float32Array(n);
  if (half <= 0) return (out.set(src), out);

  // Deque of indices with monotonically increasing values.
  const deque = new Int32Array(n);
  let head = 0;
  let tail = 0; // exclusive

  // Prime with the first `half` samples so index 0 sees its full forward window.
  for (let i = 0; i < Math.min(n, half); i++) {
    while (tail > head && src[deque[tail - 1]] >= src[i]) tail--;
    deque[tail++] = i;
  }

  for (let i = 0; i < n; i++) {
    const add = i + half;
    if (add < n) {
      while (tail > head && src[deque[tail - 1]] >= src[add]) tail--;
      deque[tail++] = add;
    }
    const drop = i - half - 1;
    while (tail > head && deque[head] <= drop) head++;
    out[i] = tail > head ? src[deque[head]] : src[i];
  }
  return out;
}

/**
 * Convolve with a normalised Hann kernel of `2·half + 1` samples.
 * Edges use the endpoint value (the gain curve is smooth there by construction).
 */
export function hannSmooth(src, half) {
  const n = src.length;
  if (half <= 0) return Float32Array.from(src);
  const klen = 2 * half + 1;
  const kernel = new Float64Array(klen);
  let sum = 0;
  for (let k = 0; k < klen; k++) {
    kernel[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (klen - 1));
    sum += kernel[k];
  }
  // A Hann window of odd length has zero endpoints; guard against a degenerate sum.
  if (sum <= 0) return Float32Array.from(src);
  for (let k = 0; k < klen; k++) kernel[k] /= sum;

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < klen; k++) {
      const idx = clamp(i + k - half, 0, n - 1);
      acc += kernel[k] * src[idx];
    }
    out[i] = acc;
  }
  return out;
}

/**
 * Compute the per-sample gain curve required to hold `data` under `ceilingDb`.
 *
 * Exposed separately so the gain-reduction meter and the tests can look at it without
 * modifying audio.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data
 * @param {LimiterOptions} opts
 * @returns {Float32Array} gain in [0, 1], one per sample
 */
export function computeLimiterGain(data, opts) {
  const sr = data.sampleRate;
  const n = data.length;
  const ceiling = dbToGain(opts.ceilingDb);
  const kneeDb = opts.kneeDb ?? 1.5;
  const kneeStart = dbToGain(opts.ceilingDb - kneeDb);
  const lfe = new Set(opts.lfeChannels ?? []);
  const factor = oversamplingFactorFor(sr);

  // ── 1. Per-sample oversampled peak envelope, linked across detection channels ──
  // Rather than interpolating the whole file (4× memory), we evaluate the interpolation
  // phases for each sample and keep only the maximum. Same result, no extra allocation.
  const peakEnv = new Float32Array(n);
  for (let c = 0; c < data.channels.length; c++) {
    if (lfe.has(c)) continue;
    const ch = data.channels[c];
    // truePeakChannel gives one number; we need the envelope, so inline the same filter.
    accumulateInterpolatedPeaks(ch, peakEnv, factor);
  }

  // ── 2. Required gain, with a soft knee ──
  const required = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pk = peakEnv[i];
    if (pk <= kneeStart) {
      required[i] = 1;
    } else if (pk >= ceiling) {
      required[i] = ceiling / pk;
    } else {
      // Smoothstep from unity at the knee start to the hard ratio at the ceiling. The
      // knee means gain reduction *starts* before the ceiling, so the limiter is already
      // moving when the transient arrives instead of slamming shut.
      const t = (pk - kneeStart) / (ceiling - kneeStart);
      required[i] = 1 - (1 - ceiling / pk) * smoothstep(t);
    }
  }

  // ── 3. Look-ahead: sliding minimum, then Hann smoothing of the same width ──
  const look = Math.max(1, Math.round(sr * ((opts.lookaheadMs ?? 3) / 1000)));
  const minimum = slidingMinimum(required, look);
  const smoothed = hannSmooth(minimum, look);

  // The smoothed curve must never exceed the required curve. It cannot by construction
  // (a convolution of a window-minimum with a unit-sum kernel supported on the same
  // window is ≤ the pointwise value), but floating-point and edge handling can drift by
  // an ULP, so clamp explicitly. This costs one pass and removes a whole class of bug.
  for (let i = 0; i < n; i++) if (smoothed[i] > required[i]) smoothed[i] = required[i];

  // ── 4. Program-dependent release ──
  const relFast = Math.max(1, sr * ((opts.releaseFastMs ?? 25) / 1000));
  const relSlow = Math.max(1, sr * ((opts.releaseSlowMs ?? 220) / 1000));
  const blendSamples = Math.max(1, sr * 0.05);
  const out = new Float32Array(n);
  let g = 1;
  let sustained = 0;
  for (let i = 0; i < n; i++) {
    const target = smoothed[i];
    if (target < g) {
      g = target; // attack is already anticipated by the look-ahead; follow immediately
      sustained = 0;
    } else {
      sustained++;
      const blend = Math.min(1, sustained / blendSamples);
      const tau = relFast * (1 - blend) + relSlow * blend;
      g += (target - g) / tau;
      // Never let the release raise the gain above what the look-ahead demands.
      if (g > target) g = target;
    }
    out[i] = g;
  }
  return out;
}

/**
 * Accumulate the maximum absolute interpolated value around each sample into `env`.
 * Shares the polyphase bank with the true-peak analyser so detection and verification
 * cannot disagree.
 */
function accumulateInterpolatedPeaks(ch, env, factor) {
  const n = ch.length;
  if (factor <= 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.abs(ch[i]);
      if (a > env[i]) env[i] = a;
    }
    return;
  }
  // buildPolyphaseFilter is memoised inside true-peak.js, so this is a map lookup.
  const phases = buildPolyphaseFilter(factor);
  const taps = phases[0].length;
  const half = taps >> 1;
  for (let i = 0; i < n; i++) {
    let mx = Math.abs(ch[i]);
    for (let p = 1; p < factor; p++) {
      const branch = phases[p];
      let acc = 0;
      for (let k = 0; k < taps; k++) {
        const idx = i + k - half + 1;
        if (idx < 0 || idx >= n) continue;
        acc += branch[k] * ch[idx];
      }
      const a = Math.abs(acc);
      if (a > mx) mx = a;
    }
    if (mx > env[i]) env[i] = mx;
  }
}

/**
 * Limit `data` in place.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data mutated
 * @param {LimiterOptions} opts
 * @returns {LimiterResult}
 */
export function limitTruePeak(data, opts) {
  const gain = computeLimiterGain(data, opts);
  const n = data.length;

  let minGain = 1;
  let sumReduction = 0;
  let reducedCount = 0;
  for (let i = 0; i < n; i++) {
    const g = gain[i];
    if (g < minGain) minGain = g;
    if (g < 0.9999) {
      sumReduction += g;
      reducedCount++;
    }
  }
  for (const ch of data.channels) {
    for (let i = 0; i < n; i++) ch[i] *= gain[i];
  }

  const result = {
    maxGainReductionDb: gainToDb(minGain),
    averageGainReductionDb: reducedCount ? gainToDb(sumReduction / reducedCount) : 0,
    reducedSampleRatio: n ? reducedCount / n : 0,
    achievedTruePeakDb: -Infinity,
    ceilingDb: opts.ceilingDb,
    ceilingRespected: true,
    correctionTrimDb: 0,
  };

  if (opts.verify === false) return result;

  // ── 5. Verification ──
  const measured = analysePeaks(data);
  result.achievedTruePeakDb = measured.truePeakDb;

  // 0.05 dB of slack: the detector and the verifier use the same filter, so any residual
  // is numerical rather than structural.
  if (measured.truePeakDb > opts.ceilingDb + 0.05) {
    const trimDb = opts.ceilingDb - measured.truePeakDb;
    // Bound the corrective trim. If more than 1 dB is needed something is structurally
    // wrong and silently attenuating the master is not the right answer — report instead.
    const applied = Math.max(trimDb, -1);
    const g = dbToGain(applied);
    for (const ch of data.channels) {
      for (let i = 0; i < n; i++) ch[i] *= g;
    }
    result.correctionTrimDb = applied;
    const after = analysePeaks(data);
    result.achievedTruePeakDb = after.truePeakDb;
    result.ceilingRespected = after.truePeakDb <= opts.ceilingDb + 0.05;
  }

  return result;
}

/**
 * Standalone verification for the render report: measure a finished buffer against a
 * ceiling without touching it.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data
 * @param {number} ceilingDb
 */
export function verifyCeiling(data, ceilingDb) {
  const peaks = analysePeaks(data);
  return {
    ...peaks,
    ceilingDb,
    overBy: peaks.truePeakDb - ceilingDb,
    respected: peaks.truePeakDb <= ceilingDb + 0.05,
  };
}

export { truePeakChannel };
