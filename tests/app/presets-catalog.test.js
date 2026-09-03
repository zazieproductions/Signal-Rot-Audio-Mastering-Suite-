import { describe, it, expect } from 'vitest';
import { PRESET_GROUPS, ALL_PRESETS, findPreset } from '../../src/presets/index.js';
import { expandCatalogPreset } from '../../src/app/presets-io.js';
import { PARAMETERS, defaultParameters } from '../../src/app/parameters.js';
import { phaseRiskFromParameters } from '../../src/audio/analysis/correlation.js';

describe('catalogue integrity', () => {
  it('exposes seven groups', () => {
    expect(PRESET_GROUPS.map((g) => g.id)).toEqual([
      'dimension',
      'genre',
      'cinematic',
      'mood',
      'color',
      'spatial',
      'restoration',
    ]);
  });

  it('preserves the distinctive presets by name', () => {
    for (const name of [
      'Analog Womb',
      'Crystal Palace',
      'Fourth Dimension',
      'Tape Ghost',
      'Vinyl Séance',
      'Hyperreal',
      'Psychological Horror',
      'Dark Ambient Score',
      'Obsidian',
      'Rust',
      'Holographic',
      'Ferric Bloom',
      'Ray Field',
      'Magnetic Memory',
      'Aperture',
      'Depth Lens',
      'Wide Awake',
      'Binaural Stage',
      'Polar Maze',
    ]) {
      expect(findPreset(name), `preset "${name}" is missing`).toBeTruthy();
    }
  });

  it('gives every preset a unique name, a description, a tag and an audit note', () => {
    const names = new Set();
    for (const p of ALL_PRESETS) {
      expect(names.has(p.name)).toBe(false);
      names.add(p.name);
      expect(p.description.length).toBeGreaterThan(15);
      expect(p.tag).toBeTruthy();
      expect(p.audit, `${p.name} has no audit note`).toBeTruthy();
      expect(['safe', 'caution', 'destructive']).toContain(p.risk);
    }
  });

  it('only sets parameters that exist in the schema', () => {
    for (const p of ALL_PRESETS) {
      for (const key of Object.keys(p.parameters)) {
        expect(PARAMETERS[key], `${p.name} sets unknown parameter "${key}"`).toBeTruthy();
      }
    }
  });

  it('sets every value inside its schema range', () => {
    for (const p of ALL_PRESETS) {
      for (const [key, value] of Object.entries(p.parameters)) {
        const spec = PARAMETERS[key];
        if (spec.type === 'number') {
          expect(value, `${p.name}.${key}`).toBeGreaterThanOrEqual(spec.min);
          expect(value, `${p.name}.${key}`).toBeLessThanOrEqual(spec.max);
        }
        if (spec.type === 'enum') expect(spec.values, `${p.name}.${key}`).toContain(value);
      }
    }
  });

  it('applies cleanly with no clamping warnings', () => {
    for (const p of ALL_PRESETS) {
      const expanded = expandCatalogPreset(p.parameters);
      for (const [key, value] of Object.entries(p.parameters)) {
        expect(expanded[key], `${p.name}.${key} was altered on apply`).toEqual(value);
      }
    }
  });
});

describe('safety review', () => {
  it('never uses a ceiling hotter than −1.0 dBTP', () => {
    // Anything above −1 dBTP clips after a lossy encode. The pre-7.0 catalogue shipped
    // four presets at −0.5 dBTP.
    for (const p of ALL_PRESETS) {
      const ceiling = p.parameters.ceiling ?? defaultParameters().ceiling;
      expect(ceiling, `${p.name} ceiling`).toBeLessThanOrEqual(-1.0);
    }
  });

  it('declares a risk level at least as severe as the phase analyser reports', () => {
    const severity = { safe: 0, caution: 1, destructive: 2 };
    const analysed = { ok: 0, caution: 1, danger: 2 };
    for (const p of ALL_PRESETS) {
      const parameters = expandCatalogPreset(p.parameters);
      const risk = phaseRiskFromParameters(parameters);
      expect(
        severity[p.risk],
        `${p.name} is declared "${p.risk}" but analyses as "${risk.level}"`,
      ).toBeGreaterThanOrEqual(analysed[risk.level]);
    }
  });

  it('anchors the low end whenever the image is widened past 130 %', () => {
    for (const p of ALL_PRESETS) {
      const parameters = expandCatalogPreset(p.parameters);
      if (parameters.width > 1.3) {
        expect(parameters.bassMono, `${p.name} is wide with no bass-mono`).toBeGreaterThan(0);
      }
    }
  });

  it('anchors the low end whenever high-band width exceeds 150 %', () => {
    for (const p of ALL_PRESETS) {
      const parameters = expandCatalogPreset(p.parameters);
      if (parameters.widthHigh > 1.5) {
        expect(
          parameters.bassMono,
          `${p.name} boosts high width with no low-frequency anchor`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('sets an explicit spread whenever binaural processing is enabled', () => {
    for (const p of ALL_PRESETS) {
      const parameters = expandCatalogPreset(p.parameters);
      if (parameters.binaural) {
        expect(
          parameters.spread,
          `${p.name} enables binaural without saying how much to spread`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('keeps stacked low-frequency shelves under +6 dB', () => {
    // `sub` (55 Hz shelf) and `warm` (120 Hz shelf) overlap, so they add at 50 Hz.
    for (const p of ALL_PRESETS) {
      const parameters = expandCatalogPreset(p.parameters);
      const stacked = parameters.sub + parameters.warm;
      expect(stacked, `${p.name} stacks ${stacked.toFixed(1)} dB of low shelf`).toBeLessThanOrEqual(
        6,
      );
    }
  });

  it('does not combine an aggressive loudness target with extreme saturation', () => {
    for (const p of ALL_PRESETS) {
      const parameters = expandCatalogPreset(p.parameters);
      if (parameters.normalize && parameters.targetLUFS > -10) {
        expect(parameters.sat, `${p.name}`).toBeLessThanOrEqual(25);
      }
    }
  });

  it('flags presets whose description promises processing they do not perform', () => {
    const promises = [
      { match: /compress/i, keys: ['mbLow', 'mbMid', 'mbHigh'] },
      { match: /depth|bloom/i, keys: ['depth'] },
      { match: /crackle|tape|vinyl|hiss|degrad|oxidis/i, keys: ['tape', 'vinyl', 'hiss', 'sat'] },
      // "transient-preserving" is a promise to do *nothing*, so it must not match here.
      {
        match: /punch|transient (attack|emphasis|shaping)/i,
        keys: ['transAttack', 'mbLow', 'mbMid', 'mbHigh'],
      },
    ];
    for (const p of ALL_PRESETS) {
      const parameters = expandCatalogPreset(p.parameters);
      for (const promise of promises) {
        if (!promise.match.test(p.description)) continue;
        const delivers = promise.keys.some((k) => Math.abs(parameters[k]) > 0);
        expect(
          delivers,
          `"${p.name}" promises ${promise.match} but sets none of ${promise.keys}`,
        ).toBe(true);
      }
    }
  });

  it('leaves normalisation off only where the description says dynamics are preserved', () => {
    for (const p of ALL_PRESETS) {
      const parameters = expandCatalogPreset(p.parameters);
      if (parameters.normalize) continue;
      expect(
        /dynamic|no loudness war|silence|instability|preserve/i.test(`${p.description} ${p.audit}`),
        `${p.name} disables normalisation without explaining why`,
      ).toBe(true);
    }
  });

  it('keeps the restoration group conservative and honest', () => {
    const group = PRESET_GROUPS.find((g) => g.id === 'restoration');
    expect(group).toBeTruthy();
    expect(group.presets.length).toBe(4);
    for (const p of group.presets) {
      expect(p.risk).toBe('safe');
      const parameters = expandCatalogPreset(p.parameters);
      expect(parameters.haas).toBe(0);
      expect(parameters.phaseRot).toBe(0);
      expect(parameters.binaural).toBe(false);
      expect(parameters.width, `${p.name}`).toBeLessThanOrEqual(1.1);
      expect(parameters.sat, `${p.name}`).toBeLessThanOrEqual(5);
      expect(
        /\bstarting point\b|not a repair/i.test(`${p.description} ${p.audit}`),
        `${p.name} does not position itself as a starting point`,
      ).toBe(true);
    }
  });
});
