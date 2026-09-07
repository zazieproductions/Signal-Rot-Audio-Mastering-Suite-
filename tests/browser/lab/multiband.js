/**
 * Real-browser measurements of Signal Rot's multiband section.
 *
 * The analytical crossover tests in Node already prove the *filter maths*. These
 * measurements prove the *rendered* wet/dry alignment, residual comb, reconstruction
 * and partial-mix behaviour inside a real OfflineAudioContext.
 */

import {
  buildMultiband,
  MB_COMPRESSOR_LOOKAHEAD_S,
  bandAmountToSettings,
} from '../../../src/audio/graph/multiband.js';
import { dynamicsCompressorMakeupCompensation } from '../../../src/audio/dsp/dynamics-compressor.js';
import { MB_CROSSOVER_LOW, MB_CROSSOVER_HIGH } from '../../../src/app/constants.js';
import {
  renderOffline,
  makeBuffer,
  impulseFill,
  sineFill,
  peakIndex,
  rmsOf,
  db,
  ua,
} from './util.js';

const SR = 48000;

function applyBand(comp, specMakeup, makeup, amount) {
  const s = bandAmountToSettings(amount);
  comp.threshold.value = s.thresholdDb;
  comp.ratio.value = s.ratio;
  comp.knee.value = s.kneeDb;
  specMakeup.gain.value = dynamicsCompressorMakeupCompensation(s.thresholdDb, s.kneeDb, s.ratio);
  makeup.gain.value = 1;
  return s;
}

function wire(ctx, { mix = 1, amounts = [0, 0, 0], fill, seconds = 0.5 }) {
  const length = Math.round(seconds * SR);
  const mb = buildMultiband(ctx);
  applyBand(mb.compLow, mb.specMakeupLow, mb.lowMakeup, amounts[0]);
  applyBand(mb.compMid, mb.specMakeupMid, mb.midMakeup, amounts[1]);
  applyBand(mb.compHigh, mb.specMakeupHigh, mb.highMakeup, amounts[2]);
  mb.wet.gain.value = mix;
  mb.dry.gain.value = 1 - mix;
  const src = ctx.createBufferSource();
  src.buffer = makeBuffer(ctx, 1, length, fill);
  src.connect(mb.input);
  mb.output.connect(ctx.destination);
  src.start(0);
  return { mb, length };
}

export async function measureDryWetAlignment() {
  const at = 128;
  const seconds = 0.08;
  const wet = await renderOffline(1, Math.round(seconds * SR), SR, (ctx) => {
    wire(ctx, { mix: 1, amounts: [0, 0, 0], fill: impulseFill(at, 1), seconds });
  });
  const dry = await renderOffline(1, Math.round(seconds * SR), SR, (ctx) => {
    wire(ctx, { mix: 0, amounts: [0, 0, 0], fill: impulseFill(at, 1), seconds });
  });
  const wetPeak = peakIndex(wet.getChannelData(0));
  const dryPeak = peakIndex(dry.getChannelData(0));
  const deltaSamples = wetPeak.index - dryPeak.index;
  const deltaMs = (deltaSamples / SR) * 1000;
  return {
    browser: ua(),
    documentedLookaheadMs: MB_COMPRESSOR_LOOKAHEAD_S * 1000,
    wetPeakIndex: wetPeak.index,
    dryPeakIndex: dryPeak.index,
    deltaSamples,
    deltaMs,
    wetPeak: wetPeak.value,
    dryPeak: dryPeak.value,
  };
}

export async function measureReconstruction() {
  const mixes = [0, 0.25, 0.5, 0.75, 1];
  const freqs = [50, 140, 400, 1000, 3200, 8000];
  const rows = [];
  for (const mix of mixes) {
    const byFreq = [];
    for (const freq of freqs) {
      if (freq >= SR / 2) continue;
      const seconds = 0.5;
      const rendered = await renderOffline(1, Math.round(seconds * SR), SR, (ctx) => {
        wire(ctx, {
          mix,
          amounts: [0, 0, 0],
          fill: sineFill(SR, freq, 0.4),
          seconds,
        });
      });
      const ch = rendered.getChannelData(0);
      const slice = ch.subarray(Math.round(0.15 * SR), Math.round(0.4 * SR));
      const gainDb = db(rmsOf(slice)) - db(0.4 / Math.SQRT2);
      byFreq.push({ freq, gainDb });
    }
    const worst = byFreq.reduce(
      (w, r) => (Math.abs(r.gainDb) > Math.abs(w.gainDb) ? r : w),
      byFreq[0],
    );
    rows.push({ mix, byFreq, worstFreq: worst.freq, worstDb: worst.gainDb });
  }
  return {
    browser: ua(),
    crossovers: { low: MB_CROSSOVER_LOW, high: MB_CROSSOVER_HIGH },
    rows,
  };
}

export async function measurePartialMixWithCompression() {
  // Amounts engaged, mix at 50 % — the historical comb-filter case.
  const mixes = [0.5, 0.7];
  const freqs = [83, 140, 250, 1000, 3200];
  const rows = [];
  for (const mix of mixes) {
    const byFreq = [];
    for (const freq of freqs) {
      const seconds = 0.6;
      const rendered = await renderOffline(1, Math.round(seconds * SR), SR, (ctx) => {
        wire(ctx, {
          mix,
          amounts: [30, 25, 20],
          fill: sineFill(SR, freq, 0.35),
          seconds,
        });
      });
      const ch = rendered.getChannelData(0);
      const slice = ch.subarray(Math.round(0.2 * SR), Math.round(0.5 * SR));
      byFreq.push({ freq, gainDb: db(rmsOf(slice)) - db(0.35 / Math.SQRT2) });
    }
    rows.push({ mix, byFreq });
  }
  return { browser: ua(), rows };
}

export async function runMultibandSuite() {
  return {
    node: 'multiband',
    browser: ua(),
    alignment: await measureDryWetAlignment(),
    reconstruction: await measureReconstruction(),
    partialMix: await measurePartialMixWithCompression(),
  };
}
