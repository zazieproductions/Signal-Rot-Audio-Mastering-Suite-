import { describe, it, expect } from 'vitest';
import {
  applyDither,
  createDitherer,
  lsbFor,
  DITHER_MODES,
} from '../../src/audio/render/dither.js';
import { cloneAudioData } from '../../src/audio/dsp/audio-data.js';
import { make, sine } from '../helpers/signals.js';

const SR = 48000;
const quantise = (v, lsb) => Math.round(v / lsb) * lsb;

describe('lsbFor', () => {
  it('is the quantiser step for each integer depth and zero for float', () => {
    expect(lsbFor(16)).toBeCloseTo(1 / 32768, 12);
    expect(lsbFor(24)).toBeCloseTo(1 / 8388608, 15);
    expect(lsbFor(32)).toBe(0);
  });
});

describe('dither modes', () => {
  it('declares three modes with descriptions', () => {
    expect(Object.keys(DITHER_MODES)).toEqual(['none', 'tpdf', 'shaped']);
    for (const mode of Object.values(DITHER_MODES)) {
      expect(mode.label).toBeTruthy();
      expect(mode.description).toBeTruthy();
    }
  });
});

describe('createDitherer', () => {
  it('is a pass-through in "none" mode', () => {
    const d = createDitherer('none', lsbFor(16), 1);
    for (const v of [-1, -0.3, 0, 0.5, 1]) expect(d.process(v)).toBe(v);
  });

  it('adds at most ±1 LSB in TPDF mode', () => {
    const lsb = lsbFor(16);
    const d = createDitherer('tpdf', lsb, 42);
    for (let i = 0; i < 50000; i++) {
      const out = d.process(0.25);
      expect(Math.abs(out - 0.25)).toBeLessThanOrEqual(lsb + 1e-12);
    }
  });

  it('produces a triangular distribution, not a rectangular one', () => {
    const lsb = lsbFor(16);
    const d = createDitherer('tpdf', lsb, 7);
    let nearZero = 0;
    let nearEdge = 0;
    const n = 200000;
    for (let i = 0; i < n; i++) {
      const e = Math.abs(d.process(0) / lsb);
      if (e < 0.25) nearZero++;
      if (e > 0.75) nearEdge++;
    }
    // A triangular density puts far more mass near 0 than near ±1.
    expect(nearZero).toBeGreaterThan(nearEdge * 3);
  });

  it('is deterministic for a given seed', () => {
    const a = createDitherer('tpdf', lsbFor(16), 99);
    const b = createDitherer('tpdf', lsbFor(16), 99);
    for (let i = 0; i < 1000; i++) expect(a.process(0.1)).toBe(b.process(0.1));
  });

  it('shapes noise away from the low band', () => {
    // Feed a constant and compare the quantisation-error spectrum. Shaped dither should
    // put less error energy below 5 kHz than flat TPDF, and more near Nyquist.
    const n = 65536;
    const lsb = lsbFor(16);
    const errorFor = (mode) => {
      const d = createDitherer(mode, lsb, 5);
      const err = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const x = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR);
        const dithered = d.process(x);
        err[i] = quantise(dithered, lsb) - x;
      }
      return err;
    };

    const energyBelow = (err, cutoffHz) => {
      // Crude band energy via a Goertzel-style sum over a few bins.
      let sum = 0;
      for (let f = 100; f < cutoffHz; f += 250) {
        let re = 0;
        let im = 0;
        for (let i = 0; i < n; i++) {
          const w = (2 * Math.PI * f * i) / SR;
          re += err[i] * Math.cos(w);
          im -= err[i] * Math.sin(w);
        }
        sum += re * re + im * im;
      }
      return sum;
    };

    const flat = energyBelow(errorFor('tpdf'), 4000);
    const shaped = energyBelow(errorFor('shaped'), 4000);
    expect(shaped).toBeLessThan(flat);
  });

  it('selects the F-weighted 9th-order shaper at 44.1/48 kHz and 2nd-order elsewhere', () => {
    const lsb = lsbFor(16);
    expect(createDitherer('shaped', lsb, 1, 44100).shaper).toBe('f-weighted-9');
    expect(createDitherer('shaped', lsb, 1, 48000).shaper).toBe('f-weighted-9');
    expect(createDitherer('shaped', lsb, 1, 96000).shaper).toBe('second-order');
    expect(createDitherer('shaped', lsb, 1, 192000).shaper).toBe('second-order');
  });

  it('F-weighted shaping cuts error energy in the ear’s 2–6 kHz trough versus 2nd-order', () => {
    // Same construction as above: quantisation-error band energy on a 220 Hz tone at
    // 44.1 kHz, comparing the F-weighted shaper against a forced 2nd-order fallback
    // (obtained by lying about the rate) and flat TPDF.
    const sr = 44100;
    const n = 65536;
    const lsb = lsbFor(16);
    const errorFor = (mode, rate) => {
      const d = createDitherer(mode, lsb, 5, rate);
      const err = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const x = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr);
        const dithered = d.process(x);
        err[i] = quantise(dithered, lsb) - x;
      }
      return err;
    };
    const bandEnergy = (err, f0, f1) => {
      let sum = 0;
      for (let f = f0; f < f1; f += 400) {
        let re = 0;
        let im = 0;
        for (let i = 0; i < n; i++) {
          const w = (2 * Math.PI * f * i) / sr;
          re += err[i] * Math.cos(w);
          im -= err[i] * Math.sin(w);
        }
        sum += re * re + im * im;
      }
      return sum;
    };

    const trough = (err) => bandEnergy(err, 2000, 6000);
    const tpdf = errorFor('tpdf', sr);
    const fWeighted = errorFor('shaped', sr);
    const secondOrder = errorFor('shaped', 96000); // forces the fallback filter

    // Measured behaviour: ≈ −18 dB versus flat TPDF and ≈ −9 dB versus the old 2nd-order
    // shaper in the maximum-sensitivity band. Assert half of each margin.
    expect(trough(fWeighted)).toBeLessThan(trough(tpdf) / 8);
    expect(trough(fWeighted)).toBeLessThan(trough(secondOrder) / 2.8);
    // The displaced energy must land above 15 kHz, where hearing threshold soars.
    expect(bandEnergy(fWeighted, 15000, 20000)).toBeGreaterThan(bandEnergy(tpdf, 15000, 20000));
  });

  it('F-weighted shaping stays bounded — no error-feedback runaway', () => {
    const lsb = lsbFor(16);
    const d = createDitherer('shaped', lsb, 9, 44100);
    let maxErr = 0;
    for (let i = 0; i < 200000; i++) {
      const x = 0.95 * Math.sin((2 * Math.PI * 997 * i) / 44100);
      const out = d.process(x);
      maxErr = Math.max(maxErr, Math.abs(out - x));
    }
    // The shaped error excursion is a bounded multiple of the LSB, nowhere near audio scale.
    expect(maxErr).toBeLessThan(20 * lsb);
  });
});

describe('applyDither', () => {
  it('refuses to dither 32-bit float and says why', () => {
    const data = sine({ amplitude: 0.5, seconds: 0.1 });
    const before = cloneAudioData(data);
    const result = applyDither(data, 'tpdf', 32, 1);
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/float/);
    expect(data.channels[0][50]).toBe(before.channels[0][50]);
  });

  it('does nothing in "none" mode', () => {
    const data = sine({ amplitude: 0.5, seconds: 0.1 });
    const before = cloneAudioData(data);
    expect(applyDither(data, 'none', 16, 1).applied).toBe(false);
    expect(data.channels[0][50]).toBe(before.channels[0][50]);
  });

  it('modifies 16-bit output by less than one LSB per sample', () => {
    const data = sine({ amplitude: 0.5, seconds: 0.2 });
    const before = cloneAudioData(data);
    expect(applyDither(data, 'tpdf', 16, 3).applied).toBe(true);
    const lsb = lsbFor(16);
    for (let i = 0; i < data.length; i++) {
      expect(Math.abs(data.channels[0][i] - before.channels[0][i])).toBeLessThanOrEqual(lsb * 1.01);
    }
  });

  it('uses an independent stream per channel — dither must not sit dead centre', () => {
    const data = sine({ amplitude: 0, seconds: 0.5 });
    applyDither(data, 'tpdf', 16, 11);
    let identical = 0;
    for (let i = 0; i < data.length; i++) {
      if (data.channels[0][i] === data.channels[1][i]) identical++;
    }
    expect(identical / data.length).toBeLessThan(0.05);
  });

  it('is reproducible for a given seed and different for a different one', () => {
    const a = make(2, 4800, SR);
    const b = make(2, 4800, SR);
    const c = make(2, 4800, SR);
    applyDither(a, 'tpdf', 16, 1234);
    applyDither(b, 'tpdf', 16, 1234);
    applyDither(c, 'tpdf', 16, 5678);
    for (let i = 0; i < a.length; i++) expect(a.channels[0][i]).toBe(b.channels[0][i]);
    let differences = 0;
    for (let i = 0; i < a.length; i++) if (a.channels[0][i] !== c.channels[0][i]) differences++;
    expect(differences).toBeGreaterThan(a.length * 0.9);
  });

  it('decorrelates the quantisation error from the signal', () => {
    // The point of dither. Quantise a very quiet fade with and without dither and
    // correlate the error against the signal.
    const n = 32768;
    const lsb = lsbFor(16);
    const signal = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      signal[i] = (1 - i / n) * 2.5 * lsb * Math.sin((2 * Math.PI * 400 * i) / SR);
    }

    const correlate = (mode) => {
      const d = createDitherer(mode, lsb, 21);
      let sx = 0;
      let se = 0;
      let sxe = 0;
      let sxx = 0;
      let see = 0;
      for (let i = 0; i < n; i++) {
        const q = quantise(d.process(signal[i]), lsb);
        const e = q - signal[i];
        sx += signal[i];
        se += e;
        sxe += signal[i] * e;
        sxx += signal[i] * signal[i];
        see += e * e;
      }
      const cov = sxe / n - (sx / n) * (se / n);
      const sd = Math.sqrt((sxx / n - (sx / n) ** 2) * (see / n - (se / n) ** 2));
      return sd < 1e-30 ? 0 : Math.abs(cov / sd);
    };

    expect(correlate('tpdf')).toBeLessThan(correlate('none'));
  });
});
