#!/usr/bin/env node
/**
 * Isolate a single chain section and measure what it does to a known signal.
 *
 *   node qa/scripts/isolate.mjs --section stereo --case mono1 --set bassMono=80
 *
 * --case mono1   : the source buffer really has ONE channel (this is what renderChain
 *                  produces for a mono file when nothing forces stereo)
 * --case mono2   : the same programme as dual mono (two identical channels)
 * --case stereo   : programme in L only / both
 * Used to separate "the DSP is wrong" from "the node graph mis-handles channel counts".
 */
import { join } from 'node:path';
import { installWebAudio, assertCurvesFlushed } from './engine.mjs';

const repoRoot = '/home/user/Signal-Rot-Audio-Mastering-Suite-';
installWebAudio();

const { buildStereo, applyStereo, setAudition } = await import(
  join(repoRoot, 'src/audio/graph/stereo.js')
);
const { buildMultiband, applyMultibandForTest } = await import(
  join(repoRoot, 'src/audio/graph/multiband.js')
);
const { buildDepth, applyDepth } = await import(join(repoRoot, 'src/audio/graph/depth.js'));
const { buildTone, buildSaturation, applyTone, applySaturation } = await import(
  join(repoRoot, 'src/audio/graph/tone.js')
);
const { buildCharacter, applyCharacter } = await import(
  join(repoRoot, 'src/audio/graph/character.js')
);
const { analyseLoudness } = await import(join(repoRoot, 'src/audio/analysis/loudness.js'));
const { analysePeaks } = await import(join(repoRoot, 'src/audio/analysis/true-peak.js'));
const { defaultParameters, validateParameters } = await import(
  join(repoRoot, 'src/app/parameters.js')
);

const { OfflineAudioContext } = globalThis;
const argv = process.argv.slice(2);
const arg = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const section = arg('--section', 'stereo');
const cases = (arg('--case', 'mono1,mono2,anti,corr') || '').split(',');
const setStr = arg('--set', '');

let params = { ...defaultParameters() };
for (const pair of setStr ? setStr.split(',') : []) {
  const [k, v] = pair.split('=');
  params[k] = Number.isNaN(Number(v)) ? v : Number(v);
}
params = validateParameters(params).parameters;

const sr = 48000;
const secs = 1.0;
const n = sr * secs;

/** test signals, generated at full scale-ish */
function signal(kind, ch) {
  const ctx = new OfflineAudioContext(1, 1, sr);
  const buf = ctx.createBuffer(ch, n, sr);
  for (let c = 0; c < ch; c++) buf.getChannelData(c).fill(0);
  const mk = (f, a, phase = 0) => {
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = a * Math.sin((2 * Math.PI * f * i) / sr + phase);
    return d;
  };
  const tone = mk(440, 0.5);
  const tone2 = mk(440, 0.5, Math.PI);
  const wide = mk(440, 0.5);
  for (let i = 0; i < 1000; i++) wide[i] += 0.2 * Math.sin((2 * Math.PI * 60 * i) / sr);
  if (kind === 'mono1') buf.copyToChannel(tone, 0);
  else if (kind === 'mono2') {
    buf.copyToChannel(tone, 0);
    buf.copyToChannel(tone, 1);
  } else if (kind === 'anti') {
    buf.copyToChannel(tone, 0);
    buf.copyToChannel(tone2, 1);
  } else if (kind === 'corr') {
    buf.copyToChannel(tone, 0);
    buf.copyToChannel(tone, 1);
  } else if (kind === 'wide') {
    buf.copyToChannel(tone, 0);
    buf.copyToChannel(tone2, 1);
  } else if (kind.startsWith('imp')) {
    const idx = Math.floor(0.01 * sr);
    const one = new Float32Array(n);
    one[idx] = 1;
    const neg = new Float32Array(n);
    neg[idx] = -1;
    if (kind === 'imp-anti') {
      buf.copyToChannel(one, 0);
      buf.copyToChannel(neg, 1);
    } else if (kind === 'imp-mid') {
      buf.copyToChannel(one, 0);
      buf.copyToChannel(one, 1);
    } else if (kind === 'imp-l') {
      buf.copyToChannel(one, 0);
    } else {
      buf.copyToChannel(one, 0);
      buf.copyToChannel(new Float32Array(n), 1);
    }
  }
  return buf;
}

const corrOf = (b) => {
  if (b.numberOfChannels === 1) return 1;
  const l = b.getChannelData(0);
  const r = b.getChannelData(1);
  let sl = 0,
    sr2 = 0,
    s12 = 0;
  for (let i = 0; i < b.length; i++) {
    s12 += l[i] * r[i];
    sl += l[i] * l[i];
    sr2 += r[i] * r[i];
  }
  return s12 / (Math.sqrt(sl * sr2) + 1e-20);
};

const rows = [];
for (const kind of cases) {
  const ch = kind === 'mono1' ? 1 : 2;
  const source = signal(kind, ch);
  const render = async (build, apply, audition) => {
    const ctx = new OfflineAudioContext(2, n, sr);
    const src = ctx.createBufferSource();
    src.buffer = source;
    const n0 = build(ctx);
    apply(n0, params);
    if (audition) setAudition(n0, 'stereo');
    src.connect(n0.input);
    n0.output.connect(ctx.destination);
    if (n0.start) n0.start(0);
    src.start(0);
    const out = await ctx.startRendering();
    if (n0.stop) n0.stop();
    return out;
  };
  const builders = {
    stereo: [(c) => buildStereo(c), (x, p) => applyStereo(x, { ...p, bypass: false }), true],
    multiband: [(c) => buildMultiband(c), (x, p) => applyMultibandForTest(x, p), false],
    depth: [(c) => buildDepth(c), (x, p) => applyDepth(x, { ...p, bypass: false }), false],
    tone: [(c) => buildTone(c), (x, p) => applyTone(x, { ...p, bypass: false }), false],
    saturation: [
      (c) => buildSaturation(c),
      (x, p) => applySaturation(x, { ...p, bypass: false }),
      false,
    ],
    character: [
      (c) => buildCharacter(c, 1234),
      (x, p) => applyCharacter(x, { ...p, bypass: false }),
      false,
    ],
  };
  const [b, a, aud] = builders[section];
  const out = await render(b, a, aud);
  const data = {
    sampleRate: sr,
    length: out.length,
    channels: Array.from({ length: out.numberOfChannels }, (_, c) => out.getChannelData(c)),
  };
  const l = analyseLoudness(data);
  const p = analysePeaks(data);
  let lRms = 0,
    rRms = 0;
  for (let i = 0; i < n; i++) {
    lRms += out.getChannelData(0)[i] ** 2;
    if (out.numberOfChannels > 1) rRms += out.getChannelData(1)[i] ** 2;
  }
  if (arg('--dump', '')) {
    const { writeFileSync } = await import('node:fs');
    const oc = out.numberOfChannels;
    const inter = new Float32Array(out.length * oc);
    for (let c = 0; c < oc; c++) {
      const d = out.getChannelData(c);
      for (let i = 0; i < out.length; i++) inter[i * oc + c] = d[i];
    }
    writeFileSync(`${arg('--dump', '')}/${section}_${kind}.f32`, Buffer.from(inter.buffer));
    writeFileSync(
      `${arg('--dump', '')}/${section}_${kind}.hdr.json`,
      JSON.stringify({ n: out.length, ch: oc, sr }),
    );
  }
  rows.push({
    case: kind,
    inCh: ch,
    outCh: out.numberOfChannels,
    lufs: +l.integrated.toFixed(2),
    tp: +p.truePeakDb.toFixed(2),
    corr: +corrOf(out).toFixed(3),
    lRms: +(10 * Math.log10(lRms / n + 1e-20)).toFixed(1),
    rRms: +(10 * Math.log10(rRms / n + 1e-20)).toFixed(1),
  });
}

// input reference
for (const kind of cases) {
  const ch = kind === 'mono1' ? 1 : 2;
  if (kind.startsWith('imp')) continue;
  const data = signal(kind, ch);
  const d = {
    sampleRate: sr,
    length: n,
    channels: Array.from({ length: ch }, (_, c) => data.getChannelData(c)),
  };
  const l = analyseLoudness(d);
  const p = analysePeaks(d);
  const lRms = Array.from(data.getChannelData(0)).reduce((s, v) => s + v * v, 0) / n;
  rows.push({
    case: kind + ' (IN)',
    inCh: ch,
    outCh: ch,
    lufs: +l.integrated.toFixed(2),
    tp: +p.truePeakDb.toFixed(2),
    corr: ch === 1 ? 1 : corrOf(data),
    lRms: +(10 * Math.log10(lRms + 1e-20)).toFixed(1),
    rRms: 'n/a',
  });
}
console.table(rows);
console.log('params:', setStr || 'schema defaults', '| section:', section);
console.log('curve writes:', JSON.stringify(assertCurvesFlushed()));
