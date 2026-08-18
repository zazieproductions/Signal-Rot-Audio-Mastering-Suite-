import { describe, it, expect } from 'vitest';
import {
  truePeakChannel,
  truePeakDb,
  truePeakLimit,
  forwardSlidingMin,
} from '../src/dsp/true-peak.js';
import { MockAudioBuffer, sine, noise, dbfsAmplitude, fade } from './helpers.js';

const SR = 48000;

/** The original Catmull-Rom estimator, kept to document what was fixed. */
function legacyTruePeak(d) {
  let mx = 0;
  for (let i = 1; i < d.length - 2; i++) {
    const p0 = d[i - 1],
      p1 = d[i],
      p2 = d[i + 1],
      p3 = d[i + 2];
    for (let f = 0; f < 4; f++) {
      const t = f / 4,
        t2 = t * t,
        t3 = t2 * t;
      const v =
        0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
      const a = Math.abs(v);
      if (a > mx) mx = a;
    }
  }
  return mx;
}

describe('forwardSlidingMin', () => {
  it('matches a brute-force forward minimum', () => {
    const v = Float32Array.from({ length: 500 }, (_, i) => Math.sin(i * 0.37) * 0.5 + 0.5);
    for (const w of [1, 7, 64, 499, 1000]) {
      const fast = forwardSlidingMin(v, w);
      for (let i = 0; i < v.length; i++) {
        let expected = v[i];
        for (let k = i + 1; k <= Math.min(v.length - 1, i + w); k++) {
          if (v[k] < expected) expected = v[k];
        }
        expect(fast[i]).toBeCloseTo(expected, 6);
      }
    }
  });

  it('handles an empty input', () => {
    expect(forwardSlidingMin(new Float32Array(0), 4).length).toBe(0);
  });
});

describe('true-peak measurement (BS.1770-4 Annex 2)', () => {
  it('reads a steady DC level at its true amplitude', () => {
    const dc = fade(new Float32Array(4000).fill(0.5), 500);
    expect(20 * Math.log10(truePeakChannel(dc))).toBeCloseTo(20 * Math.log10(0.5), 1);
  });

  it('accounts for the step discontinuity at a hard file boundary', () => {
    // Outside the buffer is digital silence, so a file that begins at full
    // level really does contain a step. The reconstruction overshoot is
    // physical, not an artefact, and the limiter must see it.
    const abrupt = new Float32Array(4000).fill(0.5);
    expect(truePeakChannel(abrupt)).toBeGreaterThan(0.5);
  });

  it('reads a low-frequency sine at its sample peak', () => {
    const s = sine(100, 1, SR, 0.5);
    expect(20 * Math.log10(truePeakChannel(s))).toBeCloseTo(-6.02, 1);
  });

  it('detects inter-sample peaks the sample peak misses', () => {
    // A sine at exactly SR/4 sampled on zero crossings has a sample peak far
    // below its true analogue peak.
    const n = 4096;
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = 0.9 * Math.sin((2 * Math.PI * (SR / 4) * i) / SR + Math.PI / 4);
    let samplePeak = 0;
    for (const v of s) samplePeak = Math.max(samplePeak, Math.abs(v));
    const tp = truePeakChannel(s);
    expect(tp).toBeGreaterThan(samplePeak);
  });

  it('keeps error bounded across the audio band', () => {
    // A sine's true peak is exactly its amplitude. Across 1-20 kHz the
    // polyphase filter should stay within a few tenths of a dB.
    for (let f = 1000; f <= 20000; f += 1000) {
      const s = fade(sine(f, 0.2, SR, dbfsAmplitude(-1)));
      const measured = 20 * Math.log10(truePeakChannel(s));
      expect(Math.abs(measured + 1)).toBeLessThan(0.35);
    }
  });

  it('has no blind spots where the legacy cubic estimator had them', () => {
    // Catmull-Rom is accurate for most sines but collapses at frequencies
    // where sampling is degenerate — 16 kHz at 48 kHz is exactly 3 samples
    // per cycle, and the legacy estimator under-reads by over a dB there.
    // Under-reading true peak is the dangerous direction: it silently ships
    // masters that clip downstream encoders.
    const s = fade(sine(16000, 0.2, SR, dbfsAmplitude(-1)));
    const legacy = 20 * Math.log10(legacyTruePeak(s));
    const proper = 20 * Math.log10(truePeakChannel(s));
    expect(legacy).toBeLessThan(-2.0); // legacy reads ~-2.25 dBTP
    expect(Math.abs(proper + 1)).toBeLessThan(0.35); // polyphase stays honest
    expect(proper - legacy).toBeGreaterThan(0.9);
  });

  it('reports -Infinity dBTP for digital silence', () => {
    expect(truePeakDb(new MockAudioBuffer(2, 1000, SR))).toBe(-Infinity);
  });
});

describe('true-peak limiter', () => {
  /** Build a stereo buffer from one channel of content. */
  function buf(ch) {
    return MockAudioBuffer.fromChannels([ch, Float32Array.from(ch)], SR);
  }

  it('brings a hot signal under the requested ceiling', () => {
    const b = buf(noise(3, SR, 0.98, 3));
    truePeakLimit(b, -1.0);
    expect(truePeakDb(b)).toBeLessThanOrEqual(-1.0 + 0.05);
  });

  it('honours a variety of ceilings', () => {
    for (const ceiling of [-0.1, -0.3, -1.0, -2.0, -6.0]) {
      const b = buf(noise(2, SR, 0.99, 11));
      truePeakLimit(b, ceiling);
      expect(truePeakDb(b)).toBeLessThanOrEqual(ceiling + 0.05);
    }
  });

  it('tames isolated inter-sample overs on transient material', () => {
    const n = SR * 2;
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = 0.05 * Math.sin((2 * Math.PI * 220 * i) / SR);
    // Sparse full-scale clicks.
    for (let i = 5000; i < n; i += 9000) {
      ch[i] = 0.999;
      ch[i + 1] = -0.999;
    }
    const b = buf(ch);
    truePeakLimit(b, -1.0);
    expect(truePeakDb(b)).toBeLessThanOrEqual(-1.0 + 0.05);
  });

  it('leaves quiet material essentially untouched', () => {
    const src = noise(1, SR, 0.05, 5);
    const b = buf(src);
    const { maxGainReductionDb } = truePeakLimit(b, -1.0);
    expect(maxGainReductionDb).toBe(0);
    for (let i = 0; i < src.length; i++) expect(b.getChannelData(0)[i]).toBe(src[i]);
  });

  it('applies identical gain to every channel, preserving the stereo image', () => {
    const l = noise(1, SR, 0.9, 21);
    const r = noise(1, SR, 0.9, 22);
    const b = MockAudioBuffer.fromChannels([l, r], SR);
    truePeakLimit(b, -1.0);
    // The ratio out/in must be the same in both channels at every sample where
    // the input is non-trivial; any divergence means the image was skewed.
    for (let i = 0; i < l.length; i += 97) {
      if (Math.abs(l[i]) < 1e-4 || Math.abs(r[i]) < 1e-4) continue;
      const gl = b.getChannelData(0)[i] / l[i];
      const gr = b.getChannelData(1)[i] / r[i];
      expect(gl).toBeCloseTo(gr, 5);
    }
  });

  it('produces a smooth gain envelope rather than stepping', () => {
    // Reconstruct the applied gain and check it has no large discontinuities,
    // which is what the previous instant-attack implementation introduced.
    const src = noise(2, SR, 0.95, 31);
    const b = buf(src);
    truePeakLimit(b, -3.0);
    const out = b.getChannelData(0);
    let prev = 1;
    let maxJump = 0;
    for (let i = 0; i < src.length; i++) {
      if (Math.abs(src[i]) < 1e-3) continue;
      const g = out[i] / src[i];
      maxJump = Math.max(maxJump, Math.abs(g - prev));
      prev = g;
    }
    expect(maxJump).toBeLessThan(0.25);
  });

  it('returns the peak gain reduction actually applied', () => {
    const b = buf(noise(1, SR, 0.99, 41));
    const { maxGainReductionDb } = truePeakLimit(b, -6.0);
    expect(maxGainReductionDb).toBeLessThan(0);
    expect(maxGainReductionDb).toBeGreaterThan(-20);
  });

  it('handles an empty buffer without throwing', () => {
    expect(() => truePeakLimit(new MockAudioBuffer(2, 0, SR), -1)).not.toThrow();
  });

  it('converges in a small number of passes', () => {
    // Convergence, not raw speed, is what keeps the export affordable: without
    // a tolerance the corrective passes chase vanishing overshoots and always
    // run to the iteration cap.
    const { passes } = truePeakLimit(buf(noise(20, SR, 0.9, 51)), -1.0);
    expect(passes).toBeGreaterThan(0);
    expect(passes).toBeLessThanOrEqual(3);
  });

  it.skipIf(process.env.SIGNALROT_SKIP_PERF)(
    'processes 60 s of stereo within the export budget',
    () => {
      // Skipped under coverage: v8 instrumentation inflates tight numeric
      // loops by ~40x and the number stops meaning anything.
      const b = buf(noise(60, SR, 0.9, 51));
      const t0 = performance.now();
      truePeakLimit(b, -1.0);
      expect(performance.now() - t0).toBeLessThan(20000);
    },
  );
});
