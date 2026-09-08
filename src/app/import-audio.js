/**
 * The single import boundary: every audio file — single load, reference load,
 * batch queue — passes through `decodeAudioFile()` before it can become a
 * working buffer.
 *
 * ── What a bad file must do ─────────────────────────────────────────────────
 * Produce **clear refusal + useful explanation**: a specific message naming the
 * file and the reason (empty, oversized, undecodable, truncated, no samples,
 * non-finite data, too many channels, too long). It must never freeze the UI,
 * corrupt state, throw a cryptic exception, or attach a half-decoded result to
 * the wrong file. Every failure path here returns a structured
 * `{ ok: false, errors }` — the caller decides how to surface it.
 *
 * ── What a good file must keep ──────────────────────────────────────────────
 * Fidelity is checked, not assumed: the decoded buffer is the app's source of
 * truth (no re-normalisation, no polarity "correction", no channel
 * reordering), and `validateDecodedBuffer` records what the user should know
 * about it — mono routing, multichannel fold-down, unusual rates, memory class.
 *
 * The browser's decoder is the codec layer. This module never claims universal
 * codec support; it reports what *this* browser could or could not decode and
 * why.
 */

import { LIMITS } from './constants.js';
import { estimateRender } from '../runtime/render-preflight.js';
import { formatBytes } from '../runtime/memory-budget.js';
import { sanitizeFilename, baseNameOf } from '../audio/encode/download.js';

/**
 * The mastering chain runs through the browser's 2-channel graph. Inputs above
 * the ceiling are refused rather than silently collapsed; inputs up to the
 * ceiling load with an explicit fold-down note.
 */
export const MAX_INPUT_CHANNELS = 24;

/** Rates decoders commonly accept — anything else is legal but unusual. */
export const KNOWN_SAMPLE_RATES = Object.freeze([
  8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000,
]);

/** Extensions the import controls advertise (`accept=`) — used for drop filtering. */
export const AUDIO_EXTENSIONS = Object.freeze([
  'wav',
  'mp3',
  'flac',
  'aiff',
  'aif',
  'aifc',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'opus',
  'webm',
]);

/**
 * Cheap heuristic: is this File *plausibly* audio? Files with an `audio/*`
 * MIME are in; extensionless files are judged by name only (a folder drop
 * brings in everything, so being conservative is a feature).
 */
export function looksLikeAudio(file) {
  if (!file) return false;
  const type = String(file.type ?? '').toLowerCase();
  if (type.startsWith('audio/')) return true;
  if (type === '') {
    const dot = file.name.lastIndexOf('.');
    if (dot < 0) return false;
    return AUDIO_EXTENSIONS.includes(file.name.slice(dot + 1).toLowerCase());
  }
  // A declared non-audio type with an audio extension is ambiguous — let the
  // decoder decide; a declared non-audio type without one is a non-audio file.
  const dot = file.name.lastIndexOf('.');
  return dot >= 0 && AUDIO_EXTENSIONS.includes(file.name.slice(dot + 1).toLowerCase());
}

/**
 * Pre-decode checks on the File itself — no bytes touched.
 * @param {File} file
 * @param {{maxBytes?: number}} [opts]
 * @returns {{errors: string[], warnings: string[]}}
 */
export function preflightFile(file, opts = {}) {
  const maxBytes = opts.maxBytes ?? LIMITS.MAX_FILE_BYTES;
  const name = sanitizeFilename(file?.name ?? 'file');
  const errors = [];
  if (file.size === 0) {
    errors.push(`“${name}” is empty (0 bytes) — there is no audio to decode.`);
  } else if (file.size > maxBytes) {
    errors.push(
      `“${name}” is ${formatBytes(file.size)} — the limit is ${formatBytes(maxBytes)}. ` +
        'Decoding it would exhaust this tab’s memory, so it is refused up front.',
    );
  }
  return { errors, warnings: [] };
}

/**
 * Turn a decoder/read failure into a message a human can act on.
 * @param {any} error
 * @param {string} fileName
 */
export function describeDecodeError(error, fileName) {
  const name = sanitizeFilename(fileName);
  const err = error ?? {};
  const label = err?.name ?? err?.message ?? 'decode error';
  if (err.name === 'EncodingError') {
    return (
      `Could not decode “${name}” — the file appears to be truncated or corrupted, ` +
      'or the container uses a codec this browser cannot parse.'
    );
  }
  if (err.name === 'NotSupportedError' || err.name === 'TypeError') {
    return (
      `“${name}” is not supported by this browser's audio decoder. WAV and MP3 work everywhere; ` +
      'FLAC, M4A/AAC, Opus and AIFF depend on the browser — see the About tab for the ' +
      'decoded list of codecs this build actually accepts.'
    );
  }
  if (
    ['ReadError', 'NotReadableError', 'SecurityError', 'InvalidStateError', 'AbortError'].includes(
      err.name,
    )
  ) {
    return `“${name}” could not be read — it may have been moved, deleted, or the OS revoked access. Try again.`;
  }
  return `Could not decode “${name}” (${label}). The file may be corrupted or the codec unsupported by this browser.`;
}

/**
 * Read failure (the file handle itself died between selection and read).
 * @param {any} error
 * @param {string} fileName
 */
export function describeReadError(error, fileName) {
  const name = sanitizeFilename(fileName);
  return (
    `“${name}” could not be read (${error?.name ?? 'read error'}) — ` +
    'it may have been moved, deleted, or access was revoked. Try again.'
  );
}

/**
 * Full post-decode audit of a decoded buffer.
 *
 * @param {AudioBuffer} buffer
 * @param {{name?: string, maxDurationS?: number, warnDurationS?: number, memoryBudgetBytes?: number}} [opts]
 * @returns {{errors: string[], warnings: string[], notes: string[],
 *            memory: {classification: string, expectedPeakBytes: number, label: string}|null}}
 */
export function validateDecodedBuffer(buffer, opts = {}) {
  const name = sanitizeFilename(opts.name ?? 'file');
  const maxDurationS = opts.maxDurationS ?? LIMITS.MAX_DURATION_S;
  const warnDurationS = opts.warnDurationS ?? LIMITS.WARN_DURATION_S;
  const errors = [];
  const warnings = [];
  const notes = [];

  const ch = buffer.numberOfChannels;
  const frames = buffer.length;
  const rate = buffer.sampleRate;
  const rateKhz = Number.isFinite(rate) ? (rate / 1000).toFixed(1) : '0';

  if (!Number.isFinite(frames) || frames < 0 || !Number.isFinite(rate) || rate <= 0) {
    errors.push(
      `“${name}” decoded into an unusable shape (${ch} ch, ${frames} frames, ${rate} Hz) — treating it as corrupted.`,
    );
    return { errors, warnings, notes, memory: null };
  }
  if (frames === 0) {
    errors.push(`“${name}” decoded but contains no audio samples — there is nothing to master.`);
    return { errors, warnings, notes, memory: null };
  }
  if (ch > MAX_INPUT_CHANNELS) {
    errors.push(
      `“${name}” has ${ch} channels; Signal Rot accepts up to ${MAX_INPUT_CHANNELS}. ` +
        'This is not a mastering target — resample it to a supported layout first.',
    );
  }

  // Non-finite samples: a 32-bit float WAV can legally contain NaN/±Inf, and the
  // browser decodes it without complaint. If it reaches the DSP, it poisons every
  // subsequent measurement, so catch it at the boundary.
  if (ch <= MAX_INPUT_CHANNELS) {
    for (let c = 0; c < ch; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        if (!Number.isFinite(data[i])) {
          errors.push(
            `“${name}” contains non-finite (NaN/∞) samples at frame ${i} of channel ${c + 1} ` +
              '— this is a corrupted float file and is refused.',
          );
          break;
        }
      }
      if (errors.length) break;
    }
  }

  const duration = frames / rate;
  const dur = formatDurationShort(duration);
  if (duration > maxDurationS) {
    errors.push(
      `“${name}” is ${dur} long; the limit is ${formatDurationShort(maxDurationS)}. ` +
        'A browser tab cannot hold that much audio.',
    );
  } else if (duration > warnDurationS) {
    warnings.push(
      `“${name}” is ${dur} at ${rateKhz} kHz — analysis and renders will be slow and memory-hungry in a browser tab.`,
    );
  }

  if (ch === 1) {
    notes.push('Input is mono; stereo processing will use explicit dual-mono routing.');
  } else if (ch > 2) {
    notes.push(
      `Input has ${ch} channels; mastering runs through the 2-channel chain, so the browser ` +
        `folds channels 3–${ch} into L/R. The render report records source vs. output layout.`,
    );
  }
  if (!KNOWN_SAMPLE_RATES.includes(rate)) {
    notes.push(
      `Unusual sample rate (${rate} Hz) — decodable, but export rates may be limited by this browser.`,
    );
  }

  // Honest memory preflight for the full-buffer render this file will need.
  let memory = null;
  try {
    memory = estimateRender(
      { channels: ch, frames },
      {
        dsp: 1,
        output: 1,
        ...(opts.memoryBudgetBytes ? { budgetBytes: opts.memoryBudgetBytes } : {}),
      },
    );
  } catch {
    memory = null;
  }
  if (
    memory &&
    (memory.classification === 'VERY HEAVY' || memory.classification === 'LIKELY UNSAFE')
  ) {
    warnings.push(
      `${ch}-channel / ${rateKhz} kHz render of “${name}” may exceed available memory ` +
        `(${memory.classification.toLowerCase()} — about ${formatBytes(memory.expectedPeakBytes)} of float audio).`,
    );
  }

  return { errors, warnings, notes, memory };
}

/** `2:34:56` style duration for messages (the UI's m:ss helper overflows at 60 min). */
export function formatDurationShort(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * The whole import: preflight → read → decode → validate.
 *
 * @param {BaseAudioContext} ctx  a live AudioContext (decode needs one)
 * @param {File} file
 * @param {object} [opts]  forwarded to preflightFile / validateDecodedBuffer
 * @returns {Promise<{ok: true, buffer: AudioBuffer, warnings: string[], notes: string[],
 *                     memory: object|null} | {ok: false, errors: string[], warnings?: string[], notes?: string[]}>}
 */
export async function decodeAudioFile(ctx, file, opts = {}) {
  const pf = preflightFile(file, opts);
  if (pf.errors.length) return { ok: false, errors: pf.errors, warnings: [], notes: [] };

  let bytes;
  try {
    bytes = await file.arrayBuffer();
  } catch (error) {
    return { ok: false, errors: [describeReadError(error, file.name)], warnings: [], notes: [] };
  }

  let buffer;
  try {
    buffer = await ctx.decodeAudioData(bytes);
  } catch (error) {
    console.warn('[signal-rot] decode failed:', file.name, error);
    return { ok: false, errors: [describeDecodeError(error, file.name)], warnings: [], notes: [] };
  }

  const v = validateDecodedBuffer(buffer, { name: file.name, ...opts });
  if (v.errors.length) {
    return { ok: false, errors: v.errors, warnings: v.warnings, notes: v.notes };
  }
  return { ok: true, buffer, warnings: v.warnings, notes: v.notes, memory: v.memory };
}

/**
 * Output naming — professional, predictable, and safe.
 *
 * The source of every generated name is `file.name` (attacker-controlled), so
 * everything flows through `sanitizeFilename`. Unicode is *kept* — a file
 * called “Träumerei 🎛.wav” stays recognisable; only path separators, control
 * characters and Windows-forbidden characters go.
 *
 * Scheme (single export and batch, so a batch of five looks like a series):
 *
 *     TrackName_master_24bit_48k.wav
 *     TrackName_master_320k_44.1k.mp3
 *
 * `uniqueName()` prevents two exports in one session from colliding on the
 * same base name (`…_2.wav`, `…_3.wav`) instead of relying on the browser to
 * invent “(2)”/“(3)” suffixes.
 */

/** `48000 → "48k"`, `44100 → "44.1k"`, `22050 → "22.05k"`. */
export function formatRateKhz(sampleRate) {
  const k = sampleRate / 1000;
  return `${Number.isInteger(k) ? k : k}k`;
}

/** Quality tag for an EXPORT_FORMATS entry. */
export function qualityTag(format) {
  if (format.container === 'mp3') return '320k';
  return `${format.bitDepth}bit`;
}

/**
 * Build a master filename from a source name.
 * @param {{base: string, sampleRate: number, format: {container:string, bitDepth:number, ext:string}}} spec
 */
export function buildMasterName({ base, sampleRate, format }) {
  const b = baseNameOf(base);
  return `${b}_master_${qualityTag(format)}_${formatRateKhz(sampleRate)}.${format.ext}`;
}

/**
 * Hand out a name no other export in this session used yet.
 * @param {string} candidate already-built name
 * @param {Set<string>} used session registry (mutated)
 */
export function uniqueName(candidate, used) {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const dot = candidate.lastIndexOf('.');
  const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
  const ext = dot > 0 ? candidate.slice(dot) : '';
  let n = 2;
  while (used.has(`${stem}_${n}${ext}`)) n += 1;
  const name = `${stem}_${n}${ext}`;
  used.add(name);
  return name;
}
