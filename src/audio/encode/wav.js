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
 *
 * The `writeWav` path below materialises the whole file in one `ArrayBuffer`; that is
 * fine for ordinary exports but is capped by the browser to roughly 2 GiB. The streaming
 * path (`writeWavStreamed` in `wav-stream.js`, backed by `stream-sinks.js`) emits the same
 * bytes in fixed-size blocks and lifts that ceiling to whatever the container and disk
 * allow — the two paths share every byte-producing helper in this module, so they cannot
 * drift apart.
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
export { GUID_TAIL };

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
 * Sequential little-endian byte writer.
 *
 * The minimal surface every RIFF chunk writer needs, backed by a `DataView` over either
 * one big allocation (`writeWav`) or a small header-sized buffer that is then streamed
 * (`writeWavStreamed`). Sharing this interface is what lets the in-memory and streaming
 * encoders call the *same* chunk- and PCM-writing code.
 *
 * @typedef {object} ByteWriter
 * @property {(s: string) => void} ascii  write a FourCC / ASCII string verbatim
 * @property {(x: number) => void} u32    unsigned 32-bit little-endian
 * @property {(x: number) => void} u16    unsigned 16-bit little-endian
 * @property {(x: number) => void} i16    signed 16-bit little-endian
 * @property {(x: number) => void} f32    32-bit IEEE float, little-endian
 * @property {(b: number) => void} u8     one byte
 */

/**
 * Adapt a `DataView` to the {@link ByteWriter} interface, tracking the write offset.
 * @param {DataView} view
 * @param {number} [startOffset]
 * @returns {ByteWriter & {view: DataView, offset: number}}
 */
export function dataViewWriter(view, startOffset = 0) {
  const w = {
    view,
    offset: startOffset,
    ascii(s) {
      for (let i = 0; i < s.length; i++) view.setUint8(w.offset + i, s.charCodeAt(i) & 0x7f);
      w.offset += s.length;
    },
    u32(x) {
      view.setUint32(w.offset, x, true);
      w.offset += 4;
    },
    u16(x) {
      view.setUint16(w.offset, x, true);
      w.offset += 2;
    },
    i16(x) {
      view.setInt16(w.offset, x, true);
      w.offset += 2;
    },
    f32(x) {
      view.setFloat32(w.offset, x, true);
      w.offset += 4;
    },
    u8(x) {
      view.setUint8(w.offset, x & 0xff);
      w.offset += 1;
    },
  };
  return w;
}

/**
 * Write a `fmt ` chunk (16-byte PCM/float or 40-byte WAVE_FORMAT_EXTENSIBLE).
 *
 * Shared by the plain WAVE writer and the ADM BWF writer so there is exactly one
 * implementation of the WAVEFORMATEXTENSIBLE layout to get wrong.
 *
 * @param {ByteWriter} w positioned where the chunk should begin
 * @param {object} spec
 * @param {number} spec.channels
 * @param {number} spec.sampleRate
 * @param {16|24|32} spec.bitDepth
 * @param {boolean} spec.extensible
 * @param {number} [spec.channelMask]
 * @returns {number} the payload size written (16 or 40)
 */
export function writeFmtChunk(w, { channels, sampleRate, bitDepth, extensible, channelMask = 0 }) {
  const isFloat = bitDepth === 32;
  const bps = bitDepth / 8;
  const blockAlign = channels * bps;
  const fmtLen = extensible ? 40 : 16;
  w.ascii('fmt ');
  w.u32(fmtLen);
  w.u16(extensible ? 0xfffe : isFloat ? 3 : 1);
  w.u16(channels);
  w.u32(sampleRate);
  w.u32(sampleRate * blockAlign);
  w.u16(blockAlign);
  w.u16(bitDepth);
  if (extensible) {
    w.u16(22); // cbSize
    w.u16(bitDepth); // wValidBitsPerSample
    w.u32(channelMask >>> 0);
    w.u16(isFloat ? 3 : 1); // KSDATAFORMAT_SUBTYPE data1 low word
    w.u16(0); // data1 high word
    for (const b of GUID_TAIL) w.u8(b);
  }
  return fmtLen;
}

/**
 * Encode one frame (one sample per channel, interleaved) into a DataView.
 *
 * @param {DataView} v
 * @param {number} offset byte offset of the frame's first sample
 * @param {Float32Array[]} channels
 * @param {number} frame
 * @param {number} ch channel count
 * @param {16|24|32} bitDepth
 * @returns {number} the number of bytes written (`ch * bitDepth/8`)
 */
export function encodePcmFrame(v, offset, channels, frame, ch, bitDepth) {
  let o = offset;
  if (bitDepth === 32) {
    for (let c = 0; c < ch; c++) {
      v.setFloat32(o, channels[c][frame], true);
      o += 4;
    }
  } else if (bitDepth === 16) {
    for (let c = 0; c < ch; c++) {
      v.setInt16(o, floatToInt(channels[c][frame], 16), true);
      o += 2;
    }
  } else {
    for (let c = 0; c < ch; c++) {
      const iv = floatToInt(channels[c][frame], 24);
      v.setUint8(o, iv & 0xff);
      v.setUint8(o + 1, (iv >> 8) & 0xff);
      v.setUint8(o + 2, (iv >> 16) & 0xff);
      o += 3;
    }
  }
  return o - offset;
}

/**
 * Validate the inputs every RIFF/WAVE writer needs. Throws on anything a `fmt ` chunk
 * cannot honestly describe; returns the derived geometry otherwise.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data
 * @param {16|24|32} bitDepth
 * @returns {{ch: number, sr: number, n: number, bps: number, blockAlign: number, dataLen: number, extensible: boolean, fmtLen: number}}
 */
export function prepareWav(data, bitDepth, opts = {}) {
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
  const bps = bitDepth / 8;
  const blockAlign = ch * bps;
  const dataLen = n * blockAlign;
  const extensible = opts.forceExtensible || ch > 2 || opts.channelMask !== undefined;
  return {
    ch,
    sr,
    n,
    bps,
    blockAlign,
    dataLen,
    extensible,
    fmtLen: extensible ? 40 : 16,
  };
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
  const g = prepareWav(data, bitDepth, opts);
  const { ch, sr, n, dataLen, extensible, fmtLen } = g;

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
  const view = new DataView(ab);
  let o = writeRiffHeader(view, plan);
  const w = dataViewWriter(view, o);

  writeFmtChunk(w, {
    channels: ch,
    sampleRate: sr,
    bitDepth,
    extensible,
    channelMask: opts.channelMask ?? 0,
  });
  o = w.offset;

  o = writeAscii(view, o, 'data');
  // In an RF64/BW64 file this is the 0xFFFFFFFF sentinel and the real size lives in ds64.
  view.setUint32(o, plan.chunks.find((c) => c.id === 'data').sizeField >>> 0, true);
  o += 4;

  for (let i = 0; i < n; i++) {
    o += encodePcmFrame(view, o, data.channels, i, ch, bitDepth);
  }
  if (dataPad) view.setUint8(o++, 0);

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
