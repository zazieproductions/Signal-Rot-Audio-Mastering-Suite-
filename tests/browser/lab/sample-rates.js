/**
 * Probe OfflineAudioContext sample-rate support and, where a rate is accepted,
 * render a short sine to prove the context actually processes audio.
 */

import { SAMPLE_RATES } from '../../conformance/thresholds.js';
import { probeRate, renderOffline, makeBuffer, sineFill, rmsOf, peakOf, db, ua } from './util.js';

export async function probeAllRates(rates = SAMPLE_RATES) {
  const browser = ua();
  const rows = [];
  for (const sampleRate of rates) {
    const probe = probeRate(sampleRate);
    if (!probe.ok) {
      rows.push({
        sampleRate,
        supported: false,
        reason: probe.reason,
        rendered: false,
      });
      continue;
    }
    try {
      const seconds = 0.15;
      const length = Math.max(32, Math.round(seconds * sampleRate));
      const rendered = await renderOffline(1, length, sampleRate, (ctx) => {
        const src = ctx.createBufferSource();
        src.buffer = makeBuffer(ctx, 1, length, sineFill(sampleRate, 1000, 0.5));
        src.connect(ctx.destination);
        src.start(0);
      });
      const ch = rendered.getChannelData(0);
      const slice = ch.subarray(Math.round(0.04 * sampleRate) || 8);
      rows.push({
        sampleRate,
        supported: true,
        rendered: true,
        length: rendered.length,
        actualRate: rendered.sampleRate,
        rmsDb: db(rmsOf(slice) * Math.SQRT2),
        peak: peakOf(slice),
        finite: slice.every((v) => Number.isFinite(v)),
      });
    } catch (error) {
      rows.push({
        sampleRate,
        supported: true,
        rendered: false,
        reason: String(error && error.message ? error.message : error),
      });
    }
  }
  return { browser, rows };
}
