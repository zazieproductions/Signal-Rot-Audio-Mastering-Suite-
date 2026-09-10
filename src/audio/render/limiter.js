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
import { designBiquad } from '../dsp/biquad.js';
import {
  analysePeaksVerified,
  truePeakChannel,
  oversamplingFactorFor,
  buildPolyphaseFilter,
  TRUE_PEAK_DETECT_TAPS,
} from '../analysis/true-peak.js';

/**
 * Working-ceiling offset, dB. The limiter detects with a short FIR that under-reads
 * inter-sample peaks (especially HF); rather than slamming the gain computer harder
 * we aim this much *below* the requested ceiling and, if an independent meter still
 * sees an over, apply a static trim (issue #21 / SON-2). 0.3 dB is a safety
 * allowance, not a loudness grab.
 */
export const TRUE_PEAK_SAFETY_DB = 0.3;
/** Independent-meter slack for `ceilingRespected`. Tighter than the old 0.05 dB
 *  self-check: the verifier is no longer the detector. */
export const TRUE_PEAK_VERIFY_SLACK_DB = 0.02;

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
 * @property {boolean} [bassAware]     adaptive release for bass-driven reduction
 *   (§6), default true. When the gain reduction is sustained *and* the detection
 *   signal is dominated by sub-150 Hz content, the release slows down quickly so a
 *   40–100 Hz cycle cannot modulate the master gain; transient-led reduction keeps
 *   the fast release.
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

  // ── 4. Program-dependent release, bass-aware (§6) ──
  // When reduction is driven by sub-150 Hz content the gain curve must *not* track the
  // 40–100 Hz cycle: a fast release there modulates the master gain at the bass rate,
  // which is LF distortion and audible pumping on kick/bass. `bassDominance[i]` is a
  // smoothed ratio of the low-passed envelope to the full-band envelope of the
  // detection sum; while it is high the release transitions to the slow constant
  // several times faster, so a sustained bass-driven reduction holds an almost flat
  // gain. Transient-led reduction (dominance low) keeps the fast release untouched.
  const bassAware = opts.bassAware !== false;
  const bassDominance = bassAware
    ? computeBassDominance(data, opts, sr, n, peakEnv)
    : new Float32Array(n);

  // Defaults 25/220 ms (conservative release) — callers may override.
  const relFast = Math.max(1, sr * ((opts.releaseFastMs ?? 25) / 1000));
  const relSlow = Math.max(1, sr * ((opts.releaseSlowMs ?? 220) / 1000));
  const blendSamples = Math.max(1, sr * 0.05);
  const out = new Float32Array(n);
  let g = 1;
  let sustained = 0;
  // Dominance *latched at the attack*: only the content that actually drove the gain
  // down decides how the release behaves. A transient that lands on a mid-frequency
  // bed keeps the fast release; a gain reduction driven by a 40–60 Hz cycle latches
  // high dominance and the release stays slow for ~100 ms of recovery.
  let latchedD = 0;
  let attacking = false;
  const latchDecay = 1 - Math.exp(-1 / (sr * 0.1));
  for (let i = 0; i < n; i++) {
    const target = smoothed[i];
    if (target < g) {
      g = target; // attack is already anticipated by the look-ahead; follow immediately
      sustained = 0;
      // Latch the *minimum* dominance across the current attack run, read at the
      // look-ahead horizon (`i + look`): the attack begins ~3 ms of look-ahead before
      // the offending peak arrives, so the dominance measured at the attack onset
      // still belongs to whatever the peak will land on — latching there would blame
      // a 3 kHz spike's gain reduction on the LF bed beneath it and slow the release
      // after every transient. Reading at the horizon means the content that actually
      // drove the peak decides the release; the min across the run covers the whole
      // descent. Each new attack run (a release happened in between) re-seeds the
      // latch, so a quiet LF passage cannot poison later bass-driven reduction.
      const domAtPeak = bassDominance[Math.min(n - 1, i + look)];
      if (attacking) {
        latchedD = Math.min(latchedD, domAtPeak);
      } else {
        latchedD = domAtPeak;
        attacking = true;
      }
    } else {
      attacking = false;
      sustained++;
      // Bass-dominated release engages in ~a quarter of the usual blend time. The
      // latch decays with a ~100 ms one-pole, so a single bass-driven attack cannot
      // hold the slow release for long after the bass stops. A threshold keeps the
      // behaviour specific: only reductions whose *driving* content is clearly
      // sub-150 Hz (latch ≥ 0.45) change the release at all — a transient landing on
      // a mid-frequency bed keeps the classic fast-release behaviour.
      const pull = Math.max(0, (latchedD - 0.45) / 0.55) * 3;
      const blend = Math.min(1, (sustained / blendSamples) * (1 + pull));
      const tau = relFast * (1 - blend) + relSlow * blend;
      g += (target - g) / tau;
      // Never let the release raise the gain above what the look-ahead demands.
      if (g > target) g = target;
      latchedD -= latchDecay * latchedD;
    }
    out[i] = g;
  }
  return out;
}

/**
 * Per-sample low-frequency dominance of the detection channels: the ratio between the
 * sub-150 Hz band's peak magnitude and the full-band peak magnitude, both measured on
 * the *same basis the limiter detects on* (per-sample maximum around each sample).
 * 0 = the peaks that drive the limiter are not bass; ≈1 = they are essentially all
 * sub-150 Hz energy.
 *
 * Envelope-smoothed magnitudes cannot tell a kick from a 3 kHz spike sitting on a bass
 * bed — a 2–3 ms transient is shorter than any practical smoothing constant, so the
 * smoothed "LF share" never dips while the transient drives the limiter. Peak-vs-peak
 * on the detection basis has no such lag: when a wideband transient crosses the
 * ceiling, the full-band peak at that instant dwarfs the LF peak and the ratio drops
 * immediately; when a 40–60 Hz cycle drives the reduction, both peaks belong to the
 * same LF waveform and the ratio stays ≈1.
 *
 * Single-pass, one allocation: for every detection channel a 2nd-order low-pass is
 * applied inline and the per-sample low-band maximum is the only state kept.
 */
function computeBassDominance(data, opts, sr, n, fullPeakEnv) {
  const lfe = new Set(opts.lfeChannels ?? []);
  const list = [];
  for (let c = 0; c < data.channels.length; c++) {
    if (lfe.has(c)) continue;
    list.push(data.channels[c]);
  }
  const out = new Float32Array(n);
  if (!list.length) return out;

  const { b0, b1, b2, a1, a2 } = designBiquad('lowpass', 150, Math.SQRT1_2, 0, sr);
  const nc = list.length;
  const sx1 = new Float64Array(nc);
  const sx2 = new Float64Array(nc);
  const sy1 = new Float64Array(nc);
  const sy2 = new Float64Array(nc);

  for (let i = 0; i < n; i++) {
    let lfPeak = 0;
    for (let c = 0; c < nc; c++) {
      const x = list[c][i];
      const y = b0 * x + b1 * sx1[c] + b2 * sx2[c] - a1 * sy1[c] - a2 * sy2[c];
      sx2[c] = sx1[c];
      sx1[c] = x;
      sy2[c] = sy1[c];
      sy1[c] = y;
      const a = Math.abs(y);
      if (a > lfPeak) lfPeak = a;
    }
    const full = fullPeakEnv[i];
    out[i] = full > 1e-6 ? Math.min(1, lfPeak / full) : 0;
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
  // Detection FIR (memoised). Verification uses a different meter — see limitTruePeak.
  const phases = buildPolyphaseFilter(factor, TRUE_PEAK_DETECT_TAPS);
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
  // Aim a little below the requested ceiling so residual detector error is absorbed
  // by headroom, not by extra attack/release crushing (issue #21).
  const safety = opts.safetyDb ?? TRUE_PEAK_SAFETY_DB;
  const workingCeiling = opts.ceilingDb - Math.max(0, safety);
  const gain = computeLimiterGain(data, { ...opts, ceilingDb: workingCeiling });
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

  // ── 5. Verification — independent meter, not the detector grading itself ──
  const measured = analysePeaksVerified(data);
  result.achievedTruePeakDb = measured.truePeakDb;

  const slack = TRUE_PEAK_VERIFY_SLACK_DB;
  if (measured.truePeakDb > opts.ceilingDb + slack) {
    // Static trim: a uniform make-up drop, not more limiter attack. Caps at 3 dB so a
    // pathological miss is reported rather than silently burying the master; 1 dB was
    // not enough for the HF-forward case SON-2 measured (+0.94 dB).
    const trimDb = opts.ceilingDb - measured.truePeakDb;
    const applied = Math.max(trimDb, -3);
    const g = dbToGain(applied);
    for (const ch of data.channels) {
      for (let i = 0; i < n; i++) ch[i] *= g;
    }
    result.correctionTrimDb = applied;
    const after = analysePeaksVerified(data);
    result.achievedTruePeakDb = after.truePeakDb;
    result.ceilingRespected = after.truePeakDb <= opts.ceilingDb + slack;
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
  const peaks = analysePeaksVerified(data);
  return {
    ...peaks,
    ceilingDb,
    overBy: peaks.truePeakDb - ceilingDb,
    respected: peaks.truePeakDb <= ceilingDb + TRUE_PEAK_VERIFY_SLACK_DB,
  };
}

export { truePeakChannel };
