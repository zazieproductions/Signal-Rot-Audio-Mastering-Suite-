import { describe, it, expect } from 'vitest';
import {
  PARAMETERS,
  PARAMETER_LIST,
  defaultParameters,
  coerceParameter,
  validateParameters,
  formatParameter,
  previewDivergences,
} from '../../src/app/parameters.js';

describe('schema integrity', () => {
  it('gives every parameter a complete specification', () => {
    for (const spec of PARAMETER_LIST) {
      expect(spec.key).toBeTruthy();
      expect(spec.label).toBeTruthy();
      expect(spec.group).toBeTruthy();
      expect(typeof spec.displayFormatter).toBe('function');
      expect(typeof spec.previewSupported).toBe('boolean');
      expect(typeof spec.exportSupported).toBe('boolean');
      expect(spec.unit !== undefined).toBe(true);
      if (spec.type === 'number') {
        expect(Number.isFinite(spec.min)).toBe(true);
        expect(Number.isFinite(spec.max)).toBe(true);
        expect(spec.min).toBeLessThan(spec.max);
      }
      if (spec.type === 'enum') expect(spec.values.length).toBeGreaterThan(1);
    }
  });

  it('has no duplicate keys', () => {
    const keys = PARAMETER_LIST.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps every default inside its own range', () => {
    for (const spec of PARAMETER_LIST) {
      if (spec.type === 'number') {
        expect(spec.defaultValue).toBeGreaterThanOrEqual(spec.min);
        expect(spec.defaultValue).toBeLessThanOrEqual(spec.max);
      }
      if (spec.type === 'enum') expect(spec.values).toContain(spec.defaultValue);
      if (spec.type === 'array') expect(spec.defaultValue).toHaveLength(spec.length);
    }
  });

  it('explains every parameter that is not honoured in the live preview', () => {
    for (const spec of PARAMETER_LIST) {
      if (!spec.previewSupported) expect(spec.previewNote).toBeTruthy();
    }
  });

  it('generates the tone-band labels from the filter definitions', () => {
    // The pre-7.0 UI said "Warmth — low shelf 170 Hz" about a shelf at 120 Hz and
    // "Body — peaking 700 Hz" about one at 350 Hz.
    expect(PARAMETERS.warm.hint).toBe('low shelf 120 Hz');
    expect(PARAMETERS.body.hint).toBe('peaking 350 Hz, Q 0.7');
    expect(PARAMETERS.clarity.hint).toMatch(/peaking 5 kHz/);
    expect(PARAMETERS.air.hint).toBe('high shelf 12 kHz');
  });
});

describe('defaults', () => {
  it('produces a fresh object every time', () => {
    const a = defaultParameters();
    const b = defaultParameters();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.matchGains[0] = 5;
    expect(b.matchGains[0]).toBe(0);
  });

  it('defaults to a safe, transparent state', () => {
    const p = defaultParameters();
    expect(p.normalize).toBe(true);
    expect(p.targetLUFS).toBe(-14);
    expect(p.ceiling).toBe(-1);
    expect(p.width).toBe(1);
    expect(p.sat).toBe(0);
    expect(p.dither).toBe('tpdf');
  });
});

describe('coerceParameter', () => {
  it('clamps numbers to their range', () => {
    expect(coerceParameter('width', 1e9)).toBe(PARAMETERS.width.max);
    expect(coerceParameter('width', -50)).toBe(PARAMETERS.width.min);
    expect(coerceParameter('ceiling', 40)).toBe(PARAMETERS.ceiling.max);
    expect(coerceParameter('targetLUFS', -500)).toBe(PARAMETERS.targetLUFS.min);
  });

  it('replaces non-numeric input with the default', () => {
    expect(coerceParameter('width', 'wide')).toBe(PARAMETERS.width.defaultValue);
    expect(coerceParameter('width', NaN)).toBe(PARAMETERS.width.defaultValue);
    // Infinity is garbage, not "very wide": it falls back rather than clamping.
    expect(coerceParameter('width', Infinity)).toBe(PARAMETERS.width.defaultValue);
    expect(coerceParameter('width', -Infinity)).toBe(PARAMETERS.width.defaultValue);
    expect(coerceParameter('width', null)).toBe(0); // Number(null) === 0, inside range
  });

  it('coerces booleans', () => {
    expect(coerceParameter('normalize', true)).toBe(true);
    expect(coerceParameter('normalize', 'false')).toBe(false);
    expect(coerceParameter('normalize', 0)).toBe(false);
    expect(coerceParameter('normalize', 1)).toBe(true);
  });

  it('rejects enum values outside the allowed set', () => {
    expect(coerceParameter('mbSpeed', 'instant')).toBe('med');
    expect(coerceParameter('mbSpeed', 'fast')).toBe('fast');
    expect(coerceParameter('dither', 'pow-r')).toBe('tpdf');
    expect(coerceParameter('haasSide', -1)).toBe(-1);
    expect(coerceParameter('haasSide', 7)).toBe(1);
  });

  it('normalises arrays to the declared length and range', () => {
    expect(coerceParameter('matchGains', [1, 2])).toEqual([1, 2, 0, 0, 0, 0, 0, 0]);
    expect(coerceParameter('matchGains', new Array(20).fill(3))).toHaveLength(8);
    expect(coerceParameter('matchGains', [999, -999, 'x', null, 1, 2, 3, 4])).toEqual([
      12, -12, 0, 0, 1, 2, 3, 4,
    ]);
    expect(coerceParameter('matchGains', 'nope')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('returns undefined for an unknown key', () => {
    expect(coerceParameter('gainReductionInDb', 5)).toBeUndefined();
  });
});

describe('validateParameters', () => {
  it('drops unknown keys instead of merging them', () => {
    const { parameters, warnings } = validateParameters({
      width: 1.2,
      __proto__hack: 1,
      evil: true,
    });
    expect(parameters.evil).toBeUndefined();
    expect(parameters.width).toBe(1.2);
    expect(warnings.some((w) => w.includes('evil'))).toBe(true);
  });

  it('fills missing keys with defaults', () => {
    const { parameters } = validateParameters({ width: 1.5 });
    expect(parameters.targetLUFS).toBe(-14);
    expect(parameters.matchGains).toHaveLength(8);
    expect(Object.keys(parameters).sort()).toEqual(Object.keys(defaultParameters()).sort());
  });

  it('warns when it clamps a value', () => {
    const { parameters, warnings } = validateParameters({ ceiling: 12 });
    expect(parameters.ceiling).toBe(PARAMETERS.ceiling.max);
    expect(warnings.some((w) => w.includes('ceiling'))).toBe(true);
  });

  it('warns when it replaces an invalid enum with the default', () => {
    const { parameters, warnings } = validateParameters({ haasSide: 7, mbSpeed: 'instant' });
    expect(parameters.haasSide).toBe(1);
    expect(parameters.mbSpeed).toBe('med');
    expect(warnings.some((w) => w.includes('haasSide'))).toBe(true);
    expect(warnings.some((w) => w.includes('mbSpeed'))).toBe(true);
  });

  it('survives hostile input without throwing', () => {
    for (const input of [null, undefined, 42, 'string', [], () => {}]) {
      const { parameters } = validateParameters(input);
      expect(parameters.width).toBe(1);
    }
  });

  it('never lets a prototype-pollution payload through', () => {
    const { parameters } = validateParameters(JSON.parse('{"__proto__":{"polluted":true}}'));
    expect({}.polluted).toBeUndefined();
    expect(parameters.polluted).toBeUndefined();
  });

  it('produces a fully finite parameter set from garbage', () => {
    const { parameters } = validateParameters({
      width: 'NaN',
      targetLUFS: Infinity,
      ceiling: 'loud',
      sat: -Infinity,
      matchGains: [NaN, Infinity, -Infinity, null, undefined, 'x', {}, []],
    });
    for (const [key, value] of Object.entries(parameters)) {
      if (Array.isArray(value)) {
        for (const v of value) expect(Number.isFinite(v)).toBe(true);
      } else if (typeof value === 'number') {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(value).not.toBeUndefined();
      expect(key).toBeTruthy();
    }
  });
});

describe('formatParameter', () => {
  it('formats with units', () => {
    expect(formatParameter('targetLUFS', -14)).toBe('-14.0 LUFS');
    expect(formatParameter('ceiling', -1)).toBe('-1.0 dBTP');
    expect(formatParameter('width', 1.25)).toBe('125 %');
    expect(formatParameter('bassMono', 0)).toBe('off');
    expect(formatParameter('bassMono', 90)).toBe('90 Hz');
    expect(formatParameter('warm', 1.6)).toBe('+1.6 dB');
    expect(formatParameter('warm', -1.6)).toBe('-1.6 dB');
    expect(formatParameter('haasSide', -1)).toBe('left');
    expect(formatParameter('textureSeed', 0x5164a17)).toBe('#05164A17');
  });

  it('degrades gracefully for an unknown key', () => {
    expect(formatParameter('nope', 5)).toBe('5');
  });
});

describe('previewDivergences', () => {
  it('lists exactly the parameters the live monitor cannot honour', () => {
    const keys = previewDivergences().map((d) => d.key);
    expect(keys).toContain('transAttack');
    expect(keys).toContain('transSustain');
    expect(keys).toContain('ceiling');
    expect(keys).toContain('dither');
    expect(keys).not.toContain('width');
    expect(keys).not.toContain('sat');
  });

  it('gives every divergence a note', () => {
    for (const d of previewDivergences()) expect(d.note.length).toBeGreaterThan(10);
  });
});
