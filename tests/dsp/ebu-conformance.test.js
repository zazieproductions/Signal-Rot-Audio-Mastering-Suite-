/**
 * EBU published conformance vectors.
 *
 * `loudness.test.js` covers the behaviour of the meter thoroughly — gating,
 * block geometry, linearity, channel weighting. What it does not do is assert
 * the **numbered compliance cases from EBU Tech 3341 and Tech 3342 against
 * their published expected values**. Those tables are the industry's shared
 * definition of "this meter is correct", and a broadcaster or mastering
 * engineer evaluating this project will look for exactly them.
 *
 * These vectors are an independent construction from the specification text,
 * written against the public API only. They were originally built to audit a
 * previous implementation, where they caught two defects that property-based
 * tests missed:
 *
 *   - Tech 3342 cases 3 and 4 returned 0.00 LU (answers: 20 LU and 15 LU),
 *     because LRA used 400 ms blocks and the −10 LU integrated gate rather
 *     than 3 s blocks and the −20 LU gate. Case 1 passed by coincidence: a
 *     10 LU spread is exactly the boundary where the wrong gate still keeps
 *     both halves of the programme.
 *   - A true-peak limiter asked for −1.0 dBTP delivered +2.8 dBTP, because a
 *     single gain pass cannot see the inter-sample peaks that applying a
 *     time-varying gain creates.
 *
 * The current implementation passes all of them. Keeping the vectors here
 * means a future refactor cannot quietly reintroduce either failure.
 *
 * Tolerances are the ones the documents themselves specify: ±0.1 LU for
 * Tech 3341, ±1 LU for Tech 3342.
 */

import { describe, it, expect } from 'vitest';
import { analyseLoudness } from '../../src/audio/analysis/loudness.js';
import { limitTruePeak } from '../../src/audio/render/limiter.js';
import { analysePeaksVerified } from '../../src/audio/analysis/true-peak.js';
import { whiteNoise } from '../helpers/signals.js';

const SR = 48000;

/** Peak amplitude of a sine at a given dBFS, per the EBU "per-channel peak level". */
const dbfs = (db) => Math.pow(10, db / 20);

/**
 * Build a dual-mono 1 kHz programme from a list of `[dBFS, seconds]` segments,
 * applied in phase to both channels as the documents require.
 */
function programme(segments, sampleRate = SR) {
  const total = segments.reduce((n, [, secs]) => n + Math.round(secs * sampleRate), 0);
  const left = new Float32Array(total);
  let phase = 0;
  let w = 0;
  for (const [db, secs] of segments) {
    const n = Math.round(secs * sampleRate);
    const amp = dbfs(db);
    for (let i = 0; i < n; i++, w++) {
      left[w] = amp * Math.sin(phase);
      phase += (2 * Math.PI * 1000) / sampleRate;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
  }
  return { sampleRate, length: total, channels: [left, Float32Array.from(left)] };
}

describe('EBU Tech 3341 — integrated loudness compliance cases', () => {
  it('case 1: 1 kHz stereo sine at −23 dBFS reads −23.0 LUFS', () => {
    expect(analyseLoudness(programme([[-23, 20]])).integrated).toBeCloseTo(-23.0, 1);
  });

  it('case 2: the same signal at −33 dBFS reads −33.0 LUFS', () => {
    expect(analyseLoudness(programme([[-33, 20]])).integrated).toBeCloseTo(-33.0, 1);
  });

  it('case 3: 10 s −36 / 60 s −23 / 10 s −36 dBFS integrates to −23.0 LUFS', () => {
    // The relative gate lands near −34.2 LUFS, so the −36 dBFS tails are
    // excluded. Fails if the relative gate offset is wrong.
    expect(analyseLoudness(programme([
      [-36, 10], [-23, 60], [-36, 10],
    ])).integrated).toBeCloseTo(-23.0, 1);
  });

  it('case 4: −72 dBFS tails are removed by the absolute gate', () => {
    expect(analyseLoudness(programme([
      [-72, 10], [-36, 10], [-23, 60], [-36, 10], [-72, 10],
    ])).integrated).toBeCloseTo(-23.0, 1);
  });

  it('case 5: −26 / −20 / −26 dBFS integrates to −23.0 LUFS', () => {
    // Nothing is gated here. This is purely a test that block energies are
    // averaged as power, not in the log domain — averaging dB would give
    // −24.0 LUFS.
    expect(analyseLoudness(programme([
      [-26, 20], [-20, 20], [-26, 20],
    ])).integrated).toBeCloseTo(-23.0, 1);
  });

  it('holds to ±0.1 LU at 44.1 kHz as well as 48 kHz', () => {
    const a = analyseLoudness(programme([[-23, 20]], 48000)).integrated;
    const b = analyseLoudness(programme([[-23, 20]], 44100)).integrated;
    expect(Math.abs(a - b)).toBeLessThan(0.1);
    expect(b).toBeCloseTo(-23.0, 1);
  });
});

describe('EBU Tech 3342 — loudness range compliance cases', () => {
  /** Two 20 s segments, `a` then `b`, as the Tech 3342 test signals specify. */
  const twoLevel = (a, b) => analyseLoudness(programme([[a, 20], [b, 20]])).lra;

  it('case 1: −20 / −30 dBFS gives LRA 10 LU', () => {
    expect(twoLevel(-20, -30)).toBeGreaterThan(9);
    expect(twoLevel(-20, -30)).toBeLessThan(11);
  });

  it('case 2: −20 / −15 dBFS gives LRA 5 LU', () => {
    expect(twoLevel(-20, -15)).toBeGreaterThan(4);
    expect(twoLevel(-20, -15)).toBeLessThan(6);
  });

  it('case 3: −40 / −20 dBFS gives LRA 20 LU', () => {
    // Returned 0.00 under a −10 LU relative gate.
    expect(twoLevel(-40, -20)).toBeGreaterThan(19);
    expect(twoLevel(-40, -20)).toBeLessThan(21);
  });

  it('case 4: −50 / −35 dBFS gives LRA 15 LU', () => {
    // Returned 0.00 under a −10 LU relative gate.
    expect(twoLevel(-50, -35)).toBeGreaterThan(14);
    expect(twoLevel(-50, -35)).toBeLessThan(16);
  });
});

describe('true-peak ceiling is delivered, not just requested', () => {
  const noiseAt = (amplitude, seconds = 20) =>
    whiteNoise({ amplitude, seconds, sampleRate: SR, channels: 2, seed: 51 });

  const measure = (data) => analysePeaksVerified(data).truePeakDb;

  it.each([-0.1, -0.3, -1.0, -2.0])('holds a %s dBTP ceiling on dense material', (ceilingDb) => {
    const data = noiseAt(0.9);
    limitTruePeak(data, { ceilingDb });
    // Verified by re-measuring the output, not by trusting the limiter's own
    // report — the previous implementation's report was the thing that lied.
    expect(measure(data)).toBeLessThanOrEqual(ceilingDb + 0.05);
  });

  it('reports a ceiling it actually achieved', () => {
    const data = noiseAt(0.9);
    const result = limitTruePeak(data, { ceilingDb: -1.0 });
    expect(result.ceilingRespected).toBe(true);
    expect(result.achievedTruePeakDb).toBeCloseTo(measure(data), 1);
    expect(result.achievedTruePeakDb).toBeLessThanOrEqual(-1.0 + 0.05);
  });

  it('leaves material already under the ceiling alone', () => {
    const data = noiseAt(0.02);
    const before = Float32Array.from(data.channels[0]);
    const result = limitTruePeak(data, { ceilingDb: -1.0 });
    expect(result.maxGainReductionDb).toBe(0);
    expect([...data.channels[0]]).toEqual([...before]);
  });
});
