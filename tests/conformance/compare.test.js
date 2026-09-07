import { describe, it, expect } from 'vitest';
import { compareMeasurements, compareBrowsers } from './compare.js';
import { classifyParameters, referenceParameters, creativeParameters } from './classify.js';
import { renderMarkdown, renderJson } from './report.js';

const base = (over = {}) => ({
  id: 'pink-noise',
  class: 'reference',
  finite: { ok: true, nan: 0, inf: 0, samples: 100 },
  loudness: { integrated: -14.0, lra: 4, silent: false, tooShort: false },
  peak: { sampleDb: -3, truePeakDb: -2.5 },
  rmsDb: -16,
  crestFactorDb: 12,
  correlation: 0.95,
  dc: { maxAbs: 0 },
  spectrum: {
    centroidHz: 1200,
    bandsDb: [
      { id: 'sub', db: -20 },
      { id: 'air', db: -18 },
    ],
  },
  mono: { overallCorrelation: 0.95, worstBand: { label: 'mid', monoLossDb: -1.2 } },
  channels: 2,
  perChannel: [
    { index: 0, silent: false },
    { index: 1, silent: false },
  ],
  ...over,
});

describe('classifyParameters', () => {
  it('calls schema defaults REFERENCE / CLEAN', () => {
    expect(classifyParameters(referenceParameters()).class).toBe('reference');
  });

  it('calls a coloured snapshot CREATIVE / SIGNAL ROT', () => {
    const c = classifyParameters(creativeParameters());
    expect(c.class).toBe('creative');
    expect(c.reasons.some((r) => r.startsWith('sat:'))).toBe(true);
  });
});

describe('compareMeasurements', () => {
  it('passes identical reference measurements', () => {
    const r = compareMeasurements([base()], [base()], { class: 'reference' });
    expect(r.summary.ok).toBe(true);
    expect(r.flags).toEqual([]);
  });

  it('flags a >1 dB unexplained loudness jump on the reference path as a defect', () => {
    const r = compareMeasurements(
      [base()],
      [base({ loudness: { integrated: -12.4, lra: 4, silent: false, tooShort: false } })],
      { class: 'reference' },
    );
    expect(r.flags.some((f) => f.kind === 'loudness-change' && f.severity === 'defect')).toBe(true);
    expect(r.summary.ok).toBe(false);
  });

  it('records the same loudness jump on a creative path as info, not a defect', () => {
    const r = compareMeasurements(
      [base({ class: 'creative' })],
      [
        base({
          class: 'creative',
          loudness: { integrated: -10.0, lra: 4, silent: false, tooShort: false },
        }),
      ],
    );
    const loud = r.flags.filter((f) => f.kind === 'loudness-change');
    expect(loud).toHaveLength(1);
    expect(loud[0].severity).toBe('info');
    expect(r.summary.ok).toBe(true);
  });

  it('always flags NaN, unexpected DC, and true-peak violations as defects', () => {
    const nan = compareMeasurements(
      [base()],
      [base({ finite: { ok: false, nan: 4, inf: 0, samples: 100 } })],
    );
    expect(nan.flags.some((f) => f.kind === 'nan' && f.severity === 'defect')).toBe(true);

    const dc = compareMeasurements([base()], [base({ dc: { maxAbs: 0.08 } })]);
    expect(dc.flags.some((f) => f.kind === 'dc')).toBe(true);

    const tp = compareMeasurements([base()], [base({ peak: { sampleDb: 0.2, truePeakDb: 0.4 } })], {
      checkCeiling: true,
      ceilingDb: -1,
    });
    expect(tp.flags.some((f) => f.kind === 'true-peak-violation')).toBe(true);
  });

  it('flags missing immersive channels and silent feeds', () => {
    const missing = compareMeasurements([base()], [base({ channels: 10 })], {
      expectedChannels: 12,
    });
    expect(missing.flags.some((f) => f.kind === 'missing-immersive-channels')).toBe(true);

    const silent = compareMeasurements(
      [base()],
      [
        base({
          perChannel: [
            { index: 0, silent: false },
            { index: 1, silent: true },
          ],
        }),
      ],
      { requireAllChannelsLive: true },
    );
    expect(silent.flags.some((f) => f.kind === 'silent-feed')).toBe(true);
  });

  it('flags a missing candidate id', () => {
    const r = compareMeasurements([base({ id: 'a' }), base({ id: 'b' })], [base({ id: 'a' })]);
    expect(r.flags.some((f) => f.kind === 'missing-measurement' && f.id === 'b')).toBe(true);
  });
});

describe('compareBrowsers', () => {
  it('downgrades non-fatal deltas to browser notes', () => {
    const r = compareBrowsers({
      chromium: [base()],
      firefox: [base({ rmsDb: -18.2, loudness: { integrated: -15.6, lra: 4, silent: false } })],
    });
    expect(r.summary.ok).toBe(true);
    expect(r.flags.every((f) => f.severity === 'browser' || f.severity === 'info')).toBe(true);
  });
});

describe('report renderer', () => {
  it('writes a markdown report that names defects and creative notes separately', () => {
    const comparison = compareMeasurements(
      [base()],
      [
        base({
          loudness: { integrated: -12.2, lra: 4, silent: false, tooShort: false },
          finite: { ok: false, nan: 1, inf: 0, samples: 10 },
        }),
      ],
      { class: 'reference' },
    );
    const md = renderMarkdown(comparison, { baseline: 'abc', candidate: 'def' });
    expect(md).toMatch(/FAIL/);
    expect(md).toMatch(/nan/);
    const json = renderJson(comparison, { baseline: 'abc' });
    expect(json.summary.defectCount).toBeGreaterThan(0);
  });
});
