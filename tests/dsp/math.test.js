import { describe, it, expect } from 'vitest';
import {
  clamp,
  dbToGain,
  gainToDb,
  smoothstep,
  onePoleCoeff,
  round,
  percentileSorted,
} from '../../src/audio/dsp/math.js';

describe('decibel conversions', () => {
  it('round-trips amplitude and decibels', () => {
    for (const db of [-60, -24, -6, -1, 0, 3, 12]) {
      expect(gainToDb(dbToGain(db))).toBeCloseTo(db, 10);
    }
  });

  it('uses the amplitude (20·log10) convention', () => {
    expect(dbToGain(-6)).toBeCloseTo(0.5011872336, 9);
    expect(dbToGain(-20)).toBeCloseTo(0.1, 12);
    expect(gainToDb(0.5)).toBeCloseTo(-6.0205999, 6);
  });

  it('floors silence rather than returning -Infinity', () => {
    expect(Number.isFinite(gainToDb(0))).toBe(true);
    expect(gainToDb(0)).toBeLessThan(-170);
  });

  it('treats negative amplitudes as magnitudes', () => {
    expect(gainToDb(-0.5)).toBeCloseTo(gainToDb(0.5), 12);
  });
});

describe('clamp', () => {
  it('bounds values', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});

describe('smoothstep', () => {
  it('is C0 continuous at the endpoints and monotonic between', () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 12);
    let previous = -1;
    for (let t = 0; t <= 1; t += 0.05) {
      const v = smoothstep(t);
      expect(v).toBeGreaterThanOrEqual(previous);
      previous = v;
    }
  });

  it('clamps outside [0,1]', () => {
    expect(smoothstep(-3)).toBe(0);
    expect(smoothstep(9)).toBe(1);
  });
});

describe('onePoleCoeff', () => {
  it('produces a coefficient that decays to 1/e over the time constant', () => {
    const sr = 48000;
    const seconds = 0.05;
    const a = onePoleCoeff(seconds, sr);
    let y = 1;
    for (let i = 0; i < seconds * sr; i++) y *= a;
    expect(y).toBeCloseTo(Math.exp(-1), 6);
  });

  it('returns 0 for a non-positive time constant instead of NaN', () => {
    expect(onePoleCoeff(0, 48000)).toBe(0);
    expect(onePoleCoeff(-1, 48000)).toBe(0);
  });
});

describe('round and percentileSorted', () => {
  it('rounds without floating-point display noise', () => {
    expect(round(0.1 + 0.2, 2)).toBe(0.3);
    expect(round(-1.005, 2)).toBe(-1);
  });

  it('interpolates percentiles', () => {
    const sorted = [0, 10, 20, 30, 40];
    expect(percentileSorted(sorted, 0)).toBe(0);
    expect(percentileSorted(sorted, 1)).toBe(40);
    expect(percentileSorted(sorted, 0.5)).toBe(20);
    expect(percentileSorted(sorted, 0.25)).toBe(10);
    expect(percentileSorted([], 0.5)).toBe(0);
    expect(percentileSorted([7], 0.9)).toBe(7);
  });
});
