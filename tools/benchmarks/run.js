#!/usr/bin/env node
/**
 * Node-side performance bench of the *pure DSP* path (analysis, limiter).
 * Web Audio graph timing lives in the Playwright suite (`tests/browser/benchmark.spec.js`)
 * because OfflineAudioContext does not exist in Node.
 *
 *     node tools/benchmarks/run.js
 *
 * Does not modify or optimise production code. Reports bottlenecks.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { generateAll, getFixture } from '../../tests/fixtures/generate.js';
import { measureAudio } from '../../tests/fixtures/measure.js';
import { analyseLoudness } from '../../src/audio/analysis/loudness.js';
import { analysePeaks } from '../../src/audio/analysis/true-peak.js';
import { limitTruePeak } from '../../src/audio/render/limiter.js';
import { cloneAudioData, createAudioData } from '../../src/audio/dsp/audio-data.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function time(fn) {
  const t0 = performance.now();
  const result = fn();
  return { ms: performance.now() - t0, result };
}

function duplicateChannels(data, n) {
  const out = createAudioData(n, data.length, data.sampleRate);
  for (let c = 0; c < n; c++) out.channels[c].set(data.channels[c % data.channels.length]);
  return out;
}

const cases = [];
const pink = getFixture('pink-noise').generate({ seconds: 4 });
const train = getFixture('transient-train').generate({ seconds: 4 });

for (const [name, data] of [
  ['pink-stereo-48k', pink],
  ['transients-stereo-48k', train],
]) {
  const loud = time(() => analyseLoudness(data));
  const peaks = time(() => analysePeaks(data));
  const meas = time(() => measureAudio(data, { id: name }));
  const limited = cloneAudioData(data);
  const lim = time(() => limitTruePeak(limited, { ceilingDb: -1 }));
  cases.push({
    id: name,
    channels: data.channels.length,
    sampleRate: data.sampleRate,
    seconds: data.length / data.sampleRate,
    loudnessMs: loud.ms,
    truePeakMs: peaks.ms,
    measureMs: meas.ms,
    limiterMs: lim.ms,
  });
}

for (const nCh of [2, 12, 16, 24]) {
  const data = duplicateChannels(pink, nCh);
  const loud = time(() => analyseLoudness(data));
  const peaks = time(() => analysePeaks(data));
  const limited = cloneAudioData(data);
  const lim = time(() => limitTruePeak(limited, { ceilingDb: -1 }));
  cases.push({
    id: `pink-${nCh}ch-48k`,
    channels: nCh,
    sampleRate: 48000,
    seconds: data.length / data.sampleRate,
    loudnessMs: loud.ms,
    truePeakMs: peaks.ms,
    limiterMs: lim.ms,
  });
}

const all = generateAll();
const catalog = time(() => {
  for (const f of all) measureAudio(f.data, { id: f.id });
});

const report = {
  generatedAt: new Date().toISOString(),
  engine: 'node',
  catalogMeasureMs: catalog.ms,
  fixtureCount: all.length,
  cases,
  bottlenecks: cases
    .slice()
    .sort((a, b) => (b.truePeakMs ?? 0) - (a.truePeakMs ?? 0))
    .slice(0, 3)
    .map(
      (c) =>
        `${c.id}: true-peak ${c.truePeakMs.toFixed(1)} ms, limiter ${c.limiterMs.toFixed(1)} ms`,
    ),
};

mkdirSync(join(root, 'lab-results/benchmarks'), { recursive: true });
const out = join(root, 'lab-results/benchmarks/node.json');
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`Wrote ${out}`);
