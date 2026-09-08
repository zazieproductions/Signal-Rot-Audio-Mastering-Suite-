/**
 * The real-world input corpus — a deterministic matrix of awkward audio files.
 *
 * Every byte is synthesised from a seeded PRNG, so the corpus is legal to ship,
 * identical on every machine, and stable across runs. Two consumers:
 *
 *   · `tests/corpus/corpus.test.js`  — verifies the generator round-trips
 *   · `tests/browser/input-corpus.spec.js` — feeds the bytes to a real browser
 *     through the app's own import path and checks what happens
 *
 * Case expectations:
 *   `expect: 'decode'`   — a conforming decoder must decode it; the app must load it
 *   `expect: 'reject'`   — the app must refuse it with a specific message
 *                          (the decoder may still decode some of these; what is
 *                          tested is the *app's* behaviour, not the codec's)
 *   `expect: 'either'`   — decoder-dependent (truncation, exotic layouts); the app
 *                          must either load a sensible result or refuse with a
 *                          specific message — never freeze, crash, or silently
 *                          attach a wrong result
 *
 * `fidelity` carries what a faithful import must preserve (channel means, peaks,
 * L/R relation) so the browser test can prove the decode did not flip polarity,
 * normalise, drop or swap channels.
 */

import { mulberry32, gaussian } from '../../src/audio/dsp/prng.js';
import {
  buildWav,
  CHANNEL_MASKS,
  truncateTail,
  corruptHeader,
  declareOversizedData,
  patchFloat32LE,
} from './wav.js';
import { buildAiff } from './aiff.js';
import lamejs from '@breezystack/lamejs';

const SR = 48000;

/** Deterministic stereo/mono signal generators (Float32Array per channel). */

function tone(f, seconds, rate, amplitude = 0.5, phase = 0) {
  const n = Math.max(1, Math.round(seconds * rate));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin(2 * Math.PI * f * (i / rate) + phase);
  return out;
}

function noise(seconds, rate, seed, amplitude = 0.4) {
  const n = Math.max(1, Math.round(seconds * rate));
  const rng = mulberry32(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * gaussian(rng);
  return out;
}

function constant(value, seconds, rate) {
  return new Float32Array(Math.max(1, Math.round(seconds * rate))).fill(value);
}

/** Very dynamic: near-silent bed with occasional loud transients. */
function dynamic(seconds, rate, seed) {
  const n = Math.max(1, Math.round(seconds * rate));
  const rng = mulberry32(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.01 * gaussian(rng);
  for (let t = 0.2; t < seconds; t += 0.25) {
    const at = Math.floor(t * rate);
    for (let k = 0; k < 1200 && at + k < n; k++) {
      out[at + k] += 0.9 * Math.exp(-k / 220) * Math.sin((2 * Math.PI * 180 * k) / rate);
    }
  }
  return out;
}

/**
 * @typedef {object} CorpusCase
 * @property {string} id
 * @property {string} description
 * @property {'decode'|'reject'|'either'} expect
 * @property {{name:string, mime:string, bytes:Uint8Array}} file
 * @property {{channels?:number, sampleRate?:number, frames?:number}} [shape]  when known
 * @property {object} [fidelity]  channelMeans?:number[], peak?:number, lr?: 'identical'|'opposite'|'independent'|'leftOnly'
 * @property {string[]} [notes]  what the app should say about it
 */

function wavCase(id, description, expect, channels, sampleRate, seconds, opts = {}) {
  const frames = Math.max(1, Math.round(seconds * sampleRate));
  const ch = [];
  for (let c = 0; c < channels; c++)
    ch.push(
      opts.make
        ? opts.make(c, frames, sampleRate, opts.seed ?? 1337 + c)
        : tone(220 + 110 * c, seconds, sampleRate, 0.4),
    );
  const spec = {
    channels: ch,
    sampleRate,
    bitDepth: opts.bitDepth ?? 16,
    info: opts.info,
    chunkOrder: opts.chunkOrder,
    channelMask: opts.channelMask,
    declaredDataFrames: opts.declaredDataFrames,
  };
  let bytes = buildWav(spec);
  if (opts.corrupt) bytes = opts.corrupt(bytes, frames, sampleRate, channels);
  const framesActual = opts.actualFrames ?? frames;
  const fidelity = {};
  if (opts.mean) fidelity.channelMeans = opts.mean;
  if (opts.peak) fidelity.peak = opts.peak;
  if (opts.lr) fidelity.lr = opts.lr;
  return {
    id,
    description,
    expect,
    file: { name: opts.name ?? `${id}.wav`, mime: 'audio/wav', bytes },
    shape: opts.noShape ? undefined : { channels, sampleRate, frames: framesActual },
    ...(fidelity ? { fidelity } : {}),
    notes: opts.notes ?? [],
  };
}

/** MP3 via the same lamejs dependency the app uses for export. */
function mp3Case(id, description, seconds, sampleRate) {
  const n = Math.round(seconds * sampleRate);
  const l = new Int16Array(n);
  const r = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    l[i] = Math.round(0.3 * Math.sin(2 * Math.PI * 440 * t) * 32767);
    r[i] = Math.round(0.22 * Math.sin(2 * Math.PI * 660 * t) * 32767);
  }
  const encoder = new lamejs.Mp3Encoder(2, sampleRate, 128);
  const out = [];
  for (let i = 0; i < n; i += 1152) {
    const block = encoder.encodeBuffer(l.subarray(i, i + 1152), r.subarray(i, i + 1152));
    if (block.length) out.push(new Uint8Array(block));
  }
  const tail = encoder.flush();
  if (tail.length) out.push(new Uint8Array(tail));
  const bytes = out.reduce((acc, b) => acc + b.length, 0);
  const all = new Uint8Array(bytes);
  let o = 0;
  for (const b of out) {
    all.set(b, o);
    o += b.length;
  }
  return {
    id,
    description,
    expect: 'decode',
    file: { name: `${id}.mp3`, mime: 'audio/mpeg', bytes: all },
    shape: { channels: 2, sampleRate },
    notes: [
      'MP3 is lossy — identity is checked against a fresh decode, not against the source samples.',
    ],
  };
}

export function buildCorpus() {
  const cases = [];
  const d = (c) => cases.push(c);

  /* ── shapes and bit depths ─────────────────────────────────────────────── */

  d(
    wavCase('mono-1s-48k-16', 'Mono, 1 s, 48 kHz, 16-bit', 'decode', 1, SR, 1, {
      make: (c, f, sr) => tone(440, f / sr, sr, 0.5),
      mean: [0],
      peak: 0.5,
    }),
  );
  d(
    wavCase('one-sample-441k-16', 'A single 44.1 kHz sample', 'decode', 1, 44100, 1 / 44100, {
      make: (c, f) => new Float32Array([0.5]).subarray(0, Math.max(1, f)),
      actualFrames: 1,
      frames: 1,
      mean: [0.5],
      peak: 0.5,
    }),
  );
  d(
    wavCase('ten-ms-48k-24', '10 ms, 48 kHz, 24-bit', 'decode', 2, SR, 0.01, {
      bitDepth: 24,
    }),
  );
  d(
    wavCase(
      'stereo-1s-441k-16',
      'Stereo, 1 s, 44.1 kHz, 16-bit, independent L/R',
      'decode',
      2,
      44100,
      1,
      {
        make: (c, f, sr) => tone(c === 0 ? 330 : 495, f / sr, sr, 0.4),
        lr: 'independent',
      },
    ),
  );
  d(
    wavCase('stereo-1s-48k-32f', 'Stereo, 1 s, 48 kHz, 32-bit float', 'decode', 2, SR, 1, {
      bitDepth: 32,
    }),
  );

  /* ── content characteristics ───────────────────────────────────────────── */

  d(
    wavCase('dual-mono-48k-16', 'Dual mono (L = R)', 'decode', 2, SR, 1, {
      make: () => tone(350, 1, SR, 0.5),
      mean: [0, 0],
      lr: 'identical',
    }),
  );
  d(
    wavCase(
      'hard-lr-48k-16',
      'Hard L/R: all signal in left, right is silence',
      'decode',
      2,
      SR,
      1,
      {
        make: (c) => (c === 0 ? tone(500, 1, SR, 0.6) : new Float32Array(SR)),
        mean: [0, 0],
        lr: 'leftOnly',
      },
    ),
  );
  d(
    wavCase(
      'opposite-polarity-48k-16',
      'Dual mono at −1.0 gain (polarity inversion)',
      'decode',
      2,
      SR,
      1,
      {
        make: () => {
          const t = tone(350, 1, SR, 0.5);
          const out = new Float32Array(t);
          for (let i = 0; i < out.length; i++) out[i] = -t[i];
          return out;
        },
        mean: [0, 0],
        lr: 'identical',
        notes: ['Import must not re-invert or "correct" the polarity.'],
      },
    ),
  );
  d(
    wavCase('silence-1s-48k-16', 'Digital silence (all zeros)', 'decode', 2, SR, 1, {
      make: () => new Float32Array(SR),
      mean: [0, 0],
      peak: 0,
      notes: ['Loudness analysis must report silence, not crash on log(0).'],
    }),
  );
  d(
    wavCase('near-silence-48k-16', 'Near-silence at −94 dBFS', 'decode', 2, SR, 1, {
      make: () => constant(2e-5, 1, SR),
      mean: [2e-5, 2e-5],
    }),
  );
  d(
    wavCase('dc-offset-48k-16', 'DC offset: constant +0.25', 'decode', 2, SR, 1, {
      make: () => constant(0.25, 1, SR),
      mean: [0.25, 0.25],
      peak: 0.25,
      notes: ['Import must not remove DC or normalise.'],
    }),
  );
  d(
    wavCase('clipped-48k-16', 'Full-scale square wave — clipped integer PCM', 'decode', 2, SR, 1, {
      make: (_c, f) => {
        const out = new Float32Array(f);
        for (let i = 0; i < f; i++) out[i] = i % 240 < 120 ? 1.0 : -1.0;
        return out;
      },
      mean: [0, 0],
      peak: 32767 / 32768,
      notes: ['The 16-bit grid tops out at ±32767/32768; a "clean" import leaves it there.'],
    }),
  );
  d(
    wavCase('sub-heavy-48k-16', 'Sub-heavy: 28 Hz sine at 0 dBFS', 'decode', 2, SR, 2, {
      make: () => tone(28, 2, SR, 0.9),
    }),
  );
  d(
    wavCase('bright-48k-16', 'Very bright: 12 kHz + 17 kHz', 'decode', 2, SR, 1, {
      make: (c, f, sr) => {
        const out = new Float32Array(f);
        for (let i = 0; i < f; i++) {
          const t = i / sr;
          out[i] =
            0.4 * Math.sin(2 * Math.PI * 12000 * t) + 0.3 * Math.sin(2 * Math.PI * 17000 * t);
        }
        return out;
      },
    }),
  );
  d(
    wavCase(
      'loud-mastered-48k-16',
      'Extremely loud: full-range noise at −0.1 dBFS',
      'decode',
      2,
      SR,
      1,
      {
        make: (c, f, sr) => noise(f / sr, sr, 9001 + c, 0.6),
      },
    ),
  );
  d(
    wavCase('very-dynamic-48k-16', 'Very dynamic: quiet bed, loud transients', 'decode', 2, SR, 2, {
      make: (c, f, sr) => dynamic(f / sr, sr, 700 + c),
    }),
  );
  d(
    wavCase(
      'float-above-one-48k-32f',
      '32-bit float with peaks at +1.5 (above full scale)',
      'decode',
      2,
      SR,
      1,
      {
        bitDepth: 32,
        make: () => tone(440, 1, SR, 1.5),
        peak: 1.5,
        notes: ['A conforming float decode must preserve values above 1.0.'],
      },
    ),
  );

  /* ── sample rates the decoders may or may not love ─────────────────────── */

  d(
    wavCase('rate-8k-1s-16-mono', '8 kHz mono (telephone)', 'decode', 1, 8000, 1, {
      make: () => tone(300, 1, 8000, 0.5),
    }),
  );
  d(wavCase('rate-22050-1s-16', '22.05 kHz stereo (half-rate CD)', 'decode', 2, 22050, 1, {}));
  d(wavCase('rate-88200-1s-16', '88.2 kHz stereo', 'decode', 2, 88200, 1, {}));
  d(wavCase('rate-96k-1s-24', '96 kHz stereo, 24-bit', 'decode', 2, 96000, 1, { bitDepth: 24 }));
  d(
    wavCase(
      'rate-176400-half-16',
      '176.4 kHz, half a second (Safari rejects this rate)',
      'either',
      2,
      176400,
      0.5,
      {},
    ),
  );
  d(
    wavCase('rate-192k-half-24', '192 kHz, half a second, 24-bit', 'either', 2, 192000, 0.5, {
      bitDepth: 24,
    }),
  );
  d(
    wavCase(
      'rate-192k-half-32f',
      '192 kHz, half a second, 32-bit float',
      'either',
      2,
      192000,
      0.5,
      { bitDepth: 32 },
    ),
  );

  /* ── channel layouts ───────────────────────────────────────────────────── */

  d(
    wavCase('5-1-1s-48k-16', '5.1 surround (WAVE_FORMAT_EXTENSIBLE)', 'either', 6, SR, 1, {
      channelMask: CHANNEL_MASKS['5.1'],
      make: (c, f, sr) => tone(100 + c * 90, f / sr, sr, 0.4),
      notes: [
        'Signal Rot masters through its 2-channel chain — a fold-down warning is expected, not silence.',
      ],
    }),
  );
  d(
    wavCase('7-1-1s-48k-16', '7.1 surround (WAVE_FORMAT_EXTENSIBLE)', 'either', 8, SR, 1, {
      channelMask: CHANNEL_MASKS['7.1'],
      make: (c, f, sr) => tone(100 + c * 70, f / sr, sr, 0.3),
      notes: ['Fold-down warning expected.'],
    }),
  );
  d(
    wavCase(
      '24ch-1s-48k-16',
      '24-channel object-style layout (the app ceiling)',
      'either',
      24,
      SR,
      1,
      {
        channelMask: CHANNEL_MASKS['7.1'],
        make: (c, f, sr) => tone(80 + c * 40, f / sr, sr, 0.2),
        notes: ['At the 24-channel limit: must load with an explicit multichannel note.'],
      },
    ),
  );
  d(
    wavCase('32ch-1s-48k-16', '32 channels — above the app ceiling', 'either', 32, SR, 1, {
      channelMask: CHANNEL_MASKS['7.1'],
      make: (c, f, sr) => tone(80 + c * 30, f / sr, sr, 0.2),
      notes: ['Must be refused with a specific channel-count message.'],
    }),
  );

  /* ── metadata and container quirks ─────────────────────────────────────── */

  d(
    wavCase('info-unicode-48k-16', 'Heavy RIFF INFO metadata with Unicode', 'decode', 2, SR, 1, {
      name: 'Träumerei 🎛 — 12" master copy.wav',
      info: {
        INAM: 'Träumerei 🎛 — 12" master copy',
        IART: 'SIGNAL ROT // Korpus',
        IGNR: 'QA',
        ICRD: '2026-09-07',
        ICMT: 'Ünïcödé tëst — «quotes» & <tags> — line two',
        ISFT: 'corpus-builder 1',
      },
    }),
  );
  d(
    wavCase(
      'odd-chunk-order-48k-16',
      'data chunk before fmt (odd chunk ordering)',
      'either',
      2,
      SR,
      1,
      {
        chunkOrder: ['data', 'fmt '],
      },
    ),
  );

  /* ── corruption and malformed input ────────────────────────────────────── */

  d(
    wavCase(
      'truncated-data-48k-16',
      'Data chunk cut mid-stream (truncated file)',
      'either',
      2,
      SR,
      1,
      {
        corrupt: (bytes) => truncateTail(bytes, Math.floor(bytes.length * 0.25)),
        notes: [
          'A lenient decoder may deliver the whole first 75 %; a strict one refuses. Both are acceptable — a crash is not.',
        ],
      },
    ),
  );
  d(
    wavCase(
      'oversized-data-decl-48k-16',
      'Data chunk size field larger than the file',
      'either',
      2,
      SR,
      1,
      {
        corrupt: (bytes) => declareOversizedData(bytes, 100000),
      },
    ),
  );
  d(
    wavCase('bad-header-48k-16', 'RIFF/WAVE markers overwritten', 'reject', 2, SR, 1, {
      corrupt: (bytes) => corruptHeader(bytes),
    }),
  );
  d(
    wavCase('zero-length-data-48k-16', 'Valid header, zero frames of audio', 'either', 2, SR, 0, {
      make: () => new Float32Array(1),
      declaredDataFrames: 0,
      actualFrames: 0,
      frames: 0,
      noShape: true,
      notes: ['Must be refused as "no audio samples" or by the decoder — never loaded empty.'],
    }),
  );
  {
    const base = buildWav({ channels: [tone(440, 0.5, SR, 0.4)], sampleRate: SR, bitDepth: 32 });
    const dataStart = 44; // 12 (RIFF) + 24 (fmt, 16 payload) + 8 (data header)
    d({
      id: 'float-nan-48k-32f',
      description: '32-bit float containing a NaN sample',
      expect: 'decode',
      file: {
        name: 'float-nan-48k-32f.wav',
        mime: 'audio/wav',
        bytes: patchFloat32LE(base, dataStart, Number.NaN),
      },
      shape: { channels: 1, sampleRate: SR, frames: Math.round(0.5 * SR) },
      notes: [
        'The decoder usually tolerates NaN; the app must catch it post-decode and refuse with a non-finite-samples message.',
      ],
    });
  }
  {
    const base = buildWav({ channels: [tone(440, 0.5, SR, 0.4)], sampleRate: SR, bitDepth: 32 });
    d({
      id: 'float-inf-48k-32f',
      description: '32-bit float containing an Infinity sample',
      expect: 'decode',
      file: {
        name: 'float-inf-48k-32f.wav',
        mime: 'audio/wav',
        bytes: patchFloat32LE(base, 44, Number.POSITIVE_INFINITY),
      },
      shape: { channels: 1, sampleRate: SR, frames: Math.round(0.5 * SR) },
      notes: ['Must be refused with a non-finite-samples message.'],
    });
  }
  d({
    id: 'empty-file',
    description: 'A 0-byte file',
    expect: 'reject',
    file: { name: 'empty.wav', mime: 'audio/wav', bytes: new Uint8Array(0) },
    notes: ['Refused before any decode is attempted.'],
  });
  d({
    id: 'not-audio-bytes',
    description: '512 bytes of plain text pretending to be audio',
    expect: 'reject',
    file: {
      name: 'notes.txt.wav',
      mime: 'audio/wav',
      bytes: new TextEncoder().encode('this is not audio '.repeat(32)),
    },
  });

  /* ── long-form ─────────────────────────────────────────────────────────── */

  d(
    wavCase(
      'long-3min-441k-16-stereo',
      '3 minutes, 44.1 kHz stereo (the everyday long file)',
      'decode',
      2,
      44100,
      180,
      {
        make: (c, f, sr) => dynamic(f / sr, sr, 300 + c),
      },
    ),
  );
  d(
    wavCase(
      'long-16min-8k-16-mono',
      '16 minutes at 8 kHz mono — above the 15-minute warning line',
      'decode',
      1,
      8000,
      960,
      {
        make: () => tone(250, 960, 8000, 0.2),
        notes: ['Must load with a duration warning ("renders will be slow").'],
      },
    ),
  );
  d(
    wavCase(
      'long-37min-8k-16-mono',
      '37 minutes at 8 kHz mono (still under the 60-minute ceiling)',
      'decode',
      1,
      8000,
      2220,
      {
        make: () => tone(250, 2220, 8000, 0.2),
        notes: ['Must load with a duration warning.'],
      },
    ),
  );
  d(
    wavCase(
      'too-long-61min-8k-16-mono',
      '61 minutes at 8 kHz mono — above the 60-minute ceiling',
      'reject',
      1,
      8000,
      3660,
      {
        make: () => tone(250, 3660, 8000, 0.2),
        notes: ['Must be refused with a specific duration-limit message.'],
      },
    ),
  );

  /* ── compressed/container inputs the corpus can synthesise legally ─────── */

  d(mp3Case('mp3-1s-441k-128k', 'MP3 128 kbit/s, 44.1 kHz stereo', 1, 44100));
  {
    const aiff = buildAiff({
      sampleRate: SR,
      channels: [tone(392, 1, SR, 0.4), tone(523, 1, SR, 0.3)],
    });
    d({
      id: 'aiff-1s-48k-16',
      description: 'AIFF 16-bit, 48 kHz stereo',
      expect: 'decode',
      file: { name: 'aiff-1s-48k-16.aiff', mime: 'audio/aiff', bytes: aiff },
      shape: { channels: 2, sampleRate: SR, frames: SR },
    });
  }

  /* ── filename hazards (content is a plain 1 s stereo tone) ─────────────── */

  d(
    wavCase(
      'name-unicode-emoji',
      'Filename with Unicode, emoji, quotes and spaces',
      'decode',
      2,
      SR,
      1,
      {
        name: `Café 🎚 “O'Brien's” take (final FINAL 2).wav`,
      },
    ),
  );
  d(
    wavCase('name-very-long', 'A 300-character filename', 'decode', 2, SR, 1, {
      name: `${'a'.repeat(300)}.wav`,
    }),
  );
  d(
    wavCase(
      'name-windows-reserved',
      'A filename that is a Windows reserved device name',
      'decode',
      2,
      SR,
      1,
      {
        name: 'CON.wav',
      },
    ),
  );
  d(
    wavCase(
      'name-html-injection',
      'A filename attempting HTML/script injection',
      'decode',
      2,
      SR,
      1,
      {
        name: '<img src=x onerror=alert(1)>.wav',
      },
    ),
  );

  return cases;
}

/** All cases, generated once. */
export const CORPUS = buildCorpus();

/** Look a case up by id. Throws when missing (typo guard for test suites). */
export function caseById(id) {
  const found = CORPUS.find((c) => c.id === id);
  if (!found) throw new Error(`unknown corpus case: ${id}`);
  return found;
}
