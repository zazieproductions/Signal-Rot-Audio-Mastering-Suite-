import { test, expect } from '@playwright/test';
import { openLab, callLab, writeResult } from './helpers.js';
import { SCOPE, mark } from '../conformance/scope.js';

test.describe(`${mark(SCOPE.REAL_WEB_AUDIO)} Stereo section (real Web Audio render)`, () => {
  test('side path is unity at unity width; bass-mono is a true LR4', async ({
    page,
  }, testInfo) => {
    await openLab(page);
    const result = await callLab(page, 'stereoSection');
    await writeResult(testInfo, 'stereo-section', result);

    // Mid path bypasses the width split: a correlated probe must pass at unity.
    // (If this fails but the side path passes, the matrix is broken, not the filters.)
    testInfo.annotations.push({
      type: 'mid-unity',
      description: `${result.browser}: mid L ${result.midUnity.leftDb.toFixed(3)} dB, R ${result.midUnity.rightDb.toFixed(3)} dB @ ${result.midUnity.freq} Hz`,
    });
    expect(Math.abs(result.midUnity.leftDb), 'mid left unity').toBeLessThan(0.35);
    expect(Math.abs(result.midUnity.rightDb), 'mid right unity').toBeLessThan(0.35);

    // Side path at unity width gains: the width split must reconstruct flat.
    // Issue #19 put +7.4 dB here at the 250 Hz / 4 kHz corners.
    for (const r of result.sideUnity.byFreq) {
      const goalMet = Math.abs(r.gainDb) < 0.1;
      testInfo.annotations.push({
        type: 'side-unity',
        description: `side @ ${r.freq} Hz: ${r.gainDb.toFixed(3)} dB ${goalMet ? '(±0.1 dB goal met)' : '(±0.1 dB goal MISSED)'}`,
      });
      expect(Math.abs(r.gainDb), `side unity @ ${r.freq} Hz`).toBeLessThan(0.5);
    }

    // Bass-mono corner shape: a genuine 24 dB/octave LR4, not a resonant bump.
    for (const r of result.bassMono.rows) {
      testInfo.annotations.push({
        type: 'bass-mono',
        description: `corner ${result.bassMono.corner} Hz, probe ${r.freq} Hz: ${r.gainDb.toFixed(2)} dB (expect ${r.expectDb} ± ${r.tolDb})`,
      });
      expect(
        Math.abs(r.gainDb - r.expectDb),
        `bass-mono shape @ ${r.freq} Hz`,
      ).toBeLessThanOrEqual(r.tolDb);
    }
  });
});
