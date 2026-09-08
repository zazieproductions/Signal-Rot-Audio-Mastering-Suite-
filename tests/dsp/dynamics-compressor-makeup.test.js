import { describe, it, expect } from 'vitest';
import {
  dynamicsCompressorMakeupDb,
  dynamicsCompressorMakeupCompensation,
} from '../../src/audio/dsp/dynamics-compressor.js';
import { bandAmountToSettings } from '../../src/audio/graph/multiband.js';
import { SCOPE, mark } from '../conformance/scope.js';

/**
 * These expectations were produced by replicating the engine algorithm
 * (exponential knee, kAtSlope geometric-mean search, saturate(1, k),
 * makeup = pow(1/Saturate(1,k), 0.6)) in an independent script, and are the values
 * the *browser* node applies — not the simplified straight-line estimate.
 */
const ENGINE_REFERENCE_DB = {
  0: 0.0,
  5: 0.016,
  10: 0.115,
  15: 0.352,
  20: 0.760,
  25: 1.357,
  30: 2.088,
  35: 2.881,
  40: 3.722,
  50: 5.506,
  60: 7.387,
  80: 11.323,
  100: 15.395,
};

describe(`${mark(SCOPE.IDEAL_MATH)} dynamics compressor fixed make-up (engine model)`, () => {
  it('applies no make-up at 1:1 or when disabled', () => {
    // amount 0 → threshold 0 dB, ratio 1:1
    expect(dynamicsCompressorMakeupDb(0, 9, 1)).toBe(0);
    // ratio 1 with any threshold/knee compresses nothing
    expect(dynamicsCompressorMakeupDb(-24, 30, 1)).toBe(0);
    expect(dynamicsCompressorMakeupDb(-36, 9, 1)).toBe(0);
  });

  it('reproduces the engine make-up for every band amount (knee 9 dB)', () => {
    // The reference table was generated against the threshold/ratio ladder
    // (threshold −0.36·a, ratio 1 + 0.04·a, knee 9 dB), so the inputs are passed
    // explicitly: this test verifies the *engine model* against the independent
    // script, independent of whatever the UI amount mapping currently is.
    for (const [amount, expectedDb] of Object.entries(ENGINE_REFERENCE_DB)) {
      const a = Number(amount);
      const got = dynamicsCompressorMakeupDb(a === 0 ? 0 : -a * 0.36, 9, 1 + a * 0.04);
      expect(got, `amount ${amount}`).toBeCloseTo(expectedDb, 2);
    }
  });

  it('is audible even at modest settings — this is the gain the chain was hiding', () => {
    // The transparency retune gentled the amount mapping (threshold −0.24·a, ratio
    // 1 + 0.02·a, knee 12 dB), which shrank the hidden make-up — but it is still
    // well above audibility at ordinary settings, so the compensation stays essential.
    const s = bandAmountToSettings(35);
    const db_ = dynamicsCompressorMakeupDb(s.thresholdDb, s.kneeDb, s.ratio);
    expect(db_).toBeGreaterThan(0.5);
    // 50 = a typical "glue" setting: +1.7 dB of unasked-for level without compensation
    const s50 = bandAmountToSettings(50);
    const db50 = dynamicsCompressorMakeupDb(s50.thresholdDb, s50.kneeDb, s50.ratio);
    expect(db50).toBeGreaterThan(1.5);
    expect(db50).toBeCloseTo(1.709, 2);
  });

  it('grows monotonically with amount', () => {
    let previous = -1;
    for (let a = 0; a <= 100; a += 5) {
      const s = bandAmountToSettings(a);
      const db_ = dynamicsCompressorMakeupDb(s.thresholdDb, s.kneeDb, s.ratio);
      expect(db_).toBeGreaterThanOrEqual(previous);
      previous = db_;
    }
  });

  it('collapses to the straight-line estimate at knee 0', () => {
    // With no soft knee, reduction at 0 dBFS is (1 − 1/ratio)·(−threshold) and the
    // make-up is 0.6× that — the closed form the audit appendix used.
    for (const [threshold, ratio, expected] of [
      [-1.2, 20, 0.684], // the live safety limiter
      [-5.4, 1.6, 1.215],
      [-7.2, 1.8, 1.92],
      [-12.6, 2.4, 4.41],
      [-36, 5, 17.28],
    ]) {
      expect(dynamicsCompressorMakeupDb(threshold, 0, ratio)).toBeCloseTo(expected, 2);
    }
  });

  it('compensation is the exact inverse of the make-up', () => {
    const s = bandAmountToSettings(70);
    const makeup = dynamicsCompressorMakeupDb(s.thresholdDb, s.kneeDb, s.ratio);
    const compensation = dynamicsCompressorMakeupCompensation(
      s.thresholdDb,
      s.kneeDb,
      s.ratio,
    );
    const roundTripDb = makeup + 20 * Math.log10(compensation);
    expect(Math.abs(roundTripDb)).toBeLessThan(1e-9);
  });
});
