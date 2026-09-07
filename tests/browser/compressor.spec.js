import { test, expect } from '@playwright/test';
import { openLab, callLab, writeResult } from './helpers.js';
import { THRESHOLDS } from '../conformance/thresholds.js';

test.describe('DynamicsCompressorNode (real Web Audio)', () => {
  test('measures lookahead, make-up, static curve and ballistics', async ({ page }, testInfo) => {
    await openLab(page);
    const result = await callLab(page, 'compressor');
    await writeResult(testInfo, 'compressor', result);

    expect(result.node).toBe('DynamicsCompressorNode');
    expect(result.browser).toBeTruthy();

    const { lookahead, makeup, curve, ballistics } = result;

    // Look-ahead is implementation-defined. We measure it; we do not assume 6.000 ms.
    expect(Number.isFinite(lookahead.delayMs)).toBe(true);
    expect(lookahead.delayMs).toBeGreaterThanOrEqual(0);
    expect(lookahead.delayMs).toBeLessThan(20);
    expect(lookahead.peakValue).toBeGreaterThan(0.1);

    const lookaheadDelta = Math.abs(lookahead.deltaVsDocumentedMs);
    testInfo.annotations.push({
      type: 'lookahead',
      description: `${result.browser}: ${lookahead.delayMs.toFixed(3)} ms (documented 6 ms, Δ ${lookahead.deltaVsDocumentedMs.toFixed(3)} ms)`,
    });
    if (lookaheadDelta > THRESHOLDS.compressorLookaheadMs) {
      testInfo.annotations.push({
        type: 'finding',
        description: `Look-ahead differs from the documented 6 ms by ${lookaheadDelta.toFixed(2)} ms — Agent A should not treat MB_COMPRESSOR_LOOKAHEAD_S as exact on this engine.`,
      });
    }

    // Ratio 1:1 (amount 0) must not invent make-up.
    const zero = makeup.rows.find((r) => r.amount === 0);
    expect(zero).toBeTruthy();
    expect(Math.abs(zero.measuredDb)).toBeLessThan(0.35);

    // Deep settings must apply *some* positive make-up — that is the spec behaviour
    // Signal Rot compensates. We do not require the analytic model to match exactly.
    const deep = makeup.rows.find((r) => r.amount === 100);
    expect(deep.measuredDb).toBeGreaterThan(5);
    expect(deep.modelDb).toBeGreaterThan(5);
    const worst = makeup.rows.reduce(
      (w, r) => (Math.abs(r.deltaDb) > Math.abs(w.deltaDb) ? r : w),
      makeup.rows[0],
    );
    testInfo.annotations.push({
      type: 'makeup',
      description: `worst model error ${worst.deltaDb.toFixed(3)} dB at amount ${worst.amount} (measured ${worst.measuredDb.toFixed(3)}, model ${worst.modelDb.toFixed(3)})`,
    });
    if (Math.abs(worst.deltaDb) > THRESHOLDS.compressorMakeupModelDb) {
      testInfo.annotations.push({
        type: 'finding',
        description: `Analytic make-up model disagrees with ${result.browser} by ${worst.deltaDb.toFixed(2)} dB at amount ${worst.amount}. Compensation will leak that much per band.`,
      });
    }

    // Static curve: below threshold the node must not squash; well above, it must.
    const below = curve.rows.find((r) => r.inputDb === -36);
    const above = curve.rows.find((r) => r.inputDb === 0);
    expect(below.reductionDb).toBeGreaterThan(-2);
    expect(above.outputPeakDb).toBeLessThan(above.inputDb + deep.measuredDb + 1);

    // Attack/release: after the tone ends, residual energy must fall.
    expect(ballistics.afterReleaseRmsDb).toBeLessThan(ballistics.toneOnRmsDb - 10);
  });
});
