/**
 * The offline master render — the single path every export goes through.
 *
 * ── Order of operations ──────────────────────────────────────────────────────────────
 *   1. `OfflineAudioContext` render of the full mastering chain (the *same*
 *      `buildMasteringChain` the live monitor uses — one constructor, one truth).
 *   2. Transient shaping (per-sample, offline only).
 *   3. Normalisation + true-peak limiting, iterated to convergence, with a
 *      crest-aware gain-reduction budget so hot targets are never met by brickwalling
 *      (`docs/GAIN-STRUCTURE-AUDIT.md` §2.6).
 *   4. Dither, if the output is fixed-point.
 *   5. Verification and report.
 *
 * ── Channel count ────────────────────────────────────────────────────────────────────
 * The audited renderer hard-coded two channels, so a mono source came back as dual mono
 * with no indication. Here the render channel count follows the source (mono stays mono
 * unless a stereo-only process is engaged), and the report states what happened.
 *
 * ── Determinism ──────────────────────────────────────────────────────────────────────
 * Everything stochastic is seeded from `parameters.textureSeed`. Rendering the same
 * project twice with the same seed produces identical samples — asserted by
 * `tests/integration/render-determinism.test.js` at the level of the pure pipeline.
 */

import { createOfflineContext } from '../context.js';
import { buildMasteringChain, applyParameters } from '../graph/build-mastering-chain.js';
import { fromAudioBuffer, samplePeak } from '../dsp/audio-data.js';
import { analyseLoudness } from '../analysis/loudness.js';
import { analysePeaks } from '../analysis/true-peak.js';
import { crestFactorDb } from '../analysis/rms.js';
import { monoCompatibility } from '../analysis/correlation.js';
import { spectralFingerprint } from '../analysis/spectral-match.js';
import { adaptParameters, spectralSummary } from '../adaptive/source-aware.js';
import { shapeTransients } from './transient-shaper.js';
import { normalizeAndLimit, CREST_AWARE_BUDGET } from './normalize.js';
import { applyDither } from './dither.js';
import { buildRenderReport } from './report.js';

/**
 * Does this parameter set require a stereo signal path?
 * Mono sources are only up-mixed when something actually needs two channels.
 */
export function requiresStereo(p) {
  return (
    p.width !== 1 ||
    p.ms !== 0 ||
    p.bassMono > 0 ||
    p.haas > 0 ||
    p.crossfeed > 0 ||
    p.phaseRot > 0 ||
    p.binaural ||
    p.widthLow !== 1 ||
    p.widthMid !== 1 ||
    p.widthHigh !== 1 ||
    p.depth > 0 ||
    p.hiss > 0 ||
    p.vinyl > 0
  );
}

/**
 * Render the mastering chain offline, without normalisation, limiting or transient
 * shaping. Used by the analysis pass and as step 1 of a full export.
 *
 * @param {AudioBuffer} source
 * @param {Record<string, any>} parameters
 * @param {object} [opts]
 * @param {number} [opts.sampleRate] 0 or undefined = keep the source rate
 * @param {Record<string, boolean>} [opts.moduleBypass]
 * @param {boolean} [opts.bypassAll]
 * @param {number} [opts.maxSeconds] truncate for fast analysis
 * @returns {Promise<AudioBuffer>}
 */
export async function renderChain(source, parameters, opts = {}) {
  const sampleRate = opts.sampleRate || source.sampleRate;
  const duration = opts.maxSeconds ? Math.min(source.duration, opts.maxSeconds) : source.duration;
  const channels = source.numberOfChannels === 1 && !requiresStereo(parameters) ? 1 : 2;
  const length = Math.max(1, Math.ceil(duration * sampleRate));

  const ctx = createOfflineContext(channels, length, sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = source;

  const chain = buildMasteringChain(ctx, { textureSeed: parameters.textureSeed });
  applyParameters(chain, parameters, {
    bypassAll: opts.bypassAll,
    moduleBypass: opts.moduleBypass,
    audition: 'stereo',
  });

  src.connect(chain.input);
  chain.output.connect(ctx.destination);
  chain.start(0);
  src.start(0);

  const rendered = await ctx.startRendering();
  chain.dispose();
  return rendered;
}

/**
 * @typedef {object} MasterRenderOptions
 * @property {AudioBuffer} source
 * @property {Record<string, any>} parameters
 * @property {number} [sampleRate]
 * @property {16|24|32} [bitDepth]
 * @property {Record<string, boolean>} [moduleBypass]
 * @property {string} [sourceName]
 * @property {string} [presetName]
 * @property {string} [format]
 * @property {(stage: string, fraction: number) => void} [onProgress]
 * @property {boolean} [refine] iterate normalisation to hit the target (default true)
 */

/**
 * Produce a finished master plus a full render report.
 *
 * @param {MasterRenderOptions} opts
 * @returns {Promise<{data: import('../dsp/audio-data.js').AudioData, report: object}>}
 */
export async function renderMaster(opts) {
  const {
    source,
    parameters,
    sampleRate,
    bitDepth = 24,
    moduleBypass,
    onProgress = () => {},
  } = opts;

  const startedAt = performance.now();

  onProgress('analysing source', 0.02);
  const sourceData = fromAudioBuffer(source);
  const analysisBefore = {
    loudness: analyseLoudness(sourceData),
    peaks: analysePeaks(sourceData),
    crestFactorDb: crestFactorDb(sourceData),
  };

  // Source-aware adaptation: the same pure function the live preview uses, fed with a
  // fresh measurement of the source. The preset defines the character; the audio decides
  // how hard the processors work. The report records exactly what was softened and why.
  const adaptation = adaptParameters(parameters, {
    integrated: analysisBefore.loudness.integrated,
    lra: analysisBefore.loudness.lra,
    crestDb: analysisBefore.crestFactorDb,
    truePeakDb: analysisBefore.peaks.truePeakDb,
    spectral: spectralSummary(spectralFingerprint(sourceData)),
  });
  const effective = adaptation.parameters;

  onProgress('rendering chain', 0.12);
  const renderedBuffer = await renderChain(source, effective, {
    sampleRate,
    moduleBypass,
  });
  const data = fromAudioBuffer(renderedBuffer);

  onProgress('transient shaping', 0.42);
  const transient = shapeTransients(data, {
    attack: effective.transAttack,
    sustain: effective.transSustain,
  });

  onProgress('normalising and limiting', 0.5);
  const loudnessResult = normalizeAndLimit(data, {
    normalize: effective.normalize,
    targetLufs: effective.targetLUFS,
    ceilingDb: effective.ceiling,
    refine: opts.refine !== false,
    // The export must never brickwall a record to hit a hot target: if the material
    // cannot take the limiting the target demands, deliver the loudest clean result and
    // say so (docs/GAIN-STRUCTURE-AUDIT.md §2.6).
    ...CREST_AWARE_BUDGET,
    onProgress: (stage, f) => onProgress(stage, 0.5 + f * 0.35),
  });

  onProgress('applying dither', 0.88);
  const dither = applyDither(data, parameters.dither, bitDepth, parameters.textureSeed);

  onProgress('verifying', 0.92);
  const analysisAfter = {
    loudness: analyseLoudness(data),
    peaks: analysePeaks(data),
    crestFactorDb: crestFactorDb(data),
    mono: monoCompatibility(data),
    samplePeak: samplePeak(data),
  };

  const report = buildRenderReport({
    parameters,
    analysisBefore,
    analysisAfter,
    loudnessResult,
    transient,
    dither,
    adaptation: {
      sourceClass: adaptation.sourceClass,
      adaptations: adaptation.adaptations,
    },
    source: {
      name: opts.sourceName ?? '',
      sampleRate: source.sampleRate,
      channels: source.numberOfChannels,
      durationSeconds: source.duration,
    },
    output: {
      sampleRate: data.sampleRate,
      channels: data.channels.length,
      durationSeconds: data.length / data.sampleRate,
      bitDepth,
      format: opts.format ?? 'wav',
    },
    presetName: opts.presetName ?? 'Custom',
    moduleBypass: moduleBypass ?? {},
    renderMs: performance.now() - startedAt,
  });

  onProgress('done', 1);
  return { data, report };
}
