/**
 * Level-safe spatial gain laws (§2.9, §4).
 *
 * Pure functions shared by the graph stage and the tests. The old stereo section
 * applied width and crossfeed as plain linear gains, which made width behave like a
 * second loudness control: doubling width doubled side energy, a wide transient could
 * push the master limiter into ducking the centre, and the Haas+width+spread
 * combination had no ceiling at all.
 *
 * The laws here are the *bounded architecture*:
 *
 *   · widthSideGain — soft-knee compression above w = 1 with an asymptotic ceiling
 *     (+6.8 dB of side gain), so extreme width settings add image, not unbounded
 *     energy; w ≤ 1 is passed through exactly (narrowing must stay exact);
 *   · per-band caps keep the low end anchored (a wide low end is a mono hazard and
 *     eats limiter headroom for no perceptual width), while the mid and top bands may
 *     go wider;
 *   · midBalanceGain softens the centre cut of the M/S balance control: even at full
 *     side bias the centre is never dropped more than ~3 dB, and small offsets are
 *     nearly transparent (the old 1 − 0.6·b cut −1 dB of centre at b = 0.18, which is
 *     exactly the sort of "width as loudness" behaviour the audit flagged);
 *   · crossfeedTapGain — bounded, monotone tap law (≈ −10 dB at full setting) instead
 *     of the old unbounded 0.45·x injection into the opposite channel;
 *   · haasWidthScale — when a Haas delay is engaged (itself a mono hazard), the width
 *     side gain is scaled back so pathological width+spread+Haas combinations cannot
 *     stack.
 *
 * All functions are deterministic, unit-tested, and return 1 (identity) for their
 * neutral inputs, so a default preset is bit-identical to the protected baseline.
 */

import { clamp, smoothstep } from '../dsp/math.js';

/** Asymptotic ceiling of the width law: +6.85 dB of side gain, not the old +∞. */
export const WIDTH_MAX_SIDE_GAIN = 2.2;
/** How quickly the law bends toward the ceiling (higher = straighter for longer). */
export const WIDTH_SOFTNESS = 0.8;

/** Per-band side-gain ceilings — the bass anchor of the width section. */
export const SIDE_BAND_CAP = Object.freeze({ low: 1.5, mid: WIDTH_MAX_SIDE_GAIN, high: WIDTH_MAX_SIDE_GAIN });

/** Maximum allowed width-control value (the UI range is wider for creative presets). */
export const WIDTH_CONTROL_MAX = 3;

/** Crossfeed tap gain ceiling: never above ≈ −9.6 dB injection into the opposite side. */
export const CROSSFEED_MAX_TAP_GAIN = 0.33;
/** Control value up to which the classic linear tap law is kept unchanged. */
const CROSSFEED_LINEAR_UP_TO = 0.55;

/**
 * Delivered side gain for a requested width.
 * @param {number} width requested width multiplier (0..WIDTH_CONTROL_MAX)
 */
export function widthSideGain(width) {
  const w = clamp(width, 0, WIDTH_CONTROL_MAX);
  if (w <= 1) return w;
  const span = WIDTH_MAX_SIDE_GAIN - 1;
  return 1 + span * (1 - Math.exp(-WIDTH_SOFTNESS * (w - 1)));
}

/**
 * Ceiling a per-band side gain. `kind` is 'low' | 'mid' | 'high'.
 * @param {number} gain linear per-band side gain
 * @param {'low'|'mid'|'high'} kind
 */
export function capSideBandGain(gain, kind) {
  const cap = SIDE_BAND_CAP[kind] ?? WIDTH_MAX_SIDE_GAIN;
  return gain <= 1 ? gain : Math.min(gain, cap);
}

/**
 * Centre gain of the M/S balance control (side-heavy direction only, b > 0).
 * The old 1 − 0.6·b law dropped the centre by 8 dB at full bias; this law is a dB-space
 * curve that stays within ~3 dB even at the extreme and is nearly transparent below
 * b ≈ 0.3.
 * @param {number} b ms balance in [−1, 1]; negative = mid-heavy (no centre cut)
 */
export function midBalanceGain(b) {
  if (b <= 0) return 1;
  return Math.pow(10, -(3 * Math.pow(clamp(b, 0, 1), 1.35)) / 20);
}

/**
 * Scale applied on top of the width gain when a Haas delay is engaged: the two
 * controls address the same perceptual axis and stack destructively.
 * @param {number} haasMs
 */
export function haasWidthScale(haasMs) {
  if (!(haasMs > 0)) return 1;
  return 1 / (1 + clamp(haasMs, 0, 40) / 300);
}

/**
 * Bounded crossfeed tap gain. Monotone, 0 at 0. Identical to the classic 0.45·x law up
 * to x = 0.55 (so normal and binaural-minimum settings are untouched), then a smooth
 * knee toward the ceiling — the old law reached 0.45 at full setting, an uncontrolled
 * energy injection into the opposite channel.
 * @param {number} x crossfeed control 0..1
 */
export function crossfeedTapGain(x) {
  const v = clamp(x, 0, 1);
  if (v <= CROSSFEED_LINEAR_UP_TO) return 0.45 * v;
  const t = smoothstep((v - CROSSFEED_LINEAR_UP_TO) / (1 - CROSSFEED_LINEAR_UP_TO));
  const floor = 0.45 * CROSSFEED_LINEAR_UP_TO;
  return floor + (CROSSFEED_MAX_TAP_GAIN - floor) * t;
}

/**
 * Combined side gain of the whole width section, before per-band caps: width × spread
 * × Haas scale, compressed by `widthSideGain`.
 *
 * @param {object} p
 * @param {number} p.width
 * @param {boolean} [p.binaural]
 * @param {number} [p.spread]
 * @param {number} [p.haas]
 * @param {number} [p.ms]
 */
export function sideWidthGain(p) {
  const spreadFactor = p.binaural ? 1 + (p.spread ?? 0) * 0.6 : 1;
  // Old law, kept for the balance < 0 (mid-heavy) side: widening the side further.
  const balanceFactor = (p.ms ?? 0) < 0 ? 1 + Math.abs(p.ms) * 0.6 : 1;
  const raw = (p.width ?? 1) * spreadFactor * balanceFactor;
  const scaled = widthSideGain(raw) * haasWidthScale(p.haas ?? 0);
  return clamp(scaled, 0, WIDTH_MAX_SIDE_GAIN);
}
