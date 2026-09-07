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
 * ── Loudness ambition vs transparency ────────────────────────────────────────────────
 * LUFS targets are guidelines, not mandatory destinations. If reaching the target would
 * require destructive processing, the loop settles for a quieter master instead:
 *
 *  · Every pass is *scored*, not just measured: `|delta| + overBudget × 1.5`, where the
 *    budget is 1.5 dB of *average* limiter gain reduction. A pass that lands closer to
 *    the target by crushing the mix scores worse than a quieter, cleaner pass.
 *  · If average reduction passes 3 dB while the target is still short, the loop stops —
 *    more gain would only buy more gain reduction — sets `ambitionReduced: true`, and
 *    keeps the best-scoring (cleaner) pass.
 *  · If the loop converged on the target but only by limiting constantly (average
 *    reduction beyond 3 dB), it steps the gain back down and re-renders once, delivering
 *    a quieter master that still breathes.
 *
 * The budget uses *average* reduction deliberately. Sparse transient limiting — deep cuts
 * on a few snare hits — is normal mastering; constant several-dB reduction across the
 * programme is crushing. The two look identical in `maxGainReductionDb` and nothing alike
 * in the average.
 *
 * The caller decides whether to run the loop (`refine: true` for the final export) or a
 * single pass (`refine: false` for previews and batch, where speed matters more than the
 * last 0.2 LU). The ambition guard only engages in the refining loop — a single pass
 * reports what it did and lets the report speak.
 *
 * ── Crest-factor-aware targets ───────────────────────────────────────────────────────
 * Saturation of the limiter is only half the story: a target can be *reachable* only by
 * flattening the material −10 dB (max) / −3 dB (average) on the way there, which is a
 * brickwalled record by any standard, not a master. When the caller supplies a gain-
 * reduction budget (`maxAverageGainReductionDb` / `maxPeakGainReductionDb`, as positive
 * magnitudes), and the converged result exceeds it, the loop delivers the loudest master
 * that stays inside the budget instead — below the requested target and reported, never
 * louder than the target, never more limited than the budget. This is what
 * `docs/GAIN-STRUCTURE-AUDIT.md` §2.6 calls for: loudness is the output, not the input.
 * The ambition guard above is the budget's always-on sibling for callers that supply no
 * explicit budget: both refuse to trade the sound for the number, and both say so.
 */

import { dbToGain, clamp } from '../dsp/math.js';
import { applyGain, cloneAudioData } from '../dsp/audio-data.js';
import { analyseLoudness, normalizationGainDb } from '../analysis/loudness.js';
import { limitTruePeak } from './limiter.js';

/**
 * Default gain-reduction budget for final exports (audit §2.6: average GR ≤ ~2 dB,
 * max GR ≤ ~6 dB). Kept out of the UI on purpose — it is a structural guard, not a
 * creative knob; the render report states when it engages.
 */
export const CREST_AWARE_BUDGET = Object.freeze({
  maxAverageGainReductionDb: 2,
  maxPeakGainReductionDb: 6,
});

/**
 * @typedef {object} NormalizeResult
 * @property {number} measuredBeforeLufs
 * @property {number} normalizationGainDb  total static gain applied before limiting
 * @property {number} achievedLufs
 * @property {number} targetLufs
 * @property {number} deltaLu              achieved − target
 * @property {number} passes
 * @property {boolean} targetReachable  false when the target was not delivered (limiter
 *     saturation, the ambition guard, or a crest-aware budget that refused to brickwall
 *     the material)
 * @property {boolean} ambitionReduced  true when loudness ambition was cut to protect the sound
 * @property {number} effectiveTargetLufs the loudness actually pursued (below target when reduced)
 * @property {object} crestAware  { capped, requestedLufs, deliveredLufs, maxAverageGainReductionDb,
 *     maxPeakGainReductionDb } — present when a GR budget was supplied
 * @property {import('./limiter.js').LimiterResult} limiter
 */

/** Average limiter reduction (dB) tolerated before a pass starts scoring badly. */
export const LIMITER_GR_BUDGET_DB = 1.5;
/** Average reduction (dB) beyond which the loop stops pushing, full stop. */
export const LIMITER_GR_CEILING_DB = 3;

/**
 * Score a refinement pass. Lower is better. Loudness error counts 1:1; every dB of
 * average limiting beyond the budget counts 1.5×, so the loop prefers a quieter clean
 * master over a louder crushed one.
 */
export function scoreRefinementPass(deltaLu, averageGainReductionDb) {
  const over = Math.max(0, -averageGainReductionDb - LIMITER_GR_BUDGET_DB);
  return Math.abs(deltaLu) + over * 1.5;
}

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
 * @param {number}  [opts.maxAverageGainReductionDb] positive GR budget, dB — see CREST_AWARE_BUDGET
 * @param {number}  [opts.maxPeakGainReductionDb]    positive GR budget, dB — see CREST_AWARE_BUDGET
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
    maxAverageGainReductionDb,
    maxPeakGainReductionDb,
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
      ambitionReduced: false,
      effectiveTargetLufs: targetLufs,
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
  // Best result seen so far, scored for loudness AND cleanliness, so a diverging late
  // pass — or a crushed one — cannot make things worse.
  let bestGainDb = totalGainDb;
  let bestScore = Infinity;
  let bestDelta = Infinity;
  let saturated = false;
  let ambitionReduced = false;

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
    const score = refine
      ? scoreRefinementPass(delta, limiter.averageGainReductionDb)
      : Math.abs(delta);
    if (score < bestScore) {
      bestScore = score;
      bestDelta = delta;
      bestGainDb = totalGainDb;
    }

    // The ambition guard: constant heavy limiting while still short of the target means
    // more gain buys only more gain reduction. Stop pushing and keep the cleaner pass.
    if (
      refine &&
      -limiter.averageGainReductionDb > LIMITER_GR_CEILING_DB &&
      delta < -toleranceLu
    ) {
      saturated = true;
      ambitionReduced = true;
      break;
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
  const finalScore = refine && limiter
    ? scoreRefinementPass(achieved - targetLufs, limiter.averageGainReductionDb)
    : Math.abs(achieved - targetLufs);
  if (refine && pristine && finalScore > bestScore + 1e-9) {
    for (let c = 0; c < data.channels.length; c++) data.channels[c].set(pristine.channels[c]);
    totalGainDb = bestGainDb;
    applyGain(data, dbToGain(totalGainDb));
    limiter = limitTruePeak(data, { ceilingDb, lfeChannels });
    achieved = analyseLoudness(data, { weights: channelWeights }).integrated;
    passes += 1;
    if (Math.abs(achieved - targetLufs) > toleranceLu && bestDelta < -toleranceLu) {
      ambitionReduced = true;
    }
  }

  // Converged on the number but only by crushing: step back down and re-render once.
  // A quieter master that breathes beats a louder one that doesn't.
  if (
    refine &&
    pristine &&
    Number.isFinite(achieved) &&
    Math.abs(achieved - targetLufs) <= toleranceLu &&
    limiter &&
    -limiter.averageGainReductionDb > LIMITER_GR_CEILING_DB
  ) {
    const stepBackDb = Math.min(
      4,
      -limiter.averageGainReductionDb - LIMITER_GR_CEILING_DB + 1.5,
    );
    for (let c = 0; c < data.channels.length; c++) data.channels[c].set(pristine.channels[c]);
    totalGainDb -= stepBackDb;
    applyGain(data, dbToGain(totalGainDb));
    limiter = limitTruePeak(data, { ceilingDb, lfeChannels });
    achieved = analyseLoudness(data, { weights: channelWeights }).integrated;
    passes += 1;
    ambitionReduced = true;
  }

  // ── Crest-factor-aware budget enforcement ────────────────────────────────────────
  // The convergence loop above answers "what gain hits the target?" — which is the right
  // question only if the material can take the limiting that gain requires. With a GR
  // budget supplied, a result that exceeds it is re-delivered as the loudest master that
  // stays inside it. The search is a bounded bisection over input gain: within-budget
  // results are monotone in gain (less gain ⇒ less reduction), and loudness is monotone
  // non-decreasing in gain, so the loudest in-budget master also stays ≤ the loudness the
  // infeasible target pass measured — never louder than the requested target.
  const hasBudget =
    refine && pristine && maxAverageGainReductionDb != null && maxPeakGainReductionDb != null;
  const crestAware = hasBudget
    ? {
        capped: false,
        requestedLufs: targetLufs,
        deliveredLufs: NaN,
        maxAverageGainReductionDb,
        maxPeakGainReductionDb,
      }
    : null;
  if (hasBudget) {
    const withinBudget = (l) =>
      l.averageGainReductionDb >= -maxAverageGainReductionDb &&
      l.maxGainReductionDb >= -maxPeakGainReductionDb;

    if (limiter && Number.isFinite(achieved) && !withinBudget(limiter)) {
      const deliver = (gainDb) => {
        for (let c = 0; c < data.channels.length; c++) data.channels[c].set(pristine.channels[c]);
        applyGain(data, dbToGain(gainDb));
        return limitTruePeak(data, { ceilingDb, lfeChannels });
      };

      // Walk down in 6 dB steps to a feasible lower bound (bounded: pathological input
      // that still exceeds the budget 24 dB down is delivered at −24 dB rather than
      // searched forever).
      let loGain = totalGainDb;
      let loLimiter = limiter;
      let steps = 0;
      while (!withinBudget(loLimiter) && steps < 4) {
        loGain -= 6;
        loLimiter = deliver(loGain);
        steps += 1;
      }
      if (withinBudget(loLimiter)) {
        // Narrow the feasible region to the loudest in-budget gain.
        let hiGain = totalGainDb;
        for (let i = 0; i < 6; i++) {
          const mid = (loGain + hiGain) / 2;
          if (withinBudget(deliver(mid))) loGain = mid;
          else hiGain = mid;
        }
        if (Math.abs(loGain - totalGainDb) > 1e-6) {
          limiter = deliver(loGain);
          totalGainDb = loGain;
          achieved = analyseLoudness(data, { weights: channelWeights }).integrated;
          passes += 1;
          crestAware.capped = true;
          crestAware.deliveredLufs = achieved;
        }
      }
    }
  }
  if (crestAware && !crestAware.capped && Number.isFinite(achieved)) {
    crestAware.deliveredLufs = achieved;
  }

  const finalDelta = Number.isFinite(achieved) ? achieved - targetLufs : NaN;
  const crestCapped =
    crestAware?.capped === true && Number.isFinite(finalDelta) && finalDelta < -toleranceLu;
  return {
    measuredBeforeLufs: before.integrated,
    normalizationGainDb: totalGainDb,
    achievedLufs: achieved,
    targetLufs,
    deltaLu: finalDelta,
    passes,
    targetReachable: !(
      (saturated || crestCapped) &&
      Number.isFinite(finalDelta) &&
      finalDelta < -toleranceLu
    ),
    ambitionReduced: ambitionReduced || crestCapped,
    effectiveTargetLufs:
      (ambitionReduced || crestCapped) && Number.isFinite(achieved) ? achieved : targetLufs,
    crestAware,
    limiter,
  };
}
