import { describe, it, expect } from 'vitest';
import {
  ALL_PRESETS,
  findPreset,
  MASTERING_PRESETS,
} from '../../src/presets/index.js';
import {
  presetFamily,
  sanitizeForFamily,
  DEGRADATION_KEYS,
} from '../../src/presets/_shared.js';
import { expandCatalogPreset } from '../../src/app/presets-io.js';

describe('Reference HD flagship', () => {
  it('exists in the mastering group', () => {
    const ref = findPreset('Reference HD');
    expect(ref).toBeTruthy();
    expect(MASTERING_PRESETS.map((p) => p.name)).toContain('Reference HD');
    expect(presetFamily(ref)).toBe('mastering');
  });

  it('is a conservative reference: −16…−14 LUFS, −1 dBTP, no colour', () => {
    const ref = findPreset('Reference HD');
    const p = expandCatalogPreset(ref.parameters);
    expect(p.targetLUFS).toBeLessThanOrEqual(-14);
    expect(p.targetLUFS).toBeGreaterThanOrEqual(-16);
    expect(p.ceiling).toBe(-1.0);
    expect(p.sat).toBe(0);
    expect(p.drive).toBe(0);
    expect(p.transAttack).toBe(0);
    expect(p.transSustain).toBe(0);
    for (const key of DEGRADATION_KEYS) expect(p[key]).toBe(0);
  });

  it('keeps compression and EQ at seasoning levels', () => {
    const ref = findPreset('Reference HD');
    const p = expandCatalogPreset(ref.parameters);
    for (const key of ['mbLow', 'mbMid', 'mbHigh']) {
      expect(p[key], key).toBeLessThanOrEqual(15);
    }
    for (const key of ['sub', 'warm', 'body', 'harsh', 'clarity', 'air', 'tilt']) {
      expect(Math.abs(p[key]), key).toBeLessThanOrEqual(0.5);
    }
    expect(p.mbMix).toBeLessThanOrEqual(60);
  });

  it('keeps stereo enhancement subtle and the sub centred', () => {
    const ref = findPreset('Reference HD');
    const p = expandCatalogPreset(ref.parameters);
    expect(p.width).toBeLessThanOrEqual(1.05);
    expect(p.width).toBeGreaterThanOrEqual(0.95);
    expect(p.bassMono).toBeGreaterThan(0);
    expect(p.depth).toBeLessThanOrEqual(10);
  });
});

describe('mastering vs creative separation', () => {
  it('lets no degradation DSP appear in any mastering preset', () => {
    for (const preset of ALL_PRESETS) {
      if (presetFamily(preset) !== 'mastering') continue;
      const p = expandCatalogPreset(preset.parameters);
      for (const key of DEGRADATION_KEYS) {
        expect(p[key], `${preset.name} leaks ${key}`).toBe(0);
      }
    }
  });

  it('scrubs degradation controls when a mastering preset is applied', () => {
    const { parameters, scrubbed } = sanitizeForFamily('mastering', {
      tape: 40,
      hiss: 10,
      vinyl: 20,
      phaseRot: 0.5,
      haas: 8,
      sat: 5,
    });
    expect(scrubbed.sort()).toEqual([...DEGRADATION_KEYS].sort());
    for (const key of DEGRADATION_KEYS) expect(parameters[key]).toBe(0);
    // Non-degradation controls pass through untouched.
    expect(parameters.sat).toBe(5);
  });

  it('leaves creative presets completely alone', () => {
    const input = { tape: 70, hiss: 25, vinyl: 45, phaseRot: 0.6, haas: 14 };
    const { parameters, scrubbed } = sanitizeForFamily('creative', input);
    expect(scrubbed).toEqual([]);
    expect(parameters).toEqual(input);
  });

  it('infers creative for anything using degradation DSP, even without the label', () => {
    expect(presetFamily({ name: 'x', parameters: { tape: 5 } })).toBe('creative');
    expect(presetFamily({ name: 'x', parameters: { haas: 2 } })).toBe('creative');
    expect(presetFamily({ name: 'x', parameters: { sat: 20 } })).toBe('mastering');
  });

  it('keeps the known degradation presets in the creative family', () => {
    for (const name of [
      'Tape Ghost',
      'Vinyl Séance',
      'Rust',
      'Noise / Harsh Wall',
      'Manic Joy',
      'Inverse Phase',
      'Panoramic',
      'Polar Maze',
      'Magnetic Memory',
      'Ferric Bloom',
      'Analog Womb',
      'Hiraeth',
      'Gold',
      'Amber',
    ]) {
      const preset = findPreset(name);
      expect(preset, name).toBeTruthy();
      expect(presetFamily(preset), name).toBe('creative');
    }
  });
});

describe('loudness honesty in the catalogue', () => {
  it('flags aggressive mastering targets as caution — loud only when deliberate', () => {
    for (const preset of ALL_PRESETS) {
      if (presetFamily(preset) !== 'mastering') continue;
      const p = expandCatalogPreset(preset.parameters);
      if (p.normalize && p.targetLUFS > -12) {
        expect(p.risk ?? preset.risk, `${preset.name} pushes ${p.targetLUFS} LUFS unflagged`).toBe(
          'caution',
        );
      }
    }
  });

  it('keeps normal mastering targets inside sane windows', () => {
    const ref = expandCatalogPreset(findPreset('Reference HD').parameters);
    expect(ref.targetLUFS).toBeGreaterThanOrEqual(-16);
    expect(ref.targetLUFS).toBeLessThanOrEqual(-14);
    const balanced = expandCatalogPreset(findPreset('Balanced Modern').parameters);
    expect(balanced.targetLUFS).toBeGreaterThanOrEqual(-14);
    expect(balanced.targetLUFS).toBeLessThanOrEqual(-11);
  });
});
