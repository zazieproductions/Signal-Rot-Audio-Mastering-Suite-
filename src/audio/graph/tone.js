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
 *   · Drive scales 1…2.2, not 1…4 — gentle enough to stay in the "density" region rather
 *     than the "crunch" region.
 *   · Asymmetry is introduced as `x + a·(x² − x⁴)`, whose integral over a symmetric
 *     domain is approximately zero, so even harmonics appear without a DC shift.
 *   · Any residual DC is measured and subtracted from the curve.
 *   · The curve is **small-signal-slope-normalised**, so its gain at low level is
 *     exactly 0 dB and turning up saturation changes harmonics and peak rounding — never
 *     level. Gain and character stay independent controls, which is the whole point.
 *
 * ── Headroom — why the stage can no longer hard-clip ─────────────────────────────────
 * `WaveShaperNode` clamps its input to [−1, +1] before the curve lookup, so a curve
 * generated over [−1, 1] is a **hard clipper at 0 dBFS** the moment anything upstream
 * exceeds full scale — and `docs/GAIN-STRUCTURE-AUDIT.md` §2.1 measured that happening
 * on 1–3 % of samples (every transient) with ordinary settings. The fix is structural:
 * the *curve domain* is extended to ±`SATURATION_HEADROOM` (12 dB) and the input gain
 * divides by the same factor, so the shaper implements the identical transfer on the
 * full-scale signal while the clamp cannot engage until +12 dBFS. At `sat = 0` the curve
 * is a straight line across that whole domain — a genuinely transparent path with 12 dB
 * of headroom instead of an identity curve that clipped at ±1.
 *
 * ── Aliasing ─────────────────────────────────────────────────────────────────────────
 * `WaveShaperNode.oversample = '4x'` is set, but the specification does not define the
 * quality of that oversampling and implementations differ. A tanh-family curve generates
 * harmonics without limit, so 4× is not enough at high drive. Two mitigations:
 *   · A pre-shaper gain reduction (up to −3.1 dB at full drive) keeps the signal in the
 *     gentler part of the curve; the make-up after it is exactly `1/preGain`, so the
 *     attenuation is never heard as a level change.
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

/**
 * Shaper headroom above full scale, as a linear multiple. The curve table spans
 * ±`SATURATION_HEADROOM` and the input to the shaper is divided by it, so the
 * `WaveShaperNode`'s ±1 input clamp cannot engage until the signal reaches
 * +20·log10(4) ≈ +12 dBFS — the clipper that destroyed transients before the limiter
 * (see `docs/GAIN-STRUCTURE-AUDIT.md` §2.1) is structurally gone.
 */
export const SATURATION_HEADROOM = 4;

/**
 * Identity transfer curve over the headroom domain: a straight line from
 * −`SATURATION_HEADROOM` to +`SATURATION_HEADROOM`. With the input gain at
 * 1/`SATURATION_HEADROOM` this is exactly transparent up to +12 dBFS and, unlike the
 * old ±1 identity, cannot hard-clip a hot signal.
 */
export const IDENTITY_CURVE = (() => {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = (i / (n - 1)) * 2 - 1;
    c[i] = u * SATURATION_HEADROOM;
  }
  return c;
})();

/** Table points for an engaged curve — 8192 keeps interpolation error inaudible
 *  even though the interesting ±1 region now occupies a quarter of the domain. */
const SATURATION_CURVE_POINTS = 8192;

/**
 * Generate a saturation transfer curve over the headroom domain.
 *
 * The returned array is indexed by the shaper input `u ∈ [−1, 1]` and stores
 * `S(u · SATURATION_HEADROOM)`, so the shaper implements the designed transfer `S` on
 * the *full-scale* signal while its input never needs to exceed ±1 until +12 dBFS.
 * `S` is DC-free and normalised to unity small-signal slope, which makes the whole
 * stage 0 dB for small signals (see `saturationGainStaging`).
 *
 * @param {number} amount 0..1
 * @returns {Float32Array} DC-free, slope-normalised curve; identity for amount ≤ 0
 */
export function makeSaturationCurve(amount) {
  if (amount <= 0) return IDENTITY_CURVE;
  const n = SATURATION_CURVE_POINTS;
  const c = new Float32Array(n);
  const k = 1 + amount * 1.2; // drive 1 … 2.2
  const asym = amount * 0.06; // even-harmonic asymmetry
  const blend = 1 - (1 - amount) * (1 - amount); // accelerating wet blend
  const D = SATURATION_HEADROOM;

  for (let i = 0; i < n; i++) {
    const u = (i / (n - 1)) * 2 - 1;
    const y = u * D; // input to the design transfer, in full-scale units
    // Bias-free asymmetric pre-distortion: ∫(y² − y⁴)dy over a symmetric domain ≈ 0.
    // The distortion is confined to |y| ≤ 1 — its derivative flips sign beyond ~1.6,
    // which would fold the curve back on itself inside the new headroom region.
    const xs = Math.abs(y) > 1 ? y : y + asym * (y * y - y * y * y * y);
    const t = Math.tanh(k * xs);
    // Small amounts stay nearly linear, so the control has usable resolution at the
    // bottom of its range.
    c[i] = (1 - blend) * y + blend * t;
  }

  // Remove DC introduced by the asymmetry (mean over the table).
  let sum = 0;
  for (let i = 0; i < n; i++) sum += c[i];
  const dc = sum / n;
  for (let i = 0; i < n; i++) c[i] -= dc;

  // Normalise to unity *small-signal slope*: raw'(0) = (1 − blend) + blend·k (the
  // asymmetry has zero derivative at 0). The curve's dc/du at the origin then equals
  // SATURATION_HEADROOM exactly, so with the input scaled by 1/HEADROOM and make-up
  // `1/preGain`, small signals pass at 0 dB regardless of `amount`.
  const slope = 1 - blend + blend * k;
  if (slope > 0 && slope !== 1) for (let i = 0; i < n; i++) c[i] /= slope;

  return c;
}

/**
 * Gain staging for a given drive amount. Returned values are what the nodes receive:
 * the pre-shaper gain carries both the drive attenuation (`p`, up to −3.1 dB — an
 * aliasing control, so loud material stays in the gentler part of the curve) and the
 * headroom division; the make-up is exactly `1/p`, so the pair is level-neutral for
 * small signals at every setting. The old `1 + 0.25·amount` make-up sat on top of a
 * curve whose small-signal slope already exceeded 1, silently raising level by up to
 * +5.2 dB (`docs/GAIN-STRUCTURE-AUDIT.md` §2.3).
 */
export function saturationGainStaging(amount) {
  const p = 1 - amount * 0.35; // up to −3.1 dB drive attenuation
  return {
    preGain: p / SATURATION_HEADROOM, // + headroom division (see module header)
    postGain: 1 / p, // exact inverse of the drive attenuation
    postLowpassHz: 22000 - amount * 4500,
    attenuationDb: -20 * Math.log10(Math.max(1e-9, p)),
    makeupDb: 20 * Math.log10(1 / Math.max(1e-9, p)),
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
