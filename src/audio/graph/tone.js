/**
 * Tonal EQ and saturation.
 *
 * ── Filter frequencies ───────────────────────────────────────────────────────────────
 * The audited UI and the audited DSP disagreed: "Warmth — low shelf 170 Hz" was a shelf at
 * 120 Hz, "Body — peaking 700 Hz" was at 350 Hz, "Clarity — presence shelf 5 kHz" was a
 * peaking filter. Every band is now defined **once**, here, and the UI renders its labels
 * from this table — so they cannot drift apart again.
 *
 * ── Saturation ───────────────────────────────────────────────────────────────────────
 * A `WaveShaperNode` with a generated transfer curve. The curve design is inherited from
 * the original engine because it was already unusually careful, and its reasoning is worth
 * keeping:
 *
 *   · Drive scales 1…1.8 — gentle enough to stay in the "density" region rather than
 *     the "crunch" region. Clean mastering presets leave this at or near zero; the
 *     control exists for colour, not for loudness.
 *   · Asymmetry is introduced as `x + a·(x² − x⁴)`, whose integral over [−1, 1] is
 *     approximately zero, so even harmonics appear without a DC shift.
 *   · Any residual DC is measured and subtracted from the curve.
 *   · The curve is peak-normalised, so turning up saturation adds harmonics but not level.
 *     Gain and character stay independent controls, which is the whole point.
 *   · 4096 points to keep the WaveShaper's internal interpolation error below the
 *     harmonic content it is generating.
 *
 * ── Aliasing ─────────────────────────────────────────────────────────────────────────
 * `WaveShaperNode.oversample = '4x'` is set, but the specification does not define the
 * quality of that oversampling and implementations differ. A tanh-family curve generates
 * harmonics without limit, so 4× is not enough at high drive. Two mitigations:
 *   · A pre-shaper gain reduction (up to −3.1 dB at full drive) keeps the signal in the
 *     gentler part of the curve, with matching make-up after.
 *   · A post-shaper low-pass tightens from 22 kHz to 17.5 kHz as drive rises, removing
 *     the top of the aliased region.
 * These reduce audible aliasing; they do not eliminate it. `docs/LIMITATIONS.md` says so.
 */

import { clamp } from '../dsp/math.js';

/**
 * The tonal EQ band definitions. `key` is the parameter name; `label` and `hint` are what
 * the UI shows. Changing a frequency here changes the DSP *and* the label together.
 */
export const TONE_BANDS = Object.freeze([
  { key: 'sub', type: 'lowshelf', freq: 55, q: 0.7071, label: 'Sub', hint: 'low shelf 55 Hz' },
  {
    key: 'warm',
    type: 'lowshelf',
    freq: 120,
    q: 0.7071,
    label: 'Warmth',
    hint: 'low shelf 120 Hz',
  },
  { key: 'body', type: 'peaking', freq: 350, q: 0.7, label: 'Body', hint: 'peaking 350 Hz, Q 0.7' },
  {
    key: 'harsh',
    type: 'peaking',
    freq: 2800,
    q: 1.2,
    label: 'Harshness',
    hint: 'peaking 2.8 kHz, Q 1.2',
  },
  {
    key: 'clarity',
    type: 'peaking',
    freq: 5000,
    q: 0.8,
    label: 'Clarity',
    hint: 'peaking 5 kHz, Q 0.8',
  },
  {
    key: 'air',
    type: 'highshelf',
    freq: 12000,
    q: 0.7071,
    label: 'Air',
    hint: 'high shelf 12 kHz',
  },
]);

/** Tilt pivot frequency — one shelf up, one down, hinged here. */
export const TILT_PIVOT_HZ = 1000;

/** Identity transfer curve: a straight line from −1 to +1. */
export const IDENTITY_CURVE = (() => {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = (i / (n - 1)) * 2 - 1;
  return c;
})();

/**
 * Generate a saturation transfer curve.
 *
 * @param {number} amount 0..1
 * @returns {Float32Array} 4096-point curve, peak-normalised, DC-free
 */
export function makeSaturationCurve(amount) {
  if (amount <= 0) return IDENTITY_CURVE;
  const n = 4096;
  const c = new Float32Array(n);
  const k = 1 + amount * 0.8; // drive 1 … 1.8
  const asym = amount * 0.04; // even-harmonic asymmetry

  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    // Bias-free asymmetric pre-distortion: ∫(x² − x⁴)dx over [−1,1] ≈ 0.
    const xs = x + asym * (x * x - x * x * x * x);
    const t = Math.tanh(k * xs);
    // Accelerating wet blend: small amounts stay nearly linear, so the control has
    // usable resolution at the bottom of its range.
    const blend = 1 - (1 - amount) * (1 - amount);
    c[i] = (1 - blend) * x + blend * t;
  }

  // Remove DC introduced by the asymmetry.
  let sum = 0;
  for (let i = 0; i < n; i++) sum += c[i];
  const dc = sum / n;
  for (let i = 0; i < n; i++) c[i] -= dc;

  // Peak-normalise so saturation is character, never level.
  let peak = 0;
  for (let i = 0; i < n; i++) if (Math.abs(c[i]) > peak) peak = Math.abs(c[i]);
  if (peak > 0 && peak !== 1) for (let i = 0; i < n; i++) c[i] /= peak;

  return c;
}

/**
 * Pre-shaper attenuation and post-shaper make-up for a given drive amount.
 * Exported so the render report can state the exact gain staging used.
 */
export function saturationGainStaging(amount) {
  return {
    preGain: 1 - amount * 0.35, // up to −3.1 dB into the shaper
    postGain: 1 + amount * 0.12, // restrained make-up; saturation is character, not level
    postLowpassHz: 22000 - amount * 6000,
  };
}

/**
 * Build the tone + saturation section.
 * @param {BaseAudioContext} ctx
 */
export function buildTone(ctx) {
  const input = ctx.createGain();

  /** @type {Record<string, BiquadFilterNode>} */
  const bands = {};
  let node = input;
  for (const band of TONE_BANDS) {
    const f = ctx.createBiquadFilter();
    f.type = band.type;
    f.frequency.value = band.freq;
    f.Q.value = band.q;
    f.gain.value = 0;
    node.connect(f);
    node = f;
    bands[band.key] = f;
  }

  const tiltLow = ctx.createBiquadFilter();
  tiltLow.type = 'lowshelf';
  tiltLow.frequency.value = TILT_PIVOT_HZ;
  const tiltHigh = ctx.createBiquadFilter();
  tiltHigh.type = 'highshelf';
  tiltHigh.frequency.value = TILT_PIVOT_HZ;
  node.connect(tiltLow);
  tiltLow.connect(tiltHigh);

  const output = ctx.createGain();
  tiltHigh.connect(output);

  return { input, output, bands, tiltLow, tiltHigh };
}

/**
 * Build the saturation stage (DC block → pre-gain → shaper → post low-pass → make-up).
 * @param {BaseAudioContext} ctx
 */
export function buildSaturation(ctx) {
  // 5 Hz high-pass: kills any subsonic DC the asymmetric curve could otherwise amplify,
  // which would eat headroom invisibly.
  const dcBlock = ctx.createBiquadFilter();
  dcBlock.type = 'highpass';
  dcBlock.frequency.value = 5;
  dcBlock.Q.value = 0.7071;

  const preGain = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  shaper.curve = IDENTITY_CURVE;
  shaper.oversample = '4x';
  const postLowpass = ctx.createBiquadFilter();
  postLowpass.type = 'lowpass';
  postLowpass.frequency.value = 22000;
  postLowpass.Q.value = 0.7071;
  const makeup = ctx.createGain();

  dcBlock.connect(preGain);
  preGain.connect(shaper);
  shaper.connect(postLowpass);
  postLowpass.connect(makeup);

  return { input: dcBlock, output: makeup, preGain, shaper, postLowpass, makeup, _amount: -1 };
}

/**
 * @param {ReturnType<typeof buildTone>} n
 * @param {object} p
 * @param {boolean} [p.bypass]
 */
export function applyTone(n, p) {
  for (const band of TONE_BANDS) {
    let value = p.bypass ? 0 : (p[band.key] ?? 0);
    // The binaural "spread" control lifts air as part of its perceptual widening.
    if (band.key === 'air' && !p.bypass && p.binaural) value += p.spread * 1.5;
    n.bands[band.key].gain.value = value;
  }
  const tilt = p.bypass ? 0 : p.tilt;
  // `|| 0` normalises negative zero so a neutral chain reports exactly 0 dB everywhere.
  n.tiltLow.gain.value = -tilt || 0;
  n.tiltHigh.gain.value = tilt || 0;
}

/**
 * @param {ReturnType<typeof buildSaturation>} n
 * @param {object} p
 * @param {number} p.sat 0..100
 * @param {boolean} [p.bypass]
 */
export function applySaturation(n, p) {
  const amount = p.bypass ? 0 : clamp(p.sat, 0, 100) / 100;
  if (n._amount !== amount) {
    n.shaper.curve = makeSaturationCurve(amount);
    n._amount = amount;
  }
  const staging = saturationGainStaging(amount);
  n.preGain.gain.value = staging.preGain;
  n.postLowpass.frequency.value = staging.postLowpassHz;
  n.makeup.gain.value = staging.postGain;
}
