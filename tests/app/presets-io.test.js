import { describe, it, expect } from 'vitest';
import {
  serializePreset,
  parsePreset,
  migrateLegacyPreset,
  expandCatalogPreset,
  MAX_PRESET_BYTES,
} from '../../src/app/presets-io.js';
import { defaultParameters, PARAMETERS } from '../../src/app/parameters.js';
import { PRESET_SCHEMA_VERSION, ENGINE_VERSION } from '../../src/app/constants.js';
import { defaultImmersive } from '../../src/app/state.js';

describe('serialisation round trip', () => {
  it('round-trips a preset exactly', () => {
    const parameters = { ...defaultParameters(), width: 1.4, sat: 22, tape: 35, targetLUFS: -11 };
    const serialised = serializePreset({ parameters, name: 'Rust', immersive: defaultImmersive() });
    const result = parsePreset(JSON.stringify(serialised));
    expect(result.ok).toBe(true);
    expect(result.preset.name).toBe('Rust');
    expect(result.preset.parameters.width).toBe(1.4);
    expect(result.preset.parameters.sat).toBe(22);
    expect(result.preset.parameters.tape).toBe(35);
    expect(result.preset.parameters.targetLUFS).toBe(-11);
    expect(result.warnings).toHaveLength(0);
  });

  it('stamps the schema and engine versions', () => {
    const s = serializePreset({ parameters: defaultParameters(), name: 'X' });
    expect(s.format).toBe('signal-rot-preset');
    expect(s.schemaVersion).toBe(PRESET_SCHEMA_VERSION);
    expect(s.engineVersion).toBe(ENGINE_VERSION);
    expect(() => new Date(s.savedAt).toISOString()).not.toThrow();
  });

  it('truncates absurdly long names and descriptions', () => {
    const s = serializePreset({
      parameters: defaultParameters(),
      name: 'n'.repeat(5000),
      description: 'd'.repeat(5000),
    });
    expect(s.name.length).toBe(120);
    expect(s.description.length).toBe(500);
  });
});

describe('rejecting malformed input', () => {
  it('rejects non-JSON', () => {
    const result = parsePreset('this is not json');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not valid JSON/i);
  });

  it('rejects a JSON array or scalar', () => {
    expect(parsePreset('[]').ok).toBe(false);
    expect(parsePreset('42').ok).toBe(false);
    expect(parsePreset('null').ok).toBe(false);
    expect(parsePreset('"a string"').ok).toBe(false);
  });

  it('rejects an object with no recognisable parameter block', () => {
    const result = parsePreset('{"hello":"world"}');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unrecognised preset structure/);
  });

  it('rejects a file above the size limit before parsing it', () => {
    const huge = `{"parameters":{},"pad":"${'x'.repeat(MAX_PRESET_BYTES)}"}`;
    const result = parsePreset(huge);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/limit/);
  });

  it('rejects non-string input', () => {
    expect(parsePreset(null).ok).toBe(false);
    expect(parsePreset({}).ok).toBe(false);
  });

  it('clamps hostile values rather than accepting them', () => {
    const result = parsePreset(
      JSON.stringify({
        schemaVersion: 3,
        parameters: { width: 1e12, ceiling: 40, targetLUFS: 1000, sat: -500, bassMono: 1e9 },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.preset.parameters.width).toBe(PARAMETERS.width.max);
    expect(result.preset.parameters.ceiling).toBe(PARAMETERS.ceiling.max);
    expect(result.preset.parameters.targetLUFS).toBe(PARAMETERS.targetLUFS.max);
    expect(result.preset.parameters.sat).toBe(0);
    expect(result.preset.parameters.bassMono).toBe(PARAMETERS.bassMono.max);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('ignores injected extra keys', () => {
    const result = parsePreset(
      JSON.stringify({ schemaVersion: 3, parameters: { constructor: 'x', __proto__: {} } }),
    );
    expect(result.ok).toBe(true);
    expect(result.preset.parameters.constructor).not.toBe('x');
  });

  it('warns when the file comes from a newer engine', () => {
    const result = parsePreset(JSON.stringify({ schemaVersion: 99, parameters: { width: 1.1 } }));
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes('newer engine'))).toBe(true);
  });
});

describe('legacy migration', () => {
  /** The shape the pre-7.0 engine wrote: `{ preset, P }`. */
  const legacy = {
    preset: 'Tape Ghost',
    P: {
      normalize: true,
      targetLUFS: -16,
      ceiling: -1,
      drive: 0,
      width: 1.15,
      ms: 0,
      bassMono: 0,
      haas: 0,
      haasSide: 1,
      crossfeed: 0,
      phaseRot: 0,
      binaural: false,
      spread: 0,
      sub: 0,
      warm: 0,
      body: 0,
      harsh: 0,
      clarity: 0,
      air: -1.5,
      tilt: -1.5,
      sat: 12,
      mbLow: 25,
      mbMid: 0,
      mbHigh: 0,
      mbMix: 40,
      mbSpeed: 'med',
      widthLow: 1,
      widthMid: 1,
      widthHigh: 1,
      tape: 70,
      hiss: 25,
      vinyl: 0,
      depth: 0,
      depthSize: 'med',
      transAttack: 0,
      transSustain: 0,
      matchStrength: 0,
      matchGains: [0, 0, 0, 0, 0, 0, 0, 0],
    },
  };

  it('accepts a pre-7.0 preset file', () => {
    const result = parsePreset(JSON.stringify(legacy));
    expect(result.ok).toBe(true);
    expect(result.preset.name).toBe('Tape Ghost');
    expect(result.preset.parameters.tape).toBe(70);
    expect(result.preset.parameters.hiss).toBe(25);
    expect(result.preset.parameters.mbMix).toBe(40);
    expect(result.preset.parameters.air).toBe(-1.5);
  });

  it('supplies defaults for parameters that did not exist', () => {
    const result = parsePreset(JSON.stringify(legacy));
    expect(result.preset.parameters.textureSeed).toBe(PARAMETERS.textureSeed.defaultValue);
    expect(result.preset.parameters.matchMode).toBe('balanced');
    expect(result.preset.parameters.dither).toBe('tpdf');
    expect(result.preset.parameters.mbSolo).toBe('none');
  });

  it('reports what it did', () => {
    const result = parsePreset(JSON.stringify(legacy));
    expect(result.warnings.some((w) => w.includes('pre-7.0'))).toBe(true);
  });

  it('handles a legacy file with a missing or malformed P block', () => {
    expect(parsePreset(JSON.stringify({ preset: 'X' })).ok).toBe(true);
    expect(parsePreset(JSON.stringify({ preset: 'X', P: 'nope' })).ok).toBe(true);
    const migrated = migrateLegacyPreset({ preset: 'X', P: null });
    expect(migrated.name).toBe('X');
    expect(migrated.notes.length).toBeGreaterThan(0);
  });

  it('notes a matchGains array of the wrong length', () => {
    const migrated = migrateLegacyPreset({ preset: 'X', P: { matchGains: [1, 2, 3] } });
    expect(migrated.notes.some((n) => n.includes('matchGains'))).toBe(true);
  });
});

describe('immersive block', () => {
  it('round-trips immersive settings with type checking', () => {
    const immersive = { ...defaultImmersive(), layout: '7.1.4', surrLevelDb: -5.5 };
    const s = serializePreset({ parameters: defaultParameters(), immersive, name: 'X' });
    const result = parsePreset(JSON.stringify(s));
    expect(result.preset.immersive.layout).toBe('7.1.4');
    expect(result.preset.immersive.surrLevelDb).toBe(-5.5);
  });

  it('discards values of the wrong type', () => {
    const result = parsePreset(
      JSON.stringify({
        schemaVersion: 3,
        parameters: {},
        immersive: { surrLevelDb: 'loud', binauralPreview: 'yes', lfeFreqHz: 90 },
      }),
    );
    const base = defaultImmersive();
    expect(result.preset.immersive.surrLevelDb).toBe(base.surrLevelDb);
    expect(result.preset.immersive.binauralPreview).toBe(base.binauralPreview);
    expect(result.preset.immersive.lfeFreqHz).toBe(90);
  });
});

describe('expandCatalogPreset', () => {
  it('resets unlisted parameters to defaults — presets must be deterministic', () => {
    const from = { ...defaultParameters(), sat: 90, tape: 80, width: 2 };
    const expanded = expandCatalogPreset({ warm: 2 });
    expect(expanded.sat).toBe(0);
    expect(expanded.tape).toBe(0);
    expect(expanded.width).toBe(1);
    expect(expanded.warm).toBe(2);
    expect(from.sat).toBe(90); // input untouched
  });

  it('preserves only what the caller explicitly carries over', () => {
    const expanded = expandCatalogPreset(
      { warm: 2 },
      { preserve: { matchGains: [1, 1, 1, 1, 1, 1, 1, 1], textureSeed: 42 } },
    );
    expect(expanded.matchGains).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(expanded.textureSeed).toBe(42);
    expect(expanded.sat).toBe(0);
  });

  it('validates the result', () => {
    const expanded = expandCatalogPreset({ width: 1e6, unknownKey: 1 });
    expect(expanded.width).toBe(PARAMETERS.width.max);
    expect(expanded.unknownKey).toBeUndefined();
  });
});
