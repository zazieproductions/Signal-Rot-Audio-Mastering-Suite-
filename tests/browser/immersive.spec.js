import { test, expect } from '@playwright/test';
import { openLab, callLab, writeResult } from './helpers.js';
import { SCOPE, mark } from '../conformance/scope.js';

test.describe(`${mark(SCOPE.REAL_WEB_AUDIO)} Immersive speaker-feed renders`, () => {
  test('every layout emits every channel, with correct L/R, height and sub routing', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await openLab(page);
    const result = await callLab(page, 'immersive');
    await writeResult(testInfo, 'immersive', result);

    const expected = {
      5.1: 6,
      7.1: 8,
      '7.1.2': 10,
      '7.1.4': 12,
      '9.1.6': 16,
      soniclab: 24,
    };

    for (const [id, n] of Object.entries(expected)) {
      const layout = result.layouts[id];
      expect(layout, id).toBeTruthy();
      expect(layout.stereo.channelCount, id).toBe(n);
      expect(layout.stereo.channels).toHaveLength(n);

      const missing = layout.stereo.channels.filter((c) => !c.finite);
      expect(missing, `${id} non-finite`).toEqual([]);

      // Hard-left source must energise left-ish channels more than right-ish ones
      // (excluding LFE, which is a sum).
      const leftish = layout.left.channels.filter((c) => c.azimuthAdm > 15 && !c.lfe);
      const rightish = layout.left.channels.filter((c) => c.azimuthAdm < -15 && !c.lfe);
      const leftE = leftish.reduce((s, c) => s + c.rms * c.rms, 0);
      const rightE = rightish.reduce((s, c) => s + c.rms * c.rms, 0);
      expect(leftE, `${id} hard-left → left`).toBeGreaterThan(rightE);

      const leftFromRight = layout.right.channels.filter((c) => c.azimuthAdm > 15 && !c.lfe);
      const rightFromRight = layout.right.channels.filter((c) => c.azimuthAdm < -15 && !c.lfe);
      const l2 = leftFromRight.reduce((s, c) => s + c.rms * c.rms, 0);
      const r2 = rightFromRight.reduce((s, c) => s + c.rms * c.rms, 0);
      expect(r2, `${id} hard-right → right`).toBeGreaterThan(l2);

      // Bass-heavy source must put energy on every LFE / sub feed.
      const subs = layout.bass.channels.filter((c) => c.lfe);
      expect(subs.length, `${id} has subs`).toBeGreaterThan(0);
      for (const sub of subs) {
        expect(sub.silent, `${id} ${sub.id} sub silent on bass`).toBe(false);
        expect(sub.rms).toBeGreaterThan(1e-4);
      }

      // Height layouts: a side-only (anti-phase) source is what the height feeds are
      // built from. They must not all be silent.
      const heights = layout.side.channels.filter((c) => c.elevation >= 20);
      if (heights.length) {
        const live = heights.filter((c) => !c.silent);
        expect(live.length, `${id} height feeds`).toBeGreaterThan(0);
      }

      // Channel map / order: ids unique, 1-based index matches delivery order.
      const ids = layout.stereo.channels.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(layout.stereo.order).toEqual(ids);
    }

    // Sonic Lab: 24 channels, four subs at the end, ear-ring fronts alive on a stereo source.
    const sl = result.layouts.soniclab.stereo;
    expect(sl.channels).toHaveLength(24);
    expect(sl.channels.slice(20).every((c) => c.lfe)).toBe(true);
    expect(sl.channels[0].id).toBe('SL1');
    expect(sl.channels[1].id).toBe('SL2');
  });
});
