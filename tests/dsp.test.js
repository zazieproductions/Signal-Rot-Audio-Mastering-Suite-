import { describe, it, expect } from 'vitest';
import {
  IDENTITY_CURVE, makeSatCurve, truePeakBlock, truePeakFile,
  transientShape, measureLUFS, fftRadix2, spectrumFingerprint, computeMatchGains, MATCH_FREQS,
  buildTruePeakPhases, TP_TAPS,
} from '../src/lib/dsp.js';
import { makeBuffer, sine, zeros, noise, maxAbs } from './helpers.js';

describe('makeSatCurve', () => {
  it('returns identity for zero amount', () => {
    expect(makeSatCurve(0)).toBe(IDENTITY_CURVE);
  });
  it('produces a DC-free, unity-normalized 4096-point curve', () => {
    for (const amt of [0.1, 0.5, 1.0]) {
      const c = makeSatCurve(amt);
      expect(c.length).toBe(4096);
      let sum = 0;
      let pk = 0;
      for (let i = 0; i < c.length; i++) {
        sum += c[i];
        if (Math.abs(c[i]) > pk) pk = Math.abs(c[i]);
      }
      expect(Math.abs(sum / c.length)).toBeLessThan(1e-4); // DC-free
      expect(pk).toBeLessThanOrEqual(1.000001); // unity normalized
      expect(pk).toBeGreaterThan(0.9);
    }
  });
});

describe('true peak estimation (4× polyphase reconstruction)', () => {
  it('builds a 3-branch polyphase kernel of the configured length', () => {
    const p = buildTruePeakPhases();
    expect(p).toHaveLength(3);
    expect(p[0]).toHaveLength(TP_TAPS);
    // Each branch must preserve DC (sum ≈ 1) so a constant signal is exact.
    for (const branch of p) {
      const sum = branch.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 4);
    }
  });

  it('reconstructs a full-scale low-frequency sine without overshoot', () => {
    // 997 Hz at 44.1 kHz: the estimator must stay ≈ 1.0 (no 13 % cubic overshoot).
    const d = sine(997, 44100, 1.0, 1.0);
    const tp = truePeakFile(makeBuffer([d], 44100));
    expect(tp).toBeGreaterThan(0.995);
    expect(tp).toBeLessThan(1.005);
  });

  it('detects inter-sample peaks above the sample peak', () => {
    // 14700 Hz at 44.1 kHz hits exactly 3 samples/cycle: sample peak is 0.866,
    // while the reconstructed inter-sample peak rises well above it.
    const sr = 44100;
    const d = sine(14700, sr, 0.5, 1.0);
    const buf = makeBuffer([d, d], sr);
    const sp = maxAbs(d);
    const tp = truePeakFile(buf);
    expect(sp).toBeCloseTo(0.866, 2);
    expect(tp).toBeGreaterThan(sp + 0.05);
  });

  it('truePeakBlock agrees with truePeakFile on a short block', () => {
    const d = sine(1000, 48000, 0.1, 0.9);
    expect(truePeakBlock(d)).toBeCloseTo(truePeakFile(makeBuffer([d], 48000)), 4);
  });
});

describe('transientShape', () => {
  it('does nothing for zero emphasis', () => {
    const d = noise(0.2);
    const copy = new Float32Array(d);
    transientShape(makeBuffer([d]), 0, 0);
    expect(d).toEqual(copy);
  });

  it('amplifies a transient with positive attack', () => {
    const d = zeros(1.0);
    d[100] = 1.0;
    const buf = makeBuffer([d]);
    transientShape(buf, 100, 0);
    expect(d[100]).toBeGreaterThan(1.0);
    expect(Number.isFinite(d[100])).toBe(true);
  });

  it('lifts steady-state signal with positive sustain', () => {
    const d = new Float32Array(48000).fill(0.5);
    transientShape(makeBuffer([d]), 0, 100);
    // Steady-state gain ≈ 1 + 1 * min(1, 0.5*3) * 0.4 = 1.4
    expect(d[d.length - 1]).toBeCloseTo(0.7, 1);
  });
});

describe('measureLUFS', () => {
  it('returns -Infinity for silence (no NaN)', () => {
    const buf = makeBuffer([zeros(1.0), zeros(1.0)]);
    const m = measureLUFS(buf);
    expect(m.lufs).toBe(-Infinity);
    expect(m.lra).toBe(0);
  });

  it('is linear in level (20 dB down ⇒ 20 LUFS down)', () => {
    const sr = 48000;
    const loud = makeBuffer([sine(1000, sr, 2.0, 1.0), sine(1000, sr, 2.0, 1.0)], sr);
    const quiet = makeBuffer([sine(1000, sr, 2.0, 0.1), sine(1000, sr, 2.0, 0.1)], sr);
    const a = measureLUFS(loud).lufs;
    const b = measureLUFS(quiet).lufs;
    expect(a - b).toBeCloseTo(20, 1);
  });

  it('applies the K-weighting high shelf (+4 dB at HF)', () => {
    const sr = 48000;
    // 400 Hz sits below the 1500 Hz shelf (≈ 0 dB) and above the 38 Hz highpass;
    // 10 kHz sits at the top of the +4 dB shelf. Difference ≈ +4 dB.
    const low = makeBuffer([sine(400, sr, 2.0, 0.5), sine(400, sr, 2.0, 0.5)], sr);
    const high = makeBuffer([sine(10000, sr, 2.0, 0.5), sine(10000, sr, 2.0, 0.5)], sr);
    const d = measureLUFS(high).lufs - measureLUFS(low).lufs;
    expect(d).toBeGreaterThan(3.7);
    expect(d).toBeLessThan(4.4);
  });

  it('gates quiet sections out (relative gate)', () => {
    const sr = 48000;
    const loud = sine(1000, sr, 2.0, 0.1);
    const q = zeros(8.0, sr);
    const mixed = new Float32Array(q.length + loud.length);
    mixed.set(q, 0);
    mixed.set(loud, q.length);
    const gated = measureLUFS(makeBuffer([mixed, mixed], sr)).lufs;
    const pure = measureLUFS(makeBuffer([loud, loud], sr)).lufs;
    expect(Math.abs(gated - pure)).toBeLessThan(1.5);
  });
});

describe('fftRadix2', () => {
  it('transforms a DC signal to a single bin', () => {
    const N = 1024;
    const re = new Float32Array(N).fill(1);
    const im = new Float32Array(N);
    fftRadix2(re, im);
    expect(re[0]).toBeCloseTo(N, 4);
    for (let k = 1; k < N; k++) expect(Math.abs(re[k])).toBeLessThan(1e-3);
  });
});

describe('spectrumFingerprint', () => {
  it('returns null for a too-short buffer', () => {
    const buf = makeBuffer([noise(0.05), noise(0.05)]);
    expect(spectrumFingerprint(buf)).toBeNull();
  });
  it('returns 8 finite band energies for a real buffer', () => {
    const buf = makeBuffer([noise(2.0), noise(2.0)]);
    const fp = spectrumFingerprint(buf);
    expect(fp).toHaveLength(MATCH_FREQS.length);
    fp.forEach((v) => expect(Number.isFinite(v)).toBe(true));
  });
});

describe('computeMatchGains', () => {
  it('returns zero for identical fingerprints', () => {
    const fp = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(computeMatchGains(fp, fp)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
  it('removes net-gain bias', () => {
    const cur = [0, 0, 0, 0, 0, 0, 0, 0];
    const ref = [6, 6, 6, 6, 6, 6, 6, 6];
    expect(computeMatchGains(cur, ref)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
  it('clamps to ±8 dB', () => {
    const cur = [0, 0, 0, 0, 0, 0, 0, 0];
    const ref = [0, 0, 0, 0, 0, 0, 0, 16];
    const g = computeMatchGains(cur, ref);
    expect(g[7]).toBe(8);
    expect(g[0]).toBe(-2);
  });
});
