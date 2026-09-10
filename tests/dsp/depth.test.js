import { describe, it, expect } from 'vitest';
import {
  buildDepth,
  applyDepth,
  CLEAN_DEPTH_SIZES,
  CLEAN_TAP_GAINS,
  DEPTH_SIZES,
} from '../../src/audio/graph/depth.js';
import { FakeAudioContext } from '../helpers/fake-audio-context.js';
import { defaultParameters } from '../../src/app/parameters.js';

const params = (patch = {}) => ({ ...defaultParameters(), ...patch });

describe('clean depth tables (§5)', () => {
  it('uses unequal, prime-ratio delays of at least ~10 ms (no obvious slap, no pitch)', () => {
    for (const size of Object.values(CLEAN_DEPTH_SIZES)) {
      expect(size.taps).toHaveLength(4);
      const unique = new Set(size.taps);
      expect(unique.size).toBe(4);
      for (let i = 0; i < size.taps.length; i++) {
        expect(size.taps[i]).toBeGreaterThan(0.009);
        if (i > 0) {
          // No pair may approach a simple 3:2 ratio (would reinforce into a colouration),
          // and consecutive delays must be clearly unequal.
          const ratio = size.taps[i] / size.taps[i - 1];
          expect(Math.abs(ratio - 1.5)).toBeGreaterThan(0.08);
          expect(ratio).toBeGreaterThan(1.15);
        }
      }
    }
  });

  it('keeps per-ear wet energy bounded and alternating (L, R, L, R)', () => {
    // Ear-alternating assignment: taps 0+2 → L, 1+3 → R.
    const left = CLEAN_TAP_GAINS[0] + CLEAN_TAP_GAINS[2];
    const right = CLEAN_TAP_GAINS[1] + CLEAN_TAP_GAINS[3];
    expect(left).toBeLessThanOrEqual(0.12);
    expect(right).toBeLessThanOrEqual(0.12);
    expect(left).toBeGreaterThan(0.05);
    expect(right).toBeGreaterThan(0.05);
  });

  it('scales room sizes coherently (med sits between small and large)', () => {
    const s = CLEAN_DEPTH_SIZES.small.taps;
    const m = CLEAN_DEPTH_SIZES.med.taps;
    const l = CLEAN_DEPTH_SIZES.large.taps;
    for (let i = 0; i < 4; i++) {
      expect(m[i]).toBeGreaterThan(s[i]);
      expect(l[i]).toBeGreaterThan(m[i]);
    }
  });

  it('is deterministic — frozen, immutable design tables', () => {
    expect(Object.isFrozen(CLEAN_DEPTH_SIZES)).toBe(true);
    expect(Object.isFrozen(CLEAN_TAP_GAINS)).toBe(true);
  });
});

describe('depth stage topology', () => {
  it('default (classic) character keeps the protected baseline wiring', () => {
    const ctx = new FakeAudioContext();
    const depth = buildDepth(ctx);
    const p = params({ depth: 40, depthSize: 'large' });
    applyDepth(depth, p);
    expect(depth.tap1.gain.gain.value).toBeCloseTo(0.28 * 0.4, 6);
    expect(depth.tap2.gain.gain.value).toBeCloseTo(0.22 * 0.4, 6);
    expect(depth.tap1.delay.delayTime.value).toBeCloseTo(DEPTH_SIZES.large.taps[0], 9);
    for (const g of depth.clean.gains) expect(g.gain.value).toBe(0);
  });

  it('clean character silences the classic taps and arms the diffused taps', () => {
    const ctx = new FakeAudioContext();
    const depth = buildDepth(ctx);
    const p = params({ depth: 50, depthSize: 'med', depthMode: 'clean' });
    applyDepth(depth, p);
    expect(depth.tap1.gain.gain.value).toBe(0);
    expect(depth.tap2.gain.gain.value).toBe(0);
    depth.clean.gains.forEach((g, i) => {
      expect(g.gain.value).toBeCloseTo(0.5 * CLEAN_TAP_GAINS[i], 6);
    });
    depth.clean.taps.forEach((d, i) => {
      expect(d.delayTime.value).toBeCloseTo(CLEAN_DEPTH_SIZES.med.taps[i], 9);
    });
  });

  it('bypass silences both wet architectures and keeps the direct path', () => {
    const ctx = new FakeAudioContext();
    const depth = buildDepth(ctx);
    applyDepth(depth, params({ depth: 80, depthMode: 'clean', bypass: true }));
    expect(depth.tap1.gain.gain.value).toBe(0);
    for (const g of depth.clean.gains) expect(g.gain.value).toBe(0);
  });
});
