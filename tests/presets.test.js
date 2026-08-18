import { describe, it, expect } from 'vitest';
import { allPresets, validatePresetCatalog, findPreset } from '../src/lib/presets.js';

describe('preset catalog', () => {
  it('contains the distinctive Signal Rot identity', () => {
    const names = new Set(allPresets().map((p) => p.n));
    for (const n of [
      'Analog Womb', 'Crystal Palace', 'Fourth Dimension', 'Tape Ghost', 'Vinyl Séance',
      'Hyperreal', 'Psychological Horror', 'Dark Ambient Score', 'Obsidian', 'Rust', 'Holographic',
    ]) {
      expect(names.has(n), `missing preset ${n}`).toBe(true);
    }
  });

  it('passes automated validation (every parameter maps and is in range)', () => {
    const r = validatePresetCatalog();
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('finds presets by name', () => {
    expect(findPreset('Obsidian').group).toBe('color');
    expect(findPreset('Holographic').group).toBe('spatial');
    expect(findPreset('Nope')).toBeNull();
  });
});
