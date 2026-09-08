import { describe, it, expect } from 'vitest';
import {
  truePeakChannel,
  truePeakChannelExact,
  analysePeaks,
  analysePeaksVerified,
  buildPolyphaseFilter,
  oversamplingFactorFor,
  truePeakEstimate,
} from '../../src/audio/analysis/true-peak.js';
import { fadedSine, sine, silence, make } from '../helpers/signals.js';

const SR = 48000;
const db = (v) => 20 * Math.log10(v);

/** The cubic (Catmull-Rom) interpolator the pre-7.0 engine used, for comparison. */
function cubicTruePeak(d) {
  let max = 0;
  for (let i = 1; i < d.length - 2; i++) {
    const p0 = d[i - 1];
    const p1 = d[i];
    const p2 = d[i + 1];
    const p3 = d[i + 2];
    for (let f = 0; f < 4; f++) {
      const t = f / 4;
      const t2 = t * t;
      const t3 = t2 * t;
      const v =
        0.5 *
        (2 * p1 +
          (-p0 + p2) * t +
          (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
          (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
      max = Math.max(max, Math.abs(v));
    }
  }
  return max;
}

/**
 * The canonical worst case: a sine at exactly fs/4 sampled at ±45°. Every sample sits at
 * 0.7071 (−3.01 dBFS); the reconstructed waveform reaches 1.0 (0 dBTP).
 */
function fsOverFour(n = 8192, fade = 1024) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let w = 1;
    if (i < fade) w = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    else if (i >= n - fade) w = 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / fade);
    x[i] = w * Math.sin((2 * Math.PI * (i + 0.5)) / 4);
  }
  return x;
}

describe('polyphase interpolation filter', () => {
  it('builds `factor` branches with unity DC gain each', () => {
    for (const factor of [2, 4, 8]) {
      const phases = buildPolyphaseFilter(factor, 12, 8.6);
      expect(phases).toHaveLength(factor);
      for (const branch of phases) {
        expect(branch).toHaveLength(12);
        let sum = 0;
        for (const c of branch) sum += c;
        expect(sum).toBeCloseTo(1, 12);
      }
    }
  });

  it('memoises identical designs', () => {
    expect(buildPolyphaseFilter(4, 12, 8.6)).toBe(buildPolyphaseFilter(4, 12, 8.6));
  });

  it('chooses 4× below 88.2 kHz, 2× below 176.4 kHz, 1× above', () => {
    expect(oversamplingFactorFor(44100)).toBe(4);
    expect(oversamplingFactorFor(48000)).toBe(4);
    expect(oversamplingFactorFor(96000)).toBe(2);
    expect(oversamplingFactorFor(192000)).toBe(1);
  });
});

describe('true-peak measurement', () => {
  it('beats cubic interpolation by ~0.9 dB on the fs/4 worst case', () => {
    const x = fsOverFour();
    let samplePeak = 0;
    for (const v of x) samplePeak = Math.max(samplePeak, Math.abs(v));

    const polyphase = db(truePeakChannel(x, SR));
    const cubic = db(cubicTruePeak(x));

    expect(db(samplePeak)).toBeCloseTo(-3.01, 1);
    // The true answer is 0 dBTP. Both under-read (a short FIR cannot sum the 1/n tails of
    // this signal's sinc series) but polyphase is an order of magnitude closer.
    expect(polyphase).toBeGreaterThan(-0.25);
    expect(polyphase).toBeLessThan(0.05);
    expect(cubic).toBeLessThan(-1.0);
    expect(polyphase - cubic).toBeGreaterThan(0.85);
  });

  it('always reads at least the sample peak', () => {
    for (const freq of [100, 997, 5000, 15000]) {
      const data = fadedSine({ amplitude: 0.8, frequency: freq, seconds: 0.2, channels: 1 });
      const ch = data.channels[0];
      let samplePeak = 0;
      for (const v of ch) samplePeak = Math.max(samplePeak, Math.abs(v));
      expect(truePeakChannel(ch, SR)).toBeGreaterThanOrEqual(samplePeak - 1e-6);
    }
  });

  it('reads a low-frequency sine at its own amplitude', () => {
    const data = fadedSine({ amplitude: 0.5, frequency: 200, seconds: 0.5, channels: 1 });
    expect(truePeakChannel(data.channels[0], SR)).toBeCloseTo(0.5, 3);
  });

  it('reads interior DC exactly', () => {
    const data = fadedSine({ amplitude: 0, seconds: 0.2, channels: 1 });
    for (let i = 0; i < data.length; i++) data.channels[0][i] = 0.5;
    // With hard edges, band-limited reconstruction genuinely overshoots at the step, so
    // fade the ends before asserting the interior value.
    const fade = 1024;
    for (let i = 0; i < fade; i++) {
      const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
      data.channels[0][i] *= w;
      data.channels[0][data.length - 1 - i] *= w;
    }
    expect(truePeakChannel(data.channels[0], SR)).toBeCloseTo(0.5, 6);
  });

  it('returns 0 for silence and for an empty buffer', () => {
    expect(truePeakChannel(new Float32Array(1000), SR)).toBe(0);
    expect(truePeakChannel(new Float32Array(0), SR)).toBe(0);
  });

  it('reports sample peak and true peak separately across channels', () => {
    const data = sine({ amplitude: 0.5, frequency: 1000, seconds: 1, channels: 2 });
    for (let i = 0; i < data.length; i++) data.channels[1][i] *= 0.5;
    const result = analysePeaks(data);
    expect(result.perChannelTruePeakDb).toHaveLength(2);
    expect(result.perChannelTruePeakDb[0]).toBeGreaterThan(result.perChannelTruePeakDb[1] + 5);
    expect(result.truePeakDb).toBeCloseTo(result.perChannelTruePeakDb[0], 6);
    expect(result.oversamplingFactor).toBe(4);
  });

  it('measures silence as −Infinity-floored, not NaN', () => {
    const result = analysePeaks(silence({ seconds: 1 }));
    expect(Number.isFinite(result.truePeakDb)).toBe(true);
    expect(result.truePeakDb).toBeLessThan(-170);
  });

  it('detects the overshoot of a clipped square wave', () => {
    // A hard-clipped signal has energy above Nyquist folded in; its reconstruction
    // overshoots (Gibbs). A sample-peak meter reads 0 dBFS and calls it safe.
    const n = 48000;
    const data = make(1, n, SR, (i) => (Math.sin((2 * Math.PI * 997 * i) / SR) > 0 ? 1 : -1));
    const result = analysePeaks(data);
    expect(result.samplePeakDb).toBeCloseTo(0, 3);
    expect(result.truePeakDb).toBeGreaterThan(1.5);
  });
});

describe('independent FFT interpolator (issue #21)', () => {
  it('reads the fs/4 ±45° worst case at 0 dBTP', () => {
    const x = fsOverFour(8192);
    const exact = db(truePeakChannelExact(x, 4));
    expect(exact).toBeGreaterThan(-0.05);
    expect(exact).toBeLessThan(0.05);
  });

  it('never reads below the detection FIR', () => {
    const x = fsOverFour();
    expect(truePeakChannelExact(x, 4)).toBeGreaterThanOrEqual(truePeakChannel(x, SR) - 1e-6);
  });

  it('agrees with the sample peak on a faded low-frequency sine', () => {
    const data = fadedSine({ amplitude: 0.5, frequency: 200, seconds: 0.5, channels: 1 });
    expect(truePeakChannelExact(data.channels[0], 4)).toBeCloseTo(0.5, 3);
  });

  it('analysePeaksVerified is at least as hot as the detection meter', () => {
    const data = sine({ amplitude: 0.9, frequency: 12000, seconds: 0.4, channels: 1 });
    const detect = analysePeaks(data);
    const verified = analysePeaksVerified(data);
    expect(verified.truePeak).toBeGreaterThanOrEqual(detect.truePeak - 1e-6);
  });
});

describe('real-time estimate', () => {
  it('is close to the full measurement on steady material', () => {
    const data = fadedSine({ amplitude: 0.7, frequency: 3000, seconds: 0.1, channels: 1 });
    const full = truePeakChannel(data.channels[0], SR);
    const estimate = truePeakEstimate(data.channels[0], SR, 2);
    expect(db(estimate)).toBeGreaterThan(db(full) - 0.5);
    expect(db(estimate)).toBeLessThan(db(full) + 0.5);
  });

  it('never reads below the sample peak', () => {
    const data = fadedSine({ amplitude: 0.9, frequency: 8000, seconds: 0.05, channels: 1 });
    let samplePeak = 0;
    for (const v of data.channels[0]) samplePeak = Math.max(samplePeak, Math.abs(v));
    expect(truePeakEstimate(data.channels[0], SR, 4)).toBeGreaterThanOrEqual(samplePeak - 1e-9);
  });
});
