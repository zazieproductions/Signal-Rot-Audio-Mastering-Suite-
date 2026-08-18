import { describe, it, expect } from 'vitest';
import {
  spectralFingerprint,
  computeMatchCurve,
  MATCH_MODES,
} from '../../src/audio/analysis/spectral-match.js';
import { fftRadix2, hannWindow, windowCoherentGain } from '../../src/audio/analysis/fft.js';
import { MATCH_FREQS } from '../../src/app/constants.js';
import { pinkNoise, whiteNoise, silence, make, sine } from '../helpers/signals.js';
import { designBiquad, processBiquadCascade } from '../../src/audio/dsp/biquad.js';

const SR = 48000;

describe('FFT', () => {
  it('transforms a DC signal to a single bin', () => {
    const n = 64;
    const re = new Float64Array(n).fill(1);
    const im = new Float64Array(n);
    fftRadix2(re, im);
    expect(re[0]).toBeCloseTo(n, 6);
    for (let k = 1; k < n; k++) expect(Math.hypot(re[k], im[k])).toBeLessThan(1e-9);
  });

  it('puts a sine at exactly its bin', () => {
    const n = 1024;
    const bin = 64;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * bin * i) / n);
    fftRadix2(re, im);
    const mags = [];
    for (let k = 0; k < n / 2; k++) mags.push(Math.hypot(re[k], im[k]));
    const peak = mags.indexOf(Math.max(...mags));
    expect(peak).toBe(bin);
    expect(mags[bin]).toBeCloseTo(n / 2, 4);
  });

  it('rejects non-power-of-two lengths', () => {
    expect(() => fftRadix2(new Float64Array(100), new Float64Array(100))).toThrow(/power of two/);
  });

  it('rejects mismatched arrays', () => {
    expect(() => fftRadix2(new Float64Array(64), new Float64Array(32))).toThrow(/mismatch/);
  });

  it('builds a periodic Hann window with the expected coherent gain', () => {
    const w = hannWindow(1024);
    expect(w[0]).toBeCloseTo(0, 12);
    expect(w[512]).toBeCloseTo(1, 12);
    expect(windowCoherentGain(w)).toBeCloseTo(0.5, 6);
    expect(hannWindow(1024)).toBe(w); // cached
  });
});

describe('spectralFingerprint', () => {
  it('returns null for programmes shorter than one frame', () => {
    expect(spectralFingerprint(make(2, 4096, SR, () => 0.1))).toBeNull();
  });

  it('returns null for silence', () => {
    expect(spectralFingerprint(silence({ seconds: 5 }))).toBeNull();
  });

  it('produces one value per mastering band, mean-removed', () => {
    const fp = spectralFingerprint(pinkNoise({ seconds: 8, seed: 31 }));
    expect(fp.bandsDb).toHaveLength(MATCH_FREQS.length);
    const mean = fp.bandsDb.reduce((a, b) => a + b, 0) / fp.bandsDb.length;
    expect(Math.abs(mean)).toBeLessThan(1e-9);
    expect(fp.framesUsed).toBeGreaterThan(3);
  });

  it('is level-independent', () => {
    const loud = spectralFingerprint(pinkNoise({ amplitude: 0.4, seconds: 8, seed: 41 }));
    const quiet = spectralFingerprint(pinkNoise({ amplitude: 0.04, seconds: 8, seed: 41 }));
    loud.bandsDb.forEach((v, i) => expect(quiet.bandsDb[i]).toBeCloseTo(v, 4));
  });

  it('sees pink noise as a falling spectrum and white noise as flat', () => {
    const pink = spectralFingerprint(pinkNoise({ seconds: 10, seed: 51 }));
    const white = spectralFingerprint(whiteNoise({ seconds: 10, seed: 51 }));
    // Pink falls ~3 dB per octave: the 60 Hz band should sit well above the 12 kHz band.
    expect(pink.bandsDb[0] - pink.bandsDb[7]).toBeGreaterThan(12);
    expect(Math.abs(white.bandsDb[0] - white.bandsDb[7])).toBeLessThan(6);
  });

  it('rejects near-silent frames so intros do not drag the average down', () => {
    const n = SR * 20;
    // First half silent, second half pink noise.
    const noisy = pinkNoise({ seconds: 10, seed: 61 });
    const data = make(2, n, SR, (i, c) => (i < n / 2 ? 0 : noisy.channels[c][i - n / 2]));
    const combined = spectralFingerprint(data);
    const noiseOnly = spectralFingerprint(noisy);
    expect(combined.framesRejected).toBeGreaterThan(0);
    combined.bandsDb.forEach((v, i) => expect(v).toBeCloseTo(noiseOnly.bandsDb[i], 0));
  });

  it('reports the duration it analysed', () => {
    const fp = spectralFingerprint(pinkNoise({ seconds: 7, seed: 71 }));
    expect(fp.durationSeconds).toBeCloseTo(7, 3);
    expect(fp.sampleRate).toBe(SR);
  });
});

describe('computeMatchCurve', () => {
  const source = () => spectralFingerprint(pinkNoise({ seconds: 10, seed: 101 }));

  it('produces a near-zero curve when source and reference are the same material', () => {
    const fp = source();
    const result = computeMatchCurve(fp, fp);
    for (const g of result.gainsDb) expect(Math.abs(g)).toBeLessThan(0.2);
    expect(result.confidence).toBeGreaterThan(0.95);
    expect(result.warnings).toHaveLength(0);
  });

  it('never changes overall level — the curve sums to zero', () => {
    const dark = pinkNoise({ seconds: 10, seed: 111 });
    processBiquadCascade(dark.channels[0], [designBiquad('highshelf', 4000, 0.7071, -8, SR)]);
    processBiquadCascade(dark.channels[1], [designBiquad('highshelf', 4000, 0.7071, -8, SR)]);
    const result = computeMatchCurve(source(), spectralFingerprint(dark));
    const sum = result.gainsDb.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum)).toBeLessThan(1.5);
  });

  it('moves in the right direction: a dark reference asks for a cut on top', () => {
    const dark = pinkNoise({ seconds: 10, seed: 121 });
    for (const ch of dark.channels) {
      processBiquadCascade(ch, [designBiquad('highshelf', 6000, 0.7071, -10, SR)]);
    }
    const result = computeMatchCurve(source(), spectralFingerprint(dark));
    // 8 kHz band (index 6) must be cut relative to the 150 Hz band (index 1).
    expect(result.gainsDb[6]).toBeLessThan(result.gainsDb[1]);
    expect(result.gainsDb[6]).toBeLessThan(0);
  });

  it('bounds each band by the mode\u2019s maximum', () => {
    const veryDark = pinkNoise({ seconds: 10, seed: 131 });
    for (const ch of veryDark.channels) {
      processBiquadCascade(ch, [
        designBiquad('highshelf', 3000, 0.7071, -24, SR),
        designBiquad('highshelf', 3000, 0.7071, -24, SR),
      ]);
    }
    const darkFp = spectralFingerprint(veryDark);
    for (const mode of ['broad', 'balanced', 'precise']) {
      const result = computeMatchCurve(source(), darkFp, { mode });
      for (const g of result.gainsDb) {
        expect(Math.abs(g)).toBeLessThanOrEqual(MATCH_MODES[mode].maxDb + 1e-9);
      }
    }
  });

  it('smooths more in broad mode than in precise mode', () => {
    const jagged = pinkNoise({ seconds: 10, seed: 141 });
    for (const ch of jagged.channels) {
      processBiquadCascade(ch, [
        designBiquad('peaking', 400, 4, 12, SR),
        designBiquad('peaking', 2500, 4, -12, SR),
      ]);
    }
    const fp = spectralFingerprint(jagged);
    const roughness = (gains) => {
      let sum = 0;
      for (let i = 1; i < gains.length; i++) sum += Math.abs(gains[i] - gains[i - 1]);
      return sum;
    };
    const broad = computeMatchCurve(source(), fp, { mode: 'broad' });
    const precise = computeMatchCurve(source(), fp, { mode: 'precise' });
    expect(roughness(broad.gainsDb)).toBeLessThan(roughness(precise.gainsDb));
  });

  it('tapers corrections at the frequency boundaries', () => {
    const shaped = pinkNoise({ seconds: 10, seed: 151 });
    for (const ch of shaped.channels) {
      processBiquadCascade(ch, [designBiquad('lowshelf', 70, 0.7071, 12, SR)]);
    }
    const fp = spectralFingerprint(shaped);
    const src = source();
    // Same material, two taper settings: a taper that starts just below 60 Hz must reduce
    // the 60 Hz correction relative to one that starts far below it.
    const tapered = computeMatchCurve(src, fp, { mode: 'precise', lowLimitHz: 55 });
    const untapered = computeMatchCurve(src, fp, { mode: 'precise', lowLimitHz: 10 });
    expect(Math.abs(tapered.gainsDb[0])).toBeLessThan(Math.abs(untapered.gainsDb[0]));
  });

  it('lowers confidence and warns when the tracks are very different', () => {
    const white = spectralFingerprint(whiteNoise({ seconds: 10, seed: 161 }));
    const result = computeMatchCurve(source(), white);
    expect(result.confidence).toBeLessThan(0.7);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('warns about a very short reference', () => {
    const short = spectralFingerprint(pinkNoise({ seconds: 2, seed: 171 }));
    const result = computeMatchCurve(source(), short);
    expect(result.warnings.some((w) => /Durations differ/.test(w))).toBe(true);
    expect(result.confidence).toBeLessThan(1);
  });

  it('warns about a sample-rate mismatch', () => {
    const other = spectralFingerprint(pinkNoise({ seconds: 10, sampleRate: 44100, seed: 181 }));
    const result = computeMatchCurve(source(), other);
    expect(result.warnings.some((w) => /Sample rates differ/.test(w))).toBe(true);
  });

  it('falls back to balanced mode for an unknown mode name', () => {
    const result = computeMatchCurve(source(), source(), { mode: 'magic' });
    expect(result.mode).toBe('balanced');
  });

  it('returns the shapes so the UI can draw all three curves', () => {
    const result = computeMatchCurve(source(), source());
    expect(result.sourceShapeDb).toHaveLength(MATCH_FREQS.length);
    expect(result.referenceShapeDb).toHaveLength(MATCH_FREQS.length);
  });

  it('produces a finite curve even from pathological input', () => {
    const tone = spectralFingerprint(sine({ amplitude: 0.5, frequency: 1000, seconds: 8 }));
    const result = computeMatchCurve(tone, source());
    for (const g of result.gainsDb) expect(Number.isFinite(g)).toBe(true);
  });
});
