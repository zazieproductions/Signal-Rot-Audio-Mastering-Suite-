import { describe, it, expect } from 'vitest';
import { sniffSampleRate, isSaneRate } from '../../src/audio/decode/sniff-rate.js';

const u16le = (v) => [v & 0xff, (v >> 8) & 0xff];
const u32le = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
const u16be = (v) => [(v >> 8) & 0xff, v & 0xff];
const u32be = (v) => [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const bytes = (...parts) => Uint8Array.from(parts.flat());

/** Minimal RIFF/WAVE PCM header with the given rate. */
function wavBytes(rate, { extensible = false } = {}) {
  const fmt = [
    ...ascii4('fmt '),
    ...u32le(16),
    ...u16le(extensible ? 0xfffe : 1),
    ...u16le(2),
    ...u32le(rate),
    ...u32le(rate * 4),
    ...u16le(4),
    ...u16le(16),
  ];
  const riffSize = 4 + 8 + fmt.length + 8;
  return bytes(
    ...ascii4('RIFF'),
    ...u32le(riffSize),
    ...ascii4('WAVE'),
    ...fmt,
    ...ascii4('data'),
    ...u32le(0),
  );
}
const ascii4 = (s) => [...s].map((c) => c.charCodeAt(0));

/** AIFF 'COMM' with an 80-bit extended float rate. */
function aiffBytes(rate) {
  const float80 = (() => {
    const out = new Array(10).fill(0);
    if (rate === 0) return out;
    let e = 0;
    let m = rate;
    while (m >= 2) {
      m /= 2;
      e++;
    }
    while (m < 1) {
      m *= 2;
      e--;
    }
    out[0] = 0;
    out[1] = (e + 16383) & 0xff;
    out[0] = (e + 16383) >> 8;
    // 64-bit mantissa: m − 1 scaled by 2^63, stored as integer bits
    let mant = Math.round((m - 1) * 2 ** 63);
    for (let i = 0; i < 8; i++) {
      out[9 - i] = mant & 0xff;
      mant = Math.floor(mant / 256);
    }
    return out;
  })();
  const comm = [
    ...ascii4('COMM'),
    ...u32be(18),
    ...u16be(2), // channels
    ...u32be(1), // frames
    ...u16be(16), // bits
    ...float80,
  ];
  return bytes(...ascii4('FORM'), ...u32be(4 + comm.length), ...ascii4('AIFF'), ...comm);
}

/** Minimal FLAC with STREAMINFO carrying `rate`. */
function flacBytes(rate) {
  const body = new Array(34).fill(0);
  // STREAMINFO rate: 20 bits at body offset 10 (absolute 18)
  body[10] = (rate >> 12) & 0xff;
  body[11] = (rate >> 4) & 0xff;
  body[12] = (rate & 0xf) << 4;
  return bytes(...ascii4('fLaC'), 0x00, 0x00, 0x00, 34, ...body);
}

/** Two consecutive MPEG frames, first at `offset` (after optional ID3). */
function mpegBytes(rateIndex, version = 3, { offset = 0 } = {}) {
  const hdr = (ver, layer, kbpsIdx, srIdx) => {
    const b = [0xff, 0xe0];
    b[1] |= ver << 3; // MPEG version (3 = MPEG1)
    b[1] |= layer << 1; // layer III
    b[1] |= 1; // no CRC
    b[2] = (kbpsIdx << 4) | (srIdx << 2);
    return b;
  };
  const rateTable = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  const rate = rateTable[version][rateIndex];
  const kbpsIdx = 9; // MPEG-1 L3 128 kbps; MPEG-2 L3 40 kbps... use table-valid idx 9
  const kbps = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][kbpsIdx] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160][kbpsIdx];
  const frameLen = Math.floor((144 * kbps * 1000) / rate);
  const out = new Array(offset + frameLen * 2 + 8).fill(0);
  const write = (at) => {
    const h = hdr(version, 1, kbpsIdx, rateIndex);
    out[at] = h[0];
    out[at + 1] = h[1];
    out[at + 2] = h[2];
    out[at + 3] = h[3];
  };
  write(offset);
  write(offset + frameLen);
  return Uint8Array.from(out);
}

describe('container sample-rate sniffing (§2.8)', () => {
  it('reads RIFF/WAVE PCM rates', () => {
    expect(sniffSampleRate(wavBytes(44100))).toBe(44100);
    expect(sniffSampleRate(wavBytes(96000))).toBe(96000);
    expect(sniffSampleRate(wavBytes(192000))).toBe(192000);
    expect(sniffSampleRate(wavBytes(22050))).toBe(22050);
  });

  it('reads WAVE_FORMAT_EXTENSIBLE WAVs', () => {
    expect(sniffSampleRate(wavBytes(48000, { extensible: true }))).toBe(48000);
  });

  it('reads FLAC STREAMINFO rates', () => {
    expect(sniffSampleRate(flacBytes(44100))).toBe(44100);
    expect(sniffSampleRate(flacBytes(88200))).toBe(88200);
    expect(sniffSampleRate(flacBytes(48000))).toBe(48000);
  });

  it('reads AIFF 80-bit extended-float rates', () => {
    expect(sniffSampleRate(aiffBytes(44100))).toBe(44100);
    expect(sniffSampleRate(aiffBytes(48000))).toBe(48000);
    expect(sniffSampleRate(aiffBytes(96000))).toBe(96000);
  });

  it('reads MPEG-1 layer III rates from two consecutive frames', () => {
    expect(sniffSampleRate(mpegBytes(0))).toBe(44100);
    expect(sniffSampleRate(mpegBytes(1))).toBe(48000);
    expect(sniffSampleRate(mpegBytes(2))).toBe(32000);
  });

  it('reads MPEG-2 layer III rates (half-rate table)', () => {
    expect(sniffSampleRate(mpegBytes(0, 2))).toBe(22050);
  });

  it('skips an ID3v2 tag before the first frame', () => {
    const base = mpegBytes(0);
    const withId3 = new Uint8Array(18 + base.length);
    withId3.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0], 0); // 'ID3' v4, size 0
    // tagSize bytes 6-9 are syncsafe; declare 8 bytes of body at offset 10
    withId3[6] = 0;
    withId3[7] = 0;
    withId3[8] = 0;
    withId3[9] = 8;
    withId3.set(base, 18);
    expect(sniffSampleRate(withId3)).toBe(44100);
  });

  it('returns null for unknown or truncated containers', () => {
    expect(sniffSampleRate(new Uint8Array(0))).toBeNull();
    expect(sniffSampleRate(new Uint8Array(64).fill(0x55))).toBeNull();
    expect(sniffSampleRate(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeNull(); // 'RIFF' only
    expect(sniffSampleRate(new Uint8Array([0x4f, 0x67, 0x67, 0x53]))).toBeNull(); // OggS
    // WAV with a nonsense rate
    const bad = wavBytes(44100);
    bad[24] = 0xff;
    bad[25] = 0xff;
    bad[26] = 0xff;
    bad[27] = 0xff;
    expect(sniffSampleRate(bad)).toBeNull();
  });

  it('rejects absurd rates through isSaneRate', () => {
    expect(isSaneRate(44100)).toBe(true);
    expect(isSaneRate(0)).toBe(false);
    expect(isSaneRate(1000000)).toBe(false);
    expect(isSaneRate(NaN)).toBe(false);
    expect(isSaneRate(8000)).toBe(true);
    expect(isSaneRate(192000)).toBe(true);
  });
});
