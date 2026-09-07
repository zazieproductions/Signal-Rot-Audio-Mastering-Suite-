/**
 * REFERENCE / CLEAN vs CREATIVE / SIGNAL ROT.
 *
 * A mastering laboratory is allowed — expected — to change audio when the user asks it
 * to. The regression harness therefore refuses to declare a creative preset "wrong"
 * because loudness, crest or spectrum moved. It *does* declare a reference / clean path
 * wrong when those things move without an explanation.
 *
 * Classification is a property of the *parameter set*, not of the fixture.
 */

import { defaultParameters } from '../../src/app/parameters.js';

/**
 * Keys that, when they leave their schema default, put the chain in creative territory.
 * Loudness-target and ceiling stay in the *delivery* column — they are not colour.
 */
export const CREATIVE_KEYS = Object.freeze([
  'drive',
  'sub',
  'warm',
  'body',
  'harsh',
  'clarity',
  'air',
  'tilt',
  'sat',
  'mbLow',
  'mbMid',
  'mbHigh',
  'mbMix',
  'mbAutoMakeup',
  'transAttack',
  'transSustain',
  'width',
  'ms',
  'bassMono',
  'haas',
  'crossfeed',
  'phaseRot',
  'widthLow',
  'widthMid',
  'widthHigh',
  'depth',
  'binaural',
  'spread',
  'tape',
  'hiss',
  'vinyl',
  'matchStrength',
]);

/**
 * A "reference / clean" render is: schema defaults, or defaults plus delivery controls
 * (normalise, target, ceiling, dither). Anything that colours, widens, saturates or
 * compresses is creative.
 *
 * @param {Record<string, any>} parameters
 * @returns {{class: 'reference'|'creative', reasons: string[]}}
 */
export function classifyParameters(parameters) {
  const defaults = defaultParameters();
  const reasons = [];
  const p = parameters ?? defaults;
  for (const key of CREATIVE_KEYS) {
    const got = p[key];
    const want = defaults[key];
    if (Array.isArray(got) || Array.isArray(want)) continue;
    if (typeof got === 'number' && typeof want === 'number') {
      if (Math.abs(got - want) > 1e-9) reasons.push(`${key}: ${want} → ${got}`);
    } else if (got !== want) {
      reasons.push(`${key}: ${want} → ${got}`);
    }
  }
  return {
    class: reasons.length ? 'creative' : 'reference',
    reasons,
  };
}

/**
 * Named parameter snapshots used by the lab. These are *test* snapshots — they do not
 * retune any production preset.
 */
export function referenceParameters(overrides = {}) {
  return { ...defaultParameters(), normalize: true, targetLUFS: -14, ceiling: -1, ...overrides };
}

/**
 * A deliberately coloured Signal Rot snapshot. Used to prove the harness distinguishes
 * "the rot did what it said" from "the clean path drifted".
 */
export function creativeParameters(overrides = {}) {
  return {
    ...defaultParameters(),
    normalize: true,
    targetLUFS: -12,
    ceiling: -1,
    drive: 2,
    sat: 35,
    tape: 25,
    mbLow: 30,
    mbMid: 22,
    mbHigh: 18,
    mbMix: 70,
    width: 1.35,
    bassMono: 80,
    depth: 30,
    air: 1.2,
    ...overrides,
  };
}

export function classOfMeasurement(measurement) {
  if (measurement?.class === 'creative' || measurement?.class === 'reference') {
    return measurement.class;
  }
  if (measurement?.parameters) return classifyParameters(measurement.parameters).class;
  return 'source';
}
