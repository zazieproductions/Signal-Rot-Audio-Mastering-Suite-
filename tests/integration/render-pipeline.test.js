import { describe, it, expect } from 'vitest';
import { shapeTransients } from '../../src/audio/render/transient-shaper.js';
import { normalizeAndLimit } from '../../src/audio/render/normalize.js';
import { applyDither } from '../../src/audio/render/dither.js';
import { buildRenderReport, summariseReport } from '../../src/audio/render/report.js';
import { analyseLoudness } from '../../src/audio/analysis/loudness.js';
import { analysePeaks } from '../../src/audio/analysis/true-peak.js';
import { crestFactorDb } from '../../src/audio/analysis/rms.js';
import { monoCompatibility } from '../../src/audio/analysis/correlation.js';
import { cloneAudioData, samplePeak } from '../../src/audio/dsp/audio-data.js';
import { writeWav } from '../../src/audio/encode/wav.js';
import { writeAiff } from '../../src/audio/encode/aiff.js';
import { defaultParameters } from '../../src/app/parameters.js';
import { toView, parseChunks, parseFmt, readSamples } from '../helpers/riff.js';
import { pinkNoise, transientTrain, sine, silence } from '../helpers/signals.js';

/**
 * The post-render half of the export pipeline, which is where every numeric guarantee
 * lives. The `OfflineAudioContext` stage cannot run in Node — `tests/integration/graph.test.js`
 * covers its construction, and `e2e/` exercises it in a real browser.
 */
function runPipeline(input, parameters, { bitDepth = 24 } = {}) {
  const data = cloneAudioData(input);
  const analysisBefore = {
    loudness: analyseLoudness(data),
    peaks: analysePeaks(data),
    crestFactorDb: crestFactorDb(data),
  };
  const transient = shapeTransients(data, {
    attack: parameters.transAttack,
    sustain: parameters.transSustain,
  });
  const loudnessResult = normalizeAndLimit(data, {
    normalize: parameters.normalize,
    targetLufs: parameters.targetLUFS,
    ceilingDb: parameters.ceiling,
    refine: true,
  });
  const dither = applyDither(data, parameters.dither, bitDepth, parameters.textureSeed);
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
    source: { name: 'fixture.wav', sampleRate: data.sampleRate, channels: 2, durationSeconds: 10 },
    output: {
      sampleRate: data.sampleRate,
      channels: data.channels.length,
      durationSeconds: data.length / data.sampleRate,
      bitDepth,
      format: 'wav',
    },
    presetName: 'Test',
    moduleBypass: {},
    renderMs: 1,
  });
  return { data, report, loudnessResult };
}

describe('normalisation converges on the target', () => {
  for (const target of [-14, -18, -23]) {
    it(`hits ${target} LUFS within 0.25 LU on pink noise`, () => {
      const parameters = { ...defaultParameters(), targetLUFS: target, ceiling: -1 };
      const { report } = runPipeline(
        pinkNoise({ amplitude: 0.1, seconds: 10, seed: 5 }),
        parameters,
      );
      expect(Math.abs(report.loudness.deltaLu)).toBeLessThan(0.25);
      expect(report.loudness.targetReachable).toBe(true);
    });
  }

  /**
   * A transparent look-ahead limiter has a hard loudness ceiling set by the material's
   * crest factor. Pink noise at a −1 dBTP ceiling saturates around −9.8 LUFS: +22 dB and
   * +30 dB of input gain deliver exactly the same loudness. Signal Rot detects the
   * plateau instead of pretending, and says so in the report.
   */
  it('reports an unreachable target honestly instead of silently missing it', () => {
    const parameters = { ...defaultParameters(), targetLUFS: -9, ceiling: -1 };
    const { report } = runPipeline(pinkNoise({ amplitude: 0.1, seconds: 10, seed: 5 }), parameters);
    expect(report.loudness.targetReachable).toBe(false);
    expect(report.loudness.deltaLu).toBeLessThan(0);
    expect(report.loudness.deltaLu).toBeGreaterThan(-2);
    expect(report.warnings.some((w) => /not reachable/.test(w))).toBe(true);
    // It still respected the ceiling while failing to reach the target.
    expect(report.limiter.ceilingRespected).toBe(true);
  });

  it('hits the target on dense transient material where a single pass would not', () => {
    const parameters = { ...defaultParameters(), targetLUFS: -9, ceiling: -1 };
    const source = transientTrain({ seconds: 8, peakAmplitude: 1.2, bedAmplitude: 0.15 });

    const singlePass = cloneAudioData(source);
    const single = normalizeAndLimit(singlePass, {
      normalize: true,
      targetLufs: -9,
      ceilingDb: -1,
      refine: false,
    });

    const { report } = runPipeline(source, parameters);
    expect(Math.abs(report.loudness.deltaLu)).toBeLessThanOrEqual(
      Math.abs(single.achievedLufs - -9) + 1e-9,
    );
    expect(Math.abs(report.loudness.deltaLu)).toBeLessThan(0.3);
  });

  it('leaves loudness alone when normalisation is off', () => {
    const parameters = { ...defaultParameters(), normalize: false, ceiling: -1 };
    const source = pinkNoise({ amplitude: 0.05, seconds: 8, seed: 7 });
    const before = analyseLoudness(source).integrated;
    const { report } = runPipeline(source, parameters);
    expect(report.loudness.normalizationGainDb).toBe(0);
    expect(report.loudness.targetLufs).toBeNull();
    expect(report.analysisAfter.integratedLufs).toBeCloseTo(before, 1);
  });

  it('does not blow up on silence', () => {
    const parameters = { ...defaultParameters(), targetLUFS: -14 };
    const { report, data } = runPipeline(silence({ seconds: 5 }), parameters);
    expect(report.analysisAfter.integratedLufs).toBeNull();
    expect(report.warnings.some((w) => /absolute gate/.test(w))).toBe(true);
    // TPDF dither is applied to silence too — that is the point of dither, and the
    // resulting noise floor is below one LSB of the target bit depth.
    const lsb = 1 / 8388608;
    for (const ch of data.channels)
      for (const v of ch) expect(Math.abs(v)).toBeLessThanOrEqual(lsb);
  });
});

describe('the ceiling is always respected and always verified', () => {
  for (const ceiling of [-0.1, -0.3, -1, -2]) {
    for (const target of [-9, -14]) {
      it(`holds ${ceiling} dBTP at ${target} LUFS`, () => {
        const parameters = { ...defaultParameters(), targetLUFS: target, ceiling };
        const { report, data } = runPipeline(
          transientTrain({ seconds: 6, peakAmplitude: 1.4 }),
          parameters,
        );
        expect(report.limiter.ceilingRespected).toBe(true);
        expect(report.limiter.achievedTruePeakDbtp).toBeLessThanOrEqual(ceiling + 0.05);
        // Independent re-measurement of the finished buffer.
        expect(analysePeaks(data).truePeakDb).toBeLessThanOrEqual(ceiling + 0.05);
      });
    }
  }

  it('reports the maximum gain reduction it applied', () => {
    const parameters = { ...defaultParameters(), targetLUFS: -9, ceiling: -1 };
    const { report } = runPipeline(transientTrain({ seconds: 6, peakAmplitude: 1.6 }), parameters);
    expect(report.limiter.maximumGainReductionDb).toBeLessThan(-1);
    expect(report.limiter.reducedSampleRatio).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  it('produces bit-identical output for the same seed and settings', () => {
    const parameters = {
      ...defaultParameters(),
      targetLUFS: -14,
      dither: 'tpdf',
      textureSeed: 777,
    };
    const source = pinkNoise({ amplitude: 0.1, seconds: 6, seed: 3 });
    const a = runPipeline(source, parameters, { bitDepth: 16 });
    const b = runPipeline(source, parameters, { bitDepth: 16 });
    for (let c = 0; c < a.data.channels.length; c++) {
      for (let i = 0; i < a.data.length; i++) {
        expect(a.data.channels[c][i]).toBe(b.data.channels[c][i]);
      }
    }
  });

  it('produces different output for a different texture seed', () => {
    const source = pinkNoise({ amplitude: 0.1, seconds: 4, seed: 3 });
    const a = runPipeline(
      source,
      { ...defaultParameters(), textureSeed: 1, dither: 'tpdf' },
      { bitDepth: 16 },
    );
    const b = runPipeline(
      source,
      { ...defaultParameters(), textureSeed: 2, dither: 'tpdf' },
      {
        bitDepth: 16,
      },
    );
    let differences = 0;
    for (let i = 0; i < a.data.length; i++) {
      if (a.data.channels[0][i] !== b.data.channels[0][i]) differences++;
    }
    expect(differences).toBeGreaterThan(a.data.length * 0.5);
  });
});

describe('format round trip', () => {
  it('preserves duration, sample rate and channel count through WAV', async () => {
    const parameters = defaultParameters();
    const source = pinkNoise({ amplitude: 0.1, seconds: 3, seed: 11 });
    const { data } = runPipeline(source, parameters);

    const view = await toView(writeWav(data, { bitDepth: 24 }));
    const { chunks } = parseChunks(view);
    const fmt = parseFmt(
      view,
      chunks.find((c) => c.id === 'fmt '),
    );
    const samples = readSamples(
      view,
      chunks.find((c) => c.id === 'data'),
      fmt,
    );

    expect(fmt.sampleRate).toBe(source.sampleRate);
    expect(fmt.channels).toBe(2);
    expect(samples[0].length).toBe(source.length);
    for (let i = 0; i < data.length; i += 997) {
      expect(samples[0][i]).toBeCloseTo(data.channels[0][i], 5);
    }
  });

  it('preserves the peak ceiling through 16-bit quantisation', async () => {
    const parameters = { ...defaultParameters(), targetLUFS: -12, ceiling: -1, dither: 'tpdf' };
    const { data } = runPipeline(transientTrain({ seconds: 4 }), parameters, { bitDepth: 16 });
    const view = await toView(writeWav(data, { bitDepth: 16 }));
    const { chunks } = parseChunks(view);
    const fmt = parseFmt(
      view,
      chunks.find((c) => c.id === 'fmt '),
    );
    const samples = readSamples(
      view,
      chunks.find((c) => c.id === 'data'),
      fmt,
    );
    const decoded = { sampleRate: fmt.sampleRate, length: samples[0].length, channels: samples };
    // Quantisation and dither add at most one LSB (−90 dBFS at 16-bit), so the ceiling
    // survives with a comfortable margin.
    expect(analysePeaks(decoded).truePeakDb).toBeLessThan(-0.9);
  });

  it('preserves duration and rate through AIFF', async () => {
    const source = sine({ amplitude: 0.4, seconds: 2, sampleRate: 44100 });
    const { data } = runPipeline(source, defaultParameters());
    const view = await toView(writeAiff(data, { bitDepth: 24 }));
    const { chunks } = parseChunks(view, false);
    const comm = chunks.find((c) => c.id === 'COMM');
    expect(view.getUint32(comm.dataOffset + 2, false)).toBe(source.length);
    expect(view.getUint16(comm.dataOffset, false)).toBe(2);
  });
});

describe('render report', () => {
  it('records everything the brief requires', () => {
    const parameters = { ...defaultParameters(), targetLUFS: -14, warm: 2, sat: 10 };
    const { report } = runPipeline(pinkNoise({ amplitude: 0.1, seconds: 8, seed: 13 }), parameters);

    expect(report.engine.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(() => new Date(report.timestamp).toISOString()).not.toThrow();
    expect(report.source.name).toBe('fixture.wav');
    expect(report.preset.name).toBe('Test');
    expect(report.parameters.warm).toBe(2);
    expect(report.parameters.sat).toBe(10);
    // Default-valued parameters are omitted to keep the report readable.
    expect(report.parameters.width).toBeUndefined();

    expect(Number.isFinite(report.analysisBefore.integratedLufs)).toBe(true);
    expect(Number.isFinite(report.analysisAfter.integratedLufs)).toBe(true);
    expect(Number.isFinite(report.analysisBefore.truePeakDbtp)).toBe(true);
    expect(Number.isFinite(report.analysisAfter.truePeakDbtp)).toBe(true);
    expect(Number.isFinite(report.loudness.normalizationGainDb)).toBe(true);
    expect(Number.isFinite(report.limiter.maximumGainReductionDb)).toBe(true);
    expect(report.format.bitDepth).toBe(24);
    expect(report.format.channels).toBe(2);
    expect(report.dither.mode).toBeTruthy();
    expect(report.reproducibility.textureSeed).toBe(parameters.textureSeed);
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(Array.isArray(report.analysisAfter.monoBands)).toBe(true);
  });

  it('is JSON-serialisable with no undefined or NaN leaking through', () => {
    const { report } = runPipeline(pinkNoise({ seconds: 5, seed: 17 }), defaultParameters());
    const json = JSON.stringify(report);
    expect(json).not.toContain('NaN');
    expect(json).not.toContain('Infinity');
    expect(JSON.parse(json)).toBeTruthy();
  });

  it('warns loudly when the ceiling is not respected', () => {
    const { report } = runPipeline(pinkNoise({ seconds: 5, seed: 19 }), defaultParameters());
    // Forge a failing limiter result and confirm the report surfaces it.
    const forged = buildRenderReport({
      parameters: defaultParameters(),
      analysisBefore: {
        loudness: { integrated: -20, lra: 5, maxMomentary: -18, maxShortTerm: -19 },
        peaks: { samplePeakDb: -3, truePeakDb: -2.5 },
        crestFactorDb: 12,
      },
      analysisAfter: {
        loudness: { integrated: -14, lra: 5, maxMomentary: -12, maxShortTerm: -13, silent: false },
        peaks: { samplePeakDb: -0.5, truePeakDb: 0.4 },
        crestFactorDb: 9,
        mono: null,
        samplePeak: 0.9,
      },
      loudnessResult: {
        measuredBeforeLufs: -20,
        normalizationGainDb: 6,
        achievedLufs: -14,
        deltaLu: 0,
        passes: 2,
        limiter: {
          maxGainReductionDb: -6,
          averageGainReductionDb: -2,
          reducedSampleRatio: 0.4,
          achievedTruePeakDb: 0.4,
          ceilingRespected: false,
          correctionTrimDb: -1,
        },
      },
      transient: { applied: false },
      dither: { mode: 'tpdf', applied: true },
      source: { name: 'x', sampleRate: 48000, channels: 2, durationSeconds: 10 },
      output: { sampleRate: 48000, channels: 2, durationSeconds: 10, bitDepth: 24, format: 'wav' },
      presetName: 'X',
      moduleBypass: {},
      renderMs: 1,
    });
    expect(forged.limiter.ceilingRespected).toBe(false);
    expect(forged.warnings.some((w) => /exceeds/.test(w))).toBe(true);
    expect(summariseReport(forged)).toContain('OVER');
    expect(report.warnings).toBeDefined();
  });

  it('summarises a render in one line', () => {
    const { report } = runPipeline(pinkNoise({ seconds: 6, seed: 23 }), defaultParameters());
    const summary = summariseReport(report);
    expect(summary).toMatch(/LUFS/);
    expect(summary).toMatch(/dBTP/);
    expect(summary).not.toContain('OVER');
  });
});
