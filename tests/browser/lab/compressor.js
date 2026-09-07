/**
 * Real-browser measurements of DynamicsCompressorNode.
 *
 * Nothing here assumes the analytical Blink model is exact. We *measure* latency,
 * make-up, the static curve, and attack/release, then report how they sit next to
 * the model Signal Rot uses to cancel the make-up.
 */

import { dynamicsCompressorMakeupDb } from '../../../src/audio/dsp/dynamics-compressor.js';
import { bandAmountToSettings } from '../../../src/audio/graph/multiband.js';
import {
  renderOffline,
  makeBuffer,
  sineFill,
  impulseFill,
  peakOf,
  rmsOf,
  db,
  peakIndex,
  firstNonzero,
  ua,
} from './util.js';

const SR = 48000;

function configure(comp, { threshold = -24, knee = 0, ratio = 4, attack = 0, release = 0.2 } = {}) {
  comp.threshold.value = threshold;
  comp.knee.value = knee;
  comp.ratio.value = ratio;
  comp.attack.value = attack;
  comp.release.value = release;
  return comp;
}

async function throughCompressor(seconds, fill, settings, { channels = 1 } = {}) {
  const length = Math.round(seconds * SR);
  const rendered = await renderOffline(channels, length, SR, (ctx) => {
    const src = ctx.createBufferSource();
    src.buffer = makeBuffer(ctx, channels, length, fill);
    const comp = configure(ctx.createDynamicsCompressor(), settings);
    src.connect(comp);
    comp.connect(ctx.destination);
    src.start(0);
  });
  return rendered.getChannelData(0);
}

export async function measureLookahead() {
  const at = 256;
  const settings = { threshold: -40, knee: 0, ratio: 12, attack: 0, release: 0.25 };
  const out = await throughCompressor(0.05, impulseFill(at, 1), settings);
  const { index, value } = peakIndex(out);
  const first = firstNonzero(out, 1e-4);
  const delaySamples = index - at;
  const delayMs = (delaySamples / SR) * 1000;
  return {
    browser: ua(),
    sampleRate: SR,
    impulseAt: at,
    peakIndex: index,
    peakValue: value,
    firstNonzero: first,
    delaySamples,
    delayMs,
    documentedMs: 6,
    deltaVsDocumentedMs: delayMs - 6,
  };
}

export async function measureMakeup() {
  // A sine well below threshold so the static curve never engages. Any gain is make-up.
  const amp = 0.003; // ≈ −50 dBFS
  const rows = [];
  const amounts = [0, 10, 20, 25, 50, 80, 100];
  for (const amount of amounts) {
    const s = bandAmountToSettings(amount);
    const settings = {
      threshold: s.thresholdDb,
      knee: s.kneeDb,
      ratio: s.ratio,
      attack: 0.01,
      release: 0.25,
    };
    const out = await throughCompressor(0.6, sineFill(SR, 1000, amp), settings);
    // skip look-ahead / attack settling
    const slice = out.subarray(Math.round(0.15 * SR), Math.round(0.5 * SR));
    const inRms = amp / Math.SQRT2;
    const outRms = rmsOf(slice);
    const measuredDb = db(outRms) - db(inRms);
    const modelDb = dynamicsCompressorMakeupDb(s.thresholdDb, s.kneeDb, s.ratio);
    rows.push({
      amount,
      thresholdDb: s.thresholdDb,
      ratio: s.ratio,
      kneeDb: s.kneeDb,
      measuredDb,
      modelDb,
      deltaDb: measuredDb - modelDb,
    });
  }
  return { browser: ua(), sampleRate: SR, probeDb: -50, rows };
}

export async function measureStaticCurve() {
  const settings = { threshold: -24, knee: 9, ratio: 4, attack: 0.0, release: 0.25 };
  const levels = [-36, -30, -24, -18, -12, -6, -3, 0];
  const rows = [];
  for (const levelDb of levels) {
    const amp = Math.pow(10, levelDb / 20);
    const out = await throughCompressor(0.7, sineFill(SR, 1000, amp), settings);
    const slice = out.subarray(Math.round(0.2 * SR), Math.round(0.55 * SR));
    const outDb = db(peakOf(slice));
    rows.push({
      inputDb: levelDb,
      outputPeakDb: outDb,
      reductionDb: outDb - levelDb,
    });
  }
  return { browser: ua(), settings, rows };
}

export async function measureAttackRelease() {
  // 0.4 s silence, 0.6 s full-scale-ish tone, 0.6 s silence.
  const seconds = 1.6;
  const length = Math.round(seconds * SR);
  const on0 = Math.round(0.4 * SR);
  const on1 = Math.round(1.0 * SR);
  const fill = (i) => (i >= on0 && i < on1 ? 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR) : 0);
  const out = await throughCompressor(seconds, fill, {
    threshold: -24,
    knee: 0,
    ratio: 8,
    attack: 0.01,
    release: 0.2,
  });
  const env = [];
  const win = Math.round(0.005 * SR);
  for (let t = 0; t < length; t += win) {
    env.push({ t: t / SR, rmsDb: db(rmsOf(out.subarray(t, Math.min(length, t + win)))) });
  }
  const during = rmsOf(out.subarray(on0 + Math.round(0.2 * SR), on1 - Math.round(0.05 * SR)));
  const after = rmsOf(
    out.subarray(on1 + Math.round(0.4 * SR), Math.min(length, on1 + Math.round(0.55 * SR))),
  );
  return {
    browser: ua(),
    attack: 0.01,
    release: 0.2,
    toneOnRmsDb: db(during),
    afterReleaseRmsDb: db(after),
    envelope: env,
  };
}

export async function runCompressorSuite() {
  const lookahead = await measureLookahead();
  const makeup = await measureMakeup();
  const curve = await measureStaticCurve();
  const ballistics = await measureAttackRelease();
  return {
    node: 'DynamicsCompressorNode',
    browser: ua(),
    lookahead,
    makeup,
    curve,
    ballistics,
  };
}
