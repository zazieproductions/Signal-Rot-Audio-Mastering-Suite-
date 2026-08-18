import { describe, it, expect } from 'vitest';
import {
  designBiquad,
  biquadResponse,
  cascadeResponse,
  processBiquadCascade,
  cabs,
} from '../../src/audio/dsp/biquad.js';

const SR = 48000;
const magAt = (coeffs, f) => cabs(biquadResponse(coeffs, f, SR));
const dbAt = (coeffs, f) => 20 * Math.log10(magAt(coeffs, f));

describe('biquad design', () => {
  it('gives a Butterworth low-pass −3.01 dB at the corner', () => {
    const lp = designBiquad('lowpass', 1000, Math.SQRT1_2, 0, SR);
    expect(dbAt(lp, 1000)).toBeCloseTo(-3.01, 1);
    expect(dbAt(lp, 100)).toBeCloseTo(0, 1);
    // 24 dB/octave for two cascaded sections => 12 dB/octave for one.
    expect(dbAt(lp, 2000)).toBeLessThan(-11);
  });

  it('gives a Butterworth high-pass mirrored about the corner', () => {
    const hp = designBiquad('highpass', 1000, Math.SQRT1_2, 0, SR);
    expect(dbAt(hp, 1000)).toBeCloseTo(-3.01, 1);
    expect(dbAt(hp, 8000)).toBeCloseTo(0, 1);
    expect(dbAt(hp, 500)).toBeLessThan(-11);
  });

  it('gives an all-pass unity magnitude at every frequency', () => {
    const ap = designBiquad('allpass', 1200, Math.SQRT1_2, 0, SR);
    for (const f of [20, 100, 1200, 5000, 20000]) {
      expect(magAt(ap, f)).toBeCloseTo(1, 6);
    }
  });

  it('gives a peaking filter its stated gain at its centre', () => {
    for (const gain of [-9, -3, 3, 9]) {
      const peak = designBiquad('peaking', 2000, 1.4, gain, SR);
      expect(dbAt(peak, 2000)).toBeCloseTo(gain, 4);
      expect(dbAt(peak, 40)).toBeCloseTo(0, 1);
    }
  });

  it('gives shelves their stated gain well past the corner', () => {
    const low = designBiquad('lowshelf', 200, Math.SQRT1_2, 6, SR);
    expect(dbAt(low, 20)).toBeCloseTo(6, 1);
    expect(dbAt(low, 8000)).toBeCloseTo(0, 1);
    const high = designBiquad('highshelf', 8000, Math.SQRT1_2, -6, SR);
    expect(dbAt(high, 20000)).toBeCloseTo(-6, 1);
    expect(dbAt(high, 100)).toBeCloseTo(0, 1);
  });

  it('stays stable when asked for a frequency at or above Nyquist', () => {
    const lp = designBiquad('lowpass', SR, Math.SQRT1_2, 0, SR);
    for (const key of ['b0', 'b1', 'b2', 'a1', 'a2']) {
      expect(Number.isFinite(lp[key])).toBe(true);
    }
  });

  it('rejects unknown filter types', () => {
    expect(() => designBiquad('bandreject', 100, 1, 0, SR)).toThrow(/unknown type/);
  });
});

describe('LR4 reconstruction', () => {
  it('sums an LR4 low-pass and high-pass to unity magnitude', () => {
    const lp = designBiquad('lowpass', 800, Math.SQRT1_2, 0, SR);
    const hp = designBiquad('highpass', 800, Math.SQRT1_2, 0, SR);
    for (let i = 0; i < 200; i++) {
      const f = 20 * Math.pow(1000, i / 199);
      const a = cascadeResponse([lp, lp], f, SR);
      const b = cascadeResponse([hp, hp], f, SR);
      const sum = cabs([a[0] + b[0], a[1] + b[1]]);
      expect(20 * Math.log10(sum)).toBeCloseTo(0, 6);
    }
  });

  it('matches the phase of a single second-order all-pass', () => {
    const lp = designBiquad('lowpass', 800, Math.SQRT1_2, 0, SR);
    const hp = designBiquad('highpass', 800, Math.SQRT1_2, 0, SR);
    const ap = designBiquad('allpass', 800, Math.SQRT1_2, 0, SR);
    for (const f of [50, 400, 800, 1600, 12000]) {
      const a = cascadeResponse([lp, lp], f, SR);
      const b = cascadeResponse([hp, hp], f, SR);
      const sum = [a[0] + b[0], a[1] + b[1]];
      const allpass = biquadResponse(ap, f, SR);
      expect(Math.atan2(sum[1], sum[0])).toBeCloseTo(Math.atan2(allpass[1], allpass[0]), 6);
    }
  });
});

describe('time-domain processing', () => {
  it('passes DC through a low-pass unchanged', () => {
    const data = new Float32Array(4000).fill(0.5);
    processBiquadCascade(data, [designBiquad('lowpass', 500, Math.SQRT1_2, 0, SR)]);
    expect(data[3999]).toBeCloseTo(0.5, 6);
  });

  it('removes DC in a high-pass', () => {
    const data = new Float32Array(20000).fill(0.5);
    processBiquadCascade(data, [designBiquad('highpass', 200, Math.SQRT1_2, 0, SR)]);
    expect(Math.abs(data[19999])).toBeLessThan(1e-3);
  });

  it('attenuates a tone by the amount the frequency response predicts', () => {
    // Compared on RMS, not peak: a sampled sine only hits its crest exactly when the
    // period divides the sample rate, so a peak comparison has a sampling-phase error of
    // up to 20·log10(cos(π·f/fs)) — which is a property of the test, not the filter.
    const coeffs = designBiquad('lowpass', 1000, Math.SQRT1_2, 0, SR);
    for (const f of [250, 1000, 4000, 9000]) {
      const n = 48000;
      const data = new Float32Array(n);
      for (let i = 0; i < n; i++) data[i] = Math.sin((2 * Math.PI * f * i) / SR);
      processBiquadCascade(data, [coeffs]);
      let sum = 0;
      for (let i = n / 2; i < n; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / (n / 2));
      // A unit sine has RMS 1/√2, so the gain is rms·√2.
      expect(20 * Math.log10(rms * Math.SQRT2)).toBeCloseTo(dbAt(coeffs, f), 2);
    }
  });
});
