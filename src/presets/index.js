/**
 * The preset catalogue.
 *
 * Six groups, forty presets, every one of them reviewed against the criteria in
 * `docs/PRESET-SCHEMA.md`: excessive gain, unsafe width, ceiling choice, low-frequency
 * build-up, contradictory settings, description accuracy, clipping risk and phase risk.
 * The per-preset `audit` string records the outcome and is shown in the UI.
 */

import { DIMENSION_PRESETS } from './dimension.js';
import { GENRE_PRESETS } from './genre.js';
import { CINEMATIC_PRESETS } from './cinematic.js';
import { MOOD_PRESETS } from './mood.js';
import { COLOR_PRESETS } from './color.js';
import { SPATIAL_PRESETS } from './spatial.js';

export const PRESET_GROUPS = Object.freeze([
  {
    id: 'dimension',
    label: 'Dimension — the signature engines',
    presets: DIMENSION_PRESETS,
  },
  { id: 'genre', label: 'Genre / character — one-tap masters', presets: GENRE_PRESETS },
  { id: 'cinematic', label: 'Cinematic / scoring', presets: CINEMATIC_PRESETS },
  { id: 'mood', label: 'Mood', presets: MOOD_PRESETS },
  { id: 'color', label: 'Colour', presets: COLOR_PRESETS },
  { id: 'spatial', label: 'Spatial', presets: SPATIAL_PRESETS },
]);

/** Flat list of every preset. */
export const ALL_PRESETS = PRESET_GROUPS.flatMap((g) => g.presets);

/** @param {string} name */
export const findPreset = (name) => ALL_PRESETS.find((p) => p.name === name) ?? null;

export {
  DIMENSION_PRESETS,
  GENRE_PRESETS,
  CINEMATIC_PRESETS,
  MOOD_PRESETS,
  COLOR_PRESETS,
  SPATIAL_PRESETS,
};
