import { describe, it, expect } from 'vitest';
import { normalizeAndLimit, scoreRefinementPass } from '../../src/audio/render/normalize.js';
import { limitTruePeak, computeLimiterGain } from '../../src/audio/render/limiter.js';
import { analyseLoudness } from '../../src/audio/analysis/loudness.js';
import { analysePeaks } from '../../src/audio/analysis/true-peak.js';
import { crestFactorDb } from '../../src/audio/analysis/rms.js';
import { cloneAudioData } from '../../src/audio/dsp/audio-data.js';
import { coerceParameter, defaultParameters } from '../../src/app/parameters.js';
import { pinkNoise, transientTrain, sine } from '../helpers/signals.js';

describe('loudness ambition guard', () => {
  it('scores a quieter clean pass better than a louder crushed one', () => {
    // Same loudness error, different cost: the crushed pass must lose.
    expect(scoreRefinementPass(-1.2, -1.0)).toBeLessThan(scoreRefinementPass(-0.7, -5.0));
    // Inside the budget, loudness error alone decides.
    expect(scoreRefinementPass(-0.2, -1.0)).toBeLessThan(scoreRefinementPass(-1.2, -1.0));
  });

  it('prefers a cleaner pass over a half-LU louder one that costs extra peak GR (SON-6)', () => {
    // wall: −1.0 LU miss at 3 dB peak GR (the clean line)
    // extra: −0.5 LU miss at 4.65 dB peak GR — 0.30 LU per extra dB, below MIN_LUFS_PER_PEAK_GR
    expect(scoreRefinementPass(-1.0, -1.0, -3.0)).toBeLessThan(
      scoreRefinementPass(-0.5, -1.0, -4.65),
    );
  });

  it('reduces ambition on pink noise at −9 LUFS instead of crushing it', () => {
    const data = pinkNoise({ amplitude: 0.1, seconds: 10, seed: 5 });
    const r = normalizeAndLimit(data, {
      normalize: true,
      targetLufs: -9,
      ceilingDb: -1,
      refine: true,
    });
    expect(r.targetReachable).toBe(false);
    expect(r.ambitionReduced).toBe(true);
    // It settled for a quieter master: short of the target, but within a couple of LU.
    expect(r.deltaLu).toBeLessThan(0);
    expect(r.deltaLu).toBeGreaterThan(-2.5);
    // …and the limiting stayed restrained instead of grinding 5+ dB off everything.
    expect(-r.limiter.averageGainReductionDb).toBeLessThan(3.5);
    expect(r.limiter.ceilingRespected).toBe(true);
  });

  it('still reaches demanding but legitimate targets on transient material', () => {
    // Sparse transient limiting is normal mastering, not crushing: the guard must not
    // steal loudness that costs only peak reduction.
    const data = transientTrain({ seconds: 8, peakAmplitude: 1.2, bedAmplitude: 0.15 });
    const r = normalizeAndLimit(data, {
      normalize: true,
      targetLufs: -9,
      ceilingDb: -1,
      refine: true,
    });
    expect(Math.abs(r.deltaLu)).toBeLessThan(0.3);
    expect(-r.limiter.averageGainReductionDb).toBeLessThan(3);
  });

  it('leaves modest targets exactly alone', () => {
    for (const target of [-14, -16, -18]) {
      const data = pinkNoise({ amplitude: 0.1, seconds: 10, seed: 5 });
      const r = normalizeAndLimit(data, {
        normalize: true,
        targetLufs: target,
        ceilingDb: -1,
        refine: true,
      });
      expect(Math.abs(r.deltaLu)).toBeLessThan(0.25);
      expect(r.ambitionReduced).toBe(false);
    }
  });
});

describe('limiter transparency', () => {
  it('begins reducing gradually below the ceiling (soft knee), not with a wall', () => {
    // A tone peaking just under the ceiling should see gentle gain (knee), not unity
    // followed by a slam: neighbouring samples must not differ wildly.
    const data = sine({ amplitude: 0.85, frequency: 200, seconds: 1 });
    const peak = analysePeaks(data).truePeakDb;
    expect(peak).toBeLessThan(-1);
    expect(peak).toBeGreaterThan(-3.5);
    const gain = computeLimiterGain(data, { ceilingDb: -1 });
    let min = 1;
    for (const g of gain) if (g < min) min = g;
    // Inside the 1.5 dB knee: some movement, but never a chop.
    expect(min).toBeGreaterThan(0.9);
    let maxDelta = 0;
    for (let i = 1; i < gain.length; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(gain[i] - gain[i - 1]));
    }
    expect(maxDelta).toBeLessThan(0.01);
  });

  it('keeps routine mastering reduction modest on healthy mixed material', () => {
    // Pink at a moderate level pushed to a reference target: the limiter should barely
    // breathe, not pump.
    const data = pinkNoise({ amplitude: 0.1, seconds: 8, seed: 21 });
    const before = analyseLoudness(data).integrated;
    expect(before).toBeLessThan(-14);
    const r = normalizeAndLimit(data, {
      normalize: true,
      targetLufs: -15,
      ceilingDb: -1,
      refine: true,
    });
    expect(-r.limiter.averageGainReductionDb).toBeLessThan(1.5);
    expect(r.limiter.ceilingRespected).toBe(true);
  });

  it('never lets a healthy master clip: true peak holds at −1 dBTP', () => {
    const data = transientTrain({ seconds: 6, peakAmplitude: 1.4 });
    limitTruePeak(data, { ceilingDb: -1 });
    expect(analysePeaks(data).truePeakDb).toBeLessThanOrEqual(-0.95);
  });
});

describe('transient and dynamics preservation', () => {
  it('does not collapse crest factor on dynamic material at reference loudness', () => {
    const data = transientTrain({ seconds: 8, peakAmplitude: 1.0, bedAmplitude: 0.12 });
    const crestBefore = crestFactorDb(cloneAudioData(data));
    normalizeAndLimit(data, { normalize: true, targetLufs: -15, ceilingDb: -1, refine: true });
    const crestAfter = crestFactorDb(data);
    // Some crest reduction is inevitable; a collapse is not.
    expect(crestBefore - crestAfter).toBeLessThan(6);
    expect(crestAfter).toBeGreaterThan(8);
  });
});

describe('preview/export gain-structure consistency', () => {
  it('lets drive trim hot sources below zero', () => {
    expect(coerceParameter('drive', -6)).toBe(-6);
    expect(coerceParameter('drive', -100)).toBe(-6);
    expect(coerceParameter('drive', 0)).toBe(0);
  });

  it('caps drive at a sane maximum', () => {
    expect(coerceParameter('drive', 9)).toBe(9);
    expect(coerceParameter('drive', 40)).toBe(9);
  });

  it('keeps the default snapshot flat and safe', () => {
    const p = defaultParameters();
    expect(p.drive).toBe(0);
    expect(p.sat).toBe(0);
    expect(p.ceiling).toBe(-1.0);
    expect(p.mbLow).toBe(0);
    expect(p.tape).toBe(0);
    expect(p.vinyl).toBe(0);
    expect(p.hiss).toBe(0);
  });
});
