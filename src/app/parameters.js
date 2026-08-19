/**
 * Canonical parameter schema.
 *
 * Every user-facing value in the engine is declared here exactly once, with its type,
 * range, unit, display formatter, and — critically — whether it is honoured in the live
 * preview and in the export. Nothing else in the codebase is allowed to invent a default,
 * a limit or a unit conversion.
 *
 * This replaces a global mutable object whose only validation was "whatever the slider
 * happened to send", and whose unit conversions (`/100` here, `*1000` there) were spread
 * across sixty event handlers.
 *
 * ── previewSupported / exportSupported ───────────────────────────────────────────────
 * These two flags drive the real-time-versus-offline matrix in the UI and in
 * `docs/DSP-SIGNAL-FLOW.md`. A parameter marked `previewSupported: false` gets a
 * "export only" badge next to its control, because a mastering tool that quietly does
 * something different when you press export is worse than one that does less.
 *
 * @typedef {object} ParameterSpec
 * @property {string} key
 * @property {'number'|'boolean'|'enum'|'array'} type
 * @property {any} defaultValue
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {string[]} [values]        for `enum`
 * @property {number} [length]          for `array`
 * @property {string} unit
 * @property {string} label
 * @property {string} [hint]
 * @property {(v:any)=>string} displayFormatter
 * @property {boolean} previewSupported
 * @property {boolean} exportSupported
 * @property {string} [previewNote]     shown when previewSupported is false
 * @property {string} group
 */

import { TONE_BANDS } from '../audio/graph/tone.js';

const dB =
  (digits = 1) =>
  (v) =>
    `${v > 0 ? '+' : ''}${v.toFixed(digits)} dB`;
const pct = (v) => `${Math.round(v * 100)} %`;
const raw = (v) => `${Math.round(v)}`;
const rawPct = (v) => `${Math.round(v)} %`;

/** @type {ParameterSpec[]} */
const SPECS = [
  // ── Loudness ─────────────────────────────────────────────────────────────────────
  {
    key: 'normalize',
    type: 'boolean',
    defaultValue: true,
    unit: '',
    label: 'Normalise to target loudness',
    group: 'loudness',
    displayFormatter: (v) => (v ? 'on' : 'off'),
    previewSupported: true,
    exportSupported: true,
    previewNote:
      'Preview applies a static gain from the last analysis; export measures, limits and ' +
      're-measures until the target is actually hit.',
  },
  {
    key: 'targetLUFS',
    type: 'number',
    defaultValue: -14,
    min: -30,
    max: -5,
    step: 0.5,
    unit: 'LUFS',
    label: 'Target integrated loudness',
    group: 'loudness',
    displayFormatter: (v) => `${v.toFixed(1)} LUFS`,
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'ceiling',
    type: 'number',
    defaultValue: -1.0,
    min: -3,
    max: -0.1,
    step: 0.1,
    unit: 'dBTP',
    label: 'True-peak ceiling',
    group: 'loudness',
    displayFormatter: (v) => `${v.toFixed(1)} dBTP`,
    previewSupported: false,
    previewNote:
      'The live monitor uses a DynamicsCompressorNode as a safety limiter. The real ' +
      'look-ahead true-peak limiter runs during export and its result is verified.',
    exportSupported: true,
  },
  {
    key: 'drive',
    type: 'number',
    defaultValue: 0,
    min: 0,
    max: 12,
    step: 0.1,
    unit: 'dB',
    label: 'Input drive',
    hint: 'Level into the whole chain — more drive, more limiting.',
    group: 'loudness',
    displayFormatter: dB(1),
    previewSupported: true,
    exportSupported: true,
  },

  // ── Tone ─────────────────────────────────────────────────────────────────────────
  ...TONE_BANDS.map((band) => ({
    key: band.key,
    type: /** @type {const} */ ('number'),
    defaultValue: 0,
    min: -12,
    max: 12,
    step: 0.1,
    unit: 'dB',
    label: band.label,
    hint: band.hint,
    group: 'tone',
    displayFormatter: dB(1),
    previewSupported: true,
    exportSupported: true,
  })),
  {
    key: 'tilt',
    type: 'number',
    defaultValue: 0,
    min: -6,
    max: 6,
    step: 0.1,
    unit: 'dB',
    label: 'Tilt',
    hint: 'Hinged shelves at 1 kHz — negative is darker, positive is brighter.',
    group: 'tone',
    displayFormatter: dB(1),
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'sat',
    type: 'number',
    defaultValue: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Saturation',
    hint: 'Waveshaper harmonic colour. Peak-normalised, so it adds character, not level.',
    group: 'tone',
    displayFormatter: rawPct,
    previewSupported: true,
    exportSupported: true,
  },

  // ── Multiband ────────────────────────────────────────────────────────────────────
  {
    key: 'mbLow',
    type: 'number',
    defaultValue: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: '',
    label: 'Low band — glue & weight',
    group: 'dynamics',
    displayFormatter: raw,
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'mbMid',
    type: 'number',
    defaultValue: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: '',
    label: 'Mid band — density & body',
    group: 'dynamics',
    displayFormatter: raw,
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'mbHigh',
    type: 'number',
    defaultValue: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: '',
    label: 'High band — polish & control',
    group: 'dynamics',
    displayFormatter: raw,
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'mbMix',
    type: 'number',
    defaultValue: 100,
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Parallel mix',
    hint: 'Below 100 % blends the compressed signal under a phase-matched dry path.',
    group: 'dynamics',
    displayFormatter: rawPct,
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'mbSpeed',
    type: 'enum',
    defaultValue: 'med',
    values: ['fast', 'med', 'slow'],
    unit: '',
    label: 'Ballistics',
    group: 'dynamics',
    displayFormatter: (v) => String(v),
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'mbAutoMakeup',
    type: 'boolean',
    defaultValue: false,
    unit: '',
    label: 'Auto make-up gain',
    hint: 'Conservative rule-of-thumb compensation per band. Off by default.',
    group: 'dynamics',
    displayFormatter: (v) => (v ? 'on' : 'off'),
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'mbSolo',
    type: 'enum',
    defaultValue: 'none',
    values: ['none', 'low', 'mid', 'high'],
    unit: '',
    label: 'Solo band',
    group: 'dynamics',
    displayFormatter: (v) => String(v),
    previewSupported: true,
    exportSupported: false,
    previewNote: 'Monitoring only — solo is never applied to an export.',
  },
  {
    key: 'mbBypassLow',
    type: 'boolean',
    defaultValue: false,
    unit: '',
    label: 'Bypass low band',
    group: 'dynamics',
    displayFormatter: (v) => (v ? 'bypassed' : 'active'),
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'mbBypassMid',
    type: 'boolean',
    defaultValue: false,
    unit: '',
    label: 'Bypass mid band',
    group: 'dynamics',
    displayFormatter: (v) => (v ? 'bypassed' : 'active'),
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'mbBypassHigh',
    type: 'boolean',
    defaultValue: false,
    unit: '',
    label: 'Bypass high band',
    group: 'dynamics',
    displayFormatter: (v) => (v ? 'bypassed' : 'active'),
    previewSupported: true,
    exportSupported: true,
  },

  // ── Transient ────────────────────────────────────────────────────────────────────
  {
    key: 'transAttack',
    type: 'number',
    defaultValue: 0,
    min: -100,
    max: 100,
    step: 1,
    unit: '',
    label: 'Attack — punch emphasis',
    hint: '±100 maps to ±6 dB of transient emphasis. Level-independent.',
    group: 'dynamics',
    displayFormatter: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`,
    previewSupported: false,
    previewNote: 'Export only — per-sample gain needs an offline pass.',
    exportSupported: true,
  },
  {
    key: 'transSustain',
    type: 'number',
    defaultValue: 0,
    min: -100,
    max: 100,
    step: 1,
    unit: '',
    label: 'Sustain — body emphasis',
    group: 'dynamics',
    displayFormatter: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`,
    previewSupported: false,
    previewNote: 'Export only — per-sample gain needs an offline pass.',
    exportSupported: true,
  },

  // ── Stereo ───────────────────────────────────────────────────────────────────────
  {
    key: 'width',
    type: 'number',
    defaultValue: 1,
    min: 0,
    max: 2.5,
    step: 0.01,
    unit: '×',
    label: 'Width',
    hint: 'Side-channel gain. 0 = mono, 1 = unchanged, 2 = double side energy.',
    group: 'stereo',
    displayFormatter: pct,
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'ms',
    type: 'number',
    defaultValue: 0,
    min: -1,
    max: 1,
    step: 0.01,
    unit: '',
    label: 'Mid / side balance',
    group: 'stereo',
    displayFormatter: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`,
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'bassMono',
    type: 'number',
    defaultValue: 0,
    min: 0,
    max: 400,
    step: 5,
    unit: 'Hz',
    label: 'Mono below',
    hint: '4th-order Linkwitz-Riley high-pass on the side channel: 24 dB/octave.',
    group: 'stereo',
    displayFormatter: (v) => (v > 0 ? `${Math.round(v)} Hz` : 'off'),
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'haas',
    type: 'number',
    defaultValue: 0,
    min: 0,
    max: 35,
    step: 0.5,
    unit: 'ms',
    label: 'Haas delay',
    hint: 'Delays one whole output channel. Destructive in mono above ~8 ms.',
    group: 'stereo',
    displayFormatter: (v) => `${v.toFixed(1)} ms`,
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'haasSide',
    type: 'enum',
    defaultValue: 1,
    values: [1, -1],
    unit: '',
    label: 'Haas side',
    group: 'stereo',
    displayFormatter: (v) => (v >= 0 ? 'right' : 'left'),
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'crossfeed',
    type: 'number',
    defaultValue: 0,
    min: 0,
    max: 1,
    step: 0.01,
    unit: '',
    label: 'Crossfeed',
    hint: 'Delayed, low-passed bleed between channels — headphone glue, not HRTF.',
    group: 'stereo',
    displayFormatter: pct,
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'phaseRot',
    type: 'number',
    defaultValue: 0,
    min: 0,
    max: 1,
    step: 0.01,
    unit: '',
    label: 'Side comb / all-pass blend',
    hint: 'Blends an all-passed side signal against the dry side. This is a comb filter.',
    group: 'stereo',
    displayFormatter: pct,
    previewSupported: true,
    exportSupported: true,
  },

  // ── Spatial ──────────────────────────────────────────────────────────────────────
  {
    key: 'widthLow',
    type: 'number',
    defaultValue: 1,
    min: 0,
    max: 2,
    step: 0.01,
    unit: '×',
    label: 'Low width (< 250 Hz)',
    group: 'spatial',
    displayFormatter: pct,
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'widthMid',
    type: 'number',
    defaultValue: 1,
    min: 0,
    max: 2,
    step: 0.01,
    unit: '×',
    label: 'Mid width (250 Hz – 4 kHz)',
    group: 'spatial',
    displayFormatter: pct,
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'widthHigh',
    type: 'number',
    defaultValue: 1,
    min: 0,
    max: 2.5,
    step: 0.01,
    unit: '×',
    label: 'High width (> 4 kHz)',
    group: 'spatial',
    displayFormatter: pct,
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'depth',
    type: 'number',
    defaultValue: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Depth',
    hint: 'Two filtered early reflections. Not a reverb — no tail, no diffusion.',
    group: 'spatial',
    displayFormatter: rawPct,
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'depthSize',
    type: 'enum',
    defaultValue: 'med',
    values: ['small', 'med', 'large'],
    unit: '',
    label: 'Space size',
    group: 'spatial',
    displayFormatter: (v) => String(v),
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'binaural',
    type: 'boolean',
    defaultValue: false,
    unit: '',
    label: 'Binaural processing',
    hint: 'Crossfeed + interaural delay + width. Not HRTF, not head-tracked.',
    group: 'spatial',
    displayFormatter: (v) => (v ? 'on' : 'off'),
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'spread',
    type: 'number',
    defaultValue: 0,
    min: 0,
    max: 1,
    step: 0.01,
    unit: '',
    label: 'Spatial spread',
    group: 'spatial',
    displayFormatter: pct,
    previewSupported: true,
    exportSupported: true,
  },

  // ── Character ────────────────────────────────────────────────────────────────────
  {
    key: 'tape',
    type: 'number',
    defaultValue: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Tape',
    hint: 'Wow, flutter, drift and a 60 Hz head bump. Not a tape-machine model.',
    group: 'character',
    displayFormatter: rawPct,
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'hiss',
    type: 'number',
    defaultValue: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Hiss bed',
    hint: 'Seeded Gaussian noise, decorrelated between channels.',
    group: 'character',
    displayFormatter: rawPct,
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'vinyl',
    type: 'number',
    defaultValue: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Vinyl',
    hint: 'Crackle, rumble and a progressive HF roll-off to 15 kHz.',
    group: 'character',
    displayFormatter: rawPct,
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'textureSeed',
    type: 'number',
    defaultValue: 0x5164a17,
    min: 0,
    max: 0xffffffff,
    step: 1,
    unit: '',
    label: 'Texture seed',
    hint: 'Same seed + same settings = byte-identical export.',
    group: 'character',
    displayFormatter: (v) => `#${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`,
    previewSupported: true,
    exportSupported: true,
  },

  // ── Match ────────────────────────────────────────────────────────────────────────
  {
    key: 'matchStrength',
    type: 'number',
    defaultValue: 0,
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Match strength',
    group: 'match',
    displayFormatter: rawPct,
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'matchMode',
    type: 'enum',
    defaultValue: 'balanced',
    values: ['broad', 'balanced', 'precise'],
    unit: '',
    label: 'Match mode',
    group: 'match',
    displayFormatter: (v) => String(v),
    previewSupported: true,
    exportSupported: true,
  },
  {
    key: 'matchGains',
    type: 'array',
    defaultValue: [0, 0, 0, 0, 0, 0, 0, 0],
    length: 8,
    min: -12,
    max: 12,
    unit: 'dB',
    label: 'Match curve',
    group: 'match',
    displayFormatter: (v) => v.map((g) => g.toFixed(1)).join(', '),
    previewSupported: true,
    exportSupported: true,
  },

  // ── Export ───────────────────────────────────────────────────────────────────────
  {
    key: 'dither',
    type: 'enum',
    defaultValue: 'tpdf',
    values: ['none', 'tpdf', 'shaped'],
    unit: '',
    label: 'Dither',
    hint: 'Applied to 16- and 24-bit integer output only. Never to 32-bit float.',
    group: 'export',
    displayFormatter: (v) => String(v),
    previewSupported: false,
    previewNote: 'Applies at the quantisation step during export.',
    exportSupported: true,
  },
];

/** @type {Record<string, ParameterSpec>} */
export const PARAMETERS = Object.freeze(Object.fromEntries(SPECS.map((s) => [s.key, s])));

/** Ordered list, useful for iteration and documentation generation. */
export const PARAMETER_LIST = Object.freeze(SPECS);

/** A fresh default parameter object. */
export function defaultParameters() {
  /** @type {Record<string, any>} */
  const out = {};
  for (const spec of SPECS) {
    out[spec.key] = spec.type === 'array' ? spec.defaultValue.slice() : spec.defaultValue;
  }
  return out;
}

/**
 * Coerce and clamp one value against its spec.
 * Returns the spec default for anything unusable, never `undefined` and never `NaN`.
 *
 * @param {string} key
 * @param {any} value
 */
export function coerceParameter(key, value) {
  const spec = PARAMETERS[key];
  if (!spec) return undefined;

  switch (spec.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : !!value && value !== 'false';
    case 'enum':
      return spec.values.includes(value) ? value : spec.defaultValue;
    case 'array': {
      const src = Array.isArray(value) ? value : [];
      const out = new Array(spec.length);
      for (let i = 0; i < spec.length; i++) {
        const n = Number(src[i]);
        out[i] = Number.isFinite(n) ? Math.min(Math.max(n, spec.min), spec.max) : 0;
      }
      return out;
    }
    case 'number':
    default: {
      const n = Number(value);
      if (!Number.isFinite(n)) return spec.defaultValue;
      return Math.min(Math.max(n, spec.min), spec.max);
    }
  }
}

/**
 * Validate an arbitrary object into a complete, safe parameter set.
 *
 * Unknown keys are dropped (not merged), missing keys take their defaults, and every value
 * is clamped. This is the *only* way external data — a preset file, a URL, a session
 * restore — enters the engine.
 *
 * @param {any} input
 * @returns {{parameters: Record<string, any>, warnings: string[]}}
 */
export function validateParameters(input) {
  const warnings = [];
  const out = defaultParameters();
  if (!input || typeof input !== 'object') {
    return { parameters: out, warnings: ['Parameter block was missing or not an object.'] };
  }

  for (const [key, value] of Object.entries(input)) {
    if (!PARAMETERS[key]) {
      warnings.push(`Unknown parameter "${key}" ignored.`);
      continue;
    }
    const coerced = coerceParameter(key, value);
    const spec = PARAMETERS[key];
    if (spec.type === 'number' && Number.isFinite(Number(value)) && coerced !== Number(value)) {
      warnings.push(
        `"${key}" was ${value}; clamped to ${coerced} (allowed ${spec.min}…${spec.max} ${spec.unit}).`,
      );
    }
    out[key] = coerced;
  }
  return { parameters: out, warnings };
}

/** Format a value for display using its spec's formatter. */
export function formatParameter(key, value) {
  const spec = PARAMETERS[key];
  if (!spec) return String(value);
  try {
    return spec.displayFormatter(value);
  } catch {
    return String(value);
  }
}

/** Every parameter that behaves differently in preview than in export. */
export function previewDivergences() {
  return PARAMETER_LIST.filter((s) => !s.previewSupported).map((s) => ({
    key: s.key,
    label: s.label,
    note: s.previewNote ?? 'Applied during export only.',
  }));
}
