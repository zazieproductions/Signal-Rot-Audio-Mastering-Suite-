import { describe, it, expect } from 'vitest';
import { transientShape } from '../src/dsp/transient.js';
import { fft, spectrumFingerprint, matchCurve, MATCH_FREQS } from '../src/dsp/reference-match.js';
import { MockAudioBuffer, sine, noise, concat } from './helpers.js';

const SR = 48000;

/** A percussive burst: fast attack, exponential decay. */
function hit(sampleRate, seconds = 0.4, amplitude = 0.8, decay = 25) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    out[i] = amplitude * Math.exp(-decay * t) * Math.sin(2 * Math.PI * 180 * t);
  }
  return out;
}

function stereo(ch) {
  return MockAudioBuffer.fromChannels([ch, Float32Array.from(ch)], SR);
}

/** Peak amplitude over a sample range. */
function peak(data, from = 0, to = data.length) {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(data[i]));
  return p;
}

describe('transient shaper', () => {
  it('is a no-op when both controls are zero', () => {
    const src = hit(SR);
    const b = stereo(src);
    transientShape(b, 0, 0);
    expect([...b.getChannelData(0)]).toEqual([...src]);
  });

  it('accentuates the attack without touching the decay much', () => {
    const src = concat(new Float32Array(SR * 0.1), hit(SR));
    const plain = stereo(src);
    const shaped = stereo(src);
    transientShape(shaped, 80, 0);

    const attackWindow = [Math.round(SR * 0.1), Math.round(SR * 0.11)];
    const tailWindow = [Math.round(SR * 0.35), Math.round(SR * 0.45)];

    const attackGain =
      peak(shaped.getChannelData(0), ...attackWindow) / peak(plain.getChannelData(0), ...attackWindow);
    const tailGain =
      peak(shaped.getChannelData(0), ...tailWindow) / peak(plain.getChannelData(0), ...tailWindow);

    expect(attackGain).toBeGreaterThan(1.05);
    expect(attackGain).toBeGreaterThan(tailGain);
  });

  it('softens the attack with a negative setting', () => {
    const src = concat(new Float32Array(SR * 0.1), hit(SR));
    const plain = stereo(src);
    const shaped = stereo(src);
    transientShape(shaped, -80, 0);
    const w = [Math.round(SR * 0.1), Math.round(SR * 0.11)];
    expect(peak(shaped.getChannelData(0), ...w)).toBeLessThan(peak(plain.getChannelData(0), ...w));
  });

  it('applies identical gain to both channels', () => {
    const l = hit(SR, 0.4, 0.8);
    const r = hit(SR, 0.4, 0.4); // deliberately different level
    const b = MockAudioBuffer.fromChannels([l, r], SR);
    transientShape(b, 60, 30);
    for (let i = 100; i < l.length; i += 211) {
      if (Math.abs(l[i]) < 1e-5 || Math.abs(r[i]) < 1e-5) continue;
      expect(b.getChannelData(0)[i] / l[i]).toBeCloseTo(b.getChannelData(1)[i] / r[i], 5);
    }
  });

  it('behaves the same regardless of input level', () => {
    // The original sustain term keyed off absolute amplitude, so the same
    // setting did different things to a quiet mix and a loud one.
    const src = hit(SR);
    const loud = stereo(src);
    const quiet = stereo(Float32Array.from(src, (v) => v * 0.05));
    transientShape(loud, 50, 50);
    transientShape(quiet, 50, 50);

    for (let i = 0; i < src.length; i += 97) {
      if (Math.abs(src[i]) < 1e-4) continue;
      const gainLoud = loud.getChannelData(0)[i] / src[i];
      const gainQuiet = quiet.getChannelData(0)[i] / (src[i] * 0.05);
      expect(gainQuiet).toBeCloseTo(gainLoud, 4);
    }
  });

  it('keeps the applied gain inside its documented bounds', () => {
    const b = stereo(noise(1, SR, 0.5, 13));
    const { maxGain, minGain } = transientShape(b, 100, -100);
    expect(maxGain).toBeLessThanOrEqual(2.2);
    expect(minGain).toBeGreaterThanOrEqual(0.25);
  });

  it('handles an empty buffer', () => {
    expect(() => transientShape(new MockAudioBuffer(2, 0, SR), 50, 50)).not.toThrow();
  });
});

describe('FFT', () => {
  it('resolves a pure tone into the expected bin', () => {
    const N = 1024;
    const bin = 64;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = Math.cos((2 * Math.PI * bin * i) / N);
    fft(re, im);
    const mag = Array.from({ length: N / 2 }, (_, k) => Math.hypot(re[k], im[k]));
    const loudest = mag.indexOf(Math.max(...mag));
    expect(loudest).toBe(bin);
    expect(mag[bin]).toBeCloseTo(N / 2, 6);
  });

  it('satisfies Parseval\u2019s theorem', () => {
    const N = 512;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const src = noise(N / SR, SR, 1, 17);
    re.set(src.subarray(0, N));
    let timeEnergy = 0;
    for (let i = 0; i < N; i++) timeEnergy += re[i] * re[i];
    fft(re, im);
    let freqEnergy = 0;
    for (let k = 0; k < N; k++) freqEnergy += re[k] * re[k] + im[k] * im[k];
    expect(freqEnergy / N).toBeCloseTo(timeEnergy, 6);
  });

  it('leaves a DC signal entirely in bin 0', () => {
    const N = 256;
    const re = new Float64Array(N).fill(1);
    const im = new Float64Array(N);
    fft(re, im);
    expect(re[0]).toBeCloseTo(N, 6);
    for (let k = 1; k < N; k++) expect(Math.hypot(re[k], im[k])).toBeLessThan(1e-9);
  });

  it('rejects non-power-of-two lengths', () => {
    expect(() => fft(new Float64Array(100), new Float64Array(100))).toThrow(RangeError);
  });
});

describe('spectrum fingerprint', () => {
  it('returns one level per matching band', () => {
    const fp = spectrumFingerprint(stereo(noise(3, SR, 0.3, 19)));
    expect(fp).toHaveLength(MATCH_FREQS.length);
    for (const v of fp) expect(Number.isFinite(v)).toBe(true);
  });

  it('returns null when the input is shorter than one analysis frame', () => {
    expect(spectrumFingerprint(stereo(noise(0.05, SR, 0.3, 19)))).toBeNull();
  });

  it('puts the energy in the band containing the tone', () => {
    const fp = spectrumFingerprint(stereo(sine(1000, 3, SR, 0.5)));
    const loudest = fp.indexOf(Math.max(...fp));
    expect(MATCH_FREQS[loudest]).toBe(1000);
  });

  it('tracks a level change consistently across all bands', () => {
    const src = noise(3, SR, 0.3, 23);
    const a = spectrumFingerprint(stereo(src));
    const b = spectrumFingerprint(stereo(Float32Array.from(src, (v) => v * 0.5)));
    // -6 dB everywhere.
    for (let i = 0; i < a.length; i++) expect(b[i] - a[i]).toBeCloseTo(-6.02, 1);
  });
});

describe('match curve', () => {
  it('is flat when the two tracks already match', () => {
    const fp = spectrumFingerprint(stereo(noise(3, SR, 0.3, 29)));
    for (const g of matchCurve(fp, fp)) expect(g).toBe(0);
  });

  it('never changes overall level, only tonal balance', () => {
    // A pure level offset must produce no correction at all.
    const src = noise(3, SR, 0.3, 31);
    const quiet = spectrumFingerprint(stereo(src));
    const loud = spectrumFingerprint(stereo(Float32Array.from(src, (v) => v * 2)));
    const curve = matchCurve(quiet, loud);
    const mean = curve.reduce((a, b) => a + b, 0) / curve.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    for (const g of curve) expect(Math.abs(g)).toBeLessThan(0.2);
  });

  it('boosts bands where the reference has more energy', () => {
    const source = [0, 0, 0, 0, 0, 0, 0, 0];
    const reference = [6, 0, 0, 0, 0, 0, 0, -6];
    const curve = matchCurve(source, reference);
    expect(curve[0]).toBeGreaterThan(0);
    expect(curve[7]).toBeLessThan(0);
  });

  it('clamps corrections to the documented limit', () => {
    const source = new Array(8).fill(0);
    const reference = [40, -40, 0, 0, 0, 0, 0, 0];
    for (const g of matchCurve(source, reference)) expect(Math.abs(g)).toBeLessThanOrEqual(8);
  });

  it('returns null for mismatched or missing fingerprints', () => {
    expect(matchCurve(null, [1, 2])).toBeNull();
    expect(matchCurve([1, 2], [1, 2, 3])).toBeNull();
  });
});
