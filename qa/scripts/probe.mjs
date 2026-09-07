#!/usr/bin/env node
/**
 * Chain diagnostics: (1) tap the mastering graph stage by stage, (2) walk renderMaster's
 * post-graph stages, reporting loudness/true-peak/correlation at each point.
 *
 *   LD_LIBRARY_PATH=/home/user/alsastub node qa/scripts/probe.mjs --src acoustic.wav [--preset "Reference HD"] [--bypass-all] [--no-normalise] [--tap]
 */
import { join } from 'node:path';
import { installWebAudio, readWav, assertCurvesFlushed } from './engine.mjs';

const repoRoot = '/home/user/Signal-Rot-Audio-Mastering-Suite-';
installWebAudio();

const { renderChain, requiresStereo } = await import(
  join(repoRoot, 'src/audio/render/render-master.js')
);
const { buildMasteringChain, applyParameters } = await import(
  join(repoRoot, 'src/audio/graph/build-mastering-chain.js')
);
const { createOfflineContext } = await import(join(repoRoot, 'src/audio/context.js'));
const { fromAudioBuffer } = await import(join(repoRoot, 'src/audio/dsp/audio-data.js'));
const { shapeTransients } = await import(join(repoRoot, 'src/audio/render/transient-shaper.js'));
const { normalizeAndLimit } = await import(join(repoRoot, 'src/audio/render/normalize.js'));
const { applyDither } = await import(join(repoRoot, 'src/audio/render/dither.js'));
const { analyseLoudness } = await import(join(repoRoot, 'src/audio/analysis/loudness.js'));
const { analysePeaks } = await import(join(repoRoot, 'src/audio/analysis/true-peak.js'));
const { crestFactorDb } = await import(join(repoRoot, 'src/audio/analysis/rms.js'));
const { monoCompatibility } = await import(join(repoRoot, 'src/audio/analysis/correlation.js'));
const { defaultParameters, validateParameters } = await import(
  join(repoRoot, 'src/app/parameters.js')
);
const { findPreset } = await import(join(repoRoot, 'src/presets/index.js'));
const { OfflineAudioContext } = globalThis;

const argv = process.argv.slice(2);
const arg = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const matDir = '/home/user/qa/materials';
const srcName = arg('--src', 'acoustic.wav');
const presetName = arg('--preset', null);
const bypassAll = argv.includes('--bypass-all');
const mods = ['match', 'tone', 'multiband', 'stereo', 'character', 'depth', 'saturation'];

const wav = await readWav(join(matDir, srcName));
const probe = new OfflineAudioContext(1, 1, wav.sampleRate);
const source = probe.createBuffer(wav.channels.length, wav.channels[0].length, wav.sampleRate);
for (let c = 0; c < wav.channels.length; c++) source.copyToChannel(wav.channels[c], c);

let parameters = { ...defaultParameters() };
if (presetName) {
  const p = findPreset(presetName);
  if (!p) throw new Error('no preset: ' + presetName);
  parameters = validateParameters({ ...parameters, ...p.parameters }).parameters;
}
if (argv.includes('--no-normalise')) parameters.normalize = false;
const overrides = arg('--set', null);
if (overrides) {
  for (const pair of overrides.split(',')) {
    const [k, v] = pair.split('=');
    parameters[k] = Number.isNaN(Number(v)) ? v : Number(v);
  }
}
const moduleBypass = bypassAll ? Object.fromEntries(mods.map((m) => [m, true])) : {};

const line = (d, tag) => {
  const l = analyseLoudness(d);
  const p = analysePeaks(d);
  let firstNZ = -1;
  for (let i = 0; i < Math.min(d.length, d.sampleRate); i++) {
    if (Math.abs(d.channels[0][i]) > 1e-6) {
      firstNZ = i;
      break;
    }
  }
  const mono = d.channels.length > 1 ? monoCompatibility(d) : null;
  const dc = d.channels.reduce(
    (m, c) => Math.max(m, Math.abs(c.reduce((s, v) => s + v, 0) / c.length)),
    0,
  );
  console.log(
    `${tag.padEnd(20)} LUFS ${l.integrated.toFixed(2).padStart(7)}  TP ${p.truePeakDb.toFixed(2).padStart(7)}` +
      `  crest ${crestFactorDb(d).toFixed(1).padStart(5)}  corr ${mono ? mono.overallCorrelation.toFixed(2) : ' n/a '}  ` +
      `dc ${dc.toFixed(4)}  firstNZ ${firstNZ >= 0 ? ((firstNZ / d.sampleRate) * 1000).toFixed(2) + 'ms' : '-'}`,
  );
};

console.log(
  `\n=== ${srcName}  preset=${presetName ?? 'schema defaults'}  bypassAll=${bypassAll}  normalize=${parameters.normalize}  stereo=${requiresStereo(parameters)}`,
);
line(fromAudioBuffer(source), '0 source');
const rendered = await renderChain(source, parameters, { moduleBypass, bypassAll });
line(fromAudioBuffer(rendered), '1 graph');
const data = fromAudioBuffer(rendered);
shapeTransients(data, { attack: parameters.transAttack, sustain: parameters.transSustain });
line(data, '2 transient');
const nl = normalizeAndLimit(data, {
  normalize: parameters.normalize,
  targetLufs: parameters.targetLUFS,
  ceilingDb: parameters.ceiling,
  refine: parameters.normalize,
});
line(data, '3 norm+limit');
console.log(
  `   norm: gain ${nl.normalizationGainDb?.toFixed(2)} dB → ${nl.achievedLufs?.toFixed(2)} LUFS (target ${nl.targetLufs}) ` +
    `passes ${nl.passes} gr ${nl.limiter?.averageGainReductionDb?.toFixed(2)}/${nl.limiter?.maxGainReductionDb?.toFixed(2)} ` +
    `TP est ${nl.limiter?.achievedTruePeakDb?.toFixed(2)} respected ${nl.limiter?.ceilingRespected}`,
);
applyDither(data, parameters.dither, 32, parameters.textureSeed);
line(data, '4 dither32f');

if (argv.includes('--tap')) {
  for (let k = 0; k < 10; k++) {
    const ctx = createOfflineContext(2, source.length, source.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = source;
    const chain = buildMasteringChain(ctx, { textureSeed: parameters.textureSeed });
    applyParameters(chain, parameters, { bypassAll, moduleBypass });
    const list = [
      ['input', chain.input],
      ['trim', chain.trim],
      ['matchEQ', chain.matchBands[chain.matchBands.length - 1]],
      ['tone', chain.tone.output],
      ['multiband', chain.multiband.output],
      ['stereo', chain.stereo.output],
      ['character', chain.character.output],
      ['depth', chain.depth.output],
      ['satur', chain.saturation.output],
      ['out', chain.output],
    ];
    src.connect(chain.input);
    list[k][1].connect(ctx.destination);
    chain.start(0);
    src.start(0);
    const out = await ctx.startRendering();
    line(fromAudioBuffer(out), `tap ${k} ${list[k][0]}`);
    chain.dispose();
  }
}
console.log('curve writes:', JSON.stringify(assertCurvesFlushed()));
