import { describe, it, expect } from 'vitest';
import {
  limitTruePeak,
  computeLimiterGain,
  slidingMinimum,
  hannSmooth,
  verifyCeiling,
} from '../../src/audio/render/limiter.js';
import { analysePeaks } from '../../src/audio/analysis/true-peak.js';
import { analyseLoudness } from '../../src/audio/analysis/loudness.js';
import { cloneAudioData } from '../../src/audio/dsp/audio-data.js';
import { transientTrain, sine, silence, make, whiteNoise } from '../helpers/signals.js';

describe('slidingMinimum', () => {
  it('takes the minimum over a centred window of 2·half + 1 samples', () => {
    //          i:  0    1    2    3    4    5    6    7    8
    const src = Float32Array.from([1, 1, 0.2, 1, 1, 1, 0.5, 1, 1]);
    const out = slidingMinimum(src, 1);
    // i = 0 sees [0,1] only (there is no sample −1), so it is 1, not 0.2.
    const expected = [1, 0.2, 0.2, 0.2, 1, 0.5, 0.5, 0.5, 1];
    expect(out).toHaveLength(expected.length);
    expected.forEach((v, i) => expect(out[i]).toBeCloseTo(v, 6));
  });

  it('is never greater than the source', () => {
    const src = whiteNoise({ seconds: 0.05, channels: 1, amplitude: 1 }).channels[0];
    const positive = Float32Array.from(src, (v) => Math.abs(v) + 0.1);
    const out = slidingMinimum(positive, 17);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeLessThanOrEqual(positive[i] + 1e-7);
  });

  it('returns a copy when the window is zero', () => {
    const src = Float32Array.from([3, 1, 2]);
    expect(Array.from(slidingMinimum(src, 0))).toEqual([3, 1, 2]);
  });
});

describe('hannSmooth', () => {
  it('preserves a constant signal', () => {
    const src = new Float32Array(200).fill(0.7);
    const out = hannSmooth(src, 20);
    for (const v of out) expect(v).toBeCloseTo(0.7, 6);
  });

  it('removes the discontinuity of a step', () => {
    const src = new Float32Array(400).fill(1);
    for (let i = 200; i < 400; i++) src[i] = 0.5;
    const out = hannSmooth(src, 24);
    // Consecutive differences must be small — that is the whole point.
    let maxDelta = 0;
    for (let i = 1; i < out.length; i++)
      maxDelta = Math.max(maxDelta, Math.abs(out[i] - out[i - 1]));
    expect(maxDelta).toBeLessThan(0.05);
  });

  it('cascading two Hann passes lowers peak slope and curvature over a single pass', () => {
    // The limiter smooths the sliding minimum with two cascaded full-width Hann kernels.
    // The cascade must be strictly gentler than the single-Hann construction it replaced:
    // lower peak first difference and clearly lower peak second difference, while still
    // reaching the full depth of the notch.
    const n = 6000;
    const look = 120;
    const req = new Float32Array(n).fill(1);
    for (let i = 3000; i < 3060; i++) req[i] = 0.5;

    const stats = (a) => {
      let d1 = 0;
      let d2 = 0;
      let min = 1;
      for (let i = 2; i < a.length; i++) {
        d1 = Math.max(d1, Math.abs(a[i] - a[i - 1]));
        d2 = Math.max(d2, Math.abs(a[i] - 2 * a[i - 1] + a[i - 2]));
        if (a[i] < min) min = a[i];
      }
      return { d1, d2, min };
    };

    const single = stats(hannSmooth(slidingMinimum(req, look), look));
    const cascade = stats(hannSmooth(hannSmooth(slidingMinimum(req, 2 * look), look), look));

    expect(cascade.d1).toBeLessThan(single.d1);
    expect(cascade.d2).toBeLessThan(single.d2 * 0.7);
    expect(cascade.min).toBeCloseTo(0.5, 6); // full depth still reached
  });

  it('the cascaded smoothing never exceeds the widened sliding minimum’s source', () => {
    // Guarantee behind the construction: kernel support (2·look) ≤ minimum window.
    const look = 64;
    const req = Float32Array.from(
      whiteNoise({ seconds: 0.05, channels: 1, amplitude: 1 }).channels[0],
      (v) => 0.5 + 0.5 * Math.abs(v),
    );
    const smoothed = hannSmooth(hannSmooth(slidingMinimum(req, 2 * look), look), look);
    for (let i = 0; i < req.length; i++) {
      expect(smoothed[i]).toBeLessThanOrEqual(req[i] + 1e-6);
    }
  });
});

describe('gain computation', () => {
  it('leaves quiet material completely untouched', () => {
    const data = sine({ amplitude: 0.1, seconds: 1 });
    const gain = computeLimiterGain(data, { ceilingDb: -1 });
    for (const g of gain) expect(g).toBe(1);
  });

  it('never exceeds the required gain at any sample', () => {
    const data = transientTrain({ seconds: 2 });
    const gain = computeLimiterGain(data, { ceilingDb: -1 });
    for (const g of gain) {
      expect(g).toBeGreaterThan(0);
      expect(g).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('produces a continuous gain curve — no steps', () => {
    const data = transientTrain({ seconds: 2, peakAmplitude: 3 });
    const gain = computeLimiterGain(data, { ceilingDb: -1, lookaheadMs: 2.5 });
    let maxDelta = 0;
    for (let i = 1; i < gain.length; i++)
      maxDelta = Math.max(maxDelta, Math.abs(gain[i] - gain[i - 1]));
    // A stepped gain curve (the pre-7.0 behaviour) jumps by the full reduction in one
    // sample; a smoothed one spreads it over the look-ahead window.
    expect(maxDelta).toBeLessThan(0.02);
  });

  it('anticipates the transient — reduction begins before the peak arrives', () => {
    const sr = 48000;
    const n = sr;
    const data = make(1, n, sr, () => 0);
    const hit = Math.floor(sr / 2);
    for (let k = 0; k < 60; k++) {
      data.channels[0][hit + k] = 2.5 * Math.exp(-k / 8) * Math.sin((2 * Math.PI * 2000 * k) / sr);
    }
    const gain = computeLimiterGain(data, { ceilingDb: -1, lookaheadMs: 2.5 });
    const lookaheadSamples = Math.round(sr * 0.0025);
    expect(gain[hit - Math.floor(lookaheadSamples / 2)]).toBeLessThan(0.999);
  });
});

describe('limitTruePeak', () => {
  it('holds the ceiling on sharp electronic transients', () => {
    for (const ceilingDb of [-0.1, -0.3, -1.0, -2.0]) {
      const data = transientTrain({ seconds: 2, peakAmplitude: 2.2 });
      const result = limitTruePeak(data, { ceilingDb });
      expect(result.ceilingRespected).toBe(true);
      expect(result.achievedTruePeakDb).toBeLessThanOrEqual(ceilingDb + 0.05);
      expect(analysePeaks(data).truePeakDb).toBeLessThanOrEqual(ceilingDb + 0.05);
    }
  });

  it('holds the ceiling on bass-heavy material', () => {
    const sr = 48000;
    const data = make(
      2,
      sr * 2,
      sr,
      (i) =>
        1.4 * Math.sin((2 * Math.PI * 45 * i) / sr) + 0.3 * Math.sin((2 * Math.PI * 90 * i) / sr),
    );
    const result = limitTruePeak(data, { ceilingDb: -1 });
    expect(result.ceilingRespected).toBe(true);
    expect(result.achievedTruePeakDb).toBeLessThanOrEqual(-0.95);
  });

  it('holds the ceiling on already-clipped input', () => {
    const sr = 48000;
    const data = make(2, sr, sr, (i) => (Math.sin((2 * Math.PI * 800 * i) / sr) > 0 ? 1 : -1));
    const result = limitTruePeak(data, { ceilingDb: -1 });
    expect(result.ceilingRespected).toBe(true);
  });

  it('applies one gain curve to both channels — the image cannot move', () => {
    const data = transientTrain({ seconds: 1 });
    // Make the right channel quieter, then verify the L/R ratio is preserved sample-wise.
    for (let i = 0; i < data.length; i++) data.channels[1][i] *= 0.5;
    const before = cloneAudioData(data);
    limitTruePeak(data, { ceilingDb: -1 });
    for (let i = 0; i < data.length; i += 97) {
      if (Math.abs(before.channels[0][i]) < 1e-4) continue;
      const ratioBefore = before.channels[1][i] / before.channels[0][i];
      const ratioAfter = data.channels[1][i] / data.channels[0][i];
      expect(ratioAfter).toBeCloseTo(ratioBefore, 5);
    }
  });

  it('excludes LFE channels from detection but still gains them', () => {
    const sr = 48000;
    const data = make(3, sr, sr, (i, c) =>
      c === 2
        ? 3.0 * Math.sin((2 * Math.PI * 40 * i) / sr)
        : 0.2 * Math.sin((2 * Math.PI * 1000 * i) / sr),
    );
    const before = cloneAudioData(data);
    const result = limitTruePeak(data, { ceilingDb: -1, lfeChannels: [2], verify: false });
    // Detection ignored the loud LFE, so almost no reduction should have been applied…
    expect(result.maxGainReductionDb).toBeGreaterThan(-0.5);
    // …but the LFE channel was still processed by the same gain curve.
    expect(data.channels[2][1000]).toBeCloseTo(before.channels[2][1000], 3);
  });

  it('reports gain-reduction statistics', () => {
    const data = transientTrain({ seconds: 2, peakAmplitude: 2.5 });
    const result = limitTruePeak(data, { ceilingDb: -1 });
    expect(result.maxGainReductionDb).toBeLessThan(-1);
    expect(result.averageGainReductionDb).toBeLessThanOrEqual(0);
    expect(result.reducedSampleRatio).toBeGreaterThan(0);
    expect(result.reducedSampleRatio).toBeLessThanOrEqual(1);
  });

  it('does nothing to material already below the ceiling', () => {
    const data = sine({ amplitude: 0.2, seconds: 1 });
    const before = cloneAudioData(data);
    const result = limitTruePeak(data, { ceilingDb: -1 });
    expect(result.maxGainReductionDb).toBe(0);
    for (let i = 0; i < data.length; i += 211) {
      expect(data.channels[0][i]).toBe(before.channels[0][i]);
    }
  });

  it('handles silence without dividing by zero', () => {
    const data = silence({ seconds: 1 });
    const result = limitTruePeak(data, { ceilingDb: -1 });
    expect(result.maxGainReductionDb).toBe(0);
    expect(Number.isFinite(result.achievedTruePeakDb)).toBe(true);
  });

  it('preserves loudness within a few LU when reduction is modest', () => {
    const data = sine({ amplitude: 0.9, frequency: 300, seconds: 6 });
    const before = analyseLoudness(data).integrated;
    limitTruePeak(data, { ceilingDb: -1 });
    const after = analyseLoudness(data).integrated;
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(before - 2);
  });
});

describe('verifyCeiling', () => {
  it('reports compliance without modifying the buffer', () => {
    const data = sine({ amplitude: 0.5, seconds: 0.5 });
    const before = cloneAudioData(data);
    const result = verifyCeiling(data, -1);
    expect(result.respected).toBe(true);
    expect(result.overBy).toBeLessThan(0);
    expect(data.channels[0][100]).toBe(before.channels[0][100]);
  });

  it('reports non-compliance and by how much', () => {
    const data = sine({ amplitude: 1.0, frequency: 500, seconds: 0.5 });
    const result = verifyCeiling(data, -3);
    expect(result.respected).toBe(false);
    expect(result.overBy).toBeGreaterThan(2.5);
  });
});
