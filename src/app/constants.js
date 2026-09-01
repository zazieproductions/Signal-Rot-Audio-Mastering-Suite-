/**
 * Engine identity and global constants.
 *
 * `ENGINE_VERSION` is written into every render report, preset file and session file.
 * Bump the minor when parameter semantics change; bump `PRESET_SCHEMA_VERSION` only when
 * a migration is required (see `src/app/preset-migrations.js`).
 */

export const ENGINE_NAME = 'SIGNAL ROT // MASTER';
export const ENGINE_VERSION = '7.1.0';
export const PRESET_SCHEMA_VERSION = 3;

/** Reference-match analysis bands (Hz), log-spaced across the mastering range. */
export const MATCH_FREQS = Object.freeze([60, 150, 400, 1000, 2500, 5000, 8000, 12000]);

/** Multiband crossover frequencies (Hz). Serial LR4 topology; see audio/graph/multiband.js */
export const MB_CROSSOVER_LOW = 140;
export const MB_CROSSOVER_HIGH = 3200;

/** Per-band stereo-width crossover frequencies (Hz), applied on the side channel only. */
export const WIDTH_CROSSOVER_LOW = 250;
export const WIDTH_CROSSOVER_HIGH = 4000;

/**
 * Resource guards. These are deliberately conservative: browsers do not report available
 * memory, and an OfflineAudioContext render allocates roughly
 * `channels * length * 4` bytes *per intermediate copy*.
 */
export const LIMITS = Object.freeze({
  /** Refuse to decode files above this size (bytes). */
  MAX_FILE_BYTES: 512 * 1024 * 1024,
  /** Warn above this decoded duration (seconds). */
  WARN_DURATION_S: 15 * 60,
  /** Hard stop above this decoded duration (seconds). */
  MAX_DURATION_S: 60 * 60,
  /** Warn when an export would exceed this many samples across all channels. */
  WARN_TOTAL_SAMPLES: 400e6,
  /** RIFF chunk sizes are unsigned 32-bit. */
  RIFF_MAX_BYTES: 0xffffffff,
});

/** Sample rates offered for export. Safari historically rejects rates above 96 kHz. */
export const EXPORT_SAMPLE_RATES = Object.freeze([0, 44100, 48000, 88200, 96000, 192000]);

/** Ordered module identifiers for the signal-flow view and the bypass system. */
export const SIGNAL_FLOW = Object.freeze([
  { id: 'match', label: 'MATCH EQ', stage: 'corrective' },
  { id: 'tone', label: 'TONE', stage: 'tonal' },
  { id: 'multiband', label: 'MULTIBAND', stage: 'dynamics' },
  { id: 'stereo', label: 'STEREO', stage: 'spatial' },
  { id: 'character', label: 'CHARACTER', stage: 'colour' },
  { id: 'depth', label: 'DEPTH', stage: 'spatial' },
  { id: 'saturation', label: 'SATURATION', stage: 'colour' },
  { id: 'transient', label: 'TRANSIENT', stage: 'dynamics', exportOnly: true },
  { id: 'normalize', label: 'NORMALIZATION', stage: 'delivery', exportOnly: true },
  { id: 'limiter', label: 'LIMITER', stage: 'delivery', exportOnly: true },
]);
