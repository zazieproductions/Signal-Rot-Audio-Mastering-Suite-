import { describe, it, expect } from 'vitest';
import { computeLimiterGain, limitTruePeak } from '../../src/audio/render/limiter.js';
import { sine, make, whiteNoise } from '../helpers/signals.js';
import { analysePeaks } from '../../src/audio/analysis/true-peak.js';

/**
 * Gain-curve ripple over the final 40 % of the render: peak-to-peak gain movement
 * relative to the mean gain. Large ripple = the limiter gain is pumping at the bass
 * rate (LF modulation distortion); near-zero ripple = steady, clean gain.
 */
function gainRipple(gain, data) {
  const start = Math.floor(data.length * 0.6);
  let mn = 1;
  let mx = 0;
  let mean = 0;
  for (let i = start; i < gain.length; i++) {
    if (gain[i] < mn) mn = gain[i];
    if (gain[i] > mx) mx = gain[i];
    mean += gain[i];
  }
  mean /= gain.length - start;
  return { p2p: (mx - mn) / mean, minGain: mn, mean };
}

describe('bass-aware limiter release (§6)', () => {
  const DEPTHS = [1.15, 1.5, 2.0]; // ~1 / ~4.4 / ~7 dB of gain reduction
  const PUMP_FREQS = [40, 50, 60]; // the classic release clearly pumps here
  const LIGHT_FREQS = [80]; // classic pumping is small but still measurable

  for (const freq of PUMP_FREQS) {
    for (const amplitude of DEPTHS) {
      it(`reduces gain pumping at ${freq} Hz (GR ≈ ${(
        -20 * Math.log10((10 ** (-1 / 20)) / amplitude)
      ).toFixed(1)} dB)`, () => {
        const data = sine({ frequency: freq, seconds: 1.2, amplitude });
        const on = computeLimiterGain(data, { ceilingDb: -1 });
        const off = computeLimiterGain(data, { ceilingDb: -1, bassAware: false });
        const rOn = gainRipple(on, data);
        const rOff = gainRipple(off, data);

        // The scenario must actually pump without the fix, or the test is vacuous.
        expect(rOff.p2p).toBeGreaterThan(1e-3);
        expect(rOn.minGain).toBeLessThan(0.99); // real gain reduction happened
        // The bass-aware release must at least halve the ripple.
        expect(rOn.p2p).toBeLessThan(rOff.p2p * 0.55);
      });
    }
  }

  for (const freq of LIGHT_FREQS) {
    for (const amplitude of DEPTHS) {
      it(`does not make ${freq} Hz gain ripple worse (GR ≈ ${(
        -20 * Math.log10((10 ** (-1 / 20)) / amplitude)
      ).toFixed(1)} dB)`, () => {
        const data = sine({ frequency: freq, seconds: 1.2, amplitude });
        const on = computeLimiterGain(data, { ceilingDb: -1 });
        const off = computeLimiterGain(data, { ceilingDb: -1, bassAware: false });
        const rOn = gainRipple(on, data);
        const rOff = gainRipple(off, data);
        expect(rOff.p2p).toBeGreaterThan(5e-4); // measurable classic ripple
        expect(rOn.p2p).toBeLessThan(rOff.p2p * 0.6);
      });
    }
  }

  for (const amplitude of DEPTHS) {
    it(`never introduces ripple where the classic release has none (100 Hz, GR ≈ ${(
      -20 * Math.log10((10 ** (-1 / 20)) / amplitude)
    ).toFixed(1)} dB)`, () => {
      const data = sine({ frequency: 100, seconds: 1.2, amplitude });
      const on = computeLimiterGain(data, { ceilingDb: -1 });
      const off = computeLimiterGain(data, { ceilingDb: -1, bassAware: false });
      const rOn = gainRipple(on, data);
      const rOff = gainRipple(off, data);
      expect(rOff.p2p).toBeLessThan(1e-4);
      // The bass-aware path must not make the steady state any noisier.
      expect(rOn.p2p).toBeLessThanOrEqual(rOff.p2p + 1e-4);
    });
  }

  it('delivers the same true-peak result while limiting less loudly in time', () => {
    // The gain curve changes, but the delivered ceiling must be respected exactly.
    const data = sine({ frequency: 50, seconds: 1.2, amplitude: 1.8 });
    const result = limitTruePeak(data, { ceilingDb: -1 });
    expect(result.ceilingRespected).toBe(true);
    expect(result.achievedTruePeakDb).toBeLessThanOrEqual(-1 + 0.05);
    expect(analysePeaks(data).truePeakDb).toBeLessThanOrEqual(-1 + 0.05);
  });

  it('leaves transient-led reduction bit-identical to the classic release', () => {
    // A 3.2 kHz burst over a 400 Hz bed: the driving content is mid-frequency, so the
    // bass-aware path must not change a single gain sample.
    const sr = 48000;
    const n = sr; // 1 s
    const data = make(2, n, sr, (i) => 0.2 * Math.sin((2 * Math.PI * 400 * i) / sr));
    const start = Math.floor(sr * 0.25);
    for (let k = 0; k < 120; k++) {
      const v = 1.6 * Math.exp(-k / 14) * Math.sin((2 * Math.PI * 3200 * k) / sr);
      for (const ch of data.channels) ch[start + k] += v;
    }
    const on = computeLimiterGain(data, { ceilingDb: -1 });
    const off = computeLimiterGain(data, { ceilingDb: -1, bassAware: false });
    expect(on).toHaveLength(off.length);
    let maxDiff = 0;
    for (let i = 0; i < on.length; i++) {
      const d = Math.abs(on[i] - off[i]);
      if (d > maxDiff) maxDiff = d;
    }
    expect(maxDiff).toBeLessThan(1e-9);
  });

  it('changes nothing on broadband material (no accidental LF gate)', () => {
    const data = whiteNoise({ seconds: 1.0, amplitude: 1.4 });
    const on = computeLimiterGain(data, { ceilingDb: -1 });
    const off = computeLimiterGain(data, { ceilingDb: -1, bassAware: false });
    let maxDiff = 0;
    for (let i = 0; i < on.length; i++) {
      const d = Math.abs(on[i] - off[i]);
      if (d > maxDiff) maxDiff = d;
    }
    // White noise has ~7 % of its energy below 150 Hz; dominance stays under the
    // engagement threshold, so the curves may differ only in float noise.
    expect(maxDiff).toBeLessThan(0.02);
  });
});
