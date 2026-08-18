/**
 * RIFF/WAVE and AIFF encoders.
 *
 * Fixes over the original inline writers:
 *
 *  - **Odd-length chunks are now padded.** Both RIFF and AIFF require chunks to
 *    start on even byte boundaries. A 24-bit mono file with an odd frame count
 *    produces an odd `data`/`SSND` chunk; the original emitted it unpadded,
 *    yielding a technically malformed file that strict parsers reject.
 *  - **Dither is applied on the way to fixed point** (see ../dsp/dither.js).
 *  - **Asymmetric scaling removed.** The original scaled negatives by 0x8000
 *    and positives by 0x7FFF, which applies a different gain to each half of
 *    the waveform — a small but real second-harmonic distortion. Quantisation
 *    now uses a single scale factor with clamping, the standard approach.
 *  - **WAVE_FORMAT_EXTENSIBLE channel masks** are emitted for multichannel
 *    files so players route the channels correctly.
 */

import { createQuantiser, resolveDitherMode } from '../dsp/dither.js';

/** Write an ASCII tag into a DataView. */
function writeTag(view, offset, tag) {
  for (let i = 0; i < tag.length; i++) view.setUint8(offset + i, tag.charCodeAt(i));
}

/** Round a chunk length up to the next even byte, per the RIFF/IFF spec. */
export const pad2 = (n) => n + (n % 2);

/**
 * Encode an AudioBuffer as a RIFF/WAVE file.
 *
 * @param {{numberOfChannels:number,length:number,sampleRate:number,getChannelData:(i:number)=>Float32Array}} buffer
 * @param {number} bitDepth 16, 24 or 32 (32 = IEEE float)
 * @param {object} [options]
 * @param {'none'|'tpdf'|'shaped'} [options.dither]
 * @param {number} [options.channelMask] emit WAVE_FORMAT_EXTENSIBLE with this mask
 * @param {() => number} [options.random] injectable RNG for deterministic tests
 * @returns {ArrayBuffer}
 */
export function encodeWav(buffer, bitDepth, options = {}) {
  const { channelMask, random } = options;
  const channels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const frames = buffer.length;
  const isFloat = bitDepth === 32;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataLength = frames * blockAlign;

  // WAVE_FORMAT_EXTENSIBLE is required for >2 channels or when a speaker mask
  // is supplied; it is also the safer choice for >16-bit multichannel audio.
  const extensible = channelMask !== undefined || channels > 2;
  const fmtLength = extensible ? 40 : 16;
  const dataPadded = pad2(dataLength);

  const riffSize = 4 + (8 + fmtLength) + (8 + dataPadded);
  const ab = new ArrayBuffer(8 + riffSize);
  const view = new DataView(ab);

  writeTag(view, 0, 'RIFF');
  view.setUint32(4, riffSize, true);
  writeTag(view, 8, 'WAVE');

  writeTag(view, 12, 'fmt ');
  view.setUint32(16, fmtLength, true);
  view.setUint16(20, extensible ? 0xfffe : isFloat ? 3 : 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  let offset = 36;
  if (extensible) {
    view.setUint16(36, 22, true); // cbSize
    view.setUint16(38, bitDepth, true); // valid bits per sample
    view.setUint32(40, (channelMask ?? 0) >>> 0, true);
    // SubFormat GUID: KSDATAFORMAT_SUBTYPE_PCM / _IEEE_FLOAT
    const guid = [
      isFloat ? 0x03 : 0x01, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x10, 0x00,
      0x80, 0x00, 0x00, 0xaa,
      0x00, 0x38, 0x9b, 0x71,
    ];
    guid.forEach((b, i) => view.setUint8(44 + i, b));
    offset = 60;
  }

  writeTag(view, offset, 'data');
  view.setUint32(offset + 4, dataLength, true);
  offset += 8;

  writeSamples(view, offset, buffer, bitDepth, {
    littleEndian: true,
    dither: options.dither,
    random,
  });

  return ab;
}

/**
 * Write interleaved sample data, quantising and dithering as required.
 * @returns {number} the offset just past the written data (unpadded)
 */
function writeSamples(view, startOffset, buffer, bitDepth, opts) {
  const { littleEndian, dither, random } = opts;
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const data = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));

  let offset = startOffset;

  if (bitDepth === 32) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        view.setFloat32(offset, data[c][i], littleEndian);
        offset += 4;
      }
    }
    return offset;
  }

  const mode = resolveDitherMode(dither, bitDepth);
  // One quantiser per channel so the dither noise is decorrelated between
  // channels and stays spread across the stereo image.
  const quantisers = data.map(() => createQuantiser(bitDepth, mode, random));

  if (bitDepth === 16) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        view.setInt16(offset, quantisers[c](data[c][i]), littleEndian);
        offset += 2;
      }
    }
    return offset;
  }

  if (bitDepth === 24) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        const code = quantisers[c](data[c][i]);
        if (littleEndian) {
          view.setUint8(offset, code & 0xff);
          view.setUint8(offset + 1, (code >> 8) & 0xff);
          view.setUint8(offset + 2, (code >> 16) & 0xff);
        } else {
          view.setUint8(offset, (code >> 16) & 0xff);
          view.setUint8(offset + 1, (code >> 8) & 0xff);
          view.setUint8(offset + 2, code & 0xff);
        }
        offset += 3;
      }
    }
    return offset;
  }

  throw new RangeError(`Unsupported bit depth: ${bitDepth}`);
}

/**
 * Encode a sample rate as an 80-bit IEEE 754 extended float (AIFF COMM field).
 * @param {number} sampleRate
 * @returns {Uint8Array} 10 bytes
 */
export function float80(sampleRate) {
  const bytes = new Uint8Array(10);
  if (!(sampleRate > 0)) return bytes;
  let exponent = 0;
  let mantissa = sampleRate;
  while (mantissa < 0x80000000) {
    mantissa *= 2;
    exponent++;
  }
  const exp = 16383 + 31 - exponent;
  bytes[0] = (exp >> 8) & 0xff;
  bytes[1] = exp & 0xff;
  const m = Math.floor(mantissa);
  for (let i = 0; i < 4; i++) bytes[2 + i] = (m >>> (24 - i * 8)) & 0xff;
  return bytes;
}

/**
 * Encode an AudioBuffer as a 24-bit big-endian AIFF file.
 *
 * @param {object} buffer AudioBuffer-like
 * @param {object} [options]
 * @param {'none'|'tpdf'|'shaped'} [options.dither]
 * @param {() => number} [options.random]
 * @returns {ArrayBuffer}
 */
export function encodeAiff(buffer, options = {}) {
  const bitDepth = 24;
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytesPerSample = bitDepth / 8;
  const dataLength = frames * channels * bytesPerSample;

  const commLength = 18;
  const ssndLength = dataLength + 8; // offset + blockSize fields
  const ssndPadded = pad2(ssndLength);
  const formSize = 4 + (8 + commLength) + (8 + ssndPadded);

  const ab = new ArrayBuffer(8 + formSize);
  const view = new DataView(ab);
  let offset = 0;
  const tag = (s) => {
    writeTag(view, offset, s);
    offset += s.length;
  };
  const u32 = (x) => {
    view.setUint32(offset, x, false);
    offset += 4;
  };
  const u16 = (x) => {
    view.setUint16(offset, x, false);
    offset += 2;
  };

  tag('FORM');
  u32(formSize);
  tag('AIFF');

  tag('COMM');
  u32(commLength);
  u16(channels);
  u32(frames);
  u16(bitDepth);
  const rate = float80(buffer.sampleRate);
  for (let i = 0; i < 10; i++) view.setUint8(offset++, rate[i]);

  tag('SSND');
  u32(ssndLength);
  u32(0); // offset
  u32(0); // blockSize

  offset = writeSamples(view, offset, buffer, bitDepth, {
    littleEndian: false,
    dither: options.dither,
    random: options.random,
  });

  return ab;
}
