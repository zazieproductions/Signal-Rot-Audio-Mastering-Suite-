import { describe, it, expect } from 'vitest';
import {
  correlation,
  correlationEnvelope,
  monoCompatibility,
  phaseRiskFromParameters,
} from '../../src/audio/analysis/correlation.js';
import { rms, rmsDb, crestFactorDb, rmsEnvelope } from '../../src/audio/analysis/rms.js';
import { sine, antiPhase, whiteNoise, silence, make, toDualMono } from '../helpers/signals.js';
import { defaultParameters } from '../../src/app/parameters.js';

const SR = 48000;

describe('correlation', () => {
  it('is +1 for identical channels', () => {
    const data = toDualMono(sine({ amplitude: 0.5, seconds: 1, channels: 1 }));
    expect(correlation(data.channels[0], data.channels[1])).toBeCloseTo(1, 6);
  });

  it('is −1 for polarity-inverted channels', () => {
    const data = antiPhase({ amplitude: 0.5, seconds: 1 });
    expect(correlation(data.channels[0], data.channels[1])).toBeCloseTo(-1, 6);
  });

  it('is near 0 for independent noise', () => {
    const data = whiteNoise({ seconds: 4, seed: 17 });
    expect(Math.abs(correlation(data.channels[0], data.channels[1]))).toBeLessThan(0.02);
  });

  it('treats silence as trivially mono-compatible rather than dividing by zero', () => {
    const data = silence({ seconds: 1 });
    expect(correlation(data.channels[0], data.channels[1])).toBe(1);
  });

  it('produces an envelope over time', () => {
    const data = whiteNoise({ seconds: 1, seed: 3 });
    const { values, hopSeconds } = correlationEnvelope(data, 0.05, 0.025);
    expect(values.length).toBeGreaterThan(30);
    expect(hopSeconds).toBeCloseTo(0.025, 6);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(-1.0001);
      expect(v).toBeLessThanOrEqual(1.0001);
    }
  });

  it('returns an empty envelope for mono', () => {
    const data = sine({ channels: 1, seconds: 1 });
    expect(correlationEnvelope(data).values).toHaveLength(0);
  });
});

describe('monoCompatibility', () => {
  it('reports no loss for a mono-derived signal', () => {
    const data = toDualMono(whiteNoise({ seconds: 2, channels: 1, seed: 5 }));
    const result = monoCompatibility(data);
    expect(result.overallCorrelation).toBeCloseTo(1, 5);
    for (const band of result.bands) expect(band.monoLossDb).toBeGreaterThan(-0.5);
  });

  it('reports total loss for anti-phase material', () => {
    const data = antiPhase({ amplitude: 0.5, frequency: 700, seconds: 2 });
    const result = monoCompatibility(data);
    expect(result.overallCorrelation).toBeCloseTo(-1, 4);
    expect(result.worstBand.monoLossDb).toBeLessThan(-40);
  });

  it('reports about −3 dB for decorrelated material — the correct answer, not a failure', () => {
    const data = whiteNoise({ seconds: 2, seed: 23 });
    const result = monoCompatibility(data);
    for (const band of result.bands) {
      expect(band.monoLossDb).toBeLessThan(-1.5);
      expect(band.monoLossDb).toBeGreaterThan(-5);
    }
  });

  it('localises cancellation to the band it happens in', () => {
    // A mono bass with an anti-phase 5 kHz tone on top.
    const n = SR * 2;
    const data = make(2, n, SR, (i, c) => {
      const bass = 0.4 * Math.sin((2 * Math.PI * 80 * i) / SR);
      const air = (c === 1 ? -1 : 1) * 0.4 * Math.sin((2 * Math.PI * 5000 * i) / SR);
      return bass + air;
    });
    const result = monoCompatibility(data);
    const byLabel = Object.fromEntries(result.bands.map((b) => [b.label, b]));
    expect(byLabel.bass.monoLossDb).toBeGreaterThan(-1);
    expect(byLabel.air.monoLossDb).toBeLessThan(-15);
    expect(result.worstBand.label).toBe('air');
  });

  it('returns an empty result for mono input', () => {
    const result = monoCompatibility(sine({ channels: 1, seconds: 1 }));
    expect(result.bands).toHaveLength(0);
    expect(result.worstBand).toBeNull();
  });
});

describe('phaseRiskFromParameters', () => {
  const p = (patch) => ({ ...defaultParameters(), ...patch });

  it('is silent for a neutral parameter set', () => {
    const result = phaseRiskFromParameters(p({}));
    expect(result.level).toBe('ok');
    expect(result.messages).toHaveLength(0);
  });

  it('escalates with width', () => {
    expect(phaseRiskFromParameters(p({ width: 1.2, bassMono: 80 })).level).toBe('ok');
    expect(phaseRiskFromParameters(p({ width: 2.0, bassMono: 80 })).level).toBe('caution');
    expect(phaseRiskFromParameters(p({ width: 2.4, bassMono: 80 })).level).toBe('danger');
  });

  it('warns about a wide image with no low-frequency anchor', () => {
    const result = phaseRiskFromParameters(p({ width: 1.5 }));
    expect(result.level).toBe('caution');
    expect(result.messages.join(' ')).toMatch(/bass-mono/i);
  });

  it('warns about long Haas delays', () => {
    expect(phaseRiskFromParameters(p({ haas: 4, bassMono: 80 })).level).toBe('ok');
    expect(phaseRiskFromParameters(p({ haas: 12, bassMono: 80 })).level).toBe('caution');
    expect(phaseRiskFromParameters(p({ haas: 25, bassMono: 80 })).level).toBe('danger');
  });

  it('treats out-of-phase low-band width as dangerous', () => {
    expect(phaseRiskFromParameters(p({ widthLow: 1.6, bassMono: 80 })).level).toBe('danger');
  });

  it('names the side comb blend for what it is', () => {
    const result = phaseRiskFromParameters(p({ phaseRot: 0.7, bassMono: 80 }));
    expect(result.messages.join(' ')).toMatch(/comb/i);
  });
});

describe('RMS and crest factor', () => {
  it('reads a full-scale sine as 0 dBFS RMS (sine-referenced, the AES convention)', () => {
    expect(rmsDb(sine({ amplitude: 1, seconds: 1 }))).toBeCloseTo(0, 2);
    expect(rmsDb(sine({ amplitude: 0.5, seconds: 1 }))).toBeCloseTo(-6.02, 1);
  });

  it('gives a sine a crest factor of 3.01 dB', () => {
    expect(crestFactorDb(sine({ amplitude: 0.7, seconds: 1 }))).toBeCloseTo(3.01, 1);
  });

  it('gives white noise a much higher crest factor than a sine', () => {
    expect(crestFactorDb(whiteNoise({ seconds: 2, seed: 9 }))).toBeGreaterThan(8);
  });

  it('returns 0 rather than NaN for silence', () => {
    expect(rms(silence({ seconds: 1 }))).toBe(0);
    expect(crestFactorDb(silence({ seconds: 1 }))).toBe(0);
  });

  it('produces an RMS envelope', () => {
    const { values, hopSeconds } = rmsEnvelope(sine({ amplitude: 0.5, seconds: 1 }), 0.05, 0.025);
    expect(values.length).toBeGreaterThan(30);
    expect(hopSeconds).toBeCloseTo(0.025, 6);
    for (const v of values) expect(v).toBeCloseTo(0.3536, 2);
  });

  it('handles out-of-range windows gracefully', () => {
    const data = sine({ seconds: 0.1 });
    expect(rms(data, -100, 1e9)).toBeGreaterThan(0);
    expect(rms(data, 500, 400)).toBe(0);
  });
});
