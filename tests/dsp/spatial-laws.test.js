import { describe, it, expect } from 'vitest';
import {
  widthSideGain,
  capSideBandGain,
  midBalanceGain,
  haasWidthScale,
  crossfeedTapGain,
  sideWidthGain,
  WIDTH_MAX_SIDE_GAIN,
  CROSSFEED_MAX_TAP_GAIN,
} from '../../src/audio/graph/spatial-laws.js';

describe('widthSideGain (§2.9 level-safe width)', () => {
  it('is identity for w ≤ 1 — narrowing stays exact', () => {
    for (const w of [0, 0.25, 0.5, 0.8, 1]) {
      expect(widthSideGain(w)).toBeCloseTo(w, 9);
    }
  });

  it('compresses extreme width settings instead of boosting without limit', () => {
    const at10 = widthSideGain(10);
    expect(at10).toBeLessThan(WIDTH_MAX_SIDE_GAIN + 1e-9);
    // 2.5 (the UI maximum) delivers far less than 2.5× side energy.
    expect(widthSideGain(2.5)).toBeLessThan(1.9);
    expect(widthSideGain(2.5)).toBeGreaterThan(1);
    // Monotone over the whole range.
    let prev = 0;
    for (let w = 0; w <= 3; w += 0.1) {
      const g = widthSideGain(w);
      expect(g).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = g;
    }
  });

  it('is neutral for a default width of 1', () => {
    expect(widthSideGain(1)).toBe(1);
  });
});

describe('capSideBandGain', () => {
  it('leaves ≤1 gains untouched and caps per band', () => {
    expect(capSideBandGain(0.7, 'low')).toBe(0.7);
    expect(capSideBandGain(2.2, 'low')).toBe(1.5);
    expect(capSideBandGain(2.2, 'mid')).toBe(2.2);
    expect(capSideBandGain(3, 'high')).toBe(2.2);
  });
});

describe('midBalanceGain', () => {
  it('protects the centre: ≥ −3 dB even at full side bias', () => {
    expect(midBalanceGain(1)).toBeGreaterThanOrEqual(10 ** (-3 / 20));
    expect(midBalanceGain(0.5)).toBeGreaterThan(0.85);
    expect(midBalanceGain(0.18)).toBeGreaterThan(0.95);
  });

  it('never boosts the centre for mid-heavy balance', () => {
    expect(midBalanceGain(-1)).toBe(1);
    expect(midBalanceGain(0)).toBe(1);
  });
});

describe('haasWidthScale', () => {
  it('is identity without Haas and scales down with delay', () => {
    expect(haasWidthScale(0)).toBe(1);
    expect(haasWidthScale(35)).toBeLessThan(1);
    expect(haasWidthScale(35)).toBeGreaterThan(0.88);
  });
});

describe('crossfeedTapGain (§4)', () => {
  it('is bounded and monotone', () => {
    expect(crossfeedTapGain(0)).toBe(0);
    expect(crossfeedTapGain(1)).toBeLessThanOrEqual(CROSSFEED_MAX_TAP_GAIN);
    let prev = -1;
    for (let x = 0; x <= 1; x += 0.05) {
      const g = crossfeedTapGain(x);
      expect(g).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(g).toBeLessThanOrEqual(CROSSFEED_MAX_TAP_GAIN);
      prev = g;
    }
  });

  it('keeps the classic law up to moderate settings, then caps growth', () => {
    // The whole point: same setting, less uncontrolled sum energy at the top.
    for (let x = 0.1; x <= 0.55; x += 0.05) {
      expect(crossfeedTapGain(x)).toBeCloseTo(0.45 * x, 9);
    }
    // Above the knee the gain grows slower and never reaches the old 0.45 ceiling.
    expect(crossfeedTapGain(1)).toBeLessThan(0.35);
    expect(crossfeedTapGain(1)).toBeLessThan(0.45);
    expect(crossfeedTapGain(0.8)).toBeLessThan(crossfeedTapGain(1));
  });
});

describe('sideWidthGain (combined law)', () => {
  it('is 1 for the default parameter set', () => {
    expect(sideWidthGain({ width: 1, binaural: false, spread: 0, haas: 0, ms: 0 })).toBe(1);
  });

  it('folds binaural spread into the bounded law', () => {
    const g = sideWidthGain({ width: 1.3, binaural: true, spread: 0.45, haas: 0, ms: 0 });
    // raw = 1.3 × (1 + 0.45×0.6) = 1.651; compressed below the raw value.
    expect(g).toBeGreaterThan(1);
    expect(g).toBeLessThan(1.651);
  });

  it('scales back when Haas is engaged (no width+spread+Haas stacking)', () => {
    const withHaas = sideWidthGain({ width: 1.6, binaural: false, spread: 0, haas: 20, ms: 0 });
    const without = sideWidthGain({ width: 1.6, binaural: false, spread: 0, haas: 0, ms: 0 });
    expect(withHaas).toBeLessThan(without);
    // 20 ms Haas still leaves useful width: reduction is gentle.
    expect(withHaas).toBeGreaterThan(without * 0.9);
  });

  it('keeps mid-heavy balance from unbounded side growth', () => {
    const g = sideWidthGain({ width: 1, binaural: false, spread: 0, haas: 0, ms: -1 });
    expect(g).toBeLessThanOrEqual(WIDTH_MAX_SIDE_GAIN);
    expect(g).toBeGreaterThan(1);
  });
});
