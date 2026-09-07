/**
 * Preview vs export parity.
 *
 * We cannot capture a live AudioContext destination bit-accurately without an
 * AudioWorklet recorder. What we *can* do — and what Signal Rot's architecture
 * actually guarantees — is compare:
 *
 *   EXPORT graph  = buildMasteringChain → destination
 *   PREVIEW graph = buildMasteringChain → safety DynamicsCompressor → makeup → destination
 *
 * The live monitor also applies a static post-gain from the last analysis; that
 * gain is measurement-dependent and is not part of the *graph* divergence. We
 * leave it out so the comparison isolates the safety-limiter difference the
 * docs already disclose.
 *
 * Bit identity is not expected. We quantify RMS, peak, and a coarse spectrum.
 */

import {
  buildMasteringChain,
  applyParameters,
} from '../../../src/audio/graph/build-mastering-chain.js';
import { dynamicsCompressorMakeupCompensation } from '../../../src/audio/dsp/dynamics-compressor.js';
import { defaultParameters } from '../../../src/app/parameters.js';
import { renderChain } from '../../../src/audio/render/render-master.js';
import { makeBuffer, renderOffline, mean, db, ua, metricsOf } from './util.js';

const SR = 48000;

function fillProgramme(sr) {
  return (i, c) => {
    const t = i / sr;
    let x =
      0.22 * Math.sin(2 * Math.PI * 110 * t) +
      0.14 * Math.sin(2 * Math.PI * 440 * t + c * 0.2) +
      0.08 * Math.sin(2 * Math.PI * 2500 * t) +
      0.05 * Math.sin(2 * Math.PI * 7000 * t);
    const beat = i % Math.round(sr / 2);
    if (beat < 300) x += 0.45 * Math.exp(-beat / 50) * Math.sin((2 * Math.PI * 1800 * beat) / sr);
    return x;
  };
}

function goertzel(ch, sr, freq) {
  let re = 0;
  let im = 0;
  const n = ch.length;
  const w = (2 * Math.PI * freq) / sr;
  for (let i = 0; i < n; i++) {
    re += ch[i] * Math.cos(w * i);
    im += ch[i] * Math.sin(w * i);
  }
  return Math.hypot(re, im) / (n / 2);
}

function spectrum(ch, sr) {
  return [60, 140, 400, 1000, 3200, 8000].map((f) => ({
    freq: f,
    db: db(goertzel(ch, sr, f)),
  }));
}

function summarise(buf) {
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
  let corrNum = 0;
  let corrDenL = 0;
  let corrDenR = 0;
  const n = Math.min(ch0.length, ch1.length);
  for (let i = 0; i < n; i++) {
    corrNum += ch0[i] * ch1[i];
    corrDenL += ch0[i] * ch0[i];
    corrDenR += ch1[i] * ch1[i];
  }
  const corrDen = Math.sqrt(corrDenL * corrDenR);
  return {
    ...metricsOf(buf),
    correlation: corrDen < 1e-20 ? 1 : corrNum / corrDen,
    dc: Math.max(Math.abs(mean(ch0)), Math.abs(mean(ch1))),
    spectrum: spectrum(ch0.subarray(Math.round(0.05 * buf.sampleRate) || 0), buf.sampleRate),
  };
}

function delta(a, b) {
  return {
    rmsDb: b.rmsDb - a.rmsDb,
    peakDb: b.peakDb - a.peakDb,
    correlation: b.correlation - a.correlation,
    dc: b.dc - a.dc,
    spectrum: a.spectrum.map((s, i) => ({
      freq: s.freq,
      db: b.spectrum[i].db - s.db,
    })),
  };
}

async function sourceBuffer(seconds = 1.2) {
  const length = Math.round(seconds * SR);
  const ctx = new OfflineAudioContext(2, length, SR);
  return makeBuffer(ctx, 2, length, fillProgramme(SR));
}

async function renderPreviewGraph(source, parameters) {
  const length = source.length;
  const sr = source.sampleRate;
  return renderOffline(2, length, sr, (ctx) => {
    const src = ctx.createBufferSource();
    const buf = ctx.createBuffer(2, length, sr);
    buf.copyToChannel(source.getChannelData(0), 0);
    buf.copyToChannel(source.getChannelData(1), 1);
    src.buffer = buf;
    const chain = buildMasteringChain(ctx, { textureSeed: parameters.textureSeed });
    applyParameters(chain, parameters, { audition: 'stereo' });
    const safety = ctx.createDynamicsCompressor();
    safety.threshold.value = Math.min(-0.2, parameters.ceiling - 0.2);
    safety.knee.value = 0;
    safety.ratio.value = 20;
    safety.attack.value = 0.002;
    safety.release.value = 0.12;
    const safetyMakeup = ctx.createGain();
    safetyMakeup.gain.value = dynamicsCompressorMakeupCompensation(safety.threshold.value, 0, 20);
    src.connect(chain.input);
    chain.output.connect(safety);
    safety.connect(safetyMakeup);
    safetyMakeup.connect(ctx.destination);
    chain.start(0);
    src.start(0);
  });
}

export async function measurePreviewExportParity() {
  const browser = ua();
  const source = await sourceBuffer(1.2);
  const clean = defaultParameters();
  clean.normalize = false;
  const coloured = {
    ...defaultParameters(),
    normalize: false,
    sat: 20,
    mbLow: 18,
    mbMid: 14,
    drive: 1.5,
    ceiling: -1,
  };

  const rows = [];
  for (const [name, parameters, cls] of [
    ['reference', clean, 'reference'],
    ['creative', coloured, 'creative'],
  ]) {
    const t0 = performance.now();
    const exported = await renderChain(source, parameters);
    const exportMs = performance.now() - t0;
    const t1 = performance.now();
    const previewed = await renderPreviewGraph(source, parameters);
    const previewMs = performance.now() - t1;
    const exp = summarise(exported);
    const pre = summarise(previewed);
    rows.push({
      name,
      class: cls,
      exportMs,
      previewMs,
      export: exp,
      preview: pre,
      delta: delta(exp, pre),
    });
  }

  return { browser, sampleRate: SR, rows };
}
