import { test, expect } from '@playwright/test';
import { openLab, callLab, writeResult } from './helpers.js';
import { THRESHOLDS } from '../conformance/thresholds.js';

test.describe('Multiband (real Web Audio render)', () => {
  test('measures dry/wet alignment, reconstruction and partial-mix comb', async ({
    page,
  }, testInfo) => {
    await openLab(page);
    const result = await callLab(page, 'multiband');
    await writeResult(testInfo, 'multiband', result);

    const { alignment, reconstruction, partialMix } = result;

    // Wet and dry impulse peaks must land together to within a fraction of a millisecond.
    expect(Number.isFinite(alignment.deltaMs)).toBe(true);
    testInfo.annotations.push({
      type: 'alignment',
      description: `${result.browser}: wet−dry = ${alignment.deltaMs.toFixed(3)} ms (documented lookahead ${alignment.documentedLookaheadMs} ms)`,
    });
    if (Math.abs(alignment.deltaMs) > THRESHOLDS.dryWetAlignMs) {
      testInfo.annotations.push({
        type: 'finding',
        description: `Dry/wet impulse alignment is ${alignment.deltaMs.toFixed(2)} ms off — residual comb at partial mbMix.`,
      });
    }
    // Hard fail only if the delay comb is obviously back (several milliseconds).
    expect(Math.abs(alignment.deltaMs)).toBeLessThan(4);

    // Dry (mix 0) is a straight wire and must be unity.
    const dry = reconstruction.rows.find((r) => r.mix === 0);
    expect(Math.abs(dry.worstDb), 'dry mix unity').toBeLessThan(0.35);

    // Inactive compressors, any mix: 7.0.0 claimed 0.000 dB reconstruction at every
    // mix. Chromium 149 measured +7.39 dB at 140 Hz and 3.2 kHz on the wet path
    // (FINDINGS A-6) because the crossover assigned linear Q to nodes that take dB
    // (issues #19/#12). The nodes now get BUTTERWORTH_Q_DB and the dry path is
    // matched to this engine's measured compressor latency, so the wet path must be
    // near unity at every mix: hard gate 0.5 dB (3× tighter than the 1.5 dB contract
    // it replaces — never widen), with the ±0.1 dB design goal recorded per row.
    testInfo.annotations.push({
      type: 'dry-delay',
      description: `${result.browser}: dry delay ${reconstruction.dryDelayMs.toFixed(3)} ms (alignment Δ ${alignment.deltaMs.toFixed(3)} ms)`,
    });
    for (const row of reconstruction.rows) {
      const goalMet = Math.abs(row.worstDb) < 0.1;
      testInfo.annotations.push({
        type: 'reconstruction',
        description: `mix ${row.mix}: worst ${row.worstDb.toFixed(3)} dB @ ${row.worstFreq} Hz ${goalMet ? '(±0.1 dB goal met)' : '(±0.1 dB goal MISSED)'}`,
      });
      const gate = row.mix === 0 ? 0.35 : 0.5;
      expect(Math.abs(row.worstDb), `mix ${row.mix} @ ${row.worstFreq} Hz`).toBeLessThan(gate);
    }

    // Partial mix *with* compression will not be perfectly flat (dynamics), but a
    // delay-comb notch of 6+ dB at 83/250 Hz is the pre-fix defect. Flag it.
    for (const row of partialMix.rows) {
      const worst = row.byFreq.reduce(
        (w, r) => (Math.abs(r.gainDb) > Math.abs(w.gainDb) ? r : w),
        row.byFreq[0],
      );
      testInfo.annotations.push({
        type: 'partial-mix',
        description: `mix ${row.mix}: worst ${worst.gainDb.toFixed(2)} dB @ ${worst.freq} Hz`,
      });
      if (Math.abs(worst.gainDb) > THRESHOLDS.combNotchDb + 3) {
        testInfo.annotations.push({
          type: 'finding',
          description: `Partial mbMix ${row.mix} notches ${worst.gainDb.toFixed(1)} dB at ${worst.freq} Hz on ${result.browser}.`,
        });
      }
    }
  });
});
