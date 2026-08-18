import { describe, it, expect } from 'vitest';
import {
  DEFAULTS, defaultState, clampState, catalogToState, validateState, describeParam,
} from '../src/lib/params.js';

describe('clampState', () => {
  it('fills missing keys with defaults', () => {
    const out = clampState({});
    expect(out.targetLUFS).toBe(-14);
    expect(out.matchGains).toHaveLength(8);
    expect(out.normalize).toBe(true);
  });

  it('clamps out-of-range values', () => {
    const out = clampState({ targetLUFS: -99, width: 999, sat: 500, mbSpeed: 'warp' });
    expect(out.targetLUFS).toBe(-24);
    expect(out.width).toBe(2.5);
    expect(out.sat).toBe(100);
    expect(out.mbSpeed).toBe('med'); // invalid enum → default
  });

  it('rejects NaN and non-numeric values safely', () => {
    const out = clampState({ drive: NaN, sub: 'loud' });
    expect(out.drive).toBe(DEFAULTS.drive);
    expect(out.sub).toBe(DEFAULTS.sub);
  });

  it('coerces matchGains to a clamped 8-array', () => {
    const out = clampState({ matchGains: [99, -99, 2] });
    expect(out.matchGains).toHaveLength(8);
    expect(out.matchGains[0]).toBe(8);
    expect(out.matchGains[1]).toBe(-8);
    expect(out.matchGains[7]).toBe(0);
  });
});

describe('catalogToState', () => {
  it('converts UI-unit catalog values (ms, crossfeed, phaseRot, spread)', () => {
    const out = catalogToState({ ms: 40, crossfeed: 55, phaseRot: 65, spread: 35, width: 2.1 });
    expect(out.ms).toBe(0.4);
    expect(out.crossfeed).toBe(0.55);
    expect(out.phaseRot).toBe(0.65);
    expect(out.spread).toBe(0.35);
    expect(out.width).toBe(2.1); // width already ratio in catalog
  });

  it('drops unknown keys', () => {
    const out = catalogToState({ nonsense: 123, drive: 2 });
    expect(out.nonsense).toBeUndefined();
    expect(out.drive).toBe(2);
  });
});

describe('validateState', () => {
  it('accepts defaults', () => {
    expect(validateState(defaultState()).ok).toBe(true);
  });
  it('reports out-of-contract states', () => {
    const bad = defaultState();
    bad.targetLUFS = -99;
    bad.mbSpeed = 'nope';
    bad.matchGains = [1];
    const r = validateState(bad);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes('targetLUFS'))).toBe(true);
    expect(r.problems.some((p) => p.includes('mbSpeed'))).toBe(true);
    expect(r.problems.some((p) => p.includes('matchGains'))).toBe(true);
  });
});

describe('describeParam', () => {
  it('formats known units', () => {
    expect(describeParam('drive', 2)).toBe('2dB');
    expect(describeParam('ms', 0.4)).toBe('40%');
  });
});
