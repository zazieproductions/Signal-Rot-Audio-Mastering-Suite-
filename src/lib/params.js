/**
 * Signal Rot — canonical parameter model.
 *
 * Every parameter has a canonical storage form (the `P` object), a numeric range or enum,
 * and a catalog form used by the built-in preset catalogs (a few values are expressed in
 * UI units there — e.g. ms/crossfeed/phaseRot/spread are 0..100 in catalogs but 0..1 canonical).
 *
 * All import paths (session files, preset JSON, built-in catalogs) are coerced through
 * `clampState` / `catalogToState` so malformed or legacy values never reach the DSP.
 */
import { clamp } from './math.js';

export const DEFAULT_MATCH_GAINS = [0, 0, 0, 0, 0, 0, 0, 0];

export const DEFAULTS = Object.freeze({
  normalize: true,
  targetLUFS: -14,
  ceiling: -0.1,
  drive: 0,
  width: 1.0,
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
  air: 0,
  tilt: 0,
  sat: 0,
  mbLow: 0,
  mbMid: 0,
  mbHigh: 0,
  mbMix: 100,
  mbSpeed: 'med',
  mbLowOn: true,
  mbMidOn: true,
  mbHighOn: true,
  mbSolo: 0,
  widthLow: 1.0,
  widthMid: 1.0,
  widthHigh: 1.0,
  tape: 0,
  hiss: 0,
  vinyl: 0,
  depth: 0,
  depthSize: 'med',
  transAttack: 0,
  transSustain: 0,
  matchStrength: 0,
  matchGains: DEFAULT_MATCH_GAINS,
  textureSeed: 0,
  dither: 'off',
  monitorMode: 'stereo',
  bypassEq: false,
  bypassMB: false,
  bypassStereo: false,
  bypassChar: false,
  bypassDepth: false,
  bypassSat: false,
  bypassMatch: false,
  bypassLimiter: false,
});

const ENUMS = {
  mbSpeed: ['fast', 'med', 'slow'],
  depthSize: ['small', 'med', 'large'],
  dither: ['off', 'tpdf'],
  monitorMode: ['stereo', 'mono', 'side'],
  haasSide: [-1, 1],
};

const NUM_RANGES = {
  targetLUFS: [-24, -6],
  ceiling: [-6, 0],
  drive: [0, 12],
  width: [0, 2.5],
  ms: [-1, 1],
  bassMono: [0, 400],
  haas: [0, 35],
  crossfeed: [0, 1],
  phaseRot: [0, 1],
  spread: [0, 1],
  sub: [-12, 12],
  warm: [-12, 12],
  body: [-12, 12],
  harsh: [-12, 12],
  clarity: [-12, 12],
  air: [-12, 12],
  tilt: [-6, 6],
  sat: [0, 100],
  mbLow: [0, 100],
  mbMid: [0, 100],
  mbHigh: [0, 100],
  mbMix: [0, 100],
  mbSolo: [0, 3],
  widthLow: [0, 2],
  widthMid: [0, 2],
  widthHigh: [0, 2.5],
  tape: [0, 100],
  hiss: [0, 100],
  vinyl: [0, 100],
  depth: [0, 100],
  transAttack: [-100, 100],
  transSustain: [-100, 100],
  matchStrength: [0, 100],
  textureSeed: [0, 4294967295],
};

const BOOLS = [
  'normalize', 'binaural', 'mbLowOn', 'mbMidOn', 'mbHighOn',
  'bypassEq', 'bypassMB', 'bypassStereo', 'bypassChar', 'bypassDepth',
  'bypassSat', 'bypassMatch', 'bypassLimiter',
];

/** Keys whose catalog (built-in preset) representation is 0..100 → canonical 0..1. */
const CATALOG_RATIO100 = new Set(['ms', 'crossfeed', 'phaseRot', 'spread']);

function clampScalar(key, value) {
  if (ENUMS[key]) return ENUMS[key].includes(value) ? value : DEFAULTS[key];
  if (BOOLS.includes(key)) return value === true || value === 1;
  if (NUM_RANGES[key]) {
    if (typeof value !== 'number' || Number.isNaN(value)) return DEFAULTS[key];
    const [lo, hi] = NUM_RANGES[key];
    const rounded = key === 'textureSeed' || key === 'mbSolo' ? Math.round(value) : value;
    return clamp(rounded, lo, hi);
  }
  return value;
}

/** Clamp a canonical (session/preset-file) state object, keeping only known keys. */
export function clampState(obj) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'matchGains') {
      const mg = obj.matchGains;
      out.matchGains = Array.isArray(mg)
        ? DEFAULT_MATCH_GAINS.map((d, i) => clamp(Number(mg[i]) || 0, -8, 8))
        : [...DEFAULT_MATCH_GAINS];
      continue;
    }
    out[key] = obj[key] !== undefined ? clampScalar(key, obj[key]) : DEFAULTS[key];
  }
  return out;
}

/**
 * Convert a built-in catalog preset (UI-unit form) into canonical values.
 * Only the keys present in the catalog object are returned.
 */
export function catalogToState(obj) {
  const out = {};
  for (const key of Object.keys(obj)) {
    if (!(key in DEFAULTS)) continue;
    let v = obj[key];
    if (CATALOG_RATIO100.has(key)) v = v / 100;
    out[key] = clampScalar(key, v);
  }
  if ('matchGains' in out && !Array.isArray(out.matchGains)) {
    out.matchGains = [...DEFAULT_MATCH_GAINS];
  }
  return out;
}

/** Full canonical copy of the defaults (mutable) — use for fresh sessions. */
export function defaultState() {
  return clampState(DEFAULTS);
}

/** Validate a state object; returns { ok, problems } describing anything out of contract. */
export function validateState(obj) {
  const problems = [];
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in obj)) {
      problems.push(`missing key: ${key}`);
      continue;
    }
    if (key === 'matchGains') {
      if (!Array.isArray(obj.matchGains) || obj.matchGains.length !== 8) {
        problems.push('matchGains must be an 8-element array');
      }
      continue;
    }
    const v = obj[key];
    if (ENUMS[key] && !ENUMS[key].includes(v)) problems.push(`${key}: invalid enum ${v}`);
    else if (BOOLS.includes(key) && typeof v !== 'boolean') problems.push(`${key}: expected boolean`);
    else if (NUM_RANGES[key] && (typeof v !== 'number' || Number.isNaN(v) || v < NUM_RANGES[key][0] || v > NUM_RANGES[key][1])) {
      problems.push(`${key}: out of range ${v}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Compact human description used in tooltips and diagnostics. */
export function describeParam(key, value) {
  const units = {
    targetLUFS: 'LUFS', drive: 'dB', width: '%', ms: '%', bassMono: 'Hz', haas: 'ms',
    crossfeed: '%', phaseRot: '%', spread: '%', sub: 'dB', warm: 'dB', body: 'dB',
    harsh: 'dB', clarity: 'dB', air: 'dB', tilt: 'dB', sat: '%', mbLow: '%', mbMid: '%',
    mbHigh: '%', mbMix: '%', widthLow: '%', widthMid: '%', widthHigh: '%', tape: '%',
    hiss: '%', vinyl: '%', depth: '%', transAttack: '%', transSustain: '%', matchStrength: '%',
  };
  if (key in units) {
    if (key === 'ms' || key === 'crossfeed' || key === 'phaseRot' || key === 'spread') {
      return `${(value * 100).toFixed(0)}${units[key]}`;
    }
    return `${value}${units[key]}`;
  }
  return `${key}=${value}`;
}
