/**
 * Analysis Web Worker.
 *
 * Loudness measurement is O(n) with a large constant: two biquad passes per channel plus a
 * mean-square over every 400 ms block at 75 % overlap, and again at 3 s for the short-term
 * series. On a ten-minute 96 kHz stereo file that is several seconds of arithmetic. Doing
 * it on the main thread — which the audited build did, once per file in the batch queue
 * and again after every slider move — freezes the interface.
 *
 * The channel data is **transferred**, not copied, so the message cost is a pointer swap.
 * The caller must therefore hand over arrays it no longer needs (the render pipeline works
 * on its own copies).
 *
 * Falls back gracefully: `analysis-client.js` runs the same functions inline when the
 * browser has no `Worker`.
 */

import { analyseLoudness } from '../audio/analysis/loudness.js';
import { analysePeaks } from '../audio/analysis/true-peak.js';
import { crestFactorDb, rmsDb } from '../audio/analysis/rms.js';
import { monoCompatibility } from '../audio/analysis/correlation.js';
import { spectralFingerprint } from '../audio/analysis/spectral-match.js';

/**
 * Run the requested analyses.
 * @param {{sampleRate:number, channels:Float32Array[], tasks:string[]}} payload
 */
function analyse(payload) {
  const data = {
    sampleRate: payload.sampleRate,
    length: payload.channels[0] ? payload.channels[0].length : 0,
    channels: payload.channels,
  };
  const tasks = payload.tasks ?? ['loudness', 'peaks'];
  /** @type {Record<string, any>} */
  const out = {};

  if (tasks.includes('loudness')) {
    const l = analyseLoudness(data);
    out.loudness = {
      integrated: l.integrated,
      lra: l.lra,
      threshold: l.threshold,
      maxMomentary: l.maxMomentary,
      maxShortTerm: l.maxShortTerm,
      tooShort: l.tooShort,
      silent: l.silent,
      // The full series is useful for the loudness-history graph but can be large; it is
      // downsampled to at most 2000 points before crossing the boundary.
      shortTerm: downsample(l.shortTerm, 2000),
      shortTermHopSeconds: l.shortTermHopSeconds,
      momentary: downsample(l.momentary, 2000),
      momentaryHopSeconds: l.momentaryHopSeconds,
    };
  }
  if (tasks.includes('peaks')) out.peaks = analysePeaks(data);
  if (tasks.includes('rms')) {
    out.rmsDb = rmsDb(data);
    out.crestFactorDb = crestFactorDb(data);
  }
  if (tasks.includes('mono')) out.mono = monoCompatibility(data);
  if (tasks.includes('fingerprint')) out.fingerprint = spectralFingerprint(data);

  return out;
}

/** Reduce a series to at most `max` points by taking block maxima (peaks matter). */
function downsample(series, max) {
  if (!series || series.length <= max) return Array.from(series ?? []);
  const step = series.length / max;
  const out = new Array(max);
  for (let i = 0; i < max; i++) {
    const from = Math.floor(i * step);
    const to = Math.min(series.length, Math.floor((i + 1) * step));
    let m = -Infinity;
    for (let k = from; k < to; k++) if (series[k] > m) m = series[k];
    out[i] = m;
  }
  return out;
}

self.addEventListener('message', (event) => {
  const { id, payload } = event.data ?? {};
  try {
    const result = analyse(payload);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
