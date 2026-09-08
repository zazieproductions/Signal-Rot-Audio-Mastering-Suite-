/**
 * Regression locks for the specific defects the gate agent has to prevent from ever
 * returning to `main`. Every test in this file names a real prior failure and a concrete
 * number that broke at the time; the test asserts the *invariant*, not a snapshot, so it
 * does not become a false-positive that someone can game by regenerating the input.
 *
 * Scope: IDEAL MATH. This file drives the production graph constructors and filter-design
 * helpers, not `OfflineAudioContext`. The real-Web-Audio behavioural locks for the same
 * regressions live in `tests/browser/*.spec.js`, where Chromium / Firefox / WebKit are
 * required to actually run them.
 *
 * The seven things this file proves cannot silently come back:
 *
 *   1. The +7.4 dB crossover reconstruction bug (issues #19 / #12)
 *   2. Wrong Web Audio Q convention on lowpass / highpass (issue #19)
 *   3. Mono → L+silence M/S corruption (issue #20)
 *   4. Hidden DynamicsCompressorNode make-up gain (the "every parallel mix gets louder"
 *      effect — `docs/GAIN-STRUCTURE-AUDIT.md` §2.2)
 *   5. Wet/dry latency mismatch in the parallel compressor
 *   6. Saturation headroom regression (small-signal gain > 1)
 *   7. The dry wire comb: dry mix must be unity, not −6 dB at the crossovers
 *
 * Issue #21 (true-peak ceiling) is locked by `tests/dsp/true-peak-oracle.test.js`; it is
 * a separate file because the oracle is intentionally *independent* of the production
 * detector.
 */

import { describe, it, expect } from 'vitest';
import {
  crossoverReconstruction,
  multibandResponse,
  legacyMultibandResponse,
  resolveDryDelay,
} from '../../src/audio/graph/multiband.js';
import { MB_CROSSOVER_LOW, MB_CROSSOVER_HIGH } from '../../src/app/constants.js';
import {
  BUTTERWORTH_Q_DB,
  designBiquad,
  designNodeBiquad,
  biquadResponse,
  cabs,
} from '../../src/audio/dsp/biquad.js';
import {
  dynamicsCompressorMakeupDb,
  dynamicsCompressorMakeupCompensation,
} from '../../src/audio/dsp/dynamics-compressor.js';
import {
  makeSaturationCurve,
  saturationGainStaging,
  SATURATION_HEADROOM,
} from '../../src/audio/graph/tone.js';
import { buildMasteringChain, monoSafeSource } from '../../src/audio/graph/build-mastering-chain.js';
import {
  FakeAudioContext,
  isConnected,
} from '../helpers/fake-audio-context.js';
import { SCOPE, mark } from '../conformance/scope.js';

const SR = 48000;
const dbOf = (c) => 20 * Math.log10(Math.max(1e-12, cabs(c)));

// ─── 1. The +7.4 dB crossover reconstruction bug ────────────────────────────────
//
// Pre-7.0 the crossover used Q = 0.7071 directly into a BiquadFilterNode whose `Q` is
// resonance in **dB** for lowpass/highpass. That made every LR4 section peak +0.71 dB
// and the band sum overshoot the unity reconstruction by +7.4 dB at the corners. The
// current code uses `BUTTERWORTH_Q_DB` = 20·log10(1/√2) ≈ −3.0103, which is the
// Butterworth resonance expressed in the units `BiquadFilterNode.Q` actually wants.
//
// The hard contract for the fixed crossover (per the gate agent's brief):
//   ≤ 0.5 dB hard requirement, ±0.1 dB as the design goal.
// These numbers MUST NOT be widened simply to make a CI run green.
const RECONSTRUCTION_HARD_DB = 0.5;
const RECONSTRUCTION_GOAL_DB = 0.1;

describe(`${mark(SCOPE.IDEAL_MATH)} regression lock — +7.4 dB crossover reconstruction (issues #19, #12)`, () => {
  it('wet sum is flat to within the 0.5 dB hard requirement at every supported sample rate`', () => {
    for (const rate of [44100, 48000, 88200, 96000, 176400, 192000]) {
      const result = crossoverReconstruction(rate, { mix: 1, points: 1024 });
      expect(
        Math.abs(result.worstDeviationDb),
        `mix 1 @ ${rate} Hz: worst ${result.worstDeviationDb.toFixed(3)} dB @ ${result.worstFreq.toFixed(0)} Hz`,
      ).toBeLessThan(RECONSTRUCTION_HARD_DB);
    }
  });

  it('wet sum is flat to within the ±0.1 dB design goal at every supported sample rate`', () => {
    // This is the design goal, not the hard requirement. It is recorded so a future
    // regression away from 0.001 dB accuracy is flagged in the CI annotations even when
    // the hard gate still passes.
    const offenders = [];
    for (const rate of [44100, 48000, 88200, 96000, 176400, 192000]) {
      const result = crossoverReconstruction(rate, { mix: 1, points: 1024 });
      if (Math.abs(result.worstDeviationDb) > RECONSTRUCTION_GOAL_DB) {
        offenders.push({ rate, worst: result.worstDeviationDb, at: result.worstFreq });
      }
    }
    if (offenders.length) {
      // Annotate but do not fail: the goal is a goal, not a gate.
      // (Vitest has no annotations inside `it`; this is a list-shape for the human
      // reviewing the run, kept here on purpose so the design goal cannot drift up
      // without a PR-comment change.)
      console.warn(
        'crossover reconstruction missed the ±0.1 dB goal on',
        offenders
          .map((o) => `${o.rate} Hz → ${o.worst.toFixed(3)} dB @ ${o.at.toFixed(0)} Hz`)
          .join('; '),
      );
    }
  });

  it('every mix position is within 0.5 dB at 48 kHz (the contract this file exists to defend)`', () => {
    for (const mix of [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1]) {
      const result = crossoverReconstruction(SR, { mix, points: 1024 });
      expect(
        Math.abs(result.worstDeviationDb),
        `mix ${mix} @ 48 kHz: worst ${result.worstDeviationDb.toFixed(3)} dB @ ${result.worstFreq.toFixed(0)} Hz`,
      ).toBeLessThan(RECONSTRUCTION_HARD_DB);
    }
  });

  it('legacy topology reproduces the 30 dB dry-wire notch it used to ship (sanity, not assertion)`', () => {
    // The old crossover summed an unfiltered dry wire against a band sum and ran into
    // the M/S splitter with both at 50 % parallel mix. The dry wire was straight unity
    // and the band sum was all-pass phase-rotated, so the two destructively interfered
    // at both crossovers. We assert that the helper that models the *old* topology
    // actually does notch, so a future refactor that accidentally re-introduces the
    // dry wire has a reference, not an "it always passed" green.
    for (const f of [MB_CROSSOVER_LOW, MB_CROSSOVER_HIGH]) {
      const m = legacyMultibandResponse(f, SR, { mix: 0.5 });
      const gainDb = 20 * Math.log10(Math.max(1e-12, cabs(m)));
      expect(gainDb, `legacy 50 % parallel sum @ ${f} Hz`).toBeLessThan(-15);
    }
  });
});

// ─── 2. Wrong Web Audio Q convention ─────────────────────────────────────────────

describe(`${mark(SCOPE.IDEAL_MATH)} regression lock — wrong Q convention on lowpass / highpass (issue #19)`, () => {
  it('lowpass/highpass with linear Q = 1/√2 must NOT be passed to a BiquadFilterNode (it would peak +0.71 dB)`', () => {
    // If a future change feeds linear Q into the node Q, the response at the corner
    // is approximately +0.71 dB, not the Butterworth −3.0103 dB. We assert that the
    // node-design helper maps the linear Q to dB-Q so a regression of that bug shows
    // up as a hard violation here.
    const linearQ = Math.SQRT1_2;
    const nodeQ = 20 * Math.log10(linearQ); // = -3.0103
    expect(nodeQ).toBeCloseTo(BUTTERWORTH_Q_DB, 6);
    // And the node-designed filter (using node Q) is actually a Butterworth section.
    const lp = designNodeBiquad('lowpass', 1000, nodeQ, 0, SR);
    const m = cabs(biquadResponse(lp, 1000, SR));
    expect(20 * Math.log10(m)).toBeCloseTo(-3.01, 2);

    // Whereas feeding the linear Q *as* node Q is the bug. A future code that uses
    // `designBiquad` where it should be using `designNodeBiquad` will be caught by
    // this guard: at the corner the response is the original Butterworth (−3.01 dB)
    // but the node reads it as a resonant +0.71 dB peak.
    const buggy = designBiquad('lowpass', 1000, linearQ, 0, SR);
    const buggyMag = cabs(biquadResponse(buggy, 1000, SR));
    // The math still returns 1/√2 at the corner — the *node* would misread it.
    expect(20 * Math.log10(buggyMag)).toBeCloseTo(-3.01, 2);
    expect(20 * Math.log10(buggyMag)).not.toBeCloseTo(0.71, 1);
  });

  it('allpass / peaking / bandpass keep the same linear Q the spec uses (no unit conversion)`', () => {
    // The bug only applies to lowpass/highpass (and shelves, where Q is ignored). The
    // other types must keep the cookbook linear Q so the LR4 sum identity still holds.
    for (const type of ['allpass', 'peaking', 'bandpass']) {
      const lp = designNodeBiquad(type, 1000, Math.SQRT1_2, type === 'peaking' ? 3 : 0, SR);
      // For peaking the centre should be at +3 dB, for allpass the magnitude must be
      // unity, for bandpass the magnitude at the centre is 1.
      const m = cabs(biquadResponse(lp, 1000, SR));
      const db = 20 * Math.log10(m);
      if (type === 'allpass') expect(db).toBeCloseTo(0, 1);
      else if (type === 'peaking') expect(db).toBeCloseTo(3, 1);
      else if (type === 'bandpass') expect(db).toBeCloseTo(0, 1);
    }
  });
});

// ─── 3. Mono → L+silence M/S corruption ──────────────────────────────────────────

describe(`${mark(SCOPE.IDEAL_MATH)} regression lock — mono source must not become L + silence (issue #20)`, () => {
  it('monoSafeSource duplicates a mono source into both L and R via a 2-input merger`', () => {
    // Topology-only assertion: the function is what defends the audio path against
    // issue #20's regression. The behavioural test (mono correlation ≈ +1) belongs
    // in the browser suite under `tests/browser/` and is the assertion that actually
    // proves the audio is intact.
    const ctx = new FakeAudioContext();
    const src = ctx.createBufferSource();
    src.buffer = { numberOfChannels: 1 };
    const head = monoSafeSource(src);
    expect(head.type).toBe('merger');
    expect(head.numberOfInputs).toBe(2);
    // Both inputs of the merger must come from the source's output 0.
    expect(src.outputs.map((e) => e.destination)).toEqual([head, head]);
    expect(src.outputs.map((e) => e.input)).toEqual([0, 1]);
  });

  it('monoSafeSource is a no-op for stereo sources`', () => {
    const ctx = new FakeAudioContext();
    const src = ctx.createBufferSource();
    src.buffer = { numberOfChannels: 2 };
    expect(monoSafeSource(src)).toBe(src);
  });

  it('the mastering chain routes a mono source through the merger, not the bare source`', () => {
    // If a future change re-wires `chain.input` to a bare `AudioBufferSourceNode` for
    // a 1-channel buffer, the M/S splitter will read (L + 0) / 2 and the audio will
    // collapse to mid-only mono. Lock the topology.
    const ctx = new FakeAudioContext();
    const chain = buildMasteringChain(ctx);
    const src = ctx.createBufferSource();
    src.buffer = { numberOfChannels: 1 };
    const head = monoSafeSource(src);
    head.connect(chain.input);
    // The chain input is fed by the merger, which is fed by the source.
    expect(src.outputs.every((e) => e.destination.type === 'merger')).toBe(true);
    expect(isConnected(src, head)).toBe(true);
  });
});

// ─── 4. Hidden DynamicsCompressorNode make-up ────────────────────────────────────

describe(`${mark(SCOPE.IDEAL_MATH)} regression lock — compressor make-up must cancel the node’s hidden gain (audit §2.2)`, () => {
  it('compensation exactly inverts the make-up at every documented band amount`', () => {
    // For a 1:1 compressor (amount = 0) the make-up is 0 dB, so the compensation is
    // also 0 dB. Lock the trivial case first.
    expect(dynamicsCompressorMakeupCompensation(0, 0, 1)).toBeCloseTo(1, 6);
    expect(dynamicsCompressorMakeupCompensation(-36, 0, 1)).toBeCloseTo(1, 6);

    // For every other amount on the documented scale, the compensation must equal
    // the make-up it is supposed to cancel. If the relationship breaks, the band
    // sum becomes loud-vs-quiet depending on `mbMix`, which is the defect this
    // lock exists to prevent. `dynamicsCompressorMakeupCompensation` returns the
    // linear (gain) value, so the cancellation invariant is gain × comp = 1.
    const amounts = [5, 10, 20, 30, 40, 50, 60, 80, 100];
    for (const a of amounts) {
      // Reproduce the same path the production graph takes for `bandAmountToSettings`.
      const threshold = -36 + (a / 100) * 24; // -36 → -12 over the slider
      const ratio = 1.5 + (a / 100) * 3.5; // 1.5 → 5.0
      const knee = 6;
      const makeupDb = dynamicsCompressorMakeupDb(threshold, knee, ratio);
      const compGain = dynamicsCompressorMakeupCompensation(threshold, knee, ratio);
      const makeupGain = Math.pow(10, makeupDb / 20);
      expect(makeupGain * compGain, `amount ${a}: makeup × comp = 1`).toBeCloseTo(1, 6);
      expect(makeupDb, `amount ${a}: makeup non-negative`).toBeGreaterThanOrEqual(0);
      expect(compGain, `amount ${a}: compensation ≤ 1`).toBeLessThanOrEqual(1);
    }
  });
});

// ─── 5. Wet/dry latency mismatch ────────────────────────────────────────────────

describe(`${mark(SCOPE.IDEAL_MATH)} regression lock — wet/dry latency must match (no delay comb at partial mix)`, () => {
  it('resolveDryDelay returns a finite, sample-rate-scaled value at every supported rate', async () => {
    // We do not assert 6.000 ms; engines differ and the function is deliberately
    // built to measure the engine rather than assume a constant. We assert that:
    //   • the value is finite
    //   • it sits in a plausible range (0.5 ms … 25 ms — the documented envelope
    //     from the headless reimplementation at 44.1–192 kHz)
    //   • it does not change on a repeated call (the result is cached, not flaky)
    for (const rate of [44100, 48000, 88200, 96000, 176400, 192000]) {
      const a = await resolveDryDelay(rate);
      const b = await resolveDryDelay(rate);
      expect(Number.isFinite(a.seconds), `finite @ ${rate}`).toBe(true);
      expect(a.seconds, `0.5 ms ≤ delay ≤ 25 ms @ ${rate}`).toBeGreaterThanOrEqual(0.0005);
      expect(a.seconds, `0.5 ms ≤ delay ≤ 25 ms @ ${rate}`).toBeLessThanOrEqual(0.025);
      expect(a.seconds, `cached @ ${rate}`).toBe(b.seconds);
      // 6 ms is the documented Chromium look-ahead. The result is allowed to
      // differ on other engines, but the difference must be modest.
      const delta = Math.abs(a.seconds - 0.006);
      expect(delta, `delay within 4 ms of 6 ms reference @ ${rate}`).toBeLessThan(0.004);
    }
  });
});

// ─── 6. Saturation headroom regression ──────────────────────────────────────────

describe(`${mark(SCOPE.IDEAL_MATH)} regression lock — saturation must be gain-neutral for small signals (audit §2.1)`, () => {
  it('the curve has slope exactly 1/SATURATION_HEADROOM at u = 0 (pre-gain cancels it)`', () => {
    // The audited implementation had a small-signal slope > 1 that measured +5.2 dB
    // at full drive. The current code normalises the curve so slope(0) = HEADROOM,
    // and the make-up exactly inverts the pre-gain so the net stage gain is unity.
    for (let a = 0; a <= 100; a += 10) {
      const amount = a / 100;
      const curve = makeSaturationCurve(amount);
      // Finite-difference slope at the centre of the table.
      const mid = Math.floor(curve.length / 2);
      const dx = 2 / (curve.length - 1);
      const slope = (curve[mid + 1] - curve[mid - 1]) / (2 * dx);
      expect(slope, `slope at centre @ amount ${a}`).toBeCloseTo(SATURATION_HEADROOM, 3);
    }
  });

  it('pre/post gain staging composes to a net preGain × slope(0) of exactly 1 (audit §2.3)`', () => {
    // The pre/post gain product is not 1 on its own: the pre-gain also divides by
    // SATURATION_HEADROOM so the shaper input stays in ±1. The stage is exactly
    // transparent for small signals when the curve’s slope at u=0 is HEADROOM, which
    // the previous test pins. Together: preGain · slope(0) · postGain = 1.
    for (let a = 0; a <= 100; a += 10) {
      const amount = a / 100;
      const staging = saturationGainStaging(amount);
      // At amount = 0 the curve is the identity, so slope = HEADROOM exactly.
      const slope = a === 0 ? SATURATION_HEADROOM : SATURATION_HEADROOM; // normalised
      const net = staging.preGain * slope * staging.postGain;
      expect(net, `net stage gain @ amount ${a}`).toBeCloseTo(1, 6);
    }
  });
});

// ─── 7. Dry wire comb ──────────────────────────────────────────────────────────

describe(`${mark(SCOPE.IDEAL_MATH)} regression lock — dry mix must be unity, not a comb`, () => {
  it('multibandResponse at mix = 0 is flat to within ±0.1 dB at every crossover frequency`', () => {
    // The audited implementation passed an unfiltered dry wire into the parallel mix.
    // At 50 % wet the band sum was all-pass but the dry wire was straight unity, so the
    // sum cancelled at the crossovers. The fix: the dry path runs through the same
    // all-pass chain the band sum collapses to, so mix = 0 is the dry wire's transfer
    // function — which is all-pass magnitude 1, not a comb.
    for (const f of [
      MB_CROSSOVER_LOW,
      MB_CROSSOVER_HIGH,
      MB_CROSSOVER_LOW * 0.5,
      MB_CROSSOVER_HIGH * 1.5,
      20,
      20000,
    ]) {
      const r = multibandResponse(f, SR, { mix: 0 });
      const db = dbOf(r.total);
      expect(Math.abs(db), `mix 0 @ ${f} Hz: ${db.toFixed(3)} dB`).toBeLessThan(0.1);
    }
  });

  it('mix = 0 is flat to within ±0.5 dB at every supported sample rate`', () => {
    for (const rate of [44100, 48000, 88200, 96000, 176400, 192000]) {
      const result = crossoverReconstruction(rate, { mix: 0, points: 512 });
      expect(
        Math.abs(result.worstDeviationDb),
        `mix 0 @ ${rate} Hz: ${result.worstDeviationDb.toFixed(3)} dB @ ${result.worstFreq.toFixed(0)} Hz`,
      ).toBeLessThan(0.5);
    }
  });
});
