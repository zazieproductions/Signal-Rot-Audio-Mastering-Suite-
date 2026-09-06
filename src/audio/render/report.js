/**
 * Render report.
 *
 * Every export produces one of these, and it is downloadable as JSON. The point is
 * accountability: a mastering engineer should be able to answer "what did this tool
 * actually do to my file?" from the artefact, not from memory.
 *
 * Notably it reports the *achieved* loudness and true peak, not the requested ones, and
 * states explicitly whether the ceiling was respected. Overs are never hidden.
 */

import { ENGINE_NAME, ENGINE_VERSION } from '../../app/constants.js';
import { PARAMETER_LIST } from '../../app/parameters.js';
import { round } from '../dsp/math.js';

const num = (v, d = 2) => (Number.isFinite(v) ? round(v, d) : null);

/**
 * Build the report object.
 * @returns {object} JSON-serialisable
 */
export function buildRenderReport(input) {
  const {
    parameters,
    analysisBefore,
    analysisAfter,
    loudnessResult,
    transient,
    dither,
    source,
    output,
    presetName,
    moduleBypass,
    renderMs,
    adaptation,
  } = input;

  const limiter = loudnessResult.limiter ?? {};
  const ceilingRespected = limiter.ceilingRespected !== false;

  /** Only record parameters that differ from their default — keeps reports readable. */
  const activeParameters = {};
  for (const spec of PARAMETER_LIST) {
    const value = parameters[spec.key];
    const isDefault =
      spec.type === 'array'
        ? JSON.stringify(value) === JSON.stringify(spec.defaultValue)
        : value === spec.defaultValue;
    if (!isDefault) activeParameters[spec.key] = value;
  }

  const warnings = [];
  if (!ceilingRespected) {
    warnings.push(
      `True peak ${num(limiter.achievedTruePeakDb)} dBTP exceeds the ${parameters.ceiling} dBTP ` +
        'ceiling. The limiter could not hold it; reduce input drive or saturation.',
    );
  }
  if (loudnessResult.ambitionReduced) {
    warnings.push(
      `Loudness ambition was reduced to protect the sound: the ${parameters.targetLUFS} LUFS ` +
        `target would have needed constant heavy limiting, so the master settled at ` +
        `${num(loudnessResult.achievedLufs, 1)} LUFS instead. Transparency over loudness.`,
    );
  }
  if (parameters.normalize && Number.isFinite(loudnessResult.deltaLu)) {
    if (loudnessResult.targetReachable === false) {
      warnings.push(
        `The ${parameters.targetLUFS} LUFS target is not reachable on this material at a ` +
          `${parameters.ceiling} dBTP ceiling: the limiter saturated at ` +
          `${num(loudnessResult.achievedLufs, 1)} LUFS (${num(loudnessResult.deltaLu, 1)} LU short). ` +
          'Beyond this point more gain produces only more gain reduction. Getting louder ' +
          'needs clipping, a lower ceiling, or a denser mix.',
      );
    } else if (Math.abs(loudnessResult.deltaLu) > 0.5) {
      warnings.push(
        `Delivered loudness is ${num(loudnessResult.deltaLu, 2)} LU from the target after ` +
          `${loudnessResult.passes} pass(es). Heavy limiting prevents the target being reached.`,
      );
    }
  }
  if (analysisAfter.mono && analysisAfter.mono.worstBand) {
    const w = analysisAfter.mono.worstBand;
    if (w.monoLossDb < -6) {
      warnings.push(
        `Mono fold-down loses ${num(w.monoLossDb, 1)} dB in the ${w.label} band ` +
          `(${w.lo}–${Math.round(w.hi)} Hz).`,
      );
    }
  }
  if (analysisAfter.loudness.silent) {
    warnings.push('The rendered master contains no material above the −70 LUFS absolute gate.');
  }

  return {
    engine: { name: ENGINE_NAME, version: ENGINE_VERSION },
    timestamp: new Date().toISOString(),
    renderMs: Math.round(renderMs),

    source: {
      name: source.name,
      sampleRate: source.sampleRate,
      channels: source.channels,
      durationSeconds: num(source.durationSeconds, 3),
    },

    preset: { name: presetName, moduleBypass: { ...moduleBypass } },

    parameters: activeParameters,

    analysisBefore: {
      integratedLufs: num(analysisBefore.loudness.integrated),
      loudnessRangeLu: num(analysisBefore.loudness.lra),
      maxMomentaryLufs: num(analysisBefore.loudness.maxMomentary),
      maxShortTermLufs: num(analysisBefore.loudness.maxShortTerm),
      samplePeakDbfs: num(analysisBefore.peaks.samplePeakDb),
      truePeakDbtp: num(analysisBefore.peaks.truePeakDb),
      crestFactorDb: num(analysisBefore.crestFactorDb),
    },

    analysisAfter: {
      integratedLufs: num(analysisAfter.loudness.integrated),
      loudnessRangeLu: num(analysisAfter.loudness.lra),
      maxMomentaryLufs: num(analysisAfter.loudness.maxMomentary),
      maxShortTermLufs: num(analysisAfter.loudness.maxShortTerm),
      samplePeakDbfs: num(analysisAfter.peaks.samplePeakDb),
      truePeakDbtp: num(analysisAfter.peaks.truePeakDb),
      crestFactorDb: num(analysisAfter.crestFactorDb),
      correlation: num(analysisAfter.mono ? analysisAfter.mono.overallCorrelation : NaN),
      monoBands: analysisAfter.mono
        ? analysisAfter.mono.bands.map((b) => ({
            band: b.label,
            fromHz: b.lo,
            toHz: Math.round(b.hi),
            correlation: num(b.correlation),
            monoLossDb: num(b.monoLossDb, 1),
          }))
        : [],
    },

    loudness: {
      targetLufs: parameters.normalize ? parameters.targetLUFS : null,
      normalizationGainDb: num(loudnessResult.normalizationGainDb),
      achievedLufs: num(loudnessResult.achievedLufs),
      deltaLu: num(loudnessResult.deltaLu),
      refinementPasses: loudnessResult.passes,
      targetReachable: loudnessResult.targetReachable !== false,
      ambitionReduced: loudnessResult.ambitionReduced === true,
      effectiveTargetLufs:
        loudnessResult.ambitionReduced && parameters.normalize
          ? num(loudnessResult.effectiveTargetLufs)
          : parameters.normalize
            ? num(parameters.targetLUFS)
            : null,
    },

    adaptation: adaptation
      ? {
          sourceClass: adaptation.sourceClass ?? 'unmeasured',
          applied: (adaptation.adaptations ?? []).length > 0,
          notes: [...(adaptation.adaptations ?? [])],
        }
      : { sourceClass: 'unmeasured', applied: false, notes: [] },

    limiter: {
      ceilingDbtp: parameters.ceiling,
      maximumGainReductionDb: num(limiter.maxGainReductionDb),
      averageGainReductionDb: num(limiter.averageGainReductionDb),
      reducedSampleRatio: num(limiter.reducedSampleRatio, 4),
      achievedTruePeakDbtp: num(limiter.achievedTruePeakDb),
      correctionTrimDb: num(limiter.correctionTrimDb),
      ceilingRespected,
    },

    transientShaper: transient.applied
      ? {
          applied: true,
          attack: parameters.transAttack,
          sustain: parameters.transSustain,
          maxBoostDb: num(transient.maxBoostDb),
          maxCutDb: num(transient.maxCutDb),
        }
      : { applied: false },

    dither: {
      mode: dither.mode,
      applied: dither.applied,
      reason: dither.reason ?? null,
    },

    format: {
      container: output.format,
      sampleRate: output.sampleRate,
      channels: output.channels,
      bitDepth: output.bitDepth,
      durationSeconds: num(output.durationSeconds, 3),
    },

    reproducibility: {
      textureSeed: parameters.textureSeed,
      note:
        'Re-rendering with this engine version, these parameters and this texture seed ' +
        'produces an identical file. Browser differences in DynamicsCompressorNode and ' +
        'WaveShaperNode oversampling can change results across engines.',
    },

    warnings,
  };
}

/**
 * Human-readable one-line summary for the toast and the render-history panel.
 */
export function summariseReport(report) {
  const l = report.loudness;
  const lim = report.limiter;
  const parts = [];
  if (Number.isFinite(l.achievedLufs)) parts.push(`${l.achievedLufs.toFixed(1)} LUFS`);
  if (Number.isFinite(lim.achievedTruePeakDbtp)) {
    parts.push(`${lim.achievedTruePeakDbtp.toFixed(2)} dBTP`);
  }
  if (Number.isFinite(lim.maximumGainReductionDb) && lim.maximumGainReductionDb < -0.05) {
    parts.push(`${lim.maximumGainReductionDb.toFixed(1)} dB GR`);
  }
  if (!lim.ceilingRespected) parts.push('⚠ OVER');
  return parts.join(' · ');
}
