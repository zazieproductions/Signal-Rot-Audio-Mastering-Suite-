/**
 * Loudness normalisation.
 *
 * ── The ordering problem ─────────────────────────────────────────────────────────────
 * Normalise-then-limit does not deliver the target. Limiting removes energy, so the
 * finished master lands below the number the user asked for — by 0.1 dB on gentle
 * material and by well over 1 dB on dense material pushed to −9 LUFS. The previous
 * implementation did exactly this and never checked.
 *
 * The fix is an iterative loop: normalise, limit, re-measure, correct, repeat.
 *
 * A naive correction — "add the shortfall to the gain" — does not converge on dense
 * material, because the limiter is *compressive*: adding 1 dB of input gain raises the
 * delivered loudness by less than 1 dB, often much less. Correcting by the full shortfall
 * therefore under-shoots every time. Measured on pink noise at −9 LUFS the naive loop
 * plateaus around −9.8 LUFS.
 *
 * This implementation estimates the local slope `dLoudness/dGain` from the previous two
 * passes (a secant step) and corrects by `shortfall / slope`, clamped to a sane range. On
 * the first correction, with no slope estimate yet, it assumes a conservative 0.6.
 *
 * Each pass is expensive (a full loudness measurement plus a full limiter pass), so the
 * loop is bounded and reports how close it got rather than grinding.
 *
 * ── Targets that cannot be reached ───────────────────────────────────────────────────
 * A transparent look-ahead limiter has a hard loudness ceiling that depends on the
 * material's crest factor. Past that point, extra input gain is met with exactly as much
 * gain reduction and the delivered loudness stops moving. Measured on pink noise at a
 * −1 dBTP ceiling:
 *
 * ```
 * +18 dB → −10.18 LUFS
 * +22 dB →  −9.80 LUFS
 * +26 dB →  −9.80 LUFS   ← saturated
 * +30 dB →  −9.80 LUFS
 * ```
 *
 * Signal Rot does not secretly insert a clipper to get past this. It detects the plateau
 * (two passes producing the same loudness for different gains), stops iterating, sets
 * `targetReachable: false`, and the render report says how far short it fell and why.
 * Getting louder than this requires clipping, distortion, or a different mix.
 *
 * The caller decides whether to run the loop (`refine: true` for the final export) or a
 * single pass (`refine: false` for previews and batch, where speed matters more than the
 * last 0.2 LU).
 */

import { dbToGain, clamp } from '../dsp/math.js';
import { applyGain, cloneAudioData } from '../dsp/audio-data.js';
import { analyseLoudness, normalizationGainDb } from '../analysis/loudness.js';
import { limitTruePeak } from './limiter.js';

/**
 * @typedef {object} NormalizeResult
 * @property {number} measuredBeforeLufs
 * @property {number} normalizationGainDb  total static gain applied before limiting
 * @property {number} achievedLufs
 * @property {number} targetLufs
 * @property {number} deltaLu              achieved − target
 * @property {number} passes
 * @property {boolean} targetReachable  false when the limiter saturated below the target
 * @property {import('./limiter.js').LimiterResult} limiter
 */

/**
 * Normalise to a target integrated loudness and limit to a true-peak ceiling.
 * Mutates `data`.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data
 * @param {object} opts
 * @param {boolean} opts.normalize
 * @param {number} opts.targetLufs
 * @param {number} opts.ceilingDb
 * @param {number[]} [opts.channelWeights]
 * @param {number[]} [opts.lfeChannels]
 * @param {boolean} [opts.refine]      run the convergence loop (default true)
 * @param {number}  [opts.maxPasses]   default 5
 * @param {number}  [opts.toleranceLu] default 0.1
 * @param {(stage:string, fraction:number)=>void} [opts.onProgress]
 * @returns {NormalizeResult}
 */
export function normalizeAndLimit(data, opts) {
  const {
    normalize,
    targetLufs,
    ceilingDb,
    channelWeights,
    lfeChannels,
    refine = true,
    maxPasses = 5,
    toleranceLu = 0.1,
    onProgress,
  } = opts;

  const report = (stage, f) => onProgress && onProgress(stage, f);

  report('measuring source loudness', 0.05);
  const before = analyseLoudness(data, { weights: channelWeights });

  if (!normalize) {
    report('limiting', 0.5);
    const limiter = limitTruePeak(data, { ceilingDb, lfeChannels });
    report('measuring result', 0.9);
    const after = analyseLoudness(data, { weights: channelWeights });
    return {
      measuredBeforeLufs: before.integrated,
      normalizationGainDb: 0,
      achievedLufs: after.integrated,
      targetLufs,
      deltaLu: after.integrated - targetLufs,
      passes: 1,
      targetReachable: true,
      limiter,
    };
  }

  // Keep a pristine copy so each refinement pass starts from the unlimited signal —
  // re-limiting an already-limited signal compounds the reduction and never converges.
  const pristine = refine ? cloneAudioData(data) : null;

  let totalGainDb = normalizationGainDb(before.integrated, targetLufs);
  let limiter = null;
  let achieved = -Infinity;
  let passes = 0;

  // Previous (gain, achieved) pair, for the secant slope estimate.
  let previousGainDb = null;
  let previousAchieved = null;
  // Best result seen so far, so a diverging late pass cannot make things worse.
  let bestGainDb = totalGainDb;
  let bestDelta = Infinity;
  let saturated = false;

  const maxIterations = refine ? maxPasses : 1;
  for (let pass = 0; pass < maxIterations; pass++) {
    passes = pass + 1;
    if (pass > 0 && pristine) {
      for (let c = 0; c < data.channels.length; c++) data.channels[c].set(pristine.channels[c]);
    }
    const progressBase = 0.1 + (pass / maxIterations) * 0.75;
    report(`normalising (pass ${passes})`, progressBase);
    applyGain(data, dbToGain(totalGainDb));

    report(`limiting (pass ${passes})`, progressBase + 0.03);
    limiter = limitTruePeak(data, { ceilingDb, lfeChannels });

    report(`verifying (pass ${passes})`, progressBase + 0.06);
    achieved = analyseLoudness(data, { weights: channelWeights }).integrated;
    if (!Number.isFinite(achieved)) break;

    const delta = achieved - targetLufs;
    if (Math.abs(delta) < Math.abs(bestDelta)) {
      bestDelta = delta;
      bestGainDb = totalGainDb;
    }
    if (Math.abs(delta) <= toleranceLu || pass === maxIterations - 1) break;

    // Secant slope: how much delivered loudness moved per dB of gain last time.
    let slope = 0.6; // conservative first guess for a limiter in compression
    if (previousGainDb !== null && Math.abs(totalGainDb - previousGainDb) > 1e-6) {
      const measured = (achieved - previousAchieved) / (totalGainDb - previousGainDb);
      if (Number.isFinite(measured) && measured <= 1.5) {
        if (measured <= 0.05) {
          // The limiter has saturated: more gain is producing no more loudness. Stop
          // rather than pushing a pointless 30 dB of gain into a brick wall.
          saturated = true;
          break;
        }
        slope = measured;
      }
    }
    previousGainDb = totalGainDb;
    previousAchieved = achieved;
    totalGainDb = clamp(totalGainDb - delta / slope, -40, 40);
  }

  // If the final pass was not the best one, redo the best.
  if (refine && pristine && Math.abs(achieved - targetLufs) > Math.abs(bestDelta) + 1e-9) {
    for (let c = 0; c < data.channels.length; c++) data.channels[c].set(pristine.channels[c]);
    totalGainDb = bestGainDb;
    applyGain(data, dbToGain(totalGainDb));
    limiter = limitTruePeak(data, { ceilingDb, lfeChannels });
    achieved = analyseLoudness(data, { weights: channelWeights }).integrated;
    passes += 1;
  }

  const finalDelta = Number.isFinite(achieved) ? achieved - targetLufs : NaN;
  return {
    measuredBeforeLufs: before.integrated,
    normalizationGainDb: totalGainDb,
    achievedLufs: achieved,
    targetLufs,
    deltaLu: finalDelta,
    passes,
    targetReachable: !(saturated && Number.isFinite(finalDelta) && finalDelta < -toleranceLu),
    limiter,
  };
}
