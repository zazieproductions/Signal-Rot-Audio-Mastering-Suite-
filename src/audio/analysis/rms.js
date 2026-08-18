/**
 * RMS and crest-factor measurement.
 *
 * RMS here is *unweighted* and referenced to a full-scale sine (the AES convention), so a
 * 0 dBFS sine reads 0 dBFS RMS rather than −3.01 dBFS. That matches every analogue meter
 * a mastering engineer has ever used, and it is stated in the UI.
 */

import { gainToDb } from '../dsp/math.js';

/** √2 — full-scale-sine reference offset. */
const SINE_REF = Math.SQRT2;

/**
 * Unweighted RMS across all channels, sine-referenced.
 * @param {import('../dsp/audio-data.js').AudioData} data
 * @param {number} [start] first frame
 * @param {number} [end] one past last frame
 */
export function rms(data, start = 0, end = data.length) {
  const from = Math.max(0, start);
  const to = Math.min(data.length, end);
  const n = to - from;
  if (n <= 0 || !data.channels.length) return 0;
  let sum = 0;
  for (const ch of data.channels) {
    for (let i = from; i < to; i++) sum += ch[i] * ch[i];
  }
  return Math.sqrt(sum / (n * data.channels.length));
}

/** Sine-referenced RMS in dBFS. */
export const rmsDb = (data, start, end) => gainToDb(rms(data, start, end) * SINE_REF);

/**
 * Crest factor — peak-to-RMS ratio in dB. A useful, if crude, density indicator:
 * ~18 dB on unmastered acoustic material, ~10 dB on a modern loud master, <6 dB on a
 * brick-walled one.
 */
export function crestFactorDb(data) {
  let peak = 0;
  for (const ch of data.channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }
  const r = rms(data);
  if (r <= 0) return 0;
  return gainToDb(peak) - gainToDb(r);
}

/**
 * Sliding RMS envelope, one value per `hopSamples`. Used by the loudness-history graph.
 * @returns {{values: Float32Array, hopSeconds: number}}
 */
export function rmsEnvelope(data, windowSeconds = 0.05, hopSeconds = 0.025) {
  const win = Math.max(1, Math.round(windowSeconds * data.sampleRate));
  const hop = Math.max(1, Math.round(hopSeconds * data.sampleRate));
  const count = Math.max(0, Math.floor((data.length - win) / hop) + 1);
  const out = new Float32Array(Math.max(0, count));
  for (let b = 0; b < count; b++) {
    out[b] = rms(data, b * hop, b * hop + win);
  }
  return { values: out, hopSeconds: hop / data.sampleRate };
}
