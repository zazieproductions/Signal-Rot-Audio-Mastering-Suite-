/**
 * Real-browser measurements of Signal Rot's stereo (M/S) section.
 *
 * The width network lives on the side channel only, so an anti-phase probe measures it
 * directly: with L = +s and R = −s, mid is 0, side is s, and (L'−R')/2 is the processed
 * side signal. At unity width gains with bass-mono off that must be unity — issue #19
 * put +7.4 dB here at 250 Hz and 4 kHz (the same dB-Q unit error as the multiband
 * crossover), and this section had no browser test at all.
 */

import { buildStereo, applyStereo, setAudition } from '../../../src/audio/graph/stereo.js';
import { defaultParameters } from '../../../src/app/parameters.js';
import { WIDTH_CROSSOVER_LOW, WIDTH_CROSSOVER_HIGH } from '../../../src/app/constants.js';
import { renderOffline, sineFill, rmsOf, db, ua } from './util.js';

const SR = 48000;

function stereoParams(patch = {}) {
  return { ...defaultParameters(), width: 1, ms: 0, bassMono: 0, ...patch };
}

async function sideGainDb(freq, patch, seconds = 0.6) {
  const length = Math.round(seconds * SR);
  const rendered = await renderOffline(2, length, SR, (ctx) => {
    const src = ctx.createBufferSource();
    const buf = ctx.createBuffer(2, length, SR);
    const fill = sineFill(SR, freq, 0.4);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    for (let i = 0; i < length; i++) {
      L[i] = fill(i);
      R[i] = -fill(i);
    }
    src.buffer = buf;
    const st = buildStereo(ctx);
    applyStereo(st, stereoParams(patch));
    setAudition(st, 'stereo');
    src.connect(st.input);
    st.output.connect(ctx.destination);
    src.start(0);
  });
  const L = rendered.getChannelData(0);
  const R = rendered.getChannelData(1);
  const a = Math.round(0.2 * SR);
  const b = Math.round(0.5 * SR);
  const side = new Float32Array(b - a);
  for (let i = a; i < b; i++) side[i - a] = (L[i] - R[i]) / 2;
  return db(rmsOf(side)) - db(0.4 / Math.SQRT2);
}

export async function measureSideUnity() {
  const freqs = [40, 150, 250, 1000, 2000, 4000, 10000];
  const byFreq = [];
  for (const freq of freqs) {
    byFreq.push({
      freq,
      gainDb: await sideGainDb(freq, { widthLow: 1, widthMid: 1, widthHigh: 1 }),
    });
  }
  const worst = byFreq.reduce(
    (w, r) => (Math.abs(r.gainDb) > Math.abs(w.gainDb) ? r : w),
    byFreq[0],
  );
  return {
    browser: ua(),
    crossovers: { low: WIDTH_CROSSOVER_LOW, high: WIDTH_CROSSOVER_HIGH },
    byFreq,
    worstFreq: worst.freq,
    worstDb: worst.gainDb,
  };
}

export async function measureBassMonoShape() {
  // Corner 80 Hz: −6 dB at the corner, −24 dB an octave below (LR4), unity above.
  const corner = 80;
  const probes = [
    { freq: 40, expectDb: -24, tolDb: 3 },
    { freq: 80, expectDb: -6, tolDb: 2 },
    { freq: 320, expectDb: 0, tolDb: 1 },
  ];
  const rows = [];
  for (const { freq, expectDb, tolDb } of probes) {
    const gainDb = await sideGainDb(freq, { bassMono: corner }, 1.2);
    rows.push({ freq, gainDb, expectDb, tolDb, within: Math.abs(gainDb - expectDb) <= tolDb });
  }
  return { browser: ua(), corner, rows };
}

export async function measureMidUnity() {
  // Correlated probe: side is 0, output must equal input (the mid path bypasses the
  // split entirely, so this separates matrix errors from filter errors).
  const freq = 1000;
  const seconds = 0.6;
  const length = Math.round(seconds * SR);
  const rendered = await renderOffline(2, length, SR, (ctx) => {
    const src = ctx.createBufferSource();
    const buf = ctx.createBuffer(2, length, SR);
    const fill = sineFill(SR, freq, 0.4);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    for (let i = 0; i < length; i++) {
      L[i] = fill(i);
      R[i] = fill(i);
    }
    src.buffer = buf;
    const st = buildStereo(ctx);
    applyStereo(st, stereoParams());
    setAudition(st, 'stereo');
    src.connect(st.input);
    st.output.connect(ctx.destination);
    src.start(0);
  });
  const slice = (ch) => ch.subarray(Math.round(0.2 * SR), Math.round(0.5 * SR));
  const lDb = db(rmsOf(slice(rendered.getChannelData(0)))) - db(0.4 / Math.SQRT2);
  const rDb = db(rmsOf(slice(rendered.getChannelData(1)))) - db(0.4 / Math.SQRT2);
  return { browser: ua(), freq, leftDb: lDb, rightDb: rDb };
}

export async function runStereoSectionSuite() {
  return {
    node: 'stereo-section',
    browser: ua(),
    sideUnity: await measureSideUnity(),
    bassMono: await measureBassMonoShape(),
    midUnity: await measureMidUnity(),
  };
}
