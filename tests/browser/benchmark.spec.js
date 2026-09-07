import { test, expect } from '@playwright/test';
import { openLab, callLab, writeResult } from './helpers.js';
import { SCOPE, mark } from '../conformance/scope.js';

test.describe(`${mark(SCOPE.REAL_WEB_AUDIO)} Performance benchmarks`, () => {
  test('records render time, output size and scaling (does not optimise production code)', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await openLab(page);
    const result = await callLab(page, 'benchmarks');
    await writeResult(testInfo, 'benchmarks', result);

    const ok = result.cases.filter((c) => c.ok);
    expect(ok.length).toBeGreaterThan(0);
    for (const c of ok) {
      expect(c.renderMs).toBeGreaterThan(0);
      expect(c.outputBytes).toBeGreaterThan(0);
      expect(Number.isFinite(c.realtimeRatio)).toBe(true);
    }

    if (result.slowest) {
      testInfo.annotations.push({
        type: 'slowest',
        description: `${result.browser}: ${result.slowest.id} ${result.slowest.renderMs.toFixed(1)} ms (${result.slowest.realtimeRatio.toFixed(2)}× realtime)`,
      });
    }
    for (const b of result.bottlenecks ?? []) {
      testInfo.annotations.push({ type: 'bottleneck', description: b });
    }

    // A 400 ms stereo render at 48 kHz must complete. We do not fail the suite if a
    // 192 kHz 24-channel render is unsupported — that is recorded as ok:false.
    const stereo48 = result.cases.find((c) => c.id === 'stereo@48000');
    expect(stereo48?.ok).toBe(true);
  });
});
