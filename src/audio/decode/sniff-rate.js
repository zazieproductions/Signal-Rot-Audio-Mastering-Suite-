/**
 * Native sample-rate sniffing for audio containers (§2.8).
 *
 * Browser `decodeAudioData` resamples to the context's rate, so a 44.1 kHz file
 * decoded against a 48 kHz device context silently becomes 48 kHz — and an export
 * "back" to 44.1 kHz then carries a second, hidden conversion. The fix is to decode
 * at the *file's own* rate when the container tells us what that is.
 *
 * Only the container *header* is parsed (first few KB), pure and deterministic, so it
 * is unit-testable in Node with synthetic byte fixtures. Supported: RIFF/WAVE, FLAC,
 * AIFF/AIFF-C and MPEG audio (MP3) frame headers. Anything else returns `null` and the
 * caller decodes at 48 kHz — the documented, honest fallback.
 */

const SANE_RATE_MIN = 8000;
const SANE_RATE_MAX = 192000;

const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const ascii = (b, o, len) => String.fromCharCode(...b.subarray(o, o + len));

/** 80-bit IEEE-754 extended float (AIFF sample-rate field). */
function readFloat80(b, o) {
  const sign = b[o] & 0x80 ? -1 : 1;
  const exponent = ((b[o] & 0x7f) << 8) | b[o + 1];
  let mantissa = 0n;
  for (let i = 0; i < 8; i++) mantissa = (mantissa << 8n) | BigInt(b[o + 2 + i]);
  if (exponent === 0 && mantissa === 0n) return 0;
  if (exponent === 0x7fff) return sign * (mantissa ? NaN : Infinity);
  // 1.mantissa × 2^(exponent − 16383): the 64-bit mantissa field holds the fraction
  // with an explicit leading 1 and 63 fractional bits.
  const fraction = Number(mantissa) / 2 ** 63;
  return sign * (1 + fraction) * 2 ** (exponent - 16383);
}

/** True when `rate` is a sane, supported file rate. */
export const isSaneRate = (rate) => Number.isFinite(rate) && rate >= SANE_RATE_MIN && rate <= SANE_RATE_MAX;

function riffWavRate(b) {
  if (b.length < 44) return null;
  if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WAVE') return null;
  // Scan chunks for 'fmt ' (robust to LIST/bext chunks before it).
  let offset = 12;
  while (offset + 8 <= b.length) {
    const id = ascii(b, offset, 4);
    const size = u32le(b, offset + 4);
    if (id === 'fmt ' && offset + 16 <= b.length) {
      const audioFormat = u16le(b, offset + 8);
      if (audioFormat !== 1 && audioFormat !== 0xfffe) return null; // PCM or WAVE_FORMAT_EXTENSIBLE only
      const rate = u32le(b, offset + 12);
      return isSaneRate(rate) ? rate : null;
    }
    if (id === 'data') break; // fmt must precede data
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  return null;
}

function flacRate(b) {
  if (b.length < 42) return null;
  if (ascii(b, 0, 4) !== 'fLaC') return null;
  const first = b[4];
  const type = first & 0x7f;
  const size = (b[5] << 16) | (b[6] << 8) | b[7];
  if (type !== 0 || size < 34) return null; // STREAMINFO required first
  const s = 8 + 8; // metadata header + MD5
  const rate = (b[s + 2] << 12) | (b[s + 3] << 4) | (b[s + 4] >> 4); // 20-bit at body+10
  return isSaneRate(rate) ? rate : null;
}

function aiffRate(b) {
  if (b.length < 12) return null;
  if (ascii(b, 0, 4) !== 'FORM') return null;
  const kind = ascii(b, 8, 4);
  if (kind !== 'AIFF' && kind !== 'AIFC') return null;
  let offset = 12;
  if (kind === 'AIFC') {
    if (b.length < 16) return null;
    offset = 16; // skip version chunk
  }
  while (offset + 8 <= b.length) {
    const id = ascii(b, offset, 4);
    const size = u32be(b, offset + 4);
    if (id === 'COMM' && offset + 8 + 18 <= b.length) {
      const rate = readFloat80(b, offset + 16);
      return isSaneRate(rate) ? Math.round(rate) : null;
    }
    if (id === 'SSND') break;
    offset += 8 + size + (size % 2);
  }
  return null;
}

/** MPEG audio frame header parsing (MPEG-1/2/2.5, layers I–III). */
function mpegFrameRate(b, offset) {
  const h = u32be(b, offset);
  if ((h >>> 21) !== 0x7ff) return null; // 11-bit sync
  const versionBits = (h >>> 19) & 0x3;
  const layerBits = (h >>> 17) & 0x3;
  if (versionBits === 1 || layerBits === 0) return null; // reserved
  const rateIndex = (h >>> 10) & 0x3;
  const table =
    versionBits === 3 ? [44100, 48000, 32000] : // MPEG-1
      versionBits === 2 ? [22050, 24000, 16000] : // MPEG-2
        [11025, 12000, 8000]; // MPEG-2.5
  return table[rateIndex];
}

/** Bitrate tables per version and layer, indexed by the 4-bit bitrate index − 1. */
const MPEG_BITRATES = {
  3: {
    3: [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // MPEG-1 L I
    2: [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], // L II
    1: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // L III
  },
  2: {
    3: [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    1: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
  0: {
    3: [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    1: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
};

/** MPEG frame length in bytes, given the header and parsed rate. */
function mpegFrameLen(b, offset, sampleRate) {
  const h = u32be(b, offset);
  const versionBits = (h >>> 19) & 0x3;
  const layerBits = (h >>> 17) & 0x3;
  const bitrateIndex = (h >>> 12) & 0xf;
  const pad = (h >>> 9) & 0x1;
  if (bitrateIndex === 0 || bitrateIndex === 15) return null;
  const kbps = MPEG_BITRATES[versionBits]?.[layerBits]?.[bitrateIndex - 1];
  if (!kbps) return null;
  const samplesPerFrame = layerBits === 3 ? 384 : 1152; // L I vs L II/III
  const bytesPerFrame = Math.floor((samplesPerFrame / 8) * (kbps * 1000) / sampleRate) + (layerBits === 3 ? pad * 4 : pad);
  return bytesPerFrame;
}

function mpegRate(b) {
  if (b.length < 4) return null;
  // Skip an ID3v2 tag if present so the scan starts at audio data.
  let start = 0;
  if (b.length >= 10 && ascii(b, 0, 3) === 'ID3') {
    const tagSize = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    start = 10 + tagSize;
  }
  // Two consecutive valid frames confirm the rate (guard against false syncs).
  const limit = Math.min(b.length - 4, start + 65536);
  for (let i = start; i < limit; i++) {
    if (b[i] !== 0xff) continue;
    const rate = mpegFrameRate(b, i);
    if (!rate) continue;
    const frameLen = mpegFrameLen(b, i, rate);
    if (!frameLen) return null;
    const next = i + frameLen;
    if (next + 4 <= b.length && mpegFrameRate(b, next) === rate) {
      return isSaneRate(rate) ? rate : null;
    }
  }
  return null;
}

/**
 * Sniff the native sample rate from container headers.
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {number|null} rate in Hz, or null when the container is unknown or the
 *   header says nothing trustworthy (caller then falls back to 48 kHz decode)
 */
export function sniffSampleRate(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return riffWavRate(b) ?? flacRate(b) ?? aiffRate(b) ?? mpegRate(b);
}
