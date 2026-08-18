import { describe, it, expect } from 'vitest';
import {
  designKWeighting,
  analyseLoudness,
  blockLoudness,
  gateIntegrated,
  loudnessRange,
  normalizationGainDb,
  ABSOLUTE_GATE_LUFS,
  CHANNEL_WEIGHTS,
} from '../../src/audio/analysis/loudness.js';
import {
  sine,
  silence,
  pinkNoise,
  toneBursts,
  antiPhase,
  extremeDynamics,
  twoLevelProgramme,
  toDualMono,
  make,
} from '../helpers/signals.js';

/**
 * ITU-R BS.1770-4 Table 1 and Table 2 — the normative 48 kHz coefficients.
 * These are the numbers the standard prints. Reproducing them exactly is the strongest
 * available evidence that the filter design is right.
 */
const BS1770_STAGE1 = {
  b0: 1.53512485958697,
  b1: -2.69169618940638,
  b2: 1.19839281085285,
  a1: -1.69065929318241,
  a2: 0.73248077421585,
};
const BS1770_STAGE2 = {
  b0: 1.0,
  b1: -2.0,
  b2: 1.0,
  a1: -1.99004745483398,
  a2: 0.99007225036621,
};

describe('K-weighting', () => {
  it('reproduces the BS.1770-4 tabulated coefficients at 48 kHz', () => {
    const [stage1, stage2] = designKWeighting(48000);
    for (const key of ['b0', 'b1', 'b2', 'a1', 'a2']) {
      expect(stage1[key]).toBeCloseTo(BS1770_STAGE1[key], 12);
      expect(stage2[key]).toBeCloseTo(BS1770_STAGE2[key], 12);
    }
  });

  it('keeps the RLB stage numerator at [1, −2, 1] — its +0.043 dB pass-band gain is part of the standard', () => {
    for (const rate of [44100, 48000, 96000, 192000]) {
      const [, stage2] = designKWeighting(rate);
      expect(stage2.b0).toBe(1);
      expect(stage2.b1).toBe(-2);
      expect(stage2.b2).toBe(1);
    }
  });

  it('stays stable at every supported sample rate', () => {
    for (const rate of [44100, 48000, 88200, 96000, 176400, 192000]) {
      for (const stage of designKWeighting(rate)) {
        for (const key of ['b0', 'b1', 'b2', 'a1', 'a2']) {
          expect(Number.isFinite(stage[key])).toBe(true);
        }
        // Poles inside the unit circle: |a2| < 1 and |a1| < 1 + a2.
        expect(Math.abs(stage.a2)).toBeLessThan(1);
        expect(Math.abs(stage.a1)).toBeLessThan(1 + stage.a2);
      }
    }
  });
});

describe('integrated loudness', () => {
  /**
   * K-weighting has almost exactly +0.691 dB of gain at 1 kHz, which cancels the −0.691 dB
   * offset in the LKFS definition. A 1 kHz stereo sine therefore reads its own peak
   * amplitude in dBFS. That is a convenient and well-known identity and it makes an
   * excellent absolute test.
   */
  it('reads a 1 kHz stereo sine at its amplitude in dBFS', () => {
    for (const [amplitude, expected] of [
      [1, 0],
      [0.1, -20],
      [0.01, -40],
    ]) {
      const result = analyseLoudness(sine({ amplitude, frequency: 1000, seconds: 8 }));
      expect(result.integrated).toBeCloseTo(expected, 1);
    }
  });

  it('reads mono 3.01 dB below the same signal in dual mono', () => {
    const mono = sine({ amplitude: 0.1, frequency: 1000, seconds: 8, channels: 1 });
    const dual = toDualMono(mono);
    const m = analyseLoudness(mono).integrated;
    const d = analyseLoudness(dual).integrated;
    expect(d - m).toBeCloseTo(3.01, 1);
  });

  it('is independent of sample rate', () => {
    const at48 = analyseLoudness(sine({ amplitude: 0.25, seconds: 8, sampleRate: 48000 }));
    const at44 = analyseLoudness(sine({ amplitude: 0.25, seconds: 8, sampleRate: 44100 }));
    const at96 = analyseLoudness(sine({ amplitude: 0.25, seconds: 8, sampleRate: 96000 }));
    expect(at44.integrated).toBeCloseTo(at48.integrated, 1);
    expect(at96.integrated).toBeCloseTo(at48.integrated, 1);
  });

  it('scales linearly with level', () => {
    const a = analyseLoudness(pinkNoise({ amplitude: 0.2, seconds: 8, seed: 11 })).integrated;
    const b = analyseLoudness(pinkNoise({ amplitude: 0.1, seconds: 8, seed: 11 })).integrated;
    expect(a - b).toBeCloseTo(6.02, 1);
  });

  it('reports −Infinity and silent for digital silence', () => {
    const result = analyseLoudness(silence({ seconds: 6 }));
    expect(result.integrated).toBe(-Infinity);
    expect(result.silent).toBe(true);
    expect(result.tooShort).toBe(false);
  });

  it('reports tooShort for programmes below one 400 ms block', () => {
    expect(analyseLoudness(sine({ seconds: 0.2 })).tooShort).toBe(true);
    expect(analyseLoudness(sine({ seconds: 0.39 })).tooShort).toBe(true);
    expect(analyseLoudness(sine({ seconds: 0.45 })).tooShort).toBe(false);
  });

  it('handles an empty buffer without throwing', () => {
    const empty = make(2, 0, 48000);
    const result = analyseLoudness(empty);
    expect(result.tooShort).toBe(true);
    expect(result.integrated).toBe(-Infinity);
  });

  it('measures anti-phase stereo the same as in-phase stereo', () => {
    // Loudness is a sum of per-channel mean squares — polarity is irrelevant. A meter
    // that reported anti-phase material as quieter would be summing to mono somewhere.
    const inPhase = sine({ amplitude: 0.4, frequency: 400, seconds: 8 });
    const out = antiPhase({ amplitude: 0.4, frequency: 400, seconds: 8 });
    expect(analyseLoudness(out).integrated).toBeCloseTo(analyseLoudness(inPhase).integrated, 4);
  });
});

describe('gating', () => {
  it('excludes silence between tone bursts from the integrated value', () => {
    // 50 % duty cycle. Without gating the average would be ~3 dB below the tone level;
    // with gating the silent blocks are discarded and the reading matches the tone.
    const bursts = toneBursts({ amplitude: 0.5, onSeconds: 2, offSeconds: 2, cycles: 4 });
    const continuous = sine({ amplitude: 0.5, frequency: 1000, seconds: 8 });
    const gated = analyseLoudness(bursts).integrated;
    const solid = analyseLoudness(continuous).integrated;
    expect(gated).toBeGreaterThan(solid - 1.5);
  });

  it('applies the absolute gate at −70 LUFS', () => {
    const blocks = [-80, -75, -71, -69, -20, -21];
    const result = gateIntegrated(blocks);
    // −80, −75 and −71 are below the absolute gate; −69 then falls below the relative gate.
    expect(result.integrated).toBeGreaterThan(-24);
    expect(result.gatedBlocks).toBe(2);
  });

  it('applies the relative gate at −10 LU below the absolute-gated mean', () => {
    const loud = new Array(20).fill(-18);
    const quiet = new Array(20).fill(-45);
    const result = gateIntegrated([...loud, ...quiet]);
    expect(result.integrated).toBeCloseTo(-18, 1);
    expect(result.gatedBlocks).toBe(20);
  });

  it('returns −Infinity when nothing survives the absolute gate', () => {
    const result = gateIntegrated([-90, -88, -95]);
    expect(result.integrated).toBe(-Infinity);
    expect(result.threshold).toBe(ABSOLUTE_GATE_LUFS);
  });

  it('produces 400 ms blocks at 75 % overlap', () => {
    const data = sine({ seconds: 10, sampleRate: 48000 });
    const { blockSamples, hopSamples, loudness } = blockLoudness(data, 0.4, 0.25);
    expect(blockSamples).toBe(19200);
    expect(hopSamples).toBe(4800);
    // (480000 − 19200) / 4800 + 1
    expect(loudness.length).toBe(97);
  });
});

describe('loudness range (EBU Tech 3342)', () => {
  it('is near zero for a constant tone', () => {
    expect(analyseLoudness(sine({ amplitude: 0.3, seconds: 20 })).lra).toBeLessThan(1);
  });

  it('measures a 15 LU programme range within a fraction of a LU', () => {
    const result = analyseLoudness(twoLevelProgramme({ rangeDb: 15, seconds: 40 }));
    expect(result.lra).toBeGreaterThan(13);
    expect(result.lra).toBeLessThan(16);
  });

  it('gates out a section 60 dB down, exactly as Tech 3342 requires', () => {
    // This looks like a bug and is not one. With a 60 dB split the loud half dominates
    // the absolute-gated mean, putting the relative gate around −26 LUFS; the quiet half
    // sits near −63 LUFS and is discarded. Loudness range is a measure of the *programme
    // material*, not of the difference between programme and near-silence.
    const result = analyseLoudness(extremeDynamics({ seconds: 40 }));
    expect(result.lra).toBeLessThan(6);
    expect(result.integrated).toBeGreaterThan(-10);
  });

  it('uses the −20 LU relative gate, not the −10 LU integrated gate', () => {
    // Blocks 15 LU below the mean survive a −20 LU gate but not a −10 LU gate, so they
    // must widen the range.
    const blocks = [...new Array(20).fill(-18), ...new Array(6).fill(-33)];
    expect(loudnessRange(blocks)).toBeGreaterThan(10);
  });

  it('returns 0 rather than NaN for degenerate input', () => {
    expect(loudnessRange([])).toBe(0);
    expect(loudnessRange([-23])).toBe(0);
    expect(loudnessRange([-90, -95])).toBe(0);
  });
});

describe('momentary and short-term series', () => {
  it('produces a 3 s short-term series with a 1 s hop', () => {
    const result = analyseLoudness(sine({ seconds: 12 }));
    expect(result.shortTermHopSeconds).toBeCloseTo(1, 6);
    expect(result.momentaryHopSeconds).toBeCloseTo(0.1, 6);
    expect(result.shortTerm.length).toBe(10);
  });

  it('omits the short-term series for programmes under 3 s', () => {
    const result = analyseLoudness(sine({ seconds: 2 }));
    expect(result.shortTerm.length).toBe(0);
    expect(result.momentary.length).toBeGreaterThan(0);
  });

  it('tracks the loudest section in maxShortTerm', () => {
    const result = analyseLoudness(extremeDynamics({ seconds: 24 }));
    expect(result.maxShortTerm).toBeGreaterThan(result.integrated - 1);
  });
});

describe('channel weighting', () => {
  it('uses the BS.1770-4 coefficients: 1.0 front, 1.41 surround, 0 LFE', () => {
    expect(CHANNEL_WEIGHTS.L).toBe(1);
    expect(CHANNEL_WEIGHTS.C).toBe(1);
    expect(CHANNEL_WEIGHTS.LFE).toBe(0);
    expect(CHANNEL_WEIGHTS.Ls).toBeCloseTo(1.41, 5);
    expect(CHANNEL_WEIGHTS.Rrs).toBeCloseTo(1.41, 5);
  });

  it('ignores LFE content entirely when its weight is 0', () => {
    const base = sine({ amplitude: 0.2, seconds: 6, channels: 2 });
    const withLfe = {
      sampleRate: base.sampleRate,
      length: base.length,
      channels: [...base.channels.map((c) => Float32Array.from(c)), new Float32Array(base.length)],
    };
    // Fill the third channel with a loud tone; with G = 0 it must not change the reading.
    for (let i = 0; i < withLfe.length; i++) {
      withLfe.channels[2][i] = Math.sin((2 * Math.PI * 40 * i) / withLfe.sampleRate);
    }
    const plain = analyseLoudness(base).integrated;
    const weighted = analyseLoudness(withLfe, { weights: [1, 1, 0] }).integrated;
    expect(weighted).toBeCloseTo(plain, 3);
  });

  it('boosts surround channels by 1.41 when weighted', () => {
    const data = sine({ amplitude: 0.2, seconds: 6, channels: 2 });
    const unweighted = analyseLoudness(data).integrated;
    const weighted = analyseLoudness(data, { weights: [1.41, 1.41] }).integrated;
    expect(weighted - unweighted).toBeCloseTo(10 * Math.log10(1.41), 3);
  });
});

describe('normalizationGainDb', () => {
  it('returns the difference between target and measured', () => {
    expect(normalizationGainDb(-20, -14)).toBeCloseTo(6, 10);
    expect(normalizationGainDb(-8, -14)).toBeCloseTo(-6, 10);
  });

  it('returns 0 for a non-finite measurement rather than ±Infinity', () => {
    expect(normalizationGainDb(-Infinity, -14)).toBe(0);
    expect(normalizationGainDb(NaN, -14)).toBe(0);
  });

  it('bounds the gain', () => {
    expect(normalizationGainDb(-200, -14, 40)).toBe(40);
    expect(normalizationGainDb(200, -14, 40)).toBe(-40);
  });
});

describe('numerical stability', () => {
  it('does not produce NaN on very long, very quiet material', () => {
    const data = sine({ amplitude: 1e-6, seconds: 30, sampleRate: 48000 });
    const result = analyseLoudness(data);
    expect(Number.isNaN(result.integrated)).toBe(false);
    expect(Number.isNaN(result.lra)).toBe(false);
  });

  it('does not produce NaN on clipped, full-scale square-ish material', () => {
    const n = 48000 * 6;
    const data = make(2, n, 48000, (i) => (Math.sin((2 * Math.PI * 100 * i) / 48000) > 0 ? 1 : -1));
    const result = analyseLoudness(data);
    expect(Number.isFinite(result.integrated)).toBe(true);
    expect(result.integrated).toBeGreaterThan(-5);
  });
});
