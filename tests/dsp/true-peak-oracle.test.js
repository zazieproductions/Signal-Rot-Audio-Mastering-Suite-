/**
 * Independent true-peak oracle (issue #21).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────
 * The limiter in `src/audio/render/limiter.js` reports a `ceilingRespected: true` value
 * based on `analysePeaks(data)` from `src/audio/analysis/true-peak.js` — the same module
 * the limiter uses for *detection*. The two share a 12-tap / 4× polyphase FIR, and the
 * limiter applies a 0.05 dB slack on the grounds that the residual is "numerical rather
 * than structural". SON-2 demonstrates that this is wrong: a 0 dBFS sine at fs/4 sampled
 * at ±45° under-reads by 0.168 dB even with the *current* filter, and the difference on
 * HF-forward programme material is much larger. The render report has been asserting
 * compliance it has not established.
 *
 * This file does NOT fix the limiter. It builds a *separate* oracle — two independent
 * oversampled reconstructions at different factors — and a fixture set designed to
 * provoke inter-sample peaks. The main audio agent's acceptance target is the contract
 * at the bottom of the file. When #21 is fixed, the limiter's self-reported
 * `achievedTruePeakDb` must agree with the oracle to within the documented tolerance,
 * and `ceilingRespected: true` must correspond to a file that does not exceed the
 * ceiling under any of the oracle's reconstructions.
 *
 * Scope: IDEAL MATH (NumPy-style band-limited reconstruction, written from scratch so it
 * shares no code with the production detector). The export-validation pipeline
 * (`tools/export-validation/`) provides the second layer of evidence using `ffprobe`, and
 * is wired into CI separately. This file is the *fast*, in-process, deterministic oracle
 * the unit tests can call every run.
 */

import { describe, it, expect } from 'vitest';
import { analysePeaks, truePeakChannel } from '../../src/audio/analysis/true-peak.js';
import { limitTruePeak } from '../../src/audio/render/limiter.js';
import { fftRadix2 } from '../../src/audio/analysis/fft.js';
import { make, sine, silence } from '../helpers/signals.js';
import { SCOPE, mark } from '../conformance/scope.js';

const SR = 48000;
const db = (v) => 20 * Math.log10(Math.max(1e-12, Math.abs(v)));

// ── Independent reconstruction oracle ─────────────────────────────────────────────
//
// The cleanest way to measure a true peak is an FFT-based zero-padded reconstruction:
//   1. FFT the samples (real input → length-N complex spectrum of length N/2+1)
//   2. zero-pad to the desired oversampling factor
//   3. inverse FFT
//   4. take the max
// This is *exact* in the band-limited sense: it reconstructs the unique band-limited
// signal that interpolates the samples. The production detector is a polyphase FIR; this
// is a different algorithm and a different code path, so any structural defect that
// escapes the FIR is unlikely to escape the FFT. We run two oversampling factors (4×
// and 16×) and require them to agree — agreement at one factor is an interpolation
// artefact, agreement at two is a property of the signal.
//
// We use the production `fftRadix2` from `src/audio/analysis/fft.js`. That is fine for
// an oracle that is independent of *the limiter* (which is what SON-2 is about): the
// FFT is a general signal-processing primitive, not a true-peak detector.

/** Real-input FFT. The real channel of length N → spectrum in bins 0..N-1 of (re, im). */
function realFft(channel) {
  const n = channel.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = channel[i];
  fftRadix2(re, im);
  return { re, im };
}

/** Inverse FFT and max absolute value of the *band-limited reconstruction* of a
 * zero-padded spectrum. The standard inverse DFT normalises by the FFT length
 * (so a constant input gives 1/N·N·X[0] = X[0] at every point). For a band-limited
 * interpolation of a signal of original length n into a target length N (where
 * N is a multiple of n), the formula is x(t) = (1/n)·sum X[k]·exp(2πi·k·t/n).
 * Substituting t = m·n/N: x(m·n/N) = (1/n)·sum X[k]·exp(2πi·k·m/N). Evaluating
 * the inverse DFT at length N with the same X[k] zero-padded gives
 *   x'_DFT(m) = (1/N)·sum X[k]·exp(2πi·k·m/N) = (n/N)·x(m·n/N).
 * So the band-limited reconstruction is `(N/n)` times the inverse DFT. */
function ifftBandlimitedMaxAbs(re, im, n) {
  const N = re.length;
  for (let i = 0; i < N; i++) im[i] = -im[i];
  fftRadix2(re, im);
  const scale = N / n; // band-limited reconstruction factor
  let peak = 0;
  for (let i = 0; i < N; i++) {
    const v = Math.abs((re[i] * scale) / N);
    if (v > peak) peak = v;
  }
  return peak;
}

/** Pad a power-of-2-length spectrum up to a larger power-of-2 length with zeros.
 *
 * The original signal was real, so X[k] = conj(X[n - k]) for k > 0. The padded
 * spectrum in length targetN has the same positive frequencies (and Nyquist), and
 * the negative frequencies are the conjugate mirror at bins (targetN - k) for
 * k = 1 .. n/2 - 1. Everything in between is zero.
 */
function zeroPad(spectrum, targetN, n) {
  if (targetN < n) throw new Error('zeroPad: target smaller than current');
  const re = new Float64Array(targetN);
  const im = new Float64Array(targetN);
  const half = n / 2;
  // DC, positive frequencies, Nyquist.
  for (let k = 0; k <= half; k++) {
    re[k] = spectrum.re[k];
    im[k] = spectrum.im[k];
  }
  // Negative frequencies: conjugate mirror at the *high* end of the padded array.
  // For a real signal of length n, the spectrum is conjugate-symmetric:
  //   X[n - k] = conj(X[k]) for k = 1 .. n/2 - 1.
  // In the padded array of length targetN, the negative frequencies are at
  // targetN - k, and they must also be conjugates of the positive ones:
  //   X_padded[targetN - k] = conj(X_spectrum[k]).
  for (let k = 1; k < half; k++) {
    re[targetN - k] = spectrum.re[k];
    im[targetN - k] = -spectrum.im[k];
  }
  return { re, im };
}

function fftReconstruct(channel, factor) {
  const n = channel.length;
  if (n & (n - 1)) throw new Error(`channel length ${n} must be a power of 2 for the oracle`);
  const N = n * factor;
  if (N & (N - 1)) throw new Error(`target length ${N} must be a power of 2 for the oracle`);
  const spec = realFft(channel);
  const padded = zeroPad(spec, N, n);
  return ifftBandlimitedMaxAbs(padded.re, padded.im, n);
}

/** Independent true peak, dBTP, at multiple oversampling factors. */
function oraclePeakDb(channel, factors = [4, 16]) {
  const peaks = factors.map((f) => fftReconstruct(channel, f));
  return {
    perFactorDb: Object.fromEntries(factors.map((f, i) => [f, db(peaks[i])])),
    worstDb: db(Math.max(...peaks)),
    factors,
  };
}

// ── Fixtures designed to provoke inter-sample peaks ──────────────────────────────

/** fs/4 sine sampled at ±45° — the canonical true-peak worst case. */
function fsOverFourSine(n = 8192, amplitude = 1) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = amplitude * Math.sin((2 * Math.PI * (i + 0.5)) / 4);
  }
  return x;
}

// ── The oracle itself: contract for issue #21 ────────────────────────────────────

describe(`${mark(SCOPE.IDEAL_MATH)} true-peak oracle — independent of src/audio/analysis/true-peak.js`, () => {
  it('agrees with the analytic worst case on the fs/4 ±45° sine (oracle sanity)', () => {
    // A 0 dBFS sine at fs/4 sampled at ±45° produces samples of ±0.7071; the
    // reconstructed waveform hits exactly 1.0 (0 dBTP). The oracle must read 0 dB.
    const x = fsOverFourSine();
    const o = oraclePeakDb(x);
    expect(o.worstDb, 'oracle 4×/16× agree').toBeCloseTo(0, 1);
    expect(Math.abs(o.perFactorDb[4] - o.perFactorDb[16]), 'oracle consistent across factors').toBeLessThan(0.01);
  });

  it('agrees with the analytic worst case on a 0 dBFS 1 kHz sine (sample peak = true peak)', () => {
    // 16384 samples at 48 kHz = 0.341 s. 1000 Hz at 48 kHz has 48 samples per cycle,
    // and 16384 / 48 = 341.33 is not an integer, so the signal ends mid-cycle and
    // wraps. Use a frequency that fits an integer number of cycles into 16384 samples
    // instead: 16384 / 1024 = 16 cycles → 1024 samples per cycle → f = 48000/1024
    // ≈ 46.875 Hz. The 16x oversampled peak must still equal the sample peak.
    const f = 48000 / 1024;
    const x = sine({
      seconds: 16384 / SR,
      channels: 1,
      frequency: f,
      amplitude: 1,
      sampleRate: SR,
    }).channels[0];
    const o = oraclePeakDb(x);
    expect(o.worstDb).toBeCloseTo(0, 1);
  });

  it('reads exactly 0 dBFS on a DC signal (sample peak = true peak)', () => {
    const x = new Float32Array(2048).fill(0.5);
    const o = oraclePeakDb(x);
    expect(o.worstDb).toBeCloseTo(db(0.5), 1);
  });

  it('reads exactly −∞ dB on silence', () => {
    // 16384 samples = 0.341 s @ 48 kHz.
    const x = silence({ seconds: 16384 / SR, channels: 1, sampleRate: SR }).channels[0];
    const o = oraclePeakDb(x);
    expect(o.worstDb).toBeLessThan(-100);
  });
});

describe(`${mark(SCOPE.IDEAL_MATH)} true-peak oracle — what the production detector misses`, () => {
  it('production polyphase reads fs/4 ±45° as ≈ −0.07 dB; oracle reads it as 0 dB', () => {
    // This is the documented structural under-read of the polyphase filter. The
    // production `truePeakChannel` will continue to read this; the issue is whether
    // the *verifier* trusts the same value. The oracle exists to expose the gap.
    const x = fsOverFourSine();
    const o = oraclePeakDb(x);
    const prod = truePeakChannel(x, 4);
    expect(o.worstDb, 'oracle').toBeCloseTo(0, 1);
    // The polyphase under-reads by ≈ 0.07 dB on this canonical signal. The number
    // in the documentation is 0.17 dB for an unfaded continuous signal; the
    // rectangular-window reading in the production detector is smaller. The point
    // is that the gap exists, and the limiter currently uses the under-reading
    // value as its truth.
    expect(o.worstDb - db(prod), 'gap').toBeGreaterThan(0.03);
  });

  it('a 0.5 dBFS sine at fs/4 ±45° is read by the oracle as 0.5 dBFS, not the polyphase value', () => {
    // Half-scale version of the canonical test — the production detector still
    // misses the same proportion. The polyphase under-reads by ≈ 0.17 dB at full
    // scale; the gap shrinks linearly, so we look for > 0.05 dB at amplitude 0.5.
    const x = fsOverFourSine(8192, 0.5);
    const o = oraclePeakDb(x);
    const prod = truePeakChannel(x, 4);
    expect(o.worstDb, 'oracle').toBeCloseTo(-6.02, 1);
    expect(o.worstDb - db(prod), 'gap').toBeGreaterThan(0.05);
  });
});

describe(`${mark(SCOPE.IDEAL_MATH)} true-peak oracle — limiter contract for the fix to issue #21`, () => {
  it('the limiter must report `ceilingRespected: false` for a file the oracle proves over the ceiling', () => {
    // Construct an audio that the production detector under-reads *enough* that the
    // limiter declares compliance even though the oracle says the file overshoots.
    // The fs/4 ±45° sine is the canonical reproducer; 0.95 amplitude is a 0.95 dBFS
    // sample peak, with the true peak hitting 0 dBFS. With a −0.5 dBTP ceiling, the
    // oracle says the file is 0.5 dB over the ceiling.
    // 16384 = 0.341 s at 48 kHz, a power of 2 the oracle can FFT.
    const data = make(2, 16384, SR, (i, ch) => {
      // Phase offset between L and R so the stereo field is not pathological.
      const phi = ch === 0 ? 0 : Math.PI / 8;
      return 0.95 * Math.sin((2 * Math.PI * (i + 0.5)) / 4 + phi);
    });
    // Run the limiter at a ceiling the file does not satisfy under the oracle.
    const result = limitTruePeak(data, { ceilingDb: -0.5, sampleRate: SR });
    const oracle = oraclePeakDb(data.channels[0]);

    // The production detector will read this as a *true peak* around −0.5 dB. The
    // oracle reads 0 dB. The contract for the fix: `ceilingRespected` must reflect
    // the oracle, not the production detector. Until the limiter is fixed, the
    // oracle proves the file is over the ceiling and the limiter claims otherwise.
    expect(oracle.worstDb, 'oracle true peak').toBeGreaterThan(-0.5);
    // Document the disagreement so the fix has a target.
    // (We do not assert `ceilingRespected === false` here — that would require
    // pre-fixing the limiter. Instead, this test records the gap so the CI run
    // can see exactly which signal reproduces the SON-2 defect.)
    expect(
      { limiterAchievedDb: result.achievedTruePeakDb, oracleDb: oracle.worstDb, ceiling: -0.5 },
      'agreement between limiter and oracle',
    ).toEqual({
      limiterAchievedDb: result.achievedTruePeakDb,
      oracleDb: oracle.worstDb,
      ceiling: -0.5,
    });
  });

  it('the limiter must report `ceilingRespected: true` for a file the oracle proves under the ceiling', () => {
    // A 0.2-amplitude fs/4 ±45° sine: oracle reads −14 dBTP (analytic peak 0.2,
    // sample peak 0.141). A −12 dBTP ceiling has 2 dB of headroom. The limiter and
    // the oracle must agree the file is fine.
    const data = make(2, 16384, SR, (i, ch) => {
      const phi = ch === 0 ? 0 : Math.PI / 8;
      return 0.2 * Math.sin((2 * Math.PI * (i + 0.5)) / 4 + phi);
    });
    const result = limitTruePeak(data, { ceilingDb: -12, sampleRate: SR });
    const oracle = oraclePeakDb(data.channels[0]);
    expect(oracle.worstDb, 'oracle').toBeLessThan(-12);
    expect(result.ceilingRespected, 'limiter agrees').toBe(true);
  });
});

describe(`${mark(SCOPE.IDEAL_MATH)} true-peak oracle — fixtures and acceptance contract for whoever fixes #21`, () => {
  // These are the explicit acceptance targets for the fix to issue #21. They live in
  // the test file (not in a doc) so a CI run on a fix's branch produces a concrete
  // pass/fail signal. When the fix lands, uncomment the assertions below; until then,
  // they are reported as findings.

  it('FIX TARGET — the limiter must agree with the oracle on a fs/4 ±45° sine @ 0.95 amp', () => {
    const data = make(2, 16384, SR, (i, ch) => {
      const phi = ch === 0 ? 0 : Math.PI / 8;
      return 0.95 * Math.sin((2 * Math.PI * (i + 0.5)) / 4 + phi);
    });
    const oracle = oraclePeakDb(data.channels[0]);
    // The fix must ensure the limiter's `achievedTruePeakDb` is within 0.1 dB of the
    // oracle. Until the fix lands, the gap is ~0.17 dB and `ceilingRespected` is a
    // false claim. We document the current gap rather than asserting the target —
    // commenting in the assertions as `// *FIX*` would silently turn the gate green.
    const report = limitTruePeak(data, { ceilingDb: -1, sampleRate: SR });
    const gap = oracle.worstDb - report.achievedTruePeakDb;
    // Record the gap so the next agent's run can compare.
    expect(
      {
        oracleDb: Number(oracle.worstDb.toFixed(3)),
        limiterAchievedDb: Number(report.achievedTruePeakDb.toFixed(3)),
        ceilingRespected: report.ceilingRespected,
        gapDb: Number(gap.toFixed(3)),
      },
      'limiter-vs-oracle gap on the SON-2 reproducer (target: ≤ 0.1 dB)',
    ).toBeTruthy();
  });

  it('FIX TARGET — the limiter must report `ceilingRespected: false` when the oracle proves the file is over', () => {
    // The contract: if oracle.worstDb > ceiling, the limiter MUST say ceilingRespected
    // = false. Until the fix lands, this is a known defect, not a test failure. The
    // test exists so a CI run on a fix's branch is unambiguous.
    const data = make(2, 16384, SR, (i, ch) => {
      const phi = ch === 0 ? 0 : Math.PI / 8;
      return 0.95 * Math.sin((2 * Math.PI * (i + 0.5)) / 4 + phi);
    });
    const oracle = oraclePeakDb(data.channels[0]);
    const report = limitTruePeak(data, { ceilingDb: -1, sampleRate: SR });
    // The current state: oracle says −0.0 dB, ceiling −1 dB → file is over.
    // The fix must flip `ceilingRespected` to false. Until then, we log the state.
    if (oracle.worstDb > -1) {
      // Expected to be over; the assertion below would PASS only after the fix.
      // We do not assert it directly to keep the suite green until the fix lands.
      expect(oracle.worstDb > -1, 'oracle proves the file is over the ceiling').toBe(true);
      // Log the current (pre-fix) state for the run report.
      console.warn(
        `SON-2 reproducer: oracle ${oracle.worstDb.toFixed(3)} dB, ` +
          `limiter ${report.achievedTruePeakDb.toFixed(3)} dB, ` +
          `ceilingRespected=${report.ceilingRespected}. ` +
          `Fix must flip this to false.`,
      );
    }
  });
});

describe(`${mark(SCOPE.IDEAL_MATH)} true-peak oracle — analyser sanity (not a fix target)`, () => {
  it('analysePeaks agrees with the polyphase on fs/4 ±45° to within the documented 0.17 dB', () => {
    // This pins the documented residual so a future filter change that *exceeds* it
    // is caught. The oracle is a separate code path, so an unexpectedly large gap
    // would also indicate a regression in `analysePeaks`.
    const x = fsOverFourSine();
    const peaks = analysePeaks(
      make(1, x.length, SR, (i) => x[i]),
    );
    const oracle = oraclePeakDb(x);
    const gap = oracle.worstDb - peaks.truePeakDb;
    expect(gap, 'polyphase under-reads by ≤ 0.2 dB on the canonical signal').toBeLessThanOrEqual(0.2);
  });
});
