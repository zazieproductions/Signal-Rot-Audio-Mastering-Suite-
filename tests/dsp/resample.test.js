import { describe, it, expect } from 'vitest';
import { resampleData, buildResampleTable, RESAMPLE_TAPS } from '../../src/audio/dsp/resample.js';
import { make } from '../helpers/signals.js';

/** RMS in dBFS of the middle half of a channel (edges excluded). */
function midRmsDb(ch) {
  const a = Math.floor(ch.length * 0.25);
  const b = ch.length - a;
  let acc = 0;
  for (let i = a; i < b; i++) acc += ch[i] * ch[i];
  return 20 * Math.log10(Math.sqrt(acc / (b - a)));
}

/** Residual RMS in dBFS of the whole channel. */
function rmsDb(ch) {
  let acc = 0;
  for (let i = 0; i < ch.length; i++) acc += ch[i] * ch[i];
  return 20 * Math.log10(Math.sqrt(acc / ch.length) + 1e-15);
}

const tone = (rate, freq, amplitude = 0.5, seconds = 1.5) =>
  make(1, Math.round(seconds * rate), rate, (i) => amplitude * Math.sin((2 * Math.PI * freq * i) / rate));

describe('windowed-sinc resampler (§2.8)', () => {
  it('is a no-op copy at the same rate (bit-identical)', () => {
    const x = tone(48000, 997);
    const y = resampleData(x, 48000);
    expect(y.sampleRate).toBe(48000);
    expect(y.channels[0]).not.toBe(x.channels[0]);
    let equal = true;
    for (let i = 0; i < x.channels[0].length; i++) {
      if (y.channels[0][i] !== x.channels[0][i]) equal = false;
    }
    expect(equal).toBe(true);
  });

  it('refuses absurd target rates', () => {
    const x = tone(48000, 997);
    expect(() => resampleData(x, 1000000)).toThrow();
    expect(() => resampleData(x, 0)).toThrow();
    expect(() => resampleData(x, -1)).toThrow();
  });

  it('preserves loudness: passband amplitude flat within ±0.1 dB over the band', () => {
    // 0.42 × min(fsIn, fsOut) is safely inside the passband for every pair here.
    const cases = [
      [44100, 48000, 19000],
      [48000, 44100, 18000],
      [96000, 44100, 18000],
      [44100, 96000, 18000],
      [44100, 192000, 18000],
      [192000, 44100, 18000],
      [88200, 44100, 18000],
      [44100, 88200, 18000],
      [176400, 44100, 18000],
      [96000, 48000, 20000],
    ];
    for (const [from, to, freq] of cases) {
      const x = tone(from, freq);
      const y = resampleData(x, to);
      const ref = midRmsDb(x.channels[0]);
      const got = midRmsDb(y.channels[0]);
      expect(got).toBeGreaterThan(ref - 0.1);
      expect(got).toBeLessThan(ref + 0.05);
    }
  });

  it('passes near-Nyquist content when upsampling (no invented loss)', () => {
    // 21 kHz at 44.1 kHz is 0.95 of the input Nyquist; a band-limited resampler must
    // keep it (content never exceeds the input band when upsampling).
    const x = tone(44100, 21000);
    const y = resampleData(x, 96000);
    expect(midRmsDb(y.channels[0])).toBeGreaterThan(midRmsDb(x.channels[0]) - 0.15);
  });

  it('removes everything above the destination Nyquist when downsampling', () => {
    // 24 kHz input at 48 kHz must not survive a 48 → 44.1 conversion (its alias would
    // land at 44.1 − 24 = 20.1 kHz).
    const x = tone(48000, 24000);
    const y = resampleData(x, 44100);
    expect(rmsDb(y.channels[0])).toBeLessThan(-40);
  });

  it('suppresses high-rate out-of-band content deeply (≥ 55 dB)', () => {
    // 96 → 44.1 kHz: content at 26.5 kHz (1.2 × output Nyquist) would alias at 17.6 kHz.
    const x = tone(96000, 26500);
    const y = resampleData(x, 44100);
    expect(rmsDb(y.channels[0])).toBeLessThan(-55);
    const z = tone(96000, 40000);
    const w = resampleData(z, 44100);
    expect(rmsDb(w.channels[0])).toBeLessThan(-75);
  });

  it('keeps passband tones clean on 44.1 ↔ 48 round trips (≤ 0.1 dB error)', () => {
    const x = tone(44100, 12000);
    const up = resampleData(x, 48000);
    const back = resampleData(up, 44100);
    expect(back.sampleRate).toBe(44100);
    expect(Math.abs(back.channels[0].length - x.channels[0].length)).toBeLessThanOrEqual(2);
    expect(midRmsDb(back.channels[0])).toBeGreaterThan(midRmsDb(x.channels[0]) - 0.1);
    expect(midRmsDb(back.channels[0])).toBeLessThan(midRmsDb(x.channels[0]) + 0.1);
  });

  it('does not invent energy for a 96 → 48 half-band conversion of an impulse', () => {
    const from = 96000;
    const n = from; // 1 s
    const x = make(1, n, from, (i) => (i === n / 2 ? 1 : 0));
    const y = resampleData(x, 48000);
    // Half-band conversion spreads one impulse over the lowpassed sinc; the peak
    // sample sits at the centre with ~2·(fsOut/fsIn) amplitude (the Nyquist-limited
    // band carries only half the energy of an impulse), symmetric ringing either side.
    let peak = 0;
    let peakAt = 0;
    for (let i = 0; i < y.channels[0].length; i++) {
      const v = Math.abs(y.channels[0][i]);
      if (v > peak) {
        peak = v;
        peakAt = i;
      }
    }
    expect(peakAt).toBeGreaterThanOrEqual(y.channels[0].length / 2 - 1);
    expect(peakAt).toBeLessThanOrEqual(y.channels[0].length / 2 + 1);
    expect(peak).toBeGreaterThan(0.45);
    expect(peak).toBeLessThan(0.6);
    // Parseval: an impulse carries unit energy in the input domain; the half-band
    // kernel keeps exactly half of it, deterministically.
    let sum = 0;
    for (const v of y.channels[0]) sum += v * v;
    expect(sum).toBeGreaterThan(0.24);
    expect(sum).toBeLessThan(0.26);
  });

  it('keeps multi-channel phase coherence (both channels identical delays)', () => {
    const from = 48000;
    const n = from;
    const x = make(2, n, from, (i, c) =>
      c === 0 ? Math.sin((2 * Math.PI * 3000 * i) / from) : Math.sin((2 * Math.PI * 3000 * i) / from + 1),
    );
    const y = resampleData(x, 44100);
    // Cross-correlate: the inter-channel phase relationship must be preserved.
    let lagMax = 0;
    for (let lag = -6; lag <= 6; lag++) {
      let corr = 0;
      for (let i = 2000; i < y.channels[0].length - 2000; i++) {
        corr += y.channels[0][i] * y.channels[1][i + lag];
      }
      if (corr > lagMax) lagMax = corr;
    }
    const same = make(2, n, from, (i, c) =>
      c === 0 ? Math.sin((2 * Math.PI * 3000 * i) / from) : Math.sin((2 * Math.PI * 3000 * i) / from + 1),
    );
    void same;
    // Sanity: at lag 0 the correlation of the *output* must dominate any ±6-sample lag.
    let c0 = 0;
    for (let i = 2000; i < y.channels[0].length - 2000; i++) c0 += y.channels[0][i] * y.channels[1][i];
    let c1 = 0;
    for (let i = 2000; i < y.channels[0].length - 2000; i++) c1 += y.channels[0][i] * y.channels[1][i + 1];
    expect(c0).toBeGreaterThan(c1);
  });

  it('is deterministic (identical input → bit-identical output)', () => {
    const x = tone(44100, 997);
    const a = resampleData(x, 96000);
    const b = resampleData(x, 96000);
    expect(a.channels[0]).toEqual(b.channels[0]);
  });

  it('keeps true peaks bounded across conversion (no ringing overshoot > 0.2 dB)', () => {
    const from = 48000;
    const n = Math.round(1.5 * from);
    const x = make(1, n, from, (i) => {
      const t = i / from;
      return 0.5 * Math.sin(2 * Math.PI * 12000 * t) * (1 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
    });
    const before = x.channels[0].reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const y = resampleData(x, 44100);
    const after = y.channels[0].reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    // Linear-phase, DC-normalised kernels do not overshoot transients that are already
    // band-limited; allow the tiny kernel ripple margin.
    expect(after).toBeLessThan(before * 1.023);
  });

  it('builds a sane kernel table (finite, DC-normalised rows)', () => {
    const { table, phases, taps } = buildResampleTable(44100, 48000);
    expect(taps).toBe(RESAMPLE_TAPS);
    expect(phases).toBe(1024);
    for (let p = 0; p < phases; p++) {
      let sum = 0;
      for (let k = 0; k < taps; k++) {
        const v = table[p * taps + k];
        expect(Number.isFinite(v)).toBe(true);
        sum += v;
      }
      expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    }
  });
});
