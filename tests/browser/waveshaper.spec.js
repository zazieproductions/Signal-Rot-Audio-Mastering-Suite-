import { test, expect } from '@playwright/test';
import { openLab, callLab, writeResult } from './helpers.js';
import { SCOPE, mark } from '../conformance/scope.js';

test.describe(`${mark(SCOPE.REAL_WEB_AUDIO)} WaveShaperNode (real Web Audio)`, () => {
  test('measures clamp, sat=0 unity, headroom, oversampling, DC, monotonicity, harmonics', async ({
    page,
  }, testInfo) => {
    await openLab(page);
    const result = await callLab(page, 'waveshaper');
    await writeResult(testInfo, 'waveshaper', result);

    expect(result.node).toBe('WaveShaperNode');

    // Spec: input domain is clamped to ±1 before the curve lookup.
    expect(result.clamping.clampedHigh).toBe(true);
    expect(result.clamping.clampedLow).toBe(true);
    expect(result.clamping.outputPeak).toBeCloseTo(1, 2);

    // Production sat=0 path must be near unity for a −6 dBFS sine.
    expect(Math.abs(result.unitySat0.gainDb)).toBeLessThan(0.35);

    // Extended-domain headroom: a +6 dBFS sine at sat=0 must not hard-clip at 0 dBFS.
    expect(result.headroom.preservedAboveUnity).toBe(true);
    expect(result.headroom.clippedAtUnity).toBe(false);
    expect(result.headroom.outputPeak).toBeGreaterThan(1.5);

    // Oversampling quality is unspecified. We record it; we require the node to run.
    expect(result.oversampling.rows).toHaveLength(3);
    for (const row of result.oversampling.rows) {
      expect(Number.isFinite(row.h3Db)).toBe(true);
      expect(Number.isFinite(row.alias23kDb)).toBe(true);
    }
    const none = result.oversampling.rows.find((r) => r.oversample === 'none');
    const x4 = result.oversampling.rows.find((r) => r.oversample === '4x');
    testInfo.annotations.push({
      type: 'oversample',
      description: `${result.browser}: alias @23 kHz none=${none.alias23kDb.toFixed(1)} dB  4x=${x4.alias23kDb.toFixed(1)} dB  (relative to H1)`,
    });

    // DC at sat=0 and modest drive must stay tiny; the curve is documented DC-free.
    for (const row of result.dcMonotonicHarmonics.harmonics) {
      expect(Math.abs(row.dc), `dc at amount ${row.amount}`).toBeLessThan(0.02);
    }
    expect(result.dcMonotonicHarmonics.folds).toBe(0);

    // Drive must actually produce harmonics (H3 in particular) once engaged.
    const full = result.dcMonotonicHarmonics.harmonics.find((r) => r.amount === 1);
    expect(full.h3Db).toBeGreaterThan(-40);
  });
});
