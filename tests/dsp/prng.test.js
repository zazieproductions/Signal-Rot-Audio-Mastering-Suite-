import { describe, it, expect } from 'vitest';
import { mulberry32, gaussian, deriveSeed, randomSeed, bipolar } from '../../src/audio/dsp/prng.js';

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    for (let i = 0; i < 500; i++) expect(a()).toBe(b());
  });

  it('produces different streams for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    let same = 0;
    for (let i = 0; i < 500; i++) if (a() === b()) same++;
    expect(same).toBe(0);
  });

  it('stays inside [0, 1)', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 20000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('has a roughly uniform distribution', () => {
    const rng = mulberry32(7);
    const bins = new Array(10).fill(0);
    const n = 100000;
    for (let i = 0; i < n; i++) bins[Math.floor(rng() * 10)]++;
    for (const count of bins) expect(Math.abs(count - n / 10) / (n / 10)).toBeLessThan(0.05);
  });
});

describe('gaussian', () => {
  it('has approximately zero mean and unit variance', () => {
    const rng = mulberry32(4242);
    let sum = 0;
    let sumSquares = 0;
    const n = 200000;
    for (let i = 0; i < n; i++) {
      const v = gaussian(rng);
      sum += v;
      sumSquares += v * v;
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.02);
    expect(sumSquares / n).toBeCloseTo(1, 1);
  });
});

describe('bipolar and deriveSeed', () => {
  it('maps uniform [0,1) to [-1,1)', () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 1000; i++) {
      const v = bipolar(rng);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThan(1);
    }
  });

  it('derives stable, distinct child seeds', () => {
    expect(deriveSeed(1, 'hiss:0')).toBe(deriveSeed(1, 'hiss:0'));
    expect(deriveSeed(1, 'hiss:0')).not.toBe(deriveSeed(1, 'hiss:1'));
    expect(deriveSeed(1, 'hiss:0')).not.toBe(deriveSeed(2, 'hiss:0'));
    expect(deriveSeed(1, 'x') >>> 0).toBe(deriveSeed(1, 'x'));
  });

  it('generates a 32-bit unsigned random seed', () => {
    for (let i = 0; i < 100; i++) {
      const s = randomSeed();
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
