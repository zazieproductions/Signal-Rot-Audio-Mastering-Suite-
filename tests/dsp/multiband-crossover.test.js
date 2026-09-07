import { describe, it, expect } from 'vitest';
import {
  multibandResponse,
  legacyMultibandResponse,
  crossoverReconstruction,
  bandAmountToSettings,
  MB_BALLISTICS,
} from '../../src/audio/graph/multiband.js';
import { cabs } from '../../src/audio/dsp/biquad.js';
import { SCOPE, mark } from '../conformance/scope.js';

const SR = 48000;
const dbOf = (c) => 20 * Math.log10(Math.max(1e-12, cabs(c)));

/**
 * ── The regression this file exists for ──────────────────────────────────────────────
 * The pre-7.0 multiband mixed the all-pass band sum against an unfiltered dry wire. At
 * 50 % parallel mix that is a comb filter with complete nulls at both crossover
 * frequencies. Both the failure and the fix are asserted here so the bug cannot silently
 * return.
 */
describe(`${mark(SCOPE.IDEAL_MATH)} crossover reconstruction — current topology`, () => {
  it('sums to exactly 0 dB at full wet', () => {
    const result = crossoverReconstruction(SR, { mix: 1, points: 1024 });
    expect(Math.abs(result.worstDeviationDb)).toBeLessThan(0.001);
  });

  it('sums to exactly 0 dB at EVERY parallel-mix position', () => {
    for (const mix of [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1]) {
      const result = crossoverReconstruction(SR, { mix, points: 512 });
      expect(Math.abs(result.worstDeviationDb)).toBeLessThan(0.001);
    }
  });

  it('is flat at every supported sample rate', () => {
    for (const rate of [44100, 48000, 96000, 192000]) {
      const result = crossoverReconstruction(rate, { mix: 0.5, points: 512 });
      expect(Math.abs(result.worstDeviationDb)).toBeLessThan(0.001);
    }
  });

  it('is flat with unusual crossover frequencies', () => {
    for (const [low, high] of [
      [80, 8000],
      [200, 1500],
      [300, 700],
      [60, 12000],
    ]) {
      const result = crossoverReconstruction(SR, {
        mix: 0.5,
        lowHz: low,
        highHz: high,
        points: 512,
      });
      expect(Math.abs(result.worstDeviationDb)).toBeLessThan(0.002);
    }
  });

  it('places each band where it belongs', () => {
    const low = multibandResponse(50, SR);
    expect(dbOf(low.low)).toBeGreaterThan(-1);
    expect(dbOf(low.mid)).toBeLessThan(-30);
    expect(dbOf(low.high)).toBeLessThan(-60);

    const mid = multibandResponse(800, SR);
    expect(dbOf(mid.mid)).toBeGreaterThan(-1);
    expect(dbOf(mid.low)).toBeLessThan(-25);
    expect(dbOf(mid.high)).toBeLessThan(-25);

    const high = multibandResponse(12000, SR);
    expect(dbOf(high.high)).toBeGreaterThan(-1);
    expect(dbOf(high.mid)).toBeLessThan(-30);
    expect(dbOf(high.low)).toBeLessThan(-60);
  });

  it('is −6 dB per band at each crossover frequency', () => {
    const atLow = multibandResponse(140, SR);
    expect(dbOf(atLow.low)).toBeCloseTo(-6.02, 1);
    expect(dbOf(atLow.mid)).toBeCloseTo(-6.02, 1);

    const atHigh = multibandResponse(3200, SR);
    expect(dbOf(atHigh.mid)).toBeCloseTo(-6.02, 1);
    expect(dbOf(atHigh.high)).toBeCloseTo(-6.02, 1);
  });

  it('changes only the intended band when one band is gained', () => {
    // Well inside the low band, where the mid band is more than 45 dB down.
    const boosted = multibandResponse(25, SR, { bandGains: [2, 1, 1] });
    expect(dbOf(boosted.sum)).toBeCloseTo(6.02, 1);
    const untouched = multibandResponse(12000, SR, { bandGains: [2, 1, 1] });
    expect(dbOf(untouched.sum)).toBeCloseTo(0, 1);
  });
});

describe(`${mark(SCOPE.IDEAL_MATH)} crossover reconstruction — pre-7.0 topology (the bug)`, () => {
  it('was flat at full wet, which is why nobody noticed', () => {
    let worst = 0;
    for (let i = 0; i < 1024; i++) {
      const f = 20 * Math.pow(22000 / 20, i / 1023);
      const d = dbOf(legacyMultibandResponse(f, SR, { mix: 1 }));
      if (Math.abs(d) > Math.abs(worst)) worst = d;
    }
    expect(Math.abs(worst)).toBeLessThan(0.05);
  });

  it('put a deep null at each crossover at 50 % parallel mix', () => {
    const atLow = dbOf(legacyMultibandResponse(140, SR, { mix: 0.5 }));
    const atHigh = dbOf(legacyMultibandResponse(3200, SR, { mix: 0.5 }));
    expect(atLow).toBeLessThan(-25);
    expect(atHigh).toBeLessThan(-25);
  });

  it('lost 6 dB at the crossovers even at 25 % and 75 % mix', () => {
    for (const mix of [0.25, 0.75]) {
      const atLow = dbOf(legacyMultibandResponse(140, SR, { mix }));
      expect(atLow).toBeLessThan(-5);
    }
  });

  it('is measurably worse than the current topology at every partial mix', () => {
    for (const mix of [0.25, 0.5, 0.75]) {
      let legacyWorst = 0;
      for (let i = 0; i < 512; i++) {
        const f = 20 * Math.pow(22000 / 20, i / 511);
        const d = dbOf(legacyMultibandResponse(f, SR, { mix }));
        if (Math.abs(d) > Math.abs(legacyWorst)) legacyWorst = d;
      }
      const current = crossoverReconstruction(SR, { mix, points: 512 }).worstDeviationDb;
      expect(Math.abs(legacyWorst)).toBeGreaterThan(Math.abs(current) + 3);
    }
  });
});

describe(`${mark(SCOPE.IDEAL_MATH)} band amount mapping`, () => {
  it('is inert at 0 and firm-but-mastering-grade at 100', () => {
    const zero = bandAmountToSettings(0);
    expect(zero.thresholdDb).toBe(0);
    expect(zero.ratio).toBe(1);
    expect(zero.kneeDb).toBe(12);
    const full = bandAmountToSettings(100);
    expect(full.thresholdDb).toBeCloseTo(-24, 6);
    expect(full.ratio).toBeCloseTo(3, 6);
  });

  it('keeps mid positions in glue territory — low ratio, gentle threshold', () => {
    // Clean mastering compression should sit at roughly 0–2 dB of gain reduction on
    // ordinary material. The mapping earns that by keeping mid amounts subtle.
    const mid = bandAmountToSettings(40);
    expect(mid.thresholdDb).toBeGreaterThan(-12);
    expect(mid.ratio).toBeLessThanOrEqual(2);
  });

  it('is monotonic and clamps out-of-range input', () => {
    let previousThreshold = 1;
    for (let a = 0; a <= 100; a += 5) {
      const s = bandAmountToSettings(a);
      expect(s.thresholdDb).toBeLessThanOrEqual(previousThreshold);
      previousThreshold = s.thresholdDb;
    }
    expect(bandAmountToSettings(-50).ratio).toBe(bandAmountToSettings(0).ratio);
    expect(bandAmountToSettings(500).ratio).toBe(bandAmountToSettings(100).ratio);
  });

  it('exposes musically meaningful ballistics', () => {
    expect(MB_BALLISTICS.fast.attack).toBeLessThan(MB_BALLISTICS.med.attack);
    expect(MB_BALLISTICS.med.attack).toBeLessThan(MB_BALLISTICS.slow.attack);
    expect(MB_BALLISTICS.fast.release).toBeLessThan(MB_BALLISTICS.slow.release);
  });
});
