import { describe, it, expect } from 'vitest';
import { fftRadix2, ifftRadix2 } from '../../src/audio/analysis/fft.js';

describe('ifftRadix2', () => {
  it('inverts a forward transform of a real impulse', () => {
    const n = 32;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    re[3] = 1;
    fftRadix2(re, im);
    ifftRadix2(re, im);
    expect(re[3]).toBeCloseTo(1, 12);
    for (let i = 0; i < n; i++) {
      if (i === 3) continue;
      expect(re[i]).toBeCloseTo(0, 12);
      expect(im[i]).toBeCloseTo(0, 12);
    }
  });

  it('round-trips a random complex buffer', () => {
    const n = 64;
    const re0 = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.37));
    const im0 = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.19));
    const re = re0.slice();
    const im = im0.slice();
    fftRadix2(re, im);
    ifftRadix2(re, im);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(re0[i], 10);
      expect(im[i]).toBeCloseTo(im0[i], 10);
    }
  });
});
