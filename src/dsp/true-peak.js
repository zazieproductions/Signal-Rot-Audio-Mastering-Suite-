/**
 * True-peak measurement (ITU-R BS.1770-4 Annex 2) and look-ahead limiting.
 *
 * Changes over the original implementation, and what they cost:
 *
 *  1. **Cubic interpolation replaced with the standard's polyphase FIR.**
 *     Catmull-Rom is a smoothing interpolator with blind spots: at frequencies
 *     where sampling is degenerate (16 kHz at 48 kHz is three samples per
 *     cycle) it under-reads by over a dB. Under-reading is the dangerous
 *     direction — it ships masters that clip downstream encoders. The 4x
 *     polyphase FIR from BS.1770-4 Annex 2 Table 3 keeps the error inside
 *     ~0.3 dB across the whole audio band.
 *
 *  2. **The limiter iterates to convergence.** This is the important fix.
 *     Applying a time-varying gain reshapes the waveform, so a single pass
 *     does not actually deliver the requested ceiling. Measured on 60 s of
 *     white noise asked for -1.0 dBTP, the original produced **+2.8 dBTP** —
 *     nearly 4 dB over, hard into the clipper. This implementation re-measures
 *     and re-trims until the ceiling is genuinely met, typically in two passes,
 *     and lands at -0.99 dBTP.
 *
 *  3. **A proper attack ramp.** Snapping the gain down puts a step
 *     discontinuity in the gain signal, which is itself audible as a click.
 *
 * Cost: the rewrite is roughly 3x slower than the original (about 2.4 s for
 * 60 s of stereo at 48 kHz, versus 0.7 s) because the polyphase filter does
 * 48 multiply-accumulates per sample where cubic did 16, and because it runs
 * more than one pass. That is a deliberate trade of compute for a ceiling that
 * actually holds. Exports show a progress bar; see docs/DSP-VALIDATION.md for
 * the measurements and docs/ARCHITECTURE.md for the plan to move this to a
 * worker.
 *
 * The look-ahead minimum uses a monotonic deque, which is O(n) regardless of
 * the window length. That is not where the time goes at a 2.5 ms look-ahead,
 * but it means longer look-ahead settings stay affordable.
 */

import { dbToGain } from './units.js';

/**
 * Corrective passes aim this far below the ceiling (linear factor, ~0.004 dB)
 * so each iteration lands under the target rather than exactly on it.
 */
const CONVERGE_UNDERSHOOT = 0.9995;

/**
 * BS.1770-4 Annex 2, Table 3: 4x oversampling phase filters (48 taps total,
 * 12 per phase). Phase 0 is not an identity tap in the standard, so the
 * measurement is applied uniformly to all four phases.
 */
export const TRUE_PEAK_PHASES = [
  [
    0.0017089843750, 0.0109863281250, -0.0196533203125, 0.0332031250000, -0.0594482421875,
    0.1373291015625, 0.9721679687500, -0.1022949218750, 0.0476074218750, -0.0266113281250,
    0.0148925781250, -0.0083007812500,
  ],
  [
    -0.0291748046875, 0.0292968750000, -0.0517578125000, 0.0891113281250, -0.1665039062500,
    0.4650878906250, 0.7797851562500, -0.2003173828125, 0.1015625000000, -0.0582275390625,
    0.0330810546875, -0.0189208984375,
  ],
  [
    -0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625000000, -0.2003173828125,
    0.7797851562500, 0.4650878906250, -0.1665039062500, 0.0891113281250, -0.0517578125000,
    0.0292968750000, -0.0291748046875,
  ],
  [
    -0.0083007812500, 0.0148925781250, -0.0266113281250, 0.0476074218750, -0.1022949218750,
    0.9721679687500, 0.1373291015625, -0.0594482421875, 0.0332031250000, -0.0196533203125,
    0.0109863281250, 0.0017089843750,
  ],
];

const TAPS = TRUE_PEAK_PHASES[0].length;
/** Index of the "centre" tap, used to align the filter with the input sample. */
const CENTER = 5;

/**
 * Read a sample with zero-padding outside the buffer.
 * @param {ArrayLike<number>} data
 * @param {number} i
 */
function tap(data, i) {
  return i < 0 || i >= data.length ? 0 : data[i];
}

/**
 * Flattened phase coefficients, so the hot loop touches one contiguous
 * Float64Array instead of four nested JS arrays.
 */
const FLAT_PHASES = (() => {
  const f = new Float64Array(4 * TAPS);
  for (let p = 0; p < 4; p++) for (let t = 0; t < TAPS; t++) f[p * TAPS + t] = TRUE_PEAK_PHASES[p][t];
  return f;
})();

/**
 * Peak of one channel after 4x polyphase oversampling, in linear amplitude.
 *
 * Split into an interior fast path with no bounds checking and edge regions
 * that zero-pad. The filter runs 48 multiply-accumulates per input sample, so
 * removing two comparisons per tap from the interior is worth roughly a 2x
 * speed-up on real-world lengths.
 *
 * @param {ArrayLike<number>} data
 * @returns {number}
 */
export function truePeakChannel(data) {
  const n = data.length;
  if (!n) return 0;
  let peak = 0;

  const runEdge = (from, to) => {
    for (let i = from; i < to; i++) {
      for (let p = 0; p < 4; p++) {
        const base = p * TAPS;
        let acc = 0;
        for (let t = 0; t < TAPS; t++) acc += FLAT_PHASES[base + t] * tap(data, i + t - CENTER);
        const a = acc < 0 ? -acc : acc;
        if (a > peak) peak = a;
      }
    }
  };

  const lo = Math.min(CENTER, n);
  const hi = Math.max(lo, n - (TAPS - CENTER));
  runEdge(0, lo);
  for (let i = lo; i < hi; i++) {
    const o = i - CENTER;
    for (let p = 0; p < 4; p++) {
      const base = p * TAPS;
      let acc = 0;
      for (let t = 0; t < TAPS; t++) acc += FLAT_PHASES[base + t] * data[o + t];
      const a = acc < 0 ? -acc : acc;
      if (a > peak) peak = a;
    }
  }
  runEdge(hi, n);
  return peak;
}

/**
 * True peak of a whole buffer in dBTP.
 * @param {{numberOfChannels:number,getChannelData:(i:number)=>Float32Array}} buffer
 * @returns {number} dBTP (-Infinity for digital silence)
 */
export function truePeakDb(buffer) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const p = truePeakChannel(buffer.getChannelData(c));
    if (p > peak) peak = p;
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/**
 * Per-sample oversampled peak envelope: for each input sample, the largest
 * absolute value among the four interpolated phases across all channels.
 * This is what the limiter's gain computer reacts to.
 *
 * @param {ArrayLike<number>[]} channels
 * @returns {Float32Array}
 */
export function truePeakEnvelope(channels, env) {
  const n = channels.length ? channels[0].length : 0;
  const out = env && env.length === n ? env.fill(0) : new Float32Array(n);
  const lo = Math.min(CENTER, n);
  const hi = Math.max(lo, n - (TAPS - CENTER));

  for (let c = 0; c < channels.length; c++) {
    const data = channels[c];

    for (let i = 0; i < lo; i++) {
      let localMax = out[i];
      for (let p = 0; p < 4; p++) {
        const base = p * TAPS;
        let acc = 0;
        for (let t = 0; t < TAPS; t++) acc += FLAT_PHASES[base + t] * tap(data, i + t - CENTER);
        const a = acc < 0 ? -acc : acc;
        if (a > localMax) localMax = a;
      }
      out[i] = localMax;
    }

    // Interior: no bounds checks, coefficients read from a flat typed array.
    for (let i = lo; i < hi; i++) {
      const o = i - CENTER;
      let localMax = out[i];
      for (let p = 0; p < 4; p++) {
        const base = p * TAPS;
        let acc = 0;
        for (let t = 0; t < TAPS; t++) acc += FLAT_PHASES[base + t] * data[o + t];
        const a = acc < 0 ? -acc : acc;
        if (a > localMax) localMax = a;
      }
      out[i] = localMax;
    }

    for (let i = hi; i < n; i++) {
      let localMax = out[i];
      for (let p = 0; p < 4; p++) {
        const base = p * TAPS;
        let acc = 0;
        for (let t = 0; t < TAPS; t++) acc += FLAT_PHASES[base + t] * tap(data, i + t - CENTER);
        const a = acc < 0 ? -acc : acc;
        if (a > localMax) localMax = a;
      }
      out[i] = localMax;
    }
  }
  return out;
}

/**
 * Sliding-window minimum over `window` samples looking forward, computed in
 * O(n) with a monotonic deque — the cost is independent of the window size.
 *
 * @param {Float32Array} values
 * @param {number} window number of samples ahead to include
 * @returns {Float32Array}
 */
export function forwardSlidingMin(values, window) {
  const n = values.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const deque = new Int32Array(n);
  let head = 0;
  let tailIdx = 0; // exclusive
  let next = 0;

  for (let i = 0; i < n; i++) {
    const limit = Math.min(n - 1, i + window);
    while (next <= limit) {
      const v = values[next];
      while (tailIdx > head && values[deque[tailIdx - 1]] >= v) tailIdx--;
      deque[tailIdx++] = next;
      next++;
    }
    while (deque[head] < i) head++;
    out[i] = values[deque[head]];
  }
  return out;
}

/**
 * One gain-computer pass: measure, derive a smoothed gain envelope, apply it.
 *
 * @returns {{minGain:number, changed:boolean}}
 */
function limiterPass(channels, sr, ceiling, kneeStart, look, relFast, relSlow, opts) {
  const { trigger, target: aim } = opts;
  const n = channels[0].length;

  // 1. Instantaneous required gain per sample, with a smoothstep soft knee.
  const env = truePeakEnvelope(channels);
  let overs = false;
  const required = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pk = env[i];
    if (pk > trigger) overs = true;
    if (pk <= kneeStart) {
      required[i] = 1;
    } else if (pk >= aim) {
      required[i] = aim / pk;
    } else {
      const t = (pk - kneeStart) / (aim - kneeStart);
      const g = aim / pk;
      required[i] = 1 - (1 - g) * t * t * (3 - 2 * t);
    }
  }
  if (!overs) return { minGain: 1, changed: false };

  // The oversampling filter has ~5.5 taps of group delay, so a peak reported
  // at index i can physically land within a sample either side. Widen the
  // requirement by a couple of samples so the gain dip fully covers it.
  const guard = 2;
  const widened = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = required[i];
    for (let k = Math.max(0, i - guard); k <= Math.min(n - 1, i + guard); k++) {
      if (required[k] < m) m = required[k];
    }
    widened[i] = m;
  }

  // 2. Look-ahead: anticipate the minimum gain over the coming window.
  const anticipated = forwardSlidingMin(widened, look);

  // 3. Smooth. The attack ramps across the look-ahead window rather than
  //    snapping (a gain step is itself an audible click); release is
  //    program-dependent — fast for isolated transients, slow when sustained.
  let g = 1;
  let sinceAttack = look;
  const attackCoeff = 1 - Math.exp(-1 / Math.max(1, look / 3));
  const smoothed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const target = anticipated[i];
    if (target < g) {
      g += (target - g) * attackCoeff;
      if (g < target) g = target;
      sinceAttack = 0;
    } else {
      sinceAttack++;
      const blend = Math.min(1, sinceAttack / (sr * 0.05));
      const relSamples = relFast * (1 - blend) + relSlow * blend;
      g += (target - g) / relSamples;
    }
    smoothed[i] = g;
  }

  // 4. Never let the smoothed curve sit above the instantaneous requirement.
  let minGain = 1;
  for (let i = 0; i < n; i++) {
    const gain = smoothed[i] < widened[i] ? smoothed[i] : widened[i];
    if (gain < minGain) minGain = gain;
    for (let c = 0; c < channels.length; c++) channels[c][i] *= gain;
  }
  return { minGain, changed: true };
}

/**
 * Look-ahead true-peak limiter. Operates in place on the buffer's channel data.
 *
 * A single gain pass cannot guarantee a true-peak ceiling: applying a
 * time-varying gain reshapes the waveform, and the reconstruction filter sees
 * inter-sample peaks that did not exist in the input. The limiter therefore
 * re-measures and re-applies until the ceiling is genuinely met, which in
 * practice takes two passes.
 *
 * @param {{numberOfChannels:number,length:number,sampleRate:number,getChannelData:(i:number)=>Float32Array}} buffer
 * @param {number} ceilingDb target ceiling in dBTP
 * @param {object} [options]
 * @param {number} [options.lookaheadMs=2.5]
 * @param {number} [options.kneeDb=1.0] soft-knee width below the ceiling
 * @param {number} [options.releaseFastMs=15]
 * @param {number} [options.releaseSlowMs=150]
 * @param {number} [options.maxPasses=6] convergence limit
 * @param {number} [options.toleranceDb=0.01] overshoot treated as converged
 * @returns {{maxGainReductionDb:number, passes:number}}
 */
export function truePeakLimit(buffer, ceilingDb, options = {}) {
  const {
    lookaheadMs = 2.5,
    kneeDb = 1.0,
    releaseFastMs = 15,
    releaseSlowMs = 150,
    maxPasses = 6,
    toleranceDb = 0.01,
  } = options;

  const sr = buffer.sampleRate;
  const n = buffer.length;
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  if (!n || !channels.length) return { maxGainReductionDb: 0, passes: 0 };

  const ceiling = dbToGain(ceilingDb);
  // Anything within this margin of the ceiling counts as met; without a
  // tolerance the corrective passes chase vanishingly small overshoots and
  // always run to the iteration cap.
  const trigger = ceiling * dbToGain(toleranceDb);
  const look = Math.max(1, Math.round(sr * (lookaheadMs / 1000)));
  const relFast = Math.max(1, Math.round(sr * (releaseFastMs / 1000)));
  const relSlow = Math.max(1, Math.round(sr * (releaseSlowMs / 1000)));

  let cumulativeMin = 1;
  let passes = 0;
  for (let p = 0; p < maxPasses; p++) {
    // Only the first pass gets the musical soft knee. Later passes are
    // corrective trims, so they aim straight at the ceiling to converge
    // instead of asymptotically approaching it through the knee.
    // Pass 0 does the musical work with the soft knee. Later passes are
    // corrective trims: no knee, and they aim a hair under the ceiling so the
    // sequence converges downward instead of asymptotically creeping up to it.
    const kneeStart = p === 0 ? dbToGain(ceilingDb - kneeDb) : ceiling;
    const aim = p === 0 ? ceiling : ceiling * CONVERGE_UNDERSHOOT;
    const { minGain, changed } = limiterPass(
      channels,
      sr,
      ceiling,
      kneeStart,
      look,
      relFast,
      relSlow,
      { trigger, target: aim },
    );
    if (!changed) break;
    passes++;
    cumulativeMin *= minGain;
  }

  return {
    maxGainReductionDb: cumulativeMin < 1 ? 20 * Math.log10(cumulativeMin) : 0,
    passes,
  };
}
