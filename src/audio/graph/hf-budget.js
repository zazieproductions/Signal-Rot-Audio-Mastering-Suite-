/**
 * Cumulative high-frequency processing budget (§2.7).
 *
 * ── Why this module exists ───────────────────────────────────────────────────────────
 * Presence, air, tilt, a reference-match curve, the binaural spread air-lift and the
 * saturation stage are five separate controls, and each one *individually* is a
 * reasonable mastering decision. Together they can deliver +6 dB or more of treble
 * excitation into a non-linear saturation stage, and the result is a master that is
 * crispy, brittle, hyped and fatiguing — not because any single control was wrong but
 * because nothing understood that the stack is one decision, not five.
 *
 * The engine therefore runs a cumulative budget over the treble stack before the signal
 * reaches the multiband and saturation stages:
 *
 *   · every positive contributor above ~4 kHz is weighted by how strongly it actually
 *     reaches the 8–13 kHz region that makes masters sound hyped;
 *   · when the weighted stack exceeds the allowed excitation, the surplus is removed
 *     from the contributors *proportionally to their size* — no single knob is silently
 *     turned all the way down, and a solo +2 dB air lift is never touched;
 *   · already-bright material lowers the allowance, so automatic HF boosting (reference
 *     matching against a bright reference, spread air-lifts) cannot push a bright source
 *     further into the brittle zone;
 *   · saturation drive is additionally scaled back while a large surplus is engaged, so
 *     the shaper does not add harmonics on top of an over-excited top end.
 *
 * ── What is NOT done here ────────────────────────────────────────────────────────────
 *  · No global treble cut is applied — a neutral or small stack is completely
 *    untouched, so existing preset sound is preserved below the threshold.
 *  · Negative HF settings (darker masters) never enter the budget: cutting treble is
 *    always safe.
 *  · Creative / intentionally abrasive presets are not exempted inside this module:
 *    destructive presets are *labelled* as destructive in the catalog, but the budget
 *    protects the saturation stage regardless, which is where the excess harmonics and
 *    aliasing would be generated. Presets that genuinely want a hyped top end can still
 *    get it up to the allowed ceiling; what they cannot do is accidentally stack five
 *    controls into +9 dB without the engine noticing.
 */

import { MATCH_FREQS } from '../../app/constants.js';
import { clamp } from '../dsp/math.js';

/** Excitation ceiling for material that is not especially bright, dB. */
export const HF_BUDGET_ALLOWED_DB = 4.0;
/** Ceiling when the source is maximally bright, dB. */
export const HF_BUDGET_BRIGHT_ALLOWED_DB = 2.75;
/** How much of the surplus is removed (0.65 = gentle, not a brick wall). */
export const HF_BUDGET_RESPONSE = 0.65;
/** Hard cap on the corrective cut, dB — never fully flatten a deliberate stack. */
export const HF_BUDGET_MAX_CUT_DB = 7;
/** Saturation drive scaling reaches this floor at a large surplus. */
export const HF_BUDGET_SAT_SCALE_FLOOR = 0.65;

/** Anchor frequencies of the MATCH_FREQS table, for the per-band reach weights. */
const MATCH_ANCHOR_HZ = [60, 150, 400, 1000, 2500, 5000, 8000, 12000];

/**
 * How strongly a contributor at `freq` reaches the 8–13 kHz "hyped" region.
 * Weights are heuristic but defensible: a 12 kHz shelf is entirely inside the region
 * (1.0), an 8 kHz band mostly inside (0.85), a 5 kHz peaking band reaches it only by
 * its upper skirt (0.45), and lower bands are not treble-excitation at all.
 */
export function reachWeight(freqHz) {
  if (freqHz >= 11000) return 1.0;
  if (freqHz >= 7000) return 0.85;
  if (freqHz >= 4000) return 0.45;
  if (freqHz >= 2500) return 0.2;
  return 0;
}

/**
 * Turn a source-brightness measurement into a 0..1 penalty factor.
 *
 * @param {number} hfRatioDb 10·log10(energy above ~9 kHz / total energy) of the source
 */
export function brightnessFactor(hfRatioDb) {
  if (!Number.isFinite(hfRatioDb)) return 0;
  // Typical full-range music sits around −14…−20 dB above 9 kHz; a genuinely dull
  // source is below −20 dB and a very bright one above −12 dB.
  return clamp((hfRatioDb + 20) / 8, 0, 1);
}

/**
 * A single positive contributor to the treble stack.
 * @typedef {{id: string, value: number, weight: number, anchorDb?: number}} StackPart
 */

/**
 * Enumerate the positive treble contributors of a parameter set.
 * `matchGains` may be passed separately (delivered, strength-scaled values).
 *
 * @param {object} p
 * @param {number[]} [matchDelivered] per-band delivered match gain in dB
 * @returns {{parts: StackPart[], estimateDb: number, spreadAirDb: number}}
 */
export function hfStackParts(p, matchDelivered) {
  const parts = [];
  let estimateDb = 0;
  const push = (id, value, weight) => {
    if (!Number.isFinite(value) || value <= 0) return;
    parts.push({ id, value, weight });
    estimateDb += value * weight;
  };

  // Binaural spread lifts air inside applyTone (spread × 1.5 dB) — it must be part of
  // the stack or the budget can be bypassed by using the "free" lift instead of the air
  // control.
  const spreadAir = p.binaural ? (p.spread ?? 0) * 1.5 : 0;

  push('air', p.air ?? 0, reachWeight(12000));
  push('spreadAir', spreadAir, reachWeight(12000));
  push('clarity', p.clarity ?? 0, reachWeight(5000));
  push('tilt', p.tilt ?? 0, reachWeight(10000));

  const delivered = matchDelivered ?? (p.matchGains ?? []).map((g) => g);
  for (let i = 0; i < MATCH_FREQS.length; i++) {
    const g = delivered[i];
    if (!Number.isFinite(g) || g <= 0) continue;
    push(`match${i}`, g, reachWeight(MATCH_ANCHOR_HZ[i]));
  }

  return { parts, estimateDb, spreadAirDb: spreadAir };
}

/**
 * Plan the HF budget for a parameter set.
 *
 * @param {object} p validated mastering parameters
 * @param {object} [opts]
 * @param {number} [opts.brightnessFactor] 0..1 from `brightnessFactor()`
 * @param {number[]} [opts.matchDelivered] delivered per-band match gains in dB
 * @returns {object} the plan; when `engaged` is false no delivered value is changed
 */
export function planHfBudget(p, opts = {}) {
  const matchDelivered = opts.matchDelivered;
  const { parts, estimateDb, spreadAirDb } = hfStackParts(p, matchDelivered);

  const b = clamp(opts.brightnessFactor ?? 0, 0, 1);
  const allowedDb =
    HF_BUDGET_ALLOWED_DB + (HF_BUDGET_BRIGHT_ALLOWED_DB - HF_BUDGET_ALLOWED_DB) * b;

  const surplusDb = estimateDb - allowedDb;
  if (surplusDb <= 0 || parts.length === 0) {
    return {
      engaged: false,
      estimateDb: round1(estimateDb),
      allowedDb: round1(allowedDb),
      surplusDb: round1(surplusDb),
      cutDb: 0,
      satScale: 1,
      contributors: parts.map((part) => part.id),
    };
  }

  // Soft knee: the response ramps in over the first dB of surplus.
  const knee = Math.min(1, surplusDb / 1.5);
  const cutDb = Math.min(
    HF_BUDGET_MAX_CUT_DB,
    round1(surplusDb * HF_BUDGET_RESPONSE * (0.5 + 0.5 * knee)),
  );

  // Proportionally split the cut across contributors (each contributor keeps its own
  // character; none is singled out).
  const weighted = parts.reduce((sum, part) => sum + part.value * part.weight, 0) || 1;
  const delivered = {};
  for (const part of parts) {
    const share = (cutDb * (part.value * part.weight)) / weighted;
    delivered[part.id] = Math.max(0, part.value - share);
  }
  // `airTotal` is the combined final air-shelf value including the (budgeted) spread
  // lift — exactly what the graph's tone stage should deliver on the air band.
  const airPart = Number.isFinite(delivered.air) ? delivered.air : (p.air ?? 0);
  const spreadPart = Number.isFinite(delivered.spreadAir) ? delivered.spreadAir : spreadAirDb;
  delivered.airTotal = airPart + spreadPart;

  // Saturation drive: while a large surplus is engaged, reduce the *effective* drive so
  // the shaper adds less harmonic content on top of an already hot top end.
  const satScale = Math.max(
    HF_BUDGET_SAT_SCALE_FLOOR,
    1 - 0.4 * clamp(surplusDb / 8, 0, 1),
  );

  return {
    engaged: true,
    estimateDb: round1(estimateDb),
    allowedDb: round1(allowedDb),
    surplusDb: round1(surplusDb),
    cutDb: round1(cutDb),
    satScale: round1(satScale),
    contributors: parts.map((part) => part.id),
    delivered: {
      airTotal: round1(delivered.airTotal),
      clarity: Number.isFinite(delivered.clarity) ? round1(delivered.clarity) : undefined,
      tilt: Number.isFinite(delivered.tilt) ? round1(delivered.tilt) : undefined,
      // Per-index match gains appear as `match<i>` only when that band is positive.
      ...Object.fromEntries(
        parts
          .filter((part) => part.id.startsWith('match'))
          .map((part) => [part.id, round1(delivered[part.id])]),
      ),
    },
  };
}

/** Per-index delivered match gains after the budget (indices with no part keep value). */
export function budgetedMatchGains(p, matchDelivered, plan) {
  if (!plan.engaged) return matchDelivered;
  const out = matchDelivered.slice();
  for (let i = 0; i < MATCH_FREQS.length; i++) {
    const v = out[i];
    if (!Number.isFinite(v) || v <= 0) continue;
    const delivered = plan.delivered[`match${i}`];
    if (Number.isFinite(delivered)) out[i] = delivered;
  }
  return out;
}

const round1 = (v) => Math.round(v * 10) / 10;
