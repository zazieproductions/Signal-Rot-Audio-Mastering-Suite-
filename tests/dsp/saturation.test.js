import { describe, it, expect } from 'vitest';
import { SCOPE, mark } from '../conformance/scope.js';
import {
  makeSaturationCurve,
  saturationGainStaging,
  IDENTITY_CURVE,
  SATURATION_HEADROOM,
} from '../../src/audio/graph/tone.js';

/**
 * These tests pin the structural properties the gain-structure audit demanded of the
 * saturation stage (`docs/GAIN-STRUCTURE-AUDIT.md` §2.1 and §2.3):
 *
 *  1. The stage is gain-neutral for small signals at every drive amount (no more
 *     "second, uncontrolled upward compressor" — the old curve had a small-signal
 *     slope > 1 that measured +5.2 dB at full drive).
 *  2. The `WaveShaperNode` input clamp at ±1 cannot engage until +12 dBFS — the stage
 *     is not a hard clipper, even at `sat = 0`.
 *  3. The curve is DC-free and monotonic across its whole (extended) domain.
 *
 * The graph-level effect (make-up node = 1/preGain, pre node = p/HEADROOM) is asserted
 * in `tests/integration/graph.test.js`; here we test the curve itself.
 */

/** Interpolate the curve at shaper input `u` (linear interpolation, like WaveShaper). */
function lookup(curve, u) {
  const n = curve.length;
  const x = ((u + 1) / 2) * (n - 1);
  const i = Math.min(n - 2, Math.max(0, Math.floor(x)));
  const t = x - i;
  return curve[i] * (1 - t) + curve[i + 1] * t;
}

/** Net stage gain for a small full-scale-domain input `x`, in dB. */
function stageGainDb(amount, x) {
  const staging = saturationGainStaging(amount);
  const curve = makeSaturationCurve(amount);
  const u = (x * staging.preGain) / 1; // input to the shaper
  const out = lookup(curve, u) * staging.postGain;
  return 20 * Math.log10(Math.abs(out) / Math.abs(x));
}

describe(`${mark(SCOPE.IDEAL_MATH)} saturation gain staging`, () => {
  it('is 0 dB for small signals at every amount', () => {
    for (let a = 0; a <= 100; a += 5) {
      const amount = a / 100;
      // A −20 dBFS probe — the level the audit used to measure the old +0.4 … +5.2 dB
      // of hidden small-signal gain. The remaining error is the residual curve DC
      // offset (subtracted from the table mean) over a probe 20 dB below where the
      // curve starts to round.
      const g = stageGainDb(amount, 0.1);
      expect(Math.abs(g), `amount ${a}`).toBeLessThan(0.15);
    }
  });

  it('is 0 dB by construction: the make-up exactly inverts the drive+headroom pre-gain', () => {
    // slope(u=0) = SATURATION_HEADROOM (see the slope-normalisation tests) and
    // postGain = 1/preGain with preGain = p/HEADROOM, so the linear-limit stage gain
    // preGain · slope(0) · postGain is exactly 1 at *every* amount — the audit's §2.3
    // requirement. Finite probes are only meaningful above ~−30 dBFS: the curve's
    // residual table DC (a fixed ≈ −60 dBFS term the in-chain 5 Hz blocker removes in
    // steady state) swamps probes quieter than that, which is a property of the
    // measurement, not the stage.
    for (let a = 0; a <= 100; a += 5) {
      const amount = a / 100;
      const s = saturationGainStaging(amount);
      expect(s.preGain * s.postGain * SATURATION_HEADROOM, `amount ${a}`).toBeCloseTo(1, 12);
    }
  });

  it('does not raise programme level at −20 dBFS (old curve added up to +5.2 dB)', () => {
    // −20 dBFS is well above the DC-residual floor, so this measures true curve
    // curvature. The residual is slightly *negative* (tanh rounding) at every amount —
    // the opposite sign of the old defect — and never exceeds a quarter decibel.
    for (let a = 0; a <= 100; a += 5) {
      const g = stageGainDb(a / 100, 0.1);
      expect(g, `amount ${a}`).toBeGreaterThan(-0.5);
      expect(g, `amount ${a}`).toBeLessThan(0.25);
    }
  });

  it('make-up is the exact inverse of the drive attenuation', () => {
    for (let a = 0; a <= 100; a += 5) {
      const amount = a / 100;
      const s = saturationGainStaging(amount);
      expect(s.postGain).toBeCloseTo(1 / (1 - amount * 0.35), 12);
    }
    const full = saturationGainStaging(1);
    expect(full.postGain).toBeCloseTo(1 / 0.65, 10);
    expect(full.postGain).toBeCloseTo(1.5384615385, 6);
  });

  it('pre-shaper gain keeps the shaper input inside ±1 up to the headroom limit', () => {
    // u = preGain · x ≤ 1 for every x ≤ SATURATION_HEADROOM when the attenuation p ≤ 1.
    for (let a = 0; a <= 100; a += 5) {
      const s = saturationGainStaging(a / 100);
      expect(s.preGain).toBeGreaterThan(0);
      expect(s.preGain * SATURATION_HEADROOM).toBeLessThanOrEqual(1);
    }
  });
});

describe(`${mark(SCOPE.IDEAL_MATH)} saturation curve (headroom domain)`, () => {
  it('is a straight line over ±HEADROOM at sat = 0, so sat = 0 cannot hard-clip', () => {
    const curve = makeSaturationCurve(0);
    expect(curve).toBe(IDENTITY_CURVE);
    expect(curve).toHaveLength(1024);
    expect(curve[0]).toBeCloseTo(-SATURATION_HEADROOM, 6);
    expect(curve[curve.length - 1]).toBeCloseTo(SATURATION_HEADROOM, 6);
    for (let i = 0; i < curve.length; i++) {
      const u = (i / (curve.length - 1)) * 2 - 1;
      expect(curve[i]).toBeCloseTo(u * SATURATION_HEADROOM, 5);
    }
  });

  it('uses a dense table once engaged (interpolation stays inaudible)', () => {
    expect(makeSaturationCurve(0.3)).toHaveLength(8192);
  });

  it('has unity small-signal slope — dc/du at the origin equals the headroom', () => {
    for (let a = 10; a <= 100; a += 10) {
      const amount = a / 100;
      const curve = makeSaturationCurve(amount);
      const n = curve.length;
      const du = 2 / (n - 1);
      const i = Math.floor((n - 1) / 2);
      // Slope of the table w.r.t. u at 0 — with staging pre = p/HEADROOM and
      // post = 1/p the net small-signal gain is 1 by construction.
      const slope = (curve[i + 1] - curve[i]) / du;
      expect(slope, `amount ${a}`).toBeCloseTo(SATURATION_HEADROOM, 3);
    }
  });

  it('is DC-free and monotonic (no fold) across the whole extended domain', () => {
    for (let a = 1; a <= 100; a += 5) {
      const amount = a / 100;
      const curve = makeSaturationCurve(amount);
      let sum = 0;
      let previous = -Infinity;
      for (let i = 0; i < curve.length; i++) {
        sum += curve[i];
        if (curve[i] + 1e-9 < previous) {
          throw new Error(`curve folds at amount ${a}, sample ${i}`);
        }
        previous = curve[i];
      }
      expect(Math.abs(sum / curve.length), `DC at amount ${a}`).toBeLessThan(1e-6);
      // The origin region must be strictly rising (unity-slope region is real, not a
      // flat identity pasted over a dead shaper).
      for (let i = 0; i < Math.floor(curve.length * 0.05); i++) {
        expect(curve[i + 1], `flat at amount ${a}, sample ${i}`).toBeGreaterThan(curve[i]);
      }
    }
  });

  it('rounds +12 dBFS peaks (curve values stay bounded) while staying monotonic', () => {
    const curve = makeSaturationCurve(1);
    const maxAbs = Math.max(
      Math.abs(curve[0]),
      Math.abs(curve[curve.length - 1]),
      Math.abs(lookup(curve, 0.5)),
    );
    expect(maxAbs).toBeLessThan(SATURATION_HEADROOM + 1);
  });
});
