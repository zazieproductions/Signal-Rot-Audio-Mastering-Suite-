/**
 * Source brightness measurement.
 *
 * A cheap, deterministic, full-band measurement used by the HF budget (§2.7) and by the
 * spatial engine's source profile: how much of the signal's energy sits above ~9 kHz.
 *
 * The filter is a 4th-order Linkwitz-Riley high-pass (two cascaded Butterworth biquads
 * at Q = 1/√2) processed over a mono sum, so the number is stable against L/R panning
 * and against polarity-flipped content.
 *
 * ── What it is not ───────────────────────────────────────────────────────────────────
 * Not a perceptual brightness model (no equal-loudness contour, no spectral centroid).
 * It is a *guard* for decisions that should not run on already-bright material — its
 * threshold behaviour is what matters, not its precision in the middle of the range.
 */

import { designBiquad, processBiquadCascade } from '../dsp/biquad.js';

/** Corner of the guard high-pass, Hz. */
export const BRIGHTNESS_HP_HZ = 9000;

/**
 * Measure the high-frequency energy ratio of an AudioData mono-sum.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data
 * @returns {{hfRatio: number, hfRatioDb: number}}
 */
export function measureBrightness(data) {
  const n = data.length;
  const mono = new Float32Array(n);
  if (data.channels.length === 1) {
    mono.set(data.channels[0]);
  } else {
    const g = 1 / data.channels.length;
    for (const ch of data.channels) {
      for (let i = 0; i < n; i++) mono[i] += ch[i] * g;
    }
  }

  const corner = Math.min(BRIGHTNESS_HP_HZ, data.sampleRate * 0.4);
  const coeffs = [
    designBiquad('highpass', corner, Math.SQRT1_2, 0, data.sampleRate),
    designBiquad('highpass', corner, Math.SQRT1_2, 0, data.sampleRate),
  ];

  // Work on a copy: the analysers must not mutate the caller's buffer.
  const hp = Float32Array.from(mono);
  processBiquadCascade(hp, coeffs);

  let total = 0;
  let hf = 0;
  for (let i = 0; i < n; i++) {
    total += mono[i] * mono[i];
    hf += hp[i] * hp[i];
  }
  if (!(total > 1e-18) || !(hf > 0)) return { hfRatio: 0, hfRatioDb: -Infinity };

  const ratio = Math.min(1, hf / total);
  return { hfRatio: ratio, hfRatioDb: 10 * Math.log10(ratio) };
}
