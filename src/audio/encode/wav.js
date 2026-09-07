/**
 * RIFF/WAVE encoder.
 *
 * Supports:
 *  · `WAVE_FORMAT_PCM` (0x0001) 16/24-bit and `WAVE_FORMAT_IEEE_FLOAT` (0x0003) 32-bit,
 *    used for plain mono/stereo files.
 *  · `WAVE_FORMAT_EXTENSIBLE` (0xFFFE) with a channel mask, required for anything above
 *    two channels if a player is to route the channels correctly.
 *
 * ── Integer conversion ───────────────────────────────────────────────────────────────
 * Two's-complement fixed point is asymmetric: 16-bit spans −32768…+32767. Scaling by
 * 32768 and clamping to +32767 is the conventional choice — it preserves the full negative
 * range and costs 0.0003 dB at the positive extreme. The alternative (scaling by 32767)
 * loses 0.0003 dB everywhere and cannot represent digital silence's neighbour exactly.
 * The clamp is applied *after* rounding so that a sample at exactly +1.0 does not wrap to
 * −32768, which is the classic off-by-one that produces a full-scale click.
 *
 * ── Size limits ──────────────────────────────────────────────────────────────────────
 * RIFF chunk sizes are unsigned 32-bit. A file above 4 GiB cannot be described by a plain
 * RIFF header, so this encoder promotes the container to RF64 (EBU Tech 3306) — or BW64
 * (ITU-R BS.2088) when asked — writing a `ds64` chunk with the real 64-bit sizes and the
 * 0xFFFFFFFF sentinel in the 32-bit fields. Small files stay ordinary RIFF, which is what
 * every player understands. A wrapped 32-bit size is never written: if a size cannot be
 * represented honestly the writer throws. See `riff-layout.js` for the arithmetic.
 */

import { clamp } from '../dsp/math.js';
import {
  CONTAINER,
  MAX_BUFFERED_BYTES,
  planRiffContainer,
  writeRiffHeader,
} from './riff-layout.js';

/** Standard `WAVEFORMATEXTENSIBLE` channel-mask bits (`ksmedia.h` `SPEAKER_*`). */
export const SPEAKER_MASK = Object.freeze({
  FRONT_LEFT: 0x1,
  FRONT_RIGHT: 0x2,
  FRONT_CENTER: 0x4,
  LOW_FREQUENCY: 0x8,
  BACK_LEFT: 0x10,
  BACK_RIGHT: 0x20,
  FRONT_LEFT_OF_CENTER: 0x40,
  FRONT_RIGHT_OF_CENTER: 0x80,
  BACK_CENTER: 0x100,
  SIDE_LEFT: 0x200,
  SIDE_RIGHT: 0x400,
  TOP_CENTER: 0x800,
  TOP_FRONT_LEFT: 0x1000,
  TOP_FRONT_CENTER: 0x2000,
  TOP_FRONT_RIGHT: 0x4000,
  TOP_BACK_LEFT: 0x8000,
  TOP_BACK_CENTER: 0x10000,
  TOP_BACK_RIGHT: 0x20000,
});

/** KSDATAFORMAT_SUBTYPE_PCM / _IEEE_FLOAT GUID tails (bytes 4..15, shared). */
const GUID_TAIL = [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

/**
 * Write an ASCII FourCC / string into a DataView.
 * @param {DataView} v @param {number} offset @param {string} s
 */
export function writeAscii(v, offset, s) {
  for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i) & 0x7f);
  return offset + s.length;
}

/**
 * Convert a normalised float sample to a two's-complement integer of `bitDepth` bits.
 * @param {number} s
 * @param {number} bitDepth 16 | 24
 */
export function floatToInt(s, bitDepth) {
  const scale = Math.pow(2, bitDepth - 1);
  const v = Math.round(clamp(s, -1, 1) * scale);
  return clamp(v, -scale, scale - 1);
}

/**
 * @typedef {object} WavOptions
 * @property {16|24|32} bitDepth
 * @property {number} [channelMask] when present (or channels > 2) writes WAVE_FORMAT_EXTENSIBLE
 * @property {boolean} [forceExtensible]
 * @property {'auto'|'riff'|'rf64'|'bw64'} [container] default `'auto'` — RIFF while the
 *   sizes fit in 32 bits, otherwise BW64. Force `'rf64'`/`'bw64'` to test the 64-bit path.
 * @property {number} [maxBufferedBytes] override the practical ArrayBuffer ceiling
 */

/**
 * Encode `AudioData` as a RIFF/WAVE file.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data
 * @param {WavOptions} opts
 * @returns {Blob}
 */
export function writeWav(data, opts) {
  const { bitDepth } = opts;
  if (![16, 24, 32].includes(bitDepth)) {
    throw new Error(`writeWav: unsupported bit depth ${bitDepth}`);
  }
  const ch = data.channels.length;
  const sr = data.sampleRate;
  const n = data.length;
  // A fmt chunk declaring 0 channels or 0 Hz is structurally parseable and semantically
  // meaningless: byteRate and blockAlign both collapse to zero and a decoder either
  // divides by zero or invents a rate. Refuse rather than emit something ambiguous.
  if (!Number.isInteger(ch) || ch < 1 || ch > 65535) {
    throw new Error(`writeWav: ${ch} channels cannot be described by a fmt chunk`);
  }
  if (!Number.isInteger(sr) || sr < 8000 || sr > 768000) {
    throw new Error(
      `writeWav: sample rate ${sr} is not a plausible audio rate. A fmt chunk declaring it ` +
        'would be ambiguous or unplayable.',
    );
  }
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`writeWav: invalid frame count ${n}`);
  }
  if (data.channels.some((c) => !c || c.length < n)) {
    throw new Error(
      'writeWav: a channel is shorter than the declared frame count. Refusing to write a ' +
        'file padded with undefined samples.',
    );
  }
  const isFloat = bitDepth === 32;
  const bps = bitDepth / 8;
  const blockAlign = ch * bps;
  const dataLen = n * blockAlign;

  const extensible = opts.forceExtensible || ch > 2 || opts.channelMask !== undefined;
  const fmtLen = extensible ? 40 : 16;

  const plan = planRiffContainer({
    chunks: [
      { id: 'fmt ', size: fmtLen },
      { id: 'data', size: dataLen },
    ],
    sampleCount: n,
    mode: opts.container ?? 'auto',
    maxBufferedBytes: opts.maxBufferedBytes ?? MAX_BUFFERED_BYTES,
  });
  const dataPad = dataLen % 2;

  const ab = new ArrayBuffer(plan.totalBytes);
  const v = new DataView(ab);
  let o = writeRiffHeader(v, plan);

  o = writeAscii(v, o, 'fmt ');
  v.setUint32(o, fmtLen, true);
  o += 4;
  v.setUint16(o, extensible ? 0xfffe : isFloat ? 3 : 1, true);
  o += 2;
  v.setUint16(o, ch, true);
  o += 2;
  v.setUint32(o, sr, true);
  o += 4;
  v.setUint32(o, sr * blockAlign, true);
  o += 4;
  v.setUint16(o, blockAlign, true);
  o += 2;
  v.setUint16(o, bitDepth, true);
  o += 2;
  if (extensible) {
    v.setUint16(o, 22, true); // cbSize
    o += 2;
    v.setUint16(o, bitDepth, true); // wValidBitsPerSample
    o += 2;
    v.setUint32(o, (opts.channelMask ?? 0) >>> 0, true);
    o += 4;
    v.setUint16(o, isFloat ? 3 : 1, true); // GUID Data1 low word
    o += 2;
    v.setUint16(o, 0, true); // GUID Data1 high word
    o += 2;
    for (const b of GUID_TAIL) v.setUint8(o++, b);
  }

  o = writeAscii(v, o, 'data');
  // In an RF64/BW64 file this is the 0xFFFFFFFF sentinel and the real size lives in ds64.
  v.setUint32(o, plan.chunks.find((c) => c.id === 'data').sizeField >>> 0, true);
  o += 4;

  const chans = data.channels;
  if (isFloat) {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        v.setFloat32(o, chans[c][i], true);
        o += 4;
      }
    }
  } else if (bitDepth === 16) {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        v.setInt16(o, floatToInt(chans[c][i], 16), true);
        o += 2;
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        const iv = floatToInt(chans[c][i], 24);
        v.setUint8(o, iv & 0xff);
        v.setUint8(o + 1, (iv >> 8) & 0xff);
        v.setUint8(o + 2, (iv >> 16) & 0xff);
        o += 3;
      }
    }
  }
  if (dataPad) v.setUint8(o++, 0);

  const blob = new Blob([ab], { type: 'audio/wav' });
  // Non-enumerable so JSON/structured-clone behaviour of the Blob is unchanged; purely a
  // hint for the delivery-manifest builder and the validation tooling.
  Object.defineProperty(blob, 'riffContainer', { value: plan.container, enumerable: false });
  return blob;
}

/**
 * Which container `writeWav` would choose, without encoding anything.
 * @param {import('../dsp/audio-data.js').AudioData} data
 * @param {16|24|32} bitDepth
 * @param {{channelMask?: number, forceExtensible?: boolean}} [opts]
 * @returns {'RIFF'|'RF64'|'BW64'}
 */
export function wavContainerFor(data, bitDepth, opts = {}) {
  const ch = data.channels.length;
  const extensible = opts.forceExtensible || ch > 2 || opts.channelMask !== undefined;
  const dataLen = data.length * ch * (bitDepth / 8);
  try {
    return planRiffContainer({
      chunks: [
        { id: 'fmt ', size: extensible ? 40 : 16 },
        { id: 'data', size: dataLen },
      ],
      sampleCount: data.length,
      maxBufferedBytes: Infinity,
    }).container;
  } catch {
    return CONTAINER.RIFF;
  }
}

/**
 * Estimated encoded size in bytes, for the pre-flight memory warning.
 * @param {import('../dsp/audio-data.js').AudioData} data
 * @param {number} bitDepth
 */
export function estimateWavBytes(data, bitDepth) {
  return 68 + data.length * data.channels.length * (bitDepth / 8);
}
