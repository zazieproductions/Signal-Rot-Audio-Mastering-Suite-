import { describe, it, expect } from 'vitest';
import {
  applySaturationHQ,
  makeSaturationTransfer,
  oversampledShape,
  saturationOversamplingFor,
  buildSaturationKernels,
} from '../../src/audio/render/saturate-hq.js';
import { makeSaturationCurve, saturationGainStaging } from '../../src/audio/graph/tone.js';
import { cloneAudioData } from '../../src/audio/dsp/audio-data.js';
import { make, fadedSine } from '../helpers/signals.js';

/** Goertzel magnitude of one bin, normalised to sine amplitude. */
function toneLevel(ch, sampleRate, freq) {
  const n = ch.length;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const w = (2 * Math.PI * freq * i) / sampleRate;
    re += ch[i] * Math.cos(w);
    im -= ch[i] * Math.sin(w);
  }
  return (2 * Math.hypot(re, im)) / n;
}

const db = (v) => 20 * Math.log10(Math.max(v, 1e-12));

describe('saturationOversamplingFor', () => {
  it('targets ≥176.4 kHz effective non-linear rate', () => {
    expect(saturationOversamplingFor(44100)).toBe(4);
    expect(saturationOversamplingFor(48000)).toBe(4);
    expect(saturationOversamplingFor(96000)).toBe(2);
    expect(saturationOversamplingFor(192000)).toBe(1);
  });
});

describe('makeSaturationTransfer', () => {
  it('matches the live WaveShaper curve at its own grid points', () => {
    for (const amount of [0.15, 0.5, 1]) {
      const curve = makeSaturationCurve(amount);
      const f = makeSaturationTransfer(amount);
      const n = curve.length;
      let maxErr = 0;
      for (let i = 0; i < n; i += 7) {
        const x = (i / (n - 1)) * 2 - 1;
        maxErr = Math.max(maxErr, Math.abs(f(x) - curve[i]));
      }
      // Same expression, same normalisation constants — only float rounding differs.
      expect(maxErr).toBeLessThan(1e-6);
    }
  });

  it('is the identity at zero amount', () => {
    const f = makeSaturationTransfer(0);
    for (const x of [-1, -0.5, 0, 0.3, 1]) expect(f(x)).toBe(x);
  });

  it('clamps its input to the WaveShaper curve domain', () => {
    const f = makeSaturationTransfer(0.7);
    expect(f(3)).toBeCloseTo(f(1), 12);
    expect(f(-3)).toBeCloseTo(f(-1), 12);
  });
});

describe('buildSaturationKernels', () => {
  it('reproduces DC exactly through the up/down pair', () => {
    const { phases, decim } = buildSaturationKernels(4);
    for (const branch of phases) {
      let s = 0;
      for (const v of branch) s += v;
      expect(s).toBeCloseTo(1, 12);
    }
    let s = 0;
    for (const v of decim) s += v;
    expect(s).toBeCloseTo(1, 12);
  });
});

describe('oversampledShape', () => {
  it('is transparent in the passband when the shaper is the identity', () => {
    const sr = 48000;
    const data = fadedSine({ amplitude: 0.5, frequency: 1000, seconds: 0.5, sampleRate: sr });
    const before = cloneAudioData(data);
    oversampledShape(data.channels[0], 4, (x) => x);
    // Interior samples (away from the zero-padded edges) must match to fine tolerance:
    // the resampling pair is flat well below its 0.86·Nyquist passband edge.
    let maxErr = 0;
    const guard = 256;
    for (let i = guard; i < data.length - guard; i++) {
      maxErr = Math.max(maxErr, Math.abs(data.channels[0][i] - before.channels[0][i]));
    }
    expect(maxErr).toBeLessThan(2e-3);
  });

  it('has zero net delay — output stays sample-aligned with input', () => {
    const sr = 48000;
    const data = fadedSine({ amplitude: 0.5, frequency: 500, seconds: 0.25, sampleRate: sr });
    const before = cloneAudioData(data);
    oversampledShape(data.channels[0], 4, (x) => x);
    // Cross-correlate at lags −4…4: the peak must be at lag 0.
    let best = 0;
    let bestLag = -99;
    for (let lag = -4; lag <= 4; lag++) {
      let acc = 0;
      for (let i = 200; i < data.length - 200; i++) {
        acc += data.channels[0][i] * before.channels[0][i + lag];
      }
      if (acc > best) {
        best = acc;
        bestLag = lag;
      }
    }
    expect(bestLag).toBe(0);
  });
});

describe('applySaturationHQ', () => {
  it('does not touch the audio at zero amount', () => {
    const data = fadedSine({ amplitude: 0.5, seconds: 0.2 });
    const before = cloneAudioData(data);
    const result = applySaturationHQ(data, 0);
    expect(result.applied).toBe(false);
    expect(data.channels[0][777]).toBe(before.channels[0][777]);
  });

  it('suppresses fold-back aliasing by tens of dB versus base-rate waveshaping', () => {
    // 15 kHz at 44.1 kHz, full drive. The third harmonic (45 kHz) folds to 900 Hz when
    // the non-linearity runs at the base rate. With oversampling it must not.
    const sr = 44100;
    const freq = 15000;
    const aliasFreq = 3 * freq - sr; // 900 Hz
    const amount = 1;
    const staging = saturationGainStaging(amount);
    const f = makeSaturationTransfer(amount);

    const hq = fadedSine({ amplitude: 0.9, frequency: freq, seconds: 1, sampleRate: sr });
    applySaturationHQ(hq, amount);

    const naive = fadedSine({ amplitude: 0.9, frequency: freq, seconds: 1, sampleRate: sr });
    for (const ch of naive.channels) {
      for (let i = 0; i < ch.length; i++) {
        ch[i] = staging.postGain * f(staging.preGain * ch[i]);
      }
    }

    const aliasNaiveDb = db(toneLevel(naive.channels[0], sr, aliasFreq));
    const aliasHqDb = db(toneLevel(hq.channels[0], sr, aliasFreq));
    // The naive alias is a clearly audible tone; the HQ path buries it.
    expect(aliasNaiveDb).toBeGreaterThan(-60);
    expect(aliasNaiveDb - aliasHqDb).toBeGreaterThan(40);
  });

  it('keeps the top octave that the live mitigation low-pass sacrifices', () => {
    // At full drive the live stage low-passes at 17.5 kHz. The HQ pass must not: an
    // 18 kHz tone through light saturation should keep essentially its full level.
    const sr = 48000;
    const data = fadedSine({ amplitude: 0.3, frequency: 18000, seconds: 0.5, sampleRate: sr });
    const inLevel = toneLevel(data.channels[0], sr, 18000);
    applySaturationHQ(data, 0.4);
    const outLevel = toneLevel(data.channels[0], sr, 18000);
    // Small level change from the transfer curve itself is fine; a mitigation low-pass
    // at 20.2 kHz (0.4 drive) would have cost multiple dB.
    expect(db(outLevel / inLevel)).toBeGreaterThan(-2);
  });

  it('generates the intended harmonics', () => {
    const sr = 48000;
    const data = fadedSine({ amplitude: 0.9, frequency: 2000, seconds: 0.5, sampleRate: sr });
    applySaturationHQ(data, 0.8);
    const fundamental = db(toneLevel(data.channels[0], sr, 2000));
    const h2 = db(toneLevel(data.channels[0], sr, 4000));
    const h3 = db(toneLevel(data.channels[0], sr, 6000));
    // Odd harmonics from tanh, even harmonics from the asymmetry term.
    expect(h3 - fundamental).toBeGreaterThan(-40);
    expect(h2 - fundamental).toBeGreaterThan(-60);
  });

  it('is deterministic', () => {
    const a = fadedSine({ amplitude: 0.8, frequency: 3000, seconds: 0.2 });
    const b = fadedSine({ amplitude: 0.8, frequency: 3000, seconds: 0.2 });
    applySaturationHQ(a, 0.6);
    applySaturationHQ(b, 0.6);
    for (let i = 0; i < a.length; i += 97) {
      expect(a.channels[0][i]).toBe(b.channels[0][i]);
    }
  });

  it('reports its configuration for the render report', () => {
    const data = fadedSine({ amplitude: 0.5, seconds: 0.1, sampleRate: 48000 });
    const result = applySaturationHQ(data, 0.5);
    expect(result.applied).toBe(true);
    expect(result.oversampling).toBe(4);
    expect(result.prototypeTaps).toBeGreaterThan(200);
    expect(result.mitigationLowpassBypassed).toBe(true);
    const staging = saturationGainStaging(0.5);
    expect(result.preGain).toBeCloseTo(staging.preGain, 12);
    expect(result.makeupGain).toBeCloseTo(staging.postGain, 12);
  });

  it('does not introduce a DC offset despite the asymmetric curve', () => {
    const sr = 48000;
    const data = make(1, sr, sr, (i) => 0.9 * Math.sin((2 * Math.PI * 100 * i) / sr));
    applySaturationHQ(data, 1);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data.channels[0][i];
    expect(Math.abs(sum / data.length)).toBeLessThan(1e-3);
  });
});
