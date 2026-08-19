import { describe, it, expect } from 'vitest';
import { shapeTransients } from '../../src/audio/render/transient-shaper.js';
import { cloneAudioData, samplePeak } from '../../src/audio/dsp/audio-data.js';
import { crestFactorDb } from '../../src/audio/analysis/rms.js';
import { make, sine } from '../helpers/signals.js';

const SR = 48000;

/** A percussive train: sharp attacks with decaying tails. */
function percussive({ amplitude = 0.6, seconds = 2, channels = 2 } = {}) {
  const n = Math.round(seconds * SR);
  const data = make(channels, n, SR);
  const spacing = Math.round(SR / 4);
  for (let start = 0; start + 4000 < n; start += spacing) {
    for (let k = 0; k < 4000; k++) {
      const env = Math.exp(-k / 600);
      const v = amplitude * env * Math.sin((2 * Math.PI * 220 * k) / SR);
      for (const ch of data.channels) ch[start + k] += v;
    }
  }
  return data;
}

describe('shapeTransients', () => {
  it('does nothing when both controls are zero', () => {
    const data = percussive();
    const before = cloneAudioData(data);
    const result = shapeTransients(data, { attack: 0, sustain: 0 });
    expect(result.applied).toBe(false);
    for (let i = 0; i < data.length; i += 313) {
      expect(data.channels[0][i]).toBe(before.channels[0][i]);
    }
  });

  it('increases crest factor when attack is positive', () => {
    const data = percussive();
    const before = crestFactorDb(data);
    shapeTransients(data, { attack: 80, sustain: 0 });
    expect(crestFactorDb(data)).toBeGreaterThan(before + 0.3);
  });

  it('reduces the sample peak when attack is negative', () => {
    // Crest factor is the wrong metric for negative attack: the two envelopes diverge for
    // the whole onset region (~40 ms), so attenuating it lowers RMS more than it lowers
    // peak. Peak reduction is the user-facing promise and is what is asserted.
    const data = percussive();
    const before = samplePeak(data);
    shapeTransients(data, { attack: -80, sustain: 0 });
    expect(samplePeak(data)).toBeLessThan(before);
  });

  it('increases the sample peak when attack is positive', () => {
    const data = percussive();
    const before = samplePeak(data);
    shapeTransients(data, { attack: 80, sustain: 0 });
    expect(samplePeak(data)).toBeGreaterThan(before * 1.2);
  });

  /**
   * The pre-7.0 sustain term was driven by the *absolute* envelope level, so the same knob
   * did different things to a quiet mix and a loud one. Both terms are now ratios of the
   * fast and slow envelopes, which are scale-invariant.
   */
  it('is level-independent: the gain trajectory is identical 20 dB down', () => {
    const loud = percussive({ amplitude: 0.6 });
    const quiet = percussive({ amplitude: 0.06 });
    const loudBefore = cloneAudioData(loud);
    const quietBefore = cloneAudioData(quiet);

    shapeTransients(loud, { attack: 60, sustain: -40 });
    shapeTransients(quiet, { attack: 60, sustain: -40 });

    let maxRatioError = 0;
    for (let i = 2000; i < loud.length; i += 97) {
      if (Math.abs(loudBefore.channels[0][i]) < 1e-5) continue;
      const gainLoud = loud.channels[0][i] / loudBefore.channels[0][i];
      const gainQuiet = quiet.channels[0][i] / quietBefore.channels[0][i];
      maxRatioError = Math.max(maxRatioError, Math.abs(gainLoud - gainQuiet));
    }
    expect(maxRatioError).toBeLessThan(0.02);
  });

  it('applies one gain to all channels — the stereo image cannot move', () => {
    const data = percussive({ channels: 2 });
    for (let i = 0; i < data.length; i++) data.channels[1][i] *= 0.4;
    const before = cloneAudioData(data);
    shapeTransients(data, { attack: 70, sustain: 30 });
    for (let i = 1000; i < data.length; i += 211) {
      if (Math.abs(before.channels[0][i]) < 1e-5) continue;
      const gainL = data.channels[0][i] / before.channels[0][i];
      const gainR = data.channels[1][i] / before.channels[1][i];
      expect(gainR).toBeCloseTo(gainL, 5);
    }
  });

  it('bounds the gain it can apply', () => {
    const data = percussive();
    const before = cloneAudioData(data);
    const result = shapeTransients(data, { attack: 100, sustain: 100 });
    expect(result.maxBoostDb).toBeLessThanOrEqual(12.0001);
    expect(result.maxCutDb).toBeGreaterThanOrEqual(-12.0001);
    for (let i = 0; i < data.length; i += 401) {
      if (Math.abs(before.channels[0][i]) < 1e-6) continue;
      const gain = Math.abs(data.channels[0][i] / before.channels[0][i]);
      expect(gain).toBeLessThan(4.1);
    }
  });

  it('barely touches a steady tone — there are no transients to shape', () => {
    // 2 kHz: the 1 ms fast follower sees two full cycles per time constant, so it does
    // not ripple. At 500 Hz it *would* ripple slightly, which is a real property of a
    // 1 ms detector and not a defect — see docs/DSP-SIGNAL-FLOW.md.
    const data = sine({ amplitude: 0.4, frequency: 2000, seconds: 2 });
    const before = cloneAudioData(data);
    shapeTransients(data, { attack: 100, sustain: 0 });
    // Skip the first 250 ms: the onset of the tone *is* a transient.
    let maxDelta = 0;
    for (let i = SR / 4; i < data.length; i += 53) {
      maxDelta = Math.max(maxDelta, Math.abs(data.channels[0][i] - before.channels[0][i]));
    }
    expect(maxDelta).toBeLessThan(0.02);
  });

  it('produces no NaN or infinities on silence', () => {
    const data = make(2, SR, SR);
    shapeTransients(data, { attack: 100, sustain: -100 });
    for (const ch of data.channels) for (const v of ch) expect(Number.isFinite(v)).toBe(true);
  });
});
