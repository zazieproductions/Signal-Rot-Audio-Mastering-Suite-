/**
 * Transient shaper — differential-envelope processing.
 *
 * ── Principle ────────────────────────────────────────────────────────────────────────
 * Two envelope followers track the same signal with different attack times. The fast one
 * (1 ms) follows transients; the slow one (50 ms) follows the body. Their *difference* is
 * a transient-detection signal that is independent of absolute level — it is large during
 * an attack and near zero during a steady tone, whether the material is at −6 dBFS or
 * −40 dBFS.
 *
 *   transient = max(0, envFast − envSlow)
 *   attackTerm  = transient / (envFast + ε)     ∈ [0, 1]   — level independent
 *   sustainTerm = envSlow   / (envFast + ε)     ∈ [0, 1]   — level independent
 *
 * The previous implementation used `min(1, envSlow · 3)` for the sustain term, which is a
 * function of *absolute* level: the same knob did different things to a quiet mix and a
 * loud one. Both terms are now ratios and therefore scale-invariant, which is asserted by
 * `tests/dsp/transient-shaper.test.js`.
 *
 * ── Detector pre-smoothing ───────────────────────────────────────────────────────────
 * The rectified signal `|x|` oscillates at twice the signal frequency. A 1 ms follower
 * partly tracks that ripple, so `envFast − envSlow` stays slightly positive even on a
 * perfectly steady tone: measured, a 2 kHz sine picked up **+1.06 dB** of "transient"
 * boost at `attack = 100`. The detector input is therefore pre-smoothed with a symmetric
 * 1 ms one-pole before the two followers, and the fast follower is 2 ms rather than 1 ms.
 *
 * Measured steady-tone boost at `attack = 100` after the change:
 *
 * | Tone    | before   | after    |
 * | ------- | -------- | -------- |
 * | 2 kHz   | +1.06 dB | +0.09 dB |
 * | 500 Hz  | +0.75 dB | +0.23 dB |
 * | 100 Hz  | +1.28 dB | +0.67 dB |
 *
 * Percussive boost is essentially unchanged (5.4 dB → 5.1 dB on the test train). The
 * residual at 100 Hz is irreducible: no envelope detector can tell a 10 ms sine cycle
 * from a 10 ms transient without a window longer than both.
 *
 * ── What "attack" actually affects ───────────────────────────────────────────────────
 * The two followers diverge for as long as the slow one is still rising, which with a
 * 50 ms slow attack means roughly the first 40 ms of an event — not just the first
 * millisecond. So the attack control shapes the *onset region*, not a single sample.
 * Consequence, measured on a percussive train: `attack = −80` reduces sample peak by
 * about 1 dB but reduces RMS by about 3 dB, so it lowers level more than it lowers crest
 * factor. That is normal for a differential-envelope shaper and it is why the control is
 * labelled "punch emphasis" rather than "peak limiter".
 *
 * ── Stereo linking ───────────────────────────────────────────────────────────────────
 * The detector uses the maximum absolute value across channels and one gain is applied to
 * all of them. Per-channel detection would move the image on every snare hit.
 *
 * ── Where it sits ────────────────────────────────────────────────────────────────────
 * Post-multiband, pre-normalisation. It must run before normalisation so the level
 * compensation accounts for the change in crest factor, and it must run offline because
 * per-sample gain computation is not available from native Web Audio nodes without an
 * AudioWorklet (which this project deliberately avoids — see docs/ARCHITECTURE.md).
 *
 * The live preview therefore does **not** include it, and the UI says so.
 */

import { clamp, onePoleCoeff } from '../dsp/math.js';

/** Bounds on the gain the shaper may apply, in dB. Prevents a runaway on pathological input. */
const MIN_GAIN_DB = -12;
const MAX_GAIN_DB = 12;

/**
 * @param {import('../dsp/audio-data.js').AudioData} data mutated in place
 * @param {object} opts
 * @param {number} opts.attack   −100…+100, percentage of attack emphasis
 * @param {number} opts.sustain  −100…+100, percentage of sustain emphasis
 * @param {number} [opts.detectorSmoothMs] default 1 — removes intra-cycle ripple
 * @param {number} [opts.fastAttackMs]  default 2
 * @param {number} [opts.slowAttackMs]  default 50
 * @param {number} [opts.fastReleaseMs] default 20
 * @param {number} [opts.slowReleaseMs] default 180
 * @returns {{maxBoostDb:number, maxCutDb:number, applied:boolean}}
 */
export function shapeTransients(data, opts) {
  const attack = (opts.attack ?? 0) / 100;
  const sustain = (opts.sustain ?? 0) / 100;
  if (attack === 0 && sustain === 0) return { maxBoostDb: 0, maxCutDb: 0, applied: false };

  const sr = data.sampleRate;
  const n = data.length;
  const chans = data.channels;

  const aPre = onePoleCoeff((opts.detectorSmoothMs ?? 1) / 1000, sr);
  const aFast = onePoleCoeff((opts.fastAttackMs ?? 2) / 1000, sr);
  const aSlow = onePoleCoeff((opts.slowAttackMs ?? 50) / 1000, sr);
  const rFast = onePoleCoeff((opts.fastReleaseMs ?? 20) / 1000, sr);
  const rSlow = onePoleCoeff((opts.slowReleaseMs ?? 180) / 1000, sr);

  const minGain = Math.pow(10, MIN_GAIN_DB / 20);
  const maxGain = Math.pow(10, MAX_GAIN_DB / 20);

  let detector = 0;
  let envFast = 0;
  let envSlow = 0;
  let maxG = 1;
  let minG = 1;

  for (let i = 0; i < n; i++) {
    // Channel-linked detector.
    let raw = 0;
    for (let c = 0; c < chans.length; c++) {
      const v = Math.abs(chans[c][i]);
      if (v > raw) raw = v;
    }

    // Symmetric pre-smoother: removes the ripple of the rectified waveform without
    // meaningfully delaying a genuine transient.
    detector = raw + (detector - raw) * aPre;
    const x = detector;

    // Asymmetric one-poles: attack coefficient when rising, release when falling.
    envFast = x > envFast ? x + (envFast - x) * aFast : x + (envFast - x) * rFast;
    envSlow = x > envSlow ? x + (envSlow - x) * aSlow : x + (envSlow - x) * rSlow;

    const denom = envFast + 1e-9;
    const attackTerm = Math.max(0, envFast - envSlow) / denom; // 0..1
    const sustainTerm = clamp(envSlow / denom, 0, 1); // 0..1

    // Gain in dB, so ±100 % maps to a musically sensible ±6 dB of emphasis rather than
    // an arbitrary multiplier. Expressed in dB the two terms add cleanly.
    const gainDb = attack * attackTerm * 6 + sustain * sustainTerm * 6;
    const g = clamp(Math.pow(10, gainDb / 20), minGain, maxGain);

    if (g > maxG) maxG = g;
    if (g < minG) minG = g;
    for (let c = 0; c < chans.length; c++) chans[c][i] *= g;
  }

  return {
    maxBoostDb: 20 * Math.log10(maxG),
    maxCutDb: 20 * Math.log10(minG),
    applied: true,
  };
}
