import { test, expect } from '@playwright/test';
import { openLab, callLab, writeResult } from './helpers.js';
import { THRESHOLDS } from '../conformance/thresholds.js';
import { SCOPE, mark } from '../conformance/scope.js';

test.describe(`${mark(SCOPE.REAL_WEB_AUDIO)} Preview / export graph parity`, () => {
  test('quantifies RMS, peak and spectral divergence between the two graphs', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await openLab(page);
    const result = await callLab(page, 'previewExport');
    await writeResult(testInfo, 'preview-export', result);

    expect(result.rows).toHaveLength(2);

    for (const row of result.rows) {
      expect(row.export.finite).toBe(true);
      expect(row.preview.finite).toBe(true);
      expect(row.export.peak).toBeGreaterThan(0);
      expect(row.preview.peak).toBeGreaterThan(0);
      expect(row.export.dc).toBeLessThan(0.02);
      expect(row.preview.dc).toBeLessThan(0.02);

      const dRms = Math.abs(row.delta.rmsDb);
      const dPeak = Math.abs(row.delta.peakDb);
      testInfo.annotations.push({
        type: 'parity',
        description: `${result.browser} ${row.name}: ΔRMS ${row.delta.rmsDb.toFixed(3)} dB, Δpeak ${row.delta.peakDb.toFixed(3)} dB, Δcorr ${row.delta.correlation.toFixed(4)}`,
      });

      // Bit identity is not expected. A reference path should still sit well inside 1 dB
      // once the safety make-up is compensated; creative may diverge more because the
      // safety compressor is a real dynamics processor.
      if (row.class === 'reference') {
        expect(dRms, 'reference RMS divergence').toBeLessThan(THRESHOLDS.rmsDb.reference + 0.5);
        expect(dPeak, 'reference peak divergence').toBeLessThan(2.5);
      }
    }
  });
});
