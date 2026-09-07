import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_CATALOG, generateAll, getFixture } from './generate.js';
import { measureAudio } from './measure.js';
import { compareMeasurements } from '../conformance/compare.js';
import { cloneAudioData } from '../../src/audio/dsp/audio-data.js';
import { shapeTransients } from '../../src/audio/render/transient-shaper.js';
import { normalizeAndLimit } from '../../src/audio/render/normalize.js';
import { referenceParameters, creativeParameters } from '../conformance/classify.js';

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(here, 'goldens', 'sources.v1.json');

function stripVolatile(m) {
  return {
    id: m.id,
    title: m.title,
    class: m.class,
    sampleRate: m.sampleRate,
    length: m.length,
    channels: m.channels,
    finite: m.finite,
    loudness: m.loudness,
    peak: { sampleDb: m.peak.sampleDb, truePeakDb: m.peak.truePeakDb },
    rmsDb: m.rmsDb,
    crestFactorDb: m.crestFactorDb,
    correlation: m.correlation,
    mono: {
      overallCorrelation: m.mono.overallCorrelation,
      worstBand: m.mono.worstBand,
    },
    ms: { sideToMidDb: m.ms.sideToMidDb },
    spectrum: {
      centroidHz: m.spectrum.centroidHz,
      bandsDb: m.spectrum.bandsDb,
    },
    dc: { maxAbs: m.dc.maxAbs },
  };
}

function measureCatalog() {
  return generateAll().map((f) =>
    measureAudio(f.data, { id: f.id, title: f.title, class: 'source', engine: 'node' }),
  );
}

describe('golden fixture bank', () => {
  it('ships every requested source', () => {
    const ids = FIXTURE_CATALOG.map((f) => f.id);
    for (const need of [
      'impulse',
      'sine-sweep',
      'multitone',
      'bass-40',
      'bass-50',
      'bass-60',
      'bass-80',
      'bass-100',
      'transient-train',
      'clipped-source',
      'pink-noise',
      'correlated-stereo',
      'anti-correlated-stereo',
      'hard-left',
      'hard-right',
      'wide-diffuse',
      'bright-synthetic',
      'dense-compressed',
      'highly-dynamic',
    ]) {
      expect(ids, need).toContain(need);
    }
  });

  it('generates finite, deterministic audio for every fixture', () => {
    const a = generateAll();
    const b = generateAll();
    for (let i = 0; i < a.length; i++) {
      expect(a[i].data.length).toBe(b[i].data.length);
      expect(a[i].data.sampleRate).toBe(48000);
      const ch = a[i].data.channels[0];
      for (let s = 0; s < ch.length; s += 97) {
        expect(Number.isFinite(ch[s])).toBe(true);
        expect(ch[s]).toBe(b[i].data.channels[0][s]);
      }
    }
  });

  it('impulse is a single sample of amplitude 1', () => {
    const data = getFixture('impulse').generate();
    let nonzero = 0;
    let peak = 0;
    for (const ch of data.channels) {
      for (let i = 0; i < ch.length; i++) {
        if (ch[i] !== 0) nonzero++;
        peak = Math.max(peak, Math.abs(ch[i]));
      }
    }
    expect(nonzero).toBe(2); // one sample, two channels
    expect(peak).toBe(1);
  });

  it('correlated stereo reads r ≈ +1 and anti-correlated r ≈ −1', () => {
    const corr = measureAudio(getFixture('correlated-stereo').generate());
    const anti = measureAudio(getFixture('anti-correlated-stereo').generate());
    expect(corr.correlation).toBeGreaterThan(0.999);
    expect(anti.correlation).toBeLessThan(-0.999);
    expect(anti.mono.worstBand.monoLossDb).toBeLessThan(-20);
  });

  it('hard-left is silent on the right and hard-right is silent on the left', () => {
    const left = measureAudio(getFixture('hard-left').generate());
    const right = measureAudio(getFixture('hard-right').generate());
    expect(left.perChannel[0].silent).toBe(false);
    expect(left.perChannel[1].silent).toBe(true);
    expect(right.perChannel[0].silent).toBe(true);
    expect(right.perChannel[1].silent).toBe(false);
  });

  it('clipped source actually reaches the clip rail', () => {
    const m = measureAudio(getFixture('clipped-source').generate());
    expect(m.peak.sample).toBeGreaterThan(0.8);
    expect(m.peak.sample).toBeLessThanOrEqual(0.89 + 1e-6);
    expect(m.crestFactorDb).toBeLessThan(6);
  });

  it('dense surrogate is denser (lower crest) than the highly-dynamic surrogate', () => {
    const dense = measureAudio(getFixture('dense-compressed').generate());
    const dyn = measureAudio(getFixture('highly-dynamic').generate());
    expect(dense.crestFactorDb).toBeLessThan(dyn.crestFactorDb);
    expect(dense.crestFactorDb).toBeLessThan(10);
    expect(dyn.loudness.lra).toBeGreaterThan(dense.loudness.lra);
  });

  it('silence is silent and reports no NaN', () => {
    const m = measureAudio(getFixture('silence').generate());
    expect(m.finite.ok).toBe(true);
    expect(m.loudness.silent).toBe(true);
    expect(m.peak.sample).toBe(0);
    expect(m.dc.maxAbs).toBe(0);
  });

  it('bass tones land in the sub/bass bands, not the air band', () => {
    const m = measureAudio(getFixture('bass-60').generate());
    const byId = Object.fromEntries(m.spectrum.bandsDb.map((b) => [b.id, b.db]));
    expect(byId.sub).toBeGreaterThan(byId.air + 20);
    expect(byId.bass).toBeGreaterThan(byId.presence + 10);
  });

  it('matches the committed source golden JSON', () => {
    const measurements = measureCatalog().map(stripVolatile);
    expect(existsSync(GOLDEN_PATH), 'run `npm run lab:goldens` to create the snapshot').toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
    const goldenStripped = golden.measurements.map((m) => stripVolatile(m));
    const comparison = compareMeasurements(goldenStripped, measurements, { class: 'reference' });
    const defects = comparison.flags.filter((f) => f.severity === 'defect');
    expect(defects, JSON.stringify(defects, null, 2)).toEqual([]);
    expect(golden.measurements).toHaveLength(measurements.length);
  });
});

describe('offline-only processing goldens (reference vs creative)', () => {
  function run(data, parameters) {
    const copy = cloneAudioData(data);
    shapeTransients(copy, { attack: parameters.transAttack, sustain: parameters.transSustain });
    normalizeAndLimit(copy, {
      normalize: parameters.normalize,
      targetLufs: parameters.targetLUFS,
      ceilingDb: parameters.ceiling,
      refine: true,
    });
    return copy;
  }

  it('reference path respects the true-peak ceiling on a transient train', () => {
    const source = getFixture('transient-train').generate();
    const out = run(source, referenceParameters());
    const m = measureAudio(out, { id: 'transient-train', class: 'reference' });
    expect(m.finite.ok).toBe(true);
    expect(m.peak.truePeakDb).toBeLessThanOrEqual(-1 + 0.15);
  });

  it('creative path is allowed to change loudness and crest — and is classified as creative', () => {
    const source = getFixture('pink-noise').generate();
    const ref = measureAudio(run(source, referenceParameters({ transAttack: 0 })), {
      id: 'pink-noise',
      class: 'reference',
    });
    const cre = measureAudio(
      run(source, creativeParameters({ transAttack: 40, transSustain: -20 })),
      { id: 'pink-noise', class: 'creative' },
    );
    const comparison = compareMeasurements([ref], [cre]);
    // Creative notes are fine; NaN / DC / missing channels are not.
    expect(comparison.flags.filter((f) => f.severity === 'defect')).toEqual([]);
    expect(cre.class).toBe('creative');
  });

  it('reference vs reference of the same render is a no-op', () => {
    const source = getFixture('multitone').generate();
    const a = measureAudio(run(source, referenceParameters()), {
      id: 'multitone',
      class: 'reference',
    });
    const b = measureAudio(run(source, referenceParameters()), {
      id: 'multitone',
      class: 'reference',
    });
    const comparison = compareMeasurements([a], [b], { class: 'reference' });
    expect(comparison.summary.ok).toBe(true);
    expect(comparison.flags).toEqual([]);
  });
});
