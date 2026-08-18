import { describe, it, expect } from 'vitest';
import {
  measureLoudness,
  measureLUFS,
  designStage1,
  designStage2,
  kWeight,
} from '../src/dsp/loudness.js';
import { MockAudioBuffer, sine, stereoSine, dbfsAmplitude, concat } from './helpers.js';

const SR = 48000;

/**
 * Evaluate the magnitude response of a normalised biquad at a frequency.
 */
function biquadMagnitudeDb(c, freq, sampleRate) {
  const w = (2 * Math.PI * freq) / sampleRate;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);
  const numRe = c.b0 + c.b1 * cos1 + c.b2 * cos2;
  const numIm = -(c.b1 * sin1 + c.b2 * sin2);
  const denRe = 1 + c.a1 * cos1 + c.a2 * cos2;
  const denIm = -(c.a1 * sin1 + c.a2 * sin2);
  const num = Math.hypot(numRe, numIm);
  const den = Math.hypot(denRe, denIm);
  return 20 * Math.log10(num / den);
}

describe('BS.1770-4 K-weighting filter design', () => {
  it('reproduces the Table 1 stage-1 coefficients at 48 kHz', () => {
    const c = designStage1(48000);
    // ITU-R BS.1770-4, Table 1 (pre-filter), normalised to a0 = 1.
    expect(c.b0).toBeCloseTo(1.53512485958697, 6);
    expect(c.b1).toBeCloseTo(-2.69169618940638, 6);
    expect(c.b2).toBeCloseTo(1.19839281085285, 6);
    expect(c.a1).toBeCloseTo(-1.69065929318241, 6);
    expect(c.a2).toBeCloseTo(0.73248077421585, 6);
  });

  it('reproduces the Table 2 stage-2 RLB coefficients at 48 kHz', () => {
    const c = designStage2(48000);
    expect(c.b0).toBeCloseTo(1.0, 6);
    expect(c.b1).toBeCloseTo(-2.0, 6);
    expect(c.b2).toBeCloseTo(1.0, 6);
    expect(c.a1).toBeCloseTo(-1.99004745483398, 6);
    expect(c.a2).toBeCloseTo(0.99007225036621, 6);
  });

  it('has the ~+0.691 dB combined gain at 1 kHz that the LKFS offset cancels', () => {
    const total =
      biquadMagnitudeDb(designStage1(SR), 1000, SR) + biquadMagnitudeDb(designStage2(SR), 1000, SR);
    // The standard's -0.691 offset is a rounded constant; the filter's true
    // 1 kHz gain is ~0.6977 dB. Anything outside a hundredth of a dB of that
    // means the filter design itself has drifted.
    expect(total).toBeGreaterThan(0.69);
    expect(total).toBeLessThan(0.705);
  });

  it('stays correctly warped at other sample rates', () => {
    // The shelf midpoint and HF plateau must land in the same place regardless
    // of sample rate — this is what the old fixed-48 kHz approach got wrong.
    for (const sr of [44100, 88200, 96000, 192000]) {
      const total =
        biquadMagnitudeDb(designStage1(sr), 1000, sr) + biquadMagnitudeDb(designStage2(sr), 1000, sr);
      // Bilinear warping keeps the 1 kHz gain within a few hundredths of a dB
      // of the 48 kHz value across the whole range. Re-using the 48 kHz
      // coefficient table verbatim at 44.1 kHz instead misplaces the shelf and
      // the RLB corner, which is what the previous implementation effectively
      // did by hard-coding filter frequencies.
      expect(Math.abs(total - 0.6977)).toBeLessThan(0.03);
    }
  });

  it('applies both stages and attenuates infrasound', () => {
    const low = kWeight(sine(10, 1, SR, 1), SR);
    const mid = kWeight(sine(1000, 1, SR, 1), SR);
    const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    expect(20 * Math.log10(rms(low) / rms(mid))).toBeLessThan(-20);
  });
});

describe('EBU Tech 3341 integrated loudness compliance', () => {
  it('case 1: 1 kHz stereo sine at -23 dBFS reads -23.0 LUFS', () => {
    const r = measureLoudness(stereoSine(1000, 20, SR, dbfsAmplitude(-23)));
    expect(r.lufs).toBeGreaterThan(-23.1);
    expect(r.lufs).toBeLessThan(-22.9);
  });

  it('case 2: 1 kHz stereo sine at -33 dBFS reads -33.0 LUFS', () => {
    const r = measureLoudness(stereoSine(1000, 20, SR, dbfsAmplitude(-33)));
    expect(r.lufs).toBeCloseTo(-33.0, 1);
  });

  it('case 3: 10 s -36 / 60 s -23 / 10 s -36 dBFS integrates to -23.0 LUFS', () => {
    // The relative gate lands at ~-34.2 LUFS here, so the -36 dBFS tails are
    // excluded. This is the case that catches a wrong relative-gate offset.
    const quiet = sine(1000, 10, SR, dbfsAmplitude(-36));
    const loud = sine(1000, 60, SR, dbfsAmplitude(-23));
    const seq = concat(quiet, loud, quiet);
    const buf = MockAudioBuffer.fromChannels([seq, Float32Array.from(seq)], SR);
    expect(measureLoudness(buf).lufs).toBeCloseTo(-23.0, 1);
  });

  it('case 4: -72 dBFS tails are removed by the absolute gate', () => {
    const silent = sine(1000, 10, SR, dbfsAmplitude(-72));
    const quiet = sine(1000, 10, SR, dbfsAmplitude(-36));
    const loud = sine(1000, 60, SR, dbfsAmplitude(-23));
    const seq = concat(silent, quiet, loud, quiet, silent);
    const buf = MockAudioBuffer.fromChannels([seq, Float32Array.from(seq)], SR);
    expect(measureLoudness(buf).lufs).toBeCloseTo(-23.0, 1);
  });

  it('case 5: -26 / -20 / -26 dBFS integrates to -23.0 LUFS (power summation)', () => {
    // Nothing is gated out here; the result is purely a test that block
    // energies are averaged as power rather than in dB.
    const quiet = sine(1000, 20, SR, dbfsAmplitude(-26));
    const loud = sine(1000, 20, SR, dbfsAmplitude(-20));
    const seq = concat(quiet, loud, quiet);
    const buf = MockAudioBuffer.fromChannels([seq, Float32Array.from(seq)], SR);
    expect(measureLoudness(buf).lufs).toBeCloseTo(-23.0, 1);
  });

  it('measures the same loudness at 44.1 kHz as at 48 kHz', () => {
    const a = measureLoudness(stereoSine(1000, 10, 48000, dbfsAmplitude(-23))).lufs;
    const b = measureLoudness(stereoSine(1000, 10, 44100, dbfsAmplitude(-23))).lufs;
    expect(Math.abs(a - b)).toBeLessThan(0.1);
  });

  it('excludes the LFE channel from the measurement', () => {
    const tone = sine(1000, 5, SR, dbfsAmplitude(-23));
    const zero = new Float32Array(tone.length);
    const withoutLfe = MockAudioBuffer.fromChannels(
      [tone, Float32Array.from(tone), zero, zero, zero, zero],
      SR,
    );
    const withLoudLfe = MockAudioBuffer.fromChannels(
      [tone, Float32Array.from(tone), zero, sine(60, 5, SR, 0.9), zero, zero],
      SR,
    );
    expect(measureLoudness(withLoudLfe).lufs).toBeCloseTo(measureLoudness(withoutLfe).lufs, 6);
  });

  it('reports -70 from the compatibility shim for digital silence', () => {
    const silence = new MockAudioBuffer(2, SR * 2, SR);
    expect(measureLUFS(silence).lufs).toBe(-70);
  });
});

describe('EBU Tech 3342 loudness range compliance', () => {
  /** Build the two-level test sequence used by the Tech 3342 cases. */
  function twoLevel(dbA, dbB) {
    const a = sine(1000, 20, SR, dbfsAmplitude(dbA));
    const b = sine(1000, 20, SR, dbfsAmplitude(dbB));
    const seq = concat(a, b);
    return MockAudioBuffer.fromChannels([seq, Float32Array.from(seq)], SR);
  }

  it('case 1: -20 / -30 dBFS gives LRA of 10 LU', () => {
    expect(measureLoudness(twoLevel(-20, -30)).lra).toBeGreaterThan(9);
    expect(measureLoudness(twoLevel(-20, -30)).lra).toBeLessThan(11);
  });

  it('case 2: -20 / -15 dBFS gives LRA of 5 LU', () => {
    const lra = measureLoudness(twoLevel(-20, -15)).lra;
    expect(lra).toBeGreaterThan(4);
    expect(lra).toBeLessThan(6);
  });

  it('case 3: -40 / -20 dBFS gives LRA of 20 LU', () => {
    const lra = measureLoudness(twoLevel(-40, -20)).lra;
    expect(lra).toBeGreaterThan(19);
    expect(lra).toBeLessThan(21);
  });

  it('case 4: -50 / -35 dBFS gives LRA of 15 LU', () => {
    const lra = measureLoudness(twoLevel(-50, -35)).lra;
    expect(lra).toBeGreaterThan(14);
    expect(lra).toBeLessThan(16);
  });

  it('reports ~0 LRA for a constant-level tone', () => {
    expect(measureLoudness(stereoSine(1000, 30, SR, dbfsAmplitude(-23))).lra).toBeLessThan(1);
  });

  it('uses 3 s short-term blocks, so a 2 s file yields no range', () => {
    expect(measureLoudness(stereoSine(1000, 2, SR, dbfsAmplitude(-23))).lra).toBe(0);
  });
});
