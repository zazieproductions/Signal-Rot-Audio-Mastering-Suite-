/**
 * The offline master render — the single path every export goes through.
 *
 * ── Order of operations ──────────────────────────────────────────────────────────────
 *   1. `OfflineAudioContext` render of the full mastering chain (the *same*
 *      `buildMasteringChain` the live monitor uses — one constructor, one truth). The
 *      context always runs at the *source's* sample rate (§2.8).
 *   2. Sample-rate conversion, only when the requested delivery rate differs from the
 *      source rate — the single deliberate, band-limited windowed-sinc conversion.
 *   3. Transient shaping (per-sample, offline only).
 *   4. Normalisation + true-peak limiting, iterated to convergence, with a
 *      crest-aware gain-reduction budget so hot targets are never met by brickwalling
 *      (`docs/GAIN-STRUCTURE-AUDIT.md` §2.6).
 *   5. Dither, if the output is fixed-point.
 *   6. Verification and report — measured on the final, converted samples.
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
import {
  buildMasteringChain,
  applyParameters,
  monoSafeSource,
} from '../graph/build-mastering-chain.js';
import { resolveDryDelay } from '../graph/multiband.js';
import { fromAudioBuffer, samplePeak } from '../dsp/audio-data.js';
import { analyseLoudness } from '../analysis/loudness.js';
import { analysePeaks } from '../analysis/true-peak.js';
import { crestFactorDb } from '../analysis/rms.js';
import { correlation, monoCompatibility } from '../analysis/correlation.js';
import { TAPE_TRANSPORT_DELAY_S } from '../graph/character.js';
import { spectralFingerprint } from '../analysis/spectral-match.js';
import { adaptParameters, spectralSummary } from '../adaptive/source-aware.js';
import { measureBrightness, brightnessFactor } from '../analysis/brightness.js';
import { planHfBudget } from '../graph/hf-budget.js';
import { MATCH_FREQS } from '../../app/constants.js';
import { shapeTransients } from './transient-shaper.js';
import { resampleData } from '../dsp/resample.js';
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
 * @param {number} [opts.dryDelaySeconds] override the engine-measured dry-path delay
 * @param {number} [opts.brightnessFactor] 0..1; measured on the source when absent
 * @returns {Promise<AudioBuffer>}
 *
 * §2.8: the offline context always runs at `source.sampleRate`, so the browser's
 * internal resampler is never invoked mid-pipeline. Delivery-rate changes are applied
 * afterwards as one deliberate windowed-sinc conversion (`resampleData` in
 * `renderMaster`), never here.
 */
export async function renderChain(source, parameters, opts = {}) {
  // §2.8: the chain always renders at the *source's native rate* — never at a
  // requested delivery rate — so the browser never resamples the buffer behind our
  // back. A delivery-rate change is one deliberate, band-limited windowed-sinc
  // conversion applied afterwards, before transient shaping and normalisation.
  const sampleRate = source.sampleRate;
  const duration = opts.maxSeconds ? Math.min(source.duration, opts.maxSeconds) : source.duration;
  const channels = source.numberOfChannels === 1 && !requiresStereo(parameters) ? 1 : 2;
  const length = Math.max(1, Math.ceil(duration * sampleRate));

  // Match the multiband dry path to the compressor latency this engine actually has
  // (6.000 ms in browsers; measured per engine and rate, memoised).
  const dryDelay =
    opts.dryDelaySeconds != null
      ? { seconds: opts.dryDelaySeconds, measured: false, latencySeconds: null }
      : await resolveDryDelay(sampleRate);

  const ctx = createOfflineContext(channels, length, sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = source;

  const chain = buildMasteringChain(ctx, {
    textureSeed: parameters.textureSeed,
    dryDelaySeconds: dryDelay.seconds,
  });
  let brightnessFactorValue = opts.brightnessFactor;
  if (!Number.isFinite(brightnessFactorValue)) {
    const measured = measureBrightness(fromAudioBuffer(source));
    brightnessFactorValue = brightnessFactor(measured.hfRatioDb);
  }
  applyParameters(chain, parameters, {
    bypassAll: opts.bypassAll,
    moduleBypass: opts.moduleBypass,
    audition: 'stereo',
    brightnessFactor: brightnessFactorValue,
  });

  // Mono sources rendered to stereo are explicitly duplicated to dual mono first: a
  // 1-channel signal would otherwise reach the M/S splitter as L + silence and come
  // back as decorrelated pseudo-stereo (issue #20). Mono-to-mono connects directly.
  const head = source.numberOfChannels === 1 && channels === 2 ? monoSafeSource(src) : src;
  head.connect(chain.input);
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
  const sourceBrightness = measureBrightness(sourceData);
  const analysisBefore = {
    loudness: analyseLoudness(sourceData),
    peaks: analysePeaks(sourceData),
    crestFactorDb: crestFactorDb(sourceData),
    brightness: {
      hfRatioDb: sourceBrightness.hfRatioDb,
      hfRatio: sourceBrightness.hfRatio,
    },
  };

  // Source-aware adaptation: the same pure function the live preview uses, fed with a
  // fresh measurement of the source. The preset defines the character; the audio decides
  // how hard the processors work. The report records exactly what was softened and why.
  const sourceCorr =
    source.numberOfChannels < 2
      ? 1
      : correlation(sourceData.channels[0], sourceData.channels[1]);
  const adaptation = adaptParameters(parameters, {
    integrated: analysisBefore.loudness.integrated,
    lra: analysisBefore.loudness.lra,
    crestDb: analysisBefore.crestFactorDb,
    truePeakDb: analysisBefore.peaks.truePeakDb,
    spectral: spectralSummary(spectralFingerprint(sourceData)),
    channels: source.numberOfChannels,
    correlation: sourceCorr,
  });
  const effective = adaptation.parameters;

  // The HF-budget plan applied to this render, for the report: computed here with the
  // exact same inputs `applyParameters` uses (effective parameters — the ones the graph
  // actually applies), so the report cannot drift from the graph.
  const matchStrength = (moduleBypass?.match ? 0 : effective.matchStrength) / 100;
  const matchDelivered = MATCH_FREQS.map(
    (_, i) => (effective.matchGains[i] ?? 0) * matchStrength || 0,
  );
  const hfBudget = planHfBudget(
    moduleBypass?.tone
      ? { ...effective, air: 0, clarity: 0, tilt: 0, binaural: false }
      : effective,
    {
      brightnessFactor: brightnessFactor(sourceBrightness.hfRatioDb),
      matchDelivered,
    },
  );

  onProgress('rendering chain', 0.12);
  // §2.8: the chain always renders at the source's native rate; when the requested
  // delivery rate differs, ONE deliberate band-limited windowed-sinc conversion is
  // applied here — before transient shaping, normalisation and limiting — so the true
  // peak is measured and enforced on the final, converted samples.
  const renderedBuffer = await renderChain(source, effective, {
    moduleBypass,
    brightnessFactor: brightnessFactor(sourceBrightness.hfRatioDb),
  });
  let data = fromAudioBuffer(renderedBuffer);
  let conversion = null;
  if (sampleRate && sampleRate !== data.sampleRate) {
    onProgress('resampling', 0.4);
    const converted = resampleData(data, sampleRate, {
      onProgress: (f) => onProgress('resampling', 0.4 + f * 0.05),
    });
    conversion = {
      method: 'windowed-sinc (Kaiser), band-limited, single stage',
      from: data.sampleRate,
      to: converted.sampleRate,
    };
    data = converted;
  }
  // The dry-path delay renderChain used (memoised — this does not re-probe). The chain
  // ran at the source rate, so measure at the source rate.
  const dryDelay = await resolveDryDelay(source.sampleRate);

  onProgress('transient shaping', 0.48);
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
    latency: {
      dryDelaySeconds: (() => {
        const engaged =
          effective.mbLow > 0 || effective.mbMid > 0 || effective.mbHigh > 0;
        const bypassed = !!(moduleBypass && moduleBypass.multiband);
        return engaged && !bypassed ? dryDelay.seconds : 0;
      })(),
      compressorLatencySeconds: dryDelay.latencySeconds,
      compressorLatencyMeasured: dryDelay.measured,
      tapeDelaySeconds:
        effective.tape > 0 && !(moduleBypass && moduleBypass.character)
          ? TAPE_TRANSPORT_DELAY_S
          : 0,
      limiterLookaheadSeconds: 0.003,
      note:
        'Look-ahead limiter delay is in the gain computer (offline, centred window) and does not shift the file. Graph delays (multiband dry, tape transport) are zeroed when those stages are idle.',
    },
    adaptation: {
      sourceClass: adaptation.sourceClass,
      adaptations: adaptation.adaptations,
    },
    hfBudget,
    conversion,
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
