/**
 * The preset catalogue.
 *
 * Eight groups: a pristine mastering family led by the Reference HD flagship, the
 * signature and colour groups, and the intentionally strange creative end. Every preset
 * is reviewed against the criteria in
 * `docs/PRESET-SCHEMA.md`: excessive gain, unsafe width, ceiling choice, low-frequency
 * build-up, contradictory settings, description accuracy, clipping risk and phase risk.
 * The per-preset `audit` string records the outcome and is shown in the UI.
 */

import { MASTERING_PRESETS } from './mastering.js';
import { DIMENSION_PRESETS } from './dimension.js';
import { GENRE_PRESETS } from './genre.js';
import { CINEMATIC_PRESETS } from './cinematic.js';
import { MOOD_PRESETS } from './mood.js';
import { COLOR_PRESETS } from './color.js';
import { SPATIAL_PRESETS } from './spatial.js';
import { RESTORATION_PRESETS } from './restoration.js';

export const PRESET_GROUPS = Object.freeze([
  {
    id: 'mastering',
    label: 'Mastering — pristine reference masters',
    presets: MASTERING_PRESETS,
  },
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
  { id: 'restoration', label: 'Restoration / corrective', presets: RESTORATION_PRESETS },
]);

/** Flat list of every preset. */
export const ALL_PRESETS = PRESET_GROUPS.flatMap((g) => g.presets);

/** @param {string} name */
export const findPreset = (name) => ALL_PRESETS.find((p) => p.name === name) ?? null;

export {
  MASTERING_PRESETS,
  DIMENSION_PRESETS,
  GENRE_PRESETS,
  CINEMATIC_PRESETS,
  MOOD_PRESETS,
  COLOR_PRESETS,
  SPATIAL_PRESETS,
  RESTORATION_PRESETS,
};

export { presetFamily, sanitizeForFamily, DEGRADATION_KEYS } from './_shared.js';
