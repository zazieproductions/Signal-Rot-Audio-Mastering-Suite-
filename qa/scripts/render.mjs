#!/usr/bin/env node
/**
 * QA render harness — drives Signal Rot's *real* export path headlessly.
 *
 *   node qa/scripts/render.mjs --jobs jobs.json --out /home/user/qa/out [--mat /home/user/qa/materials]
 *
 * Installs a genuine Web Audio implementation (node-web-audio-api) as
 * `window.OfflineAudioContext` (see engine.mjs for the one engine adaptation), then calls
 * `renderMaster()` the way `src/app/export-controller.js` does: analysis → source-aware
 * adaptation → offline graph render → transient shaping → normalise+limit → dither → report.
 * The WAV that comes out is written by the repo's own encoder, so what I measure is what a
 * user would download.
 *
 * job: { id, src, preset?, params?, sampleRate?, bitDepth?, bypass?, refine? }
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installWebAudio, readWav, assertCurvesFlushed } from './engine.mjs';

const repoRoot = '/home/user/Signal-Rot-Audio-Mastering-Suite-';
installWebAudio();

const { renderMaster } = await import(join(repoRoot, 'src/audio/render/render-master.js'));
const { writeWav } = await import(join(repoRoot, 'src/audio/encode/wav.js'));
const { defaultParameters, validateParameters } = await import(
  join(repoRoot, 'src/app/parameters.js')
);
const { findPreset } = await import(join(repoRoot, 'src/presets/index.js'));
const { presetFamily, sanitizeForFamily } = await import(join(repoRoot, 'src/presets/_shared.js'));
const { expandCatalogPreset } = await import(join(repoRoot, 'src/app/presets-io.js'));
const { OfflineAudioContext } = globalThis;

/** Build the parameter block exactly the way the UI's catalogue path does. */
function parametersFor(job) {
  let patch = { ...(job.params ?? {}) };
  let meta = {};
  if (job.preset) {
    const p = findPreset(job.preset);
    if (!p) throw new Error('unknown preset: ' + job.preset);
    const family = presetFamily(p);
    const { parameters: clean, scrubbed } = sanitizeForFamily(family, p.parameters);
    patch = { ...clean, ...patch };
    const viaApp = expandCatalogPreset(clean, { preserve: {} });
    meta = {
      family,
      risk: p.risk,
      description: p.description,
      scrubbed,
      appPathDiffers: JSON.stringify(viaApp) !== JSON.stringify(clean),
    };
    if (job.useAppPath) patch = { ...viaApp, ...(job.params ?? {}) };
  }
  return { parameters: validateParameters({ ...defaultParameters(), ...patch }).parameters, meta };
}

const argv = process.argv.slice(2);
const arg = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const jobsPath = arg('--jobs');
const outDir = arg('--out', '/home/user/qa/out');
const matDir = arg('--mat', '/home/user/qa/materials');
if (!jobsPath) throw new Error('--jobs required');
const jobs = JSON.parse(readFileSync(jobsPath, 'utf8'));
mkdirSync(outDir, { recursive: true });

const probe = new OfflineAudioContext(1, 1, 44100);
const results = [];

for (const job of jobs) {
  const t0 = Date.now();
  try {
    const wav = await readWav(join(matDir, job.src));
    const source = probe.createBuffer(wav.channels.length, wav.channels[0].length, wav.sampleRate);
    for (let c = 0; c < wav.channels.length; c++) source.copyToChannel(wav.channels[c], c);

    const { parameters, meta } = parametersFor(job);
    const { data, report } = await renderMaster({
      source,
      parameters,
      sampleRate: job.sampleRate || 0,
      bitDepth: job.bitDepth ?? 32,
      moduleBypass: job.bypass ?? {},
      sourceName: job.src,
      presetName: job.preset ?? job.id,
      format: 'wav',
      refine: job.refine !== false,
    });
    const out = join(outDir, `${job.id}.wav`);
    const blob = writeWav(data, { bitDepth: job.bitDepth ?? 32 });
    writeFileSync(out, Buffer.from(await blob.arrayBuffer()));

    const a = report.analysisAfter ?? {};
    results.push({
      job: {
        id: job.id,
        src: job.src,
        preset: job.preset ?? null,
        overrides: job.params ?? {},
        bypass: job.bypass ?? null,
        meta,
      },
      ms: Date.now() - t0,
      output: out,
      report,
      parameters,
    });
    process.stdout.write(
      `${String(job.id).padEnd(30)} ${String(a.integratedLufs).padStart(6)} LUFS (tgt ${parameters.targetLUFS}${report.loudness.ambitionReduced ? '*' : ''}${(report.loudness.crestAware ?? {}).capped ? '!' : ''}) ` +
        `tp ${String(a.truePeakDbtp).padStart(6)} gr ${report.limiter.averageGainReductionDb}/${report.limiter.maximumGainReductionDb} ` +
        `crest ${a.crestFactorDb} corr ${a.correlation} ch ${report.format.channels} warn ${(report.warnings ?? []).length} ${((Date.now() - t0) / 1000).toFixed(1)}s\n`,
    );
  } catch (err) {
    process.stdout.write(
      `${String(job.id).padEnd(30)} FAILED ${String(err.message).slice(0, 90)}\n`,
    );
    results.push({
      job: { id: job.id, src: job.src, preset: job.preset ?? null },
      error: String(err.stack || err),
    });
  }
}

writeFileSync(join(outDir, 'reports.json'), JSON.stringify(results, null, 1));
const curve = assertCurvesFlushed();
process.stdout.write(
  `\n${results.filter((r) => !r.error).length}/${jobs.length} rendered → ${outDir}/reports.json\n`,
);
process.stdout.write(`waveshaper curves: ${JSON.stringify(curve)}\n`);
