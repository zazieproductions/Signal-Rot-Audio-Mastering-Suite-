/**
 * AIFF (Audio Interchange File Format) encoder — 16/24-bit big-endian PCM.
 *
 * AIFF is big-endian throughout, including the chunk sizes, and stores the sample rate as
 * an IEEE 754 80-bit extended-precision float. Both are easy to get subtly wrong and both
 * are covered by `tests/format/aiff.test.js`.
 *
 * Chunk layout written here:
 *   FORM <size> AIFF
 *     COMM <18>  numChannels(2) numSampleFrames(4) sampleSize(2) sampleRate(10)
 *     SSND <8 + dataLen>  offset(4) blockSize(4) <samples>
 *
 * ── Odd-byte padding ─────────────────────────────────────────────────────────────────
 * The IFF specification requires every chunk's *contents* to be padded to an even length,
 * with the pad byte excluded from the chunk size. 24-bit audio with an odd frame count
 * and an odd channel count produces an odd `SSND` payload — the previous implementation
 * emitted an unaligned file that strict parsers reject.
 */

import { clamp } from '../dsp/math.js';
import { LIMITS } from '../../app/constants.js';
import { floatToInt } from './wav.js';

/**
 * Encode a sample rate as an IEEE 754 80-bit extended float (big-endian).
 *
 * Layout: 1 sign bit, 15 exponent bits (bias 16383), 64 explicit mantissa bits with an
 * explicit leading 1 (unlike 32/64-bit floats, which imply it).
 *
 * @param {number} rate
 * @returns {Uint8Array} 10 bytes
 */
export function encodeExtended80(rate) {
  const b = new Uint8Array(10);
  if (!(rate > 0)) return b;

  // Normalise the mantissa into [2^63, 2^64).
  let exponent = 0;
  let mantissa = rate;
  while (mantissa < 0x8000000000000) {
    mantissa *= 2;
    exponent++;
  }
  // At this point mantissa ∈ [2^51, 2^52) — go the rest of the way with exact powers of
  // two so we stay inside the 2^53 exact-integer range of a double for the high word.
  const biasedExp = 16383 + 63 - exponent - 12;
  b[0] = (biasedExp >> 8) & 0xff;
  b[1] = biasedExp & 0xff;

  // mantissa currently occupies 52 bits; shift into the top of the 64-bit field.
  const hi = Math.floor(mantissa / 0x100000); // top 32 bits
  const lo = Math.floor(mantissa - hi * 0x100000) * 0x1000; // remaining bits, left-aligned
  b[2] = (hi >>> 24) & 0xff;
  b[3] = (hi >>> 16) & 0xff;
  b[4] = (hi >>> 8) & 0xff;
  b[5] = hi & 0xff;
  b[6] = (lo >>> 24) & 0xff;
  b[7] = (lo >>> 16) & 0xff;
  b[8] = (lo >>> 8) & 0xff;
  b[9] = lo & 0xff;
  return b;
}

/** Decode an 80-bit extended float back to a Number — used by the format tests. */
export function decodeExtended80(bytes) {
  const exp = ((bytes[0] & 0x7f) << 8) | bytes[1];
  let mantissa = 0;
  for (let i = 2; i < 10; i++) mantissa = mantissa * 256 + bytes[i];
  if (exp === 0 && mantissa === 0) return 0;
  return mantissa * Math.pow(2, exp - 16383 - 63);
}

/**
 * @param {import('../dsp/audio-data.js').AudioData} data
 * @param {object} [opts]
 * @param {16|24} [opts.bitDepth] default 24
 * @returns {Blob}
 */
export function writeAiff(data, opts = {}) {
  const bitDepth = opts.bitDepth ?? 24;
  if (![16, 24].includes(bitDepth)) {
    throw new Error(`writeAiff: unsupported bit depth ${bitDepth} (AIFF PCM is 16 or 24 here)`);
  }
  const ch = data.channels.length;
  const n = data.length;
  const bps = bitDepth / 8;
  const dataLen = n * ch * bps;
  const ssndLen = 8 + dataLen; // offset + blockSize + samples
  const ssndPad = ssndLen % 2;
  const commLen = 18;
  const formSize = 4 + (8 + commLen) + (8 + ssndLen + ssndPad);

  if (formSize + 8 > LIMITS.RIFF_MAX_BYTES) {
    throw new Error('AIFF would exceed the 4 GB IFF size limit. Export a shorter region.');
  }

  const ab = new ArrayBuffer(8 + formSize);
  const v = new DataView(ab);
  let o = 0;
  const ascii = (s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i) & 0x7f);
  };
  const u32 = (x) => {
    v.setUint32(o, x, false);
    o += 4;
  };
  const u16 = (x) => {
    v.setUint16(o, x, false);
    o += 2;
  };

  ascii('FORM');
  u32(formSize);
  ascii('AIFF');

  ascii('COMM');
  u32(commLen);
  u16(ch);
  u32(n);
  u16(bitDepth);
  for (const byte of encodeExtended80(data.sampleRate)) v.setUint8(o++, byte);

  ascii('SSND');
  u32(ssndLen);
  u32(0); // offset
  u32(0); // blockSize

  const chans = data.channels;
  if (bitDepth === 16) {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        v.setInt16(o, floatToInt(chans[c][i], 16), false);
        o += 2;
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        const iv = floatToInt(clamp(chans[c][i], -1, 1), 24);
        v.setUint8(o++, (iv >> 16) & 0xff);
        v.setUint8(o++, (iv >> 8) & 0xff);
        v.setUint8(o++, iv & 0xff);
      }
    }
  }
  if (ssndPad) v.setUint8(o++, 0);

  return new Blob([ab], { type: 'audio/aiff' });
}
