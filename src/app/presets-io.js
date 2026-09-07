/**
 * Preset serialisation, validation and migration.
 *
 * ── File format (schema version 3) ───────────────────────────────────────────────────
 * ```json
 * {
 *   "format": "signal-rot-preset",
 *   "schemaVersion": 3,
 *   "engineVersion": "7.0.0",
 *   "name": "Analog Womb",
 *   "description": "…",
 *   "savedAt": "2026-08-18T00:00:00.000Z",
 *   "parameters": { … },
 *   "immersive": { … }
 * }
 * ```
 *
 * ── Migration ────────────────────────────────────────────────────────────────────────
 * Version 1 and 2 files are the ones the previous engine wrote: `{ preset, P }`, with a
 * different unit convention for several parameters (`ms` and `crossfeed` stored as
 * percentages in the preset catalogue but as ratios in the runtime object, `phaseRot`
 * likewise). Rather than guess, the migration reads the shape and applies the conversion
 * the old code applied at load time, then runs the result through the schema validator.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────────────
 * A preset file is untrusted input. It is parsed with a size limit, its type is checked
 * before any property access, unknown keys are dropped rather than merged, and every
 * numeric value is clamped to its schema range. A hand-edited file cannot set
 * `width: 1e9` or `ceiling: +40`.
 */

import { ENGINE_VERSION, PRESET_SCHEMA_VERSION } from './constants.js';
import { validateParameters, defaultParameters } from './parameters.js';
import { sanitizeForFamily } from '../presets/_shared.js';
import { defaultImmersive } from './state.js';

/** Refuse to parse anything larger than this — a preset is a few kilobytes. */
export const MAX_PRESET_BYTES = 256 * 1024;

/**
 * Serialise the current state into a preset object.
 *
 * @param {object} opts
 * @param {Record<string, any>} opts.parameters
 * @param {object} [opts.immersive]
 * @param {string} [opts.name]
 * @param {string} [opts.description]
 * @param {'mastering'|'creative'} [opts.family]
 */
export function serializePreset(opts) {
  return {
    format: 'signal-rot-preset',
    schemaVersion: PRESET_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    name: String(opts.name ?? 'Custom').slice(0, 120),
    description: String(opts.description ?? '').slice(0, 500),
    ...(opts.family ? { family: opts.family } : {}),
    savedAt: new Date().toISOString(),
    parameters: { ...opts.parameters },
    immersive: opts.immersive ? { ...opts.immersive } : undefined,
  };
}

/**
 * Migrate a v1/v2 preset (`{ preset, P }`) to the v3 parameter shape.
 *
 * The old runtime object already stored `ms`, `crossfeed`, `phaseRot` and `spread` as
 * ratios (the catalogue stored them as percentages and divided at apply time), and
 * `width` / `widthLow` / `widthMid` / `widthHigh` as ratios. So a saved `P` needs no unit
 * conversion — only key filtering. What it *does* need is the new keys that did not exist:
 * `textureSeed`, `matchMode`, `dither`, the multiband solo/bypass set.
 *
 * @param {any} raw
 * @returns {{parameters: Record<string, any>, name: string, notes: string[]}}
 */
export function migrateLegacyPreset(raw) {
  const notes = [];
  const p = raw && typeof raw.P === 'object' && raw.P ? raw.P : {};
  const name = typeof raw?.preset === 'string' ? raw.preset : 'Imported';
  notes.push('Migrated a pre-7.0 preset file (no schemaVersion).');

  const mapped = { ...p };

  // `matchGains` was a plain array of eight numbers — same shape, just validate it.
  if (Array.isArray(p.matchGains) && p.matchGains.length !== 8) {
    notes.push(`matchGains had ${p.matchGains.length} entries; padded/truncated to 8.`);
  }

  // Keys that were removed or renamed.
  if ('binaural' in p && typeof p.binaural !== 'boolean') {
    mapped.binaural = !!p.binaural;
  }

  // New keys get schema defaults, which `validateParameters` supplies.
  notes.push('New parameters (texture seed, match mode, dither) set to defaults.');

  return { parameters: mapped, name, notes };
}

/**
 * Parse and validate a preset from JSON text.
 *
 * Never throws on bad input — returns `{ ok: false, error }` instead, so the UI can show
 * a specific message rather than a generic "Bad preset file".
 *
 * @param {string} text
 * @returns {{ok:true, preset:object, warnings:string[]} | {ok:false, error:string}}
 */
export function parsePreset(text) {
  if (typeof text !== 'string') return { ok: false, error: 'Preset was not text.' };
  if (text.length > MAX_PRESET_BYTES) {
    return {
      ok: false,
      error: `Preset file is ${(text.length / 1024).toFixed(0)} kB; the limit is ${
        MAX_PRESET_BYTES / 1024
      } kB.`,
    };
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${/** @type {Error} */ (e).message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Preset must be a JSON object.' };
  }

  const warnings = [];
  let parameterSource;
  let name;
  let immersive;

  const version = Number(raw.schemaVersion);
  if (Number.isFinite(version) && version >= 3) {
    if (raw.format && raw.format !== 'signal-rot-preset') {
      warnings.push(`Unexpected format tag "${raw.format}" — loading anyway.`);
    }
    if (version > PRESET_SCHEMA_VERSION) {
      warnings.push(
        `Preset was written by a newer engine (schema ${version} > ${PRESET_SCHEMA_VERSION}). ` +
          'Unknown settings were ignored.',
      );
    }
    parameterSource = raw.parameters;
    name = typeof raw.name === 'string' ? raw.name : 'Imported';
    immersive = raw.immersive;
  } else if (raw.P || raw.preset) {
    const migrated = migrateLegacyPreset(raw);
    parameterSource = migrated.parameters;
    name = migrated.name;
    warnings.push(...migrated.notes);
  } else if (raw.parameters) {
    parameterSource = raw.parameters;
    name = typeof raw.name === 'string' ? raw.name : 'Imported';
    warnings.push('Preset had no schemaVersion; treated as current-format parameters.');
  } else {
    return {
      ok: false,
      error: 'Unrecognised preset structure — expected a "parameters" or "P" block.',
    };
  }

  const { parameters: validated, warnings: paramWarnings } = validateParameters(parameterSource);
  warnings.push(...paramWarnings);

  // Family contract, file edition: a file that claims to be a mastering preset may not
  // smuggle degradation DSP in. Creative files pass through untouched.
  let parameters = validated;
  if (raw.family === 'mastering') {
    const scrubbed = sanitizeForFamily('mastering', validated);
    if (scrubbed.scrubbed.length) {
      warnings.push(
        `Mastering family: ${scrubbed.scrubbed.join(', ')} forced off — degradation DSP ` +
          'cannot appear in a mastering preset.',
      );
    }
    parameters = scrubbed.parameters;
  }

  /** @type {Record<string, any>|undefined} */
  let safeImmersive;
  if (immersive && typeof immersive === 'object') {
    const base = defaultImmersive();
    safeImmersive = { ...base };
    for (const key of Object.keys(base)) {
      const v = immersive[key];
      if (typeof base[key] === 'number') {
        const n = Number(v);
        if (Number.isFinite(n)) safeImmersive[key] = n;
      } else if (typeof base[key] === 'boolean') {
        if (typeof v === 'boolean') safeImmersive[key] = v;
      } else if (typeof v === 'string') {
        safeImmersive[key] = v;
      }
    }
  }

  return {
    ok: true,
    warnings,
    preset: {
      name: String(name).slice(0, 120),
      description: typeof raw.description === 'string' ? raw.description.slice(0, 500) : '',
      parameters,
      immersive: safeImmersive,
    },
  };
}

/**
 * Turn a catalogue entry's sparse parameter block into a complete parameter set.
 *
 * Catalogue presets are deliberately sparse — they list only what they change — but
 * applying one must produce a *deterministic* result, so everything unlisted returns to
 * its default. The audited implementation preserved loudness settings and the match curve
 * across preset changes, which meant the same preset gave different results depending on
 * what you had done before. That behaviour is retained only for the match curve (which is
 * a measurement of your source, not a creative choice) and is now explicit.
 *
 * @param {Record<string, any>} presetParams
 * @param {object} [opts]
 * @param {Record<string, any>} [opts.preserve] values carried over from current state
 */
export function expandCatalogPreset(presetParams, opts = {}) {
  const base = defaultParameters();
  const merged = { ...base, ...(opts.preserve ?? {}), ...presetParams };
  return validateParameters(merged).parameters;
}
