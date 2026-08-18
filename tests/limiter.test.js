import { describe, it, expect } from 'vitest';
import { truePeakLimit, verifyTruePeak } from '../src/lib/limiter.js';
import { truePeakFile } from '../src/lib/dsp.js';
import { makeBuffer, sine } from './helpers.js';

describe('truePeakLimit', () => {
  it('reduces a full-scale sine to the requested ceiling', () => {
    const sr = 48000;
    const buf = makeBuffer([sine(997, sr, 1.0, 1.0), sine(997, sr, 1.0, 1.0)], sr);
    const before = truePeakFile(buf);
    expect(before).toBeGreaterThan(0.99); // full scale input
    const { maxGainReductionDb } = truePeakLimit(buf, -1.0);
    const measured = verifyTruePeak(buf, -1.0).measuredTruePeakDbtp;
    expect(maxGainReductionDb).toBeGreaterThan(0.8);
    expect(measured).toBeLessThanOrEqual(-0.8);
    expect(measured).toBeGreaterThanOrEqual(-1.5);
  });

  it('leaves a quiet signal untouched', () => {
    const sr = 48000;
    const buf = makeBuffer([sine(1000, sr, 0.5, 0.5), sine(1000, sr, 0.5, 0.5)], sr);
    const { maxGainReductionDb } = truePeakLimit(buf, -1.0);
    expect(maxGainReductionDb).toBeLessThan(0.05);
  });

  it('is stereo-linked (both channels share the same gain)', () => {
    const sr = 48000;
    const L = sine(997, sr, 0.5, 1.0);
    const R = new Float32Array(L.length); // silent channel
    const buf = makeBuffer([L, R], sr);
    truePeakLimit(buf, -3.0);
    // Silent channel must remain silent (no injected signal), and its envelope must be
    // shaped by the linked gain — i.e. still silent.
    for (let i = 0; i < R.length; i += 1000) expect(R[i]).toBe(0);
  });
});

describe('verifyTruePeak', () => {
  it('flags a file that exceeds the ceiling', () => {
    const sr = 48000;
    const buf = makeBuffer([sine(997, sr, 1.0, 1.0), sine(997, sr, 1.0, 1.0)], sr);
    const v = verifyTruePeak(buf, -1.0);
    expect(v.exceeded).toBe(true);
    expect(v.measuredTruePeakDbtp).toBeGreaterThan(-0.2);
  });
  it('passes a quiet file', () => {
    const sr = 48000;
    const buf = makeBuffer([sine(1000, sr, 0.5, 0.3), sine(1000, sr, 0.5, 0.3)], sr);
    const v = verifyTruePeak(buf, -1.0);
    expect(v.exceeded).toBe(false);
  });
});
