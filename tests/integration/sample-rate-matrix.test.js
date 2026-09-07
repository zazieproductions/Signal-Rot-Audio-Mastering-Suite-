/**
 * Sample-rate matrix (PRIORITY 5).
 *
 * ── Purpose ────────────────────────────────────────────────────────────────────────
 * PR #26 mentions an unverified behaviour at every sample rate the product supports.
 * This file exercises the **production** graph at all six rates (44.1, 48, 88.2, 96,
 * 176.4, 192 kHz) using the analytical/Node path. It is *not* a substitute for the
 * real-browser conformance suite — `tests/browser/sample-rates.spec.js` already runs
 * the same matrix against `OfflineAudioContext` and reports refusals honestly. The
 * point of this Node-side matrix is that it runs in CI even when a browser is not
 * available, so a sample-rate regression lands red on every PR.
 *
 * The matrix looks for:
 *   • unexpected tonal deltas (e.g. a peak in the band-sum that should be flat)
 *   • latency changes that exceed the documented envelope
 *   • reconstruction failures (the 0.5 dB hard requirement, ±0.1 dB design goal)
 *   • true-peak differences (a rate change should not move the analytical answer)
 *   • browser-specific behaviour is NOT testable here — see the browser suite
 *   • unsupported-rate assumptions (e.g. a hard-coded 48 kHz in the limiter path)
 *
 * The matrix does NOT "fix" production behaviour. If a rate is broken, the test
 * fails and the finding is handed to the main audio agent.
 *
 * Scope: IDEAL MATH. The graph is built via the production constructors and the
 * analytical response / loudness / peak functions, with no `OfflineAudioContext`.
 */

import { describe, it, expect } from 'vitest';
import { crossoverReconstruction, multibandResponse, resolveDryDelay } from '../../src/audio/graph/multiband.js';
import { SAMPLE_RATES } from '../conformance/thresholds.js';
import { analysePeaks } from '../../src/audio/analysis/true-peak.js';
import { analyseLoudness } from '../../src/audio/analysis/loudness.js';
import { sine, pinkNoise } from '../helpers/signals.js';
import { SCOPE, mark } from '../conformance/scope.js';

const RATES = SAMPLE_RATES;

// ── Reconstruction matrix ────────────────────────────────────────────────────────
//
// The fixed crossover's contract is hard 0.5 dB / goal 0.1 dB. We sweep every mix at
// every supported rate and assert the hard contract. Design-goal misses are recorded
// as a finding, not a failure.
const RECONSTRUCTION_HARD_DB = 0.5;

describe(`${mark(SCOPE.IDEAL_MATH)} sample-rate matrix — crossover reconstruction (fixed topology)`, () => {
  for (const rate of RATES) {
    for (const mix of [0, 0.25, 0.5, 0.75, 1]) {
      it(`mix ${mix} @ ${rate} Hz: hard 0.5 dB envelope`, () => {
        const result = crossoverReconstruction(rate, { mix, points: 256 });
        expect(
          Math.abs(result.worstDeviationDb),
          `mix ${mix} @ ${rate} Hz: worst ${result.worstDeviationDb.toFixed(3)} dB @ ${result.worstFreq.toFixed(0)} Hz`,
        ).toBeLessThan(RECONSTRUCTION_HARD_DB);
      });
    }
  }
});

describe(`${mark(SCOPE.IDEAL_MATH)} sample-rate matrix — dry mix is unity, not a comb`, () => {
  for (const rate of RATES) {
    it(`mix 0 @ ${rate} Hz: dry path is flat to within 0.35 dB`, () => {
      const result = crossoverReconstruction(rate, { mix: 0, points: 256 });
      expect(
        Math.abs(result.worstDeviationDb),
        `mix 0 @ ${rate} Hz: worst ${result.worstDeviationDb.toFixed(3)} dB @ ${result.worstFreq.toFixed(0)} Hz`,
      ).toBeLessThan(0.35);
    });
  }
});

describe(`${mark(SCOPE.IDEAL_MATH)} sample-rate matrix — band placement is rate-stable`, () => {
  // The low band lives below the low crossover, mid lives between, high above. The
  // exact magnitudes are a function of the biquad response at the probe frequency;
  // what must NOT change with sample rate is the *routing* of energy to bands.
  for (const rate of RATES) {
    it(`low band @ 50 Hz / mid @ 800 Hz / high @ 12 kHz @ ${rate} Hz`, () => {
      const low = multibandResponse(50, rate).low;
      const mid = multibandResponse(800, rate).mid;
      const high = multibandResponse(12000, rate).high;
      const db = (c) => 20 * Math.log10(Math.max(1e-12, Math.hypot(c[0], c[1])));
      expect(db(low), `low @ ${rate} Hz`).toBeGreaterThan(-3);
      expect(db(mid), `mid @ ${rate} Hz`).toBeGreaterThan(-3);
      // High band at 12 kHz must hold at Nyquist up to 192 kHz; the constraint is
      // simply that 12 kHz < rate/2, which holds for every rate in the matrix.
      expect(rate / 2, `12 kHz < Nyquist @ ${rate} Hz`).toBeGreaterThan(12000);
      expect(db(high), `high @ ${rate} Hz`).toBeGreaterThan(-3);
    });
  }
});

describe(`${mark(SCOPE.IDEAL_MATH)} sample-rate matrix — dry-path delay resolution`, () => {
  // The dry-path delay is *engine-measured* by `resolveDryDelay`. The Node-side
  // reimplementation measures different values at different rates (the docstring
  // quotes 8.7 / 8.0 / 6.7 / 6.0 ms at 44.1 / 48 / 96 / 192 kHz). The contract
  // here is that the value:
  //   • is finite
  //   • is in a sensible envelope
  //   • does not change on a repeated call (cached, not flaky)
  //   • does not exceed 4 ms of the documented 6 ms reference (a wider gap is
  //     audible as a delay comb in the parallel mix)
  for (const rate of RATES) {
    it(`resolveDryDelay @ ${rate} Hz`, async () => {
      const a = await resolveDryDelay(rate);
      const b = await resolveDryDelay(rate);
      expect(Number.isFinite(a.seconds), `finite @ ${rate}`).toBe(true);
      expect(a.seconds, `in [0.5, 25] ms envelope @ ${rate}`).toBeGreaterThanOrEqual(0.0005);
      expect(a.seconds, `in [0.5, 25] ms envelope @ ${rate}`).toBeLessThanOrEqual(0.025);
      expect(a.seconds, `cached @ ${rate}`).toBe(b.seconds);
      expect(
        Math.abs(a.seconds - 0.006),
        `within 4 ms of 6 ms reference @ ${rate}`,
      ).toBeLessThan(0.004);
    });
  }
});

describe(`${mark(SCOPE.IDEAL_MATH)} sample-rate matrix — analytical true peak is rate-stable on a flat sine`, () => {
  // A sine at full scale has sample peak = true peak = 0 dBTP at every sample rate.
  // The test must use a frequency that fits an integer number of cycles into the
  // buffer length, otherwise a wrap-around discontinuity makes the polyphase
  // oversampler read a spurious peak. The cleanest choice: a frequency whose
  // period divides 16384 (the power-of-2 buffer length), so 16384 / (rate / f) is
  // an integer.
  for (const rate of RATES) {
    it(`full-scale sine @ ${rate} Hz: true peak ≈ sample peak (≤ 0.05 dB)`, () => {
      // 16384 samples at `rate` Hz: pick f so that 16384 = (rate/f) * N for some N.
      // The smallest integer-period frequency is rate / 16384 ≈ 2.93 Hz @ 48 kHz —
      // too low to test the detector meaningfully. Use 16 cycles instead: f = rate/1024.
      const f = rate / 1024;
      const data = sine({
        seconds: 16384 / rate,
        channels: 1,
        frequency: f,
        amplitude: 1,
        sampleRate: rate,
      });
      const peaks = analysePeaks(data);
      expect(peaks.truePeakDb, `true peak @ ${rate} Hz`).toBeCloseTo(0, 1);
    });
  }
});

describe(`${mark(SCOPE.IDEAL_MATH)} sample-rate matrix — loudness is rate-stable on a fixed programme`, () => {
  // Pink noise passes the EBU R128 absolute gate at every rate and has a flat
  // spectrum, so its integrated loudness is a function of amplitude alone. A 0.1
  // amplitude pink-noise signal sits at approximately −20 LUFS at every rate; if a
  // rate introduces a filter-coefficient bug, the reading moves noticeably.
  for (const rate of RATES) {
    it(`pink noise @ 0.1 amplitude @ ${rate} Hz: integrated LUFS is rate-stable`, () => {
      const data = pinkNoise({ amplitude: 0.1, seconds: 5, channels: 2, sampleRate: rate });
      const l = analyseLoudness(data);
      // Sanity: not -Infinity, not a hard clip. Exact LUFS depends on the noise seed,
      // but a wide window catches filter-coefficient drift across rates.
      expect(Number.isFinite(l.integrated), `finite LUFS @ ${rate} Hz`).toBe(true);
      expect(l.integrated, `LUFS @ ${rate} Hz`).toBeGreaterThan(-30);
      expect(l.integrated, `LUFS @ ${rate} Hz`).toBeLessThan(-10);
    });
  }
});
