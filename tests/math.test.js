import { describe, it, expect } from 'vitest';
import { clamp, dbToGain, gainToDb, fmtTime, mulberry32, fnv1a, sanitizeFileName, baseName, lerp } from '../src/lib/math.js';

describe('clamp', () => {
  it('bounds values', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});

describe('dB / gain conversion', () => {
  it('round-trips', () => {
    expect(dbToGain(0)).toBeCloseTo(1, 10);
    expect(dbToGain(6)).toBeCloseTo(1.995262, 5);
    expect(gainToDb(1)).toBeCloseTo(0, 10);
    expect(gainToDb(0.5)).toBeCloseTo(-6.0206, 3);
  });
  it('floors gainToDb at -180 dB (no -Infinity)', () => {
    expect(gainToDb(0)).toBeCloseTo(-180, 5);
  });
});

describe('fmtTime', () => {
  it('formats m:ss', () => {
    expect(fmtTime(0)).toBe('0:00');
    expect(fmtTime(65)).toBe('1:05');
    expect(fmtTime(-5)).toBe('0:00');
  });
});

describe('mulberry32', () => {
  it('is deterministic for a seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });
  it('returns values in [0,1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('fnv1a', () => {
  it('is stable and 32-bit', () => {
    expect(fnv1a('hello')).toBe(fnv1a('hello'));
    expect(fnv1a('hello')).toBeGreaterThanOrEqual(0);
    expect(fnv1a('hello')).toBeLessThan(2 ** 32);
    expect(fnv1a('a')).not.toBe(fnv1a('b'));
  });
});

describe('sanitizeFileName / baseName', () => {
  it('strips illegal characters', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeFileName('   ')).toBe('master');
  });
  it('strips extensions in baseName', () => {
    expect(baseName('My Song.wav')).toBe('My Song');
    expect(baseName('track_01.mp3')).toBe('track_01');
  });
});

describe('lerp', () => {
  it('interpolates', () => {
    expect(lerp(0, 10, 0.5)).toBeCloseTo(5, 10);
    expect(lerp(1, 3, 0)).toBe(1);
  });
});
