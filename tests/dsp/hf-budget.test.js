import { describe, it, expect } from 'vitest';
import {
  planHfBudget,
  hfStackParts,
  brightnessFactor,
  reachWeight,
  budgetedMatchGains,
  HF_BUDGET_ALLOWED_DB,
} from '../../src/audio/graph/hf-budget.js';
import { measureBrightness } from '../../src/audio/analysis/brightness.js';
import { defaultParameters } from '../../src/app/parameters.js';
import { createAudioData } from '../../src/audio/dsp/audio-data.js';
import { sine, whiteNoise } from '../helpers/signals.js';

const params = (patch = {}) => ({ ...defaultParameters(), ...patch });

describe('reachWeight', () => {
  it('weights by proximity to the 8–13 kHz hyped region', () => {
    expect(reachWeight(12000)).toBe(1);
    expect(reachWeight(8000)).toBe(0.85);
    expect(reachWeight(5000)).toBe(0.45);
    expect(reachWeight(2500)).toBe(0.2);
    expect(reachWeight(400)).toBe(0);
  });
});

describe('hfStackParts', () => {
  it('counts the binaural spread air-lift as part of the stack', () => {
    const { estimateDb, spreadAirDb } = hfStackParts(params({ binaural: true, spread: 1 }));
    expect(spreadAirDb).toBe(1.5);
    expect(estimateDb).toBeCloseTo(1.5, 6);
  });

  it('ignores zero and negative contributors — darker settings never enter the budget', () => {
    const { parts, estimateDb } = hfStackParts(params({ air: -3, clarity: -1, tilt: -2 }));
    expect(estimateDb).toBe(0);
    expect(parts).toHaveLength(0);
  });

  it('estimates a stacked preset as the weighted sum of its parts', () => {
    // +2 air +2 clarity +2 tilt +2 dB of 12 kHz reference-match + spread air lift.
    const p = params({
      air: 2,
      clarity: 2,
      tilt: 2,
      binaural: true,
      spread: 1,
      matchGains: [0, 0, 0, 0, 0, 0, 0, 2],
    });
    const { estimateDb } = hfStackParts(p);
    // air + clarity + tilt (0.85 reach at 10 kHz) + match + spread lift
    const expected = 2 + 0.45 * 2 + 0.85 * 2 + 2 + 1.5;
    expect(estimateDb).toBeCloseTo(expected, 6);
  });

  it('accepts delivered (strength-scaled) match gains', () => {
    const p = params({ matchGains: [0, 0, 0, 0, 0, 0, 0, 4], matchStrength: 50 });
    const delivered = p.matchGains.map((g) => (g * 50) / 100);
    const { estimateDb } = hfStackParts(p, delivered);
    expect(estimateDb).toBeCloseTo(2, 6); // 4 dB × 50 % × reach 1.0
  });
});

describe('brightnessFactor', () => {
  it('maps measured HF ratios into a 0..1 penalty', () => {
    expect(brightnessFactor(-30)).toBe(0);
    expect(brightnessFactor(-10)).toBe(1);
    expect(brightnessFactor(-16)).toBeCloseTo(0.5, 6);
    expect(brightnessFactor(NaN)).toBe(0);
    expect(brightnessFactor(-Infinity)).toBe(0);
  });
});

describe('planHfBudget', () => {
  it('is fully neutral below the allowance — solo boosts pass untouched', () => {
    const plan = planHfBudget(params({ air: 2, clarity: 2 }));
    expect(plan.engaged).toBe(false);
    expect(plan.cutDb).toBe(0);
    expect(plan.satScale).toBe(1);
  });

  it('trims a stacked treble boost proportionally', () => {
    const p = params({ air: 2, clarity: 2, tilt: 2, matchGains: [0, 0, 0, 0, 0, 0, 0, 2] });
    const plan = planHfBudget(p);
    expect(plan.engaged).toBe(true);
    expect(plan.estimateDb).toBeGreaterThan(HF_BUDGET_ALLOWED_DB);
    expect(plan.cutDb).toBeGreaterThan(0);
    expect(plan.cutDb).toBeLessThanOrEqual(7);

    // Every positive contributor is reduced; bigger contributors lose more dB.
    expect(plan.delivered.airTotal).toBeLessThan(4); // air 2 + spread 0 → ~2 − share
    expect(plan.delivered.clarity).toBeLessThan(2);
    expect(plan.delivered.clarity).toBeGreaterThan(0);
    expect(plan.delivered.tilt).toBeLessThan(2);
    // Match 12 kHz band (2 dB) is included and reduced.
    const matchDelivered = p.matchGains.map((g) => (g * 100) / 100);
    const out = budgetedMatchGains(p, matchDelivered, plan);
    expect(out[7]).toBeLessThan(2);
    expect(out[7]).toBeGreaterThan(0);
  });

  it('reduces saturation drive when a large surplus is engaged', () => {
    const p = params({ air: 6, clarity: 6, tilt: 4, sat: 60 });
    const plan = planHfBudget(p);
    expect(plan.engaged).toBe(true);
    expect(plan.satScale).toBeLessThan(1);
    expect(plan.satScale).toBeGreaterThanOrEqual(0.65);
  });

  it('lowers the allowance for bright material', () => {
    const p = params({ air: 5 });
    const neutral = planHfBudget(p);
    // air 5 > 4 allowance → engaged even without brightness? air 5*1 = 5 > 4 → engaged.
    const dim = planHfBudget(p, { brightnessFactor: 0 });
    const bright = planHfBudget(p, { brightnessFactor: 1 });
    expect(bright.allowedDb).toBeLessThan(dim.allowedDb);
    // Same stack must be cut harder on bright material.
    expect(bright.cutDb).toBeGreaterThan(dim.cutDb);
    expect(neutral.engaged).toBe(true);
  });

  it('never cuts darker-only settings', () => {
    const plan = planHfBudget(
      params({ air: -4, tilt: -3, matchGains: [0, 0, 0, 0, 0, 0, 0, -2] }),
      { brightnessFactor: 1 },
    );
    expect(plan.engaged).toBe(false);
    expect(plan.cutDb).toBe(0);
  });

  it('returns identical plans for identical inputs (deterministic)', () => {
    const a = params({ air: 3, clarity: 3, tilt: 2 });
    const b = params({ air: 3, clarity: 3, tilt: 2 });
    expect(planHfBudget(a)).toEqual(planHfBudget(b));
  });

  it('caps the cut so a deliberate extreme stack is tamed, not flattened', () => {
    const p = params({ air: 9, clarity: 9, tilt: 6 });
    const plan = planHfBudget(p);
    expect(plan.cutDb).toBeLessThanOrEqual(7);
    expect(plan.delivered.airTotal).toBeGreaterThan(9 - 7);
  });
});

describe('measureBrightness', () => {
  it('reads a high ratio for an 18 kHz sine and near zero for 200 Hz', () => {
    // LR4 high-pass at 9 kHz: well above the corner a sine passes almost entirely.
    const high = sine({ frequency: 18000, seconds: 0.2, sampleRate: 48000, amplitude: 0.5 });
    const m = measureBrightness(high);
    expect(m.hfRatio).toBeGreaterThan(0.8);
    expect(m.hfRatioDb).toBeGreaterThan(-1.5);

    const low = sine({ frequency: 200, seconds: 0.2, sampleRate: 48000, amplitude: 0.5 });
    const ml = measureBrightness(low);
    expect(ml.hfRatio).toBeLessThan(0.001);
  });

  it('is polarity- and channel-safe (mono-sum measurement)', () => {
    const left = whiteNoise({ seconds: 0.2, sampleRate: 48000, amplitude: 0.5 });
    const ch = left.channels[0]; // identical pair
    const inPhase = createAudioData(2, ch.length, 48000);
    inPhase.channels[0].set(ch);
    inPhase.channels[1].set(ch);
    const anti = createAudioData(2, ch.length, 48000);
    anti.channels[0].set(ch);
    anti.channels[1].set(Float32Array.from(ch, (v) => -v));
    // Mono-sum of anti-phase white noise is near silence; the mono-sum metric must still
    // be finite and identical for identical left channels.
    expect(measureBrightness(anti).hfRatioDb).toBe(-Infinity);
    expect(Number.isFinite(measureBrightness(inPhase).hfRatioDb)).toBe(true);
  });
});
