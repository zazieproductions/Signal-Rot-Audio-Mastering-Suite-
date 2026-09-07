/**
 * Real-browser measurements of WaveShaperNode — both the spec node itself and
 * Signal Rot's production saturation stage (`buildSaturation` / `applySaturation`).
 */

import {
  makeSaturationCurve,
  saturationGainStaging,
  IDENTITY_CURVE,
  SATURATION_HEADROOM,
  buildSaturation,
  applySaturation,
} from '../../../src/audio/graph/tone.js';
import { renderOffline, makeBuffer, sineFill, rmsOf, peakOf, mean, db, ua } from './util.js';

const SR = 48000;

function dftMag(channel, sampleRate, freq) {
  // Single-bin Goertzel / correlation against a sine/cosine at `freq`.
  let re = 0;
  let im = 0;
  const n = channel.length;
  const w = (2 * Math.PI * freq) / sampleRate;
  for (let i = 0; i < n; i++) {
    re += channel[i] * Math.cos(w * i);
    im += channel[i] * Math.sin(w * i);
  }
  return Math.hypot(re, im) / (n / 2);
}

async function throughShaper({ curve, oversample = 'none', fill, seconds = 0.5, amp }) {
  const length = Math.round(seconds * SR);
  const rendered = await renderOffline(1, length, SR, (ctx) => {
    const src = ctx.createBufferSource();
    src.buffer = makeBuffer(ctx, 1, length, fill ?? sineFill(SR, 1000, amp ?? 0.5));
    const sh = ctx.createWaveShaper();
    sh.curve = curve;
    sh.oversample = oversample;
    src.connect(sh);
    sh.connect(ctx.destination);
    src.start(0);
  });
  return rendered.getChannelData(0);
}

export async function measureClamping() {
  // Identity curve over ±1: any |x|>1 must come out as ±1.
  const n = 8;
  const identity = new Float32Array(n);
  for (let i = 0; i < n; i++) identity[i] = (i / (n - 1)) * 2 - 1;
  const out = await throughShaper({
    curve: identity,
    fill: () => 2.5,
    seconds: 0.05,
  });
  const outNeg = await throughShaper({
    curve: identity,
    fill: () => -2.5,
    seconds: 0.05,
  });
  return {
    browser: ua(),
    overRangeInput: 2.5,
    outputPeak: peakOf(out),
    outputTrough: peakOf(outNeg) * Math.sign(mean(outNeg) || -1),
    clampedHigh: Math.abs(peakOf(out) - 1) < 1e-3,
    clampedLow: Math.abs(peakOf(outNeg) - 1) < 1e-3,
  };
}

export async function measureUnitySat0() {
  // Production identity curve over ±HEADROOM, driven the way the stage drives it.
  const staging = saturationGainStaging(0);
  const length = Math.round(0.4 * SR);
  const amp = 0.5;
  const rendered = await renderOffline(1, length, SR, (ctx) => {
    const src = ctx.createBufferSource();
    src.buffer = makeBuffer(ctx, 1, length, sineFill(SR, 1000, amp));
    const sat = buildSaturation(ctx);
    applySaturation(sat, { sat: 0 });
    src.connect(sat.input);
    sat.output.connect(ctx.destination);
    src.start(0);
  });
  const ch = rendered.getChannelData(0);
  const slice = ch.subarray(Math.round(0.05 * SR));
  return {
    browser: ua(),
    headroom: SATURATION_HEADROOM,
    preGain: staging.preGain,
    postGain: staging.postGain,
    inputAmp: amp,
    outputRms: rmsOf(slice),
    outputPeak: peakOf(slice),
    gainDb: db(rmsOf(slice)) - db(amp / Math.SQRT2),
    curveIsIdentity: IDENTITY_CURVE[0] === -SATURATION_HEADROOM,
  };
}

export async function measureHeadroom() {
  // A +6 dBFS peak (amp 2) must survive sat=0 without being hard-clipped to 1.
  const amp = 2.0;
  const length = Math.round(0.4 * SR);
  const rendered = await renderOffline(1, length, SR, (ctx) => {
    const src = ctx.createBufferSource();
    src.buffer = makeBuffer(ctx, 1, length, sineFill(SR, 200, amp));
    const sat = buildSaturation(ctx);
    applySaturation(sat, { sat: 0 });
    src.connect(sat.input);
    sat.output.connect(ctx.destination);
    src.start(0);
  });
  const ch = rendered.getChannelData(0);
  const slice = ch.subarray(Math.round(0.08 * SR));
  const p = peakOf(slice);
  return {
    browser: ua(),
    inputAmp: amp,
    outputPeak: p,
    clippedAtUnity: p < 1.05,
    preservedAboveUnity: p > 1.5,
  };
}

export async function measureOversampling() {
  const curve = makeSaturationCurve(0.8);
  const freq = 5000;
  const amp = 0.7;
  const modes = ['none', '2x', '4x'];
  const rows = [];
  for (const oversample of modes) {
    const out = await throughShaper({
      curve,
      oversample,
      fill: sineFill(SR, freq, amp),
      seconds: 0.4,
    });
    const slice = out.subarray(Math.round(0.05 * SR));
    const h1 = dftMag(slice, SR, freq);
    const h2 = dftMag(slice, SR, freq * 2);
    const h3 = dftMag(slice, SR, freq * 3);
    // 5 kHz × 3 = 15 kHz (in-band). Alias of 5 kHz × 5 = 25 kHz → 23 kHz at 48 k.
    const alias = dftMag(slice, SR, 23000);
    rows.push({
      oversample,
      dc: mean(slice),
      h1,
      h2Db: db(h2) - db(h1),
      h3Db: db(h3) - db(h1),
      alias23kDb: db(alias) - db(h1),
      peak: peakOf(slice),
    });
  }
  return { browser: ua(), drive: 0.8, frequency: freq, rows };
}

export async function measureDcMonotonicHarmonics() {
  const amounts = [0, 0.25, 0.5, 1];
  const rows = [];
  for (const amount of amounts) {
    const curve = makeSaturationCurve(amount);
    const out = await throughShaper({
      curve,
      oversample: '4x',
      fill: sineFill(SR, 1000, 0.5),
      seconds: 0.4,
    });
    const slice = out.subarray(Math.round(0.05 * SR));
    const h1 = dftMag(slice, SR, 1000);
    const h2 = dftMag(slice, SR, 2000);
    const h3 = dftMag(slice, SR, 3000);
    const h4 = dftMag(slice, SR, 4000);
    rows.push({
      amount,
      dc: mean(slice),
      h2Db: db(h2) - db(h1),
      h3Db: db(h3) - db(h1),
      h4Db: db(h4) - db(h1),
    });
  }

  // DC sweep for monotonicity of the *node* with an engaged curve.
  const curve = makeSaturationCurve(0.7);
  const sweep = [];
  let previous = -Infinity;
  let folds = 0;
  for (let x = -1; x <= 1.0001; x += 0.05) {
    const out = await throughShaper({
      curve,
      oversample: 'none',
      fill: () => x,
      seconds: 0.02,
    });
    const y = mean(out);
    if (y + 1e-6 < previous) folds++;
    previous = y;
    sweep.push({ x, y });
  }
  return { browser: ua(), harmonics: rows, dcSweep: sweep, folds };
}

export async function runWaveShaperSuite() {
  return {
    node: 'WaveShaperNode',
    browser: ua(),
    clamping: await measureClamping(),
    unitySat0: await measureUnitySat0(),
    headroom: await measureHeadroom(),
    oversampling: await measureOversampling(),
    dcMonotonicHarmonics: await measureDcMonotonicHarmonics(),
  };
}
