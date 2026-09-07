import { test, expect } from '@playwright/test';
import { openLab, callLab, writeResult } from './helpers.js';
import { SAMPLE_RATES } from '../conformance/thresholds.js';

test.describe('OfflineAudioContext sample rates', () => {
  test('probes 44.1 / 48 / 88.2 / 96 / 176.4 / 192 kHz and records refusals honestly', async ({
    page,
  }, testInfo) => {
    await openLab(page);
    const result = await callLab(page, 'probeAllRates');
    await writeResult(testInfo, 'sample-rates', result);

    expect(result.rows).toHaveLength(SAMPLE_RATES.length);

    const supported = result.rows.filter((r) => r.supported && r.rendered);
    const refused = result.rows.filter((r) => !r.supported || !r.rendered);

    testInfo.annotations.push({
      type: 'sample-rates',
      description: `${result.browser} supported: ${supported.map((r) => r.sampleRate).join(', ') || '(none)'}; unsupported: ${refused.map((r) => `${r.sampleRate} (${r.reason ?? 'render failed'})`).join(', ') || '(none)'}`,
    });

    // 44.1 and 48 kHz are required for the product to function at all.
    for (const need of [44100, 48000]) {
      const row = result.rows.find((r) => r.sampleRate === need);
      expect(row.supported, `${need} must be constructible`).toBe(true);
      expect(row.rendered, `${need} must render`).toBe(true);
      expect(row.finite).toBe(true);
      expect(row.peak).toBeGreaterThan(0.3);
    }

    // Higher rates: do not fail the suite when the engine refuses them. Record it.
    for (const row of refused) {
      expect(row.reason || row.supported === false).toBeTruthy();
    }
  });
});
