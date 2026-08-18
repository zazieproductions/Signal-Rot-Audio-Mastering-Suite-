import { describe, it, expect } from 'vitest';
import { encodeWav, encodeAiff, float80, pad2 } from '../src/export/wav.js';
import { createQuantiser, resolveDitherMode } from '../src/dsp/dither.js';
import { MockAudioBuffer, sine, mulberry32 } from './helpers.js';

const SR = 48000;

/** Minimal RIFF chunk walker, so the tests parse what a real decoder parses. */
function parseRiff(ab) {
  const v = new DataView(ab);
  const str = (o, n) => String.fromCharCode(...new Uint8Array(ab, o, n));
  expect(str(0, 4)).toBe('RIFF');
  expect(str(8, 4)).toBe('WAVE');
  const declared = v.getUint32(4, true);
  const chunks = {};
  let o = 12;
  while (o + 8 <= ab.byteLength) {
    const id = str(o, 4);
    const size = v.getUint32(o + 4, true);
    chunks[id] = { offset: o + 8, size };
    o += 8 + size + (size % 2); // chunks are word-aligned
  }
  return { view: v, chunks, declared, consumed: o };
}

/** Minimal IFF/AIFF chunk walker. */
function parseAiff(ab) {
  const v = new DataView(ab);
  const str = (o, n) => String.fromCharCode(...new Uint8Array(ab, o, n));
  expect(str(0, 4)).toBe('FORM');
  expect(str(8, 4)).toBe('AIFF');
  const declared = v.getUint32(4, false);
  const chunks = {};
  let o = 12;
  while (o + 8 <= ab.byteLength) {
    const id = str(o, 4);
    const size = v.getUint32(o + 4, false);
    chunks[id] = { offset: o + 8, size };
    o += 8 + size + (size % 2);
  }
  return { view: v, chunks, declared, consumed: o };
}

function toneBuffer(channels = 2, frames = 1000, amplitude = 0.5) {
  const buf = new MockAudioBuffer(channels, frames, SR);
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < frames; i++) d[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / SR);
  }
  return buf;
}

describe('WAV encoder', () => {
  it('writes a well-formed 16-bit stereo header', () => {
    const ab = encodeWav(toneBuffer(2, 1000), 16, { dither: 'none' });
    const { view, chunks, declared } = parseRiff(ab);
    expect(declared).toBe(ab.byteLength - 8);
    expect(chunks['fmt ']).toBeDefined();
    expect(chunks.data).toBeDefined();
    expect(view.getUint16(20, true)).toBe(1); // WAVE_FORMAT_PCM
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint32(24, true)).toBe(SR);
    expect(view.getUint16(32, true)).toBe(4); // block align
    expect(view.getUint16(34, true)).toBe(16);
    expect(chunks.data.size).toBe(1000 * 2 * 2);
  });

  it('writes IEEE float for 32-bit and round-trips samples exactly', () => {
    const src = toneBuffer(2, 500);
    const ab = encodeWav(src, 32);
    const { view, chunks } = parseRiff(ab);
    expect(view.getUint16(20, true)).toBe(3); // WAVE_FORMAT_IEEE_FLOAT
    for (let i = 0; i < 500; i++) {
      const got = view.getFloat32(chunks.data.offset + i * 8, true);
      expect(got).toBeCloseTo(src.getChannelData(0)[i], 6);
    }
  });

  it('pads an odd-length data chunk so the file stays word-aligned', () => {
    // 24-bit mono with an odd frame count => odd data chunk. The original
    // writer emitted this unpadded, producing a malformed RIFF file.
    const ab = encodeWav(toneBuffer(1, 333), 24, { dither: 'none' });
    expect(333 * 3).toBe(999); // odd, by construction
    expect(ab.byteLength % 2).toBe(0);
    const { chunks, declared } = parseRiff(ab);
    expect(chunks.data.size).toBe(999);
    expect(declared).toBe(ab.byteLength - 8);
  });

  it('emits WAVE_FORMAT_EXTENSIBLE with a channel mask for multichannel', () => {
    const mask = 0x3f; // 5.1
    const ab = encodeWav(toneBuffer(6, 200), 24, { channelMask: mask, dither: 'none' });
    const { view, chunks } = parseRiff(ab);
    expect(view.getUint16(20, true)).toBe(0xfffe);
    expect(view.getUint16(36, true)).toBe(22); // cbSize
    expect(view.getUint16(38, true)).toBe(24); // valid bits
    expect(view.getUint32(40, true)).toBe(mask);
    expect(chunks.data.size).toBe(200 * 6 * 3);
    // KSDATAFORMAT_SUBTYPE_PCM
    expect(view.getUint8(44)).toBe(0x01);
    expect(view.getUint8(50)).toBe(0x10);
  });

  it('clamps rather than wrapping on out-of-range input', () => {
    const buf = new MockAudioBuffer(1, 4, SR);
    buf.getChannelData(0).set([2.0, -2.0, 1.0, -1.0]);
    const ab = encodeWav(buf, 16, { dither: 'none' });
    const { view, chunks } = parseRiff(ab);
    const at = (i) => view.getInt16(chunks.data.offset + i * 2, true);
    expect(at(0)).toBe(32767);
    expect(at(1)).toBe(-32768);
    expect(at(2)).toBe(32767);
    expect(at(3)).toBe(-32768);
  });

  it('quantises symmetrically (no even-harmonic bias from split scaling)', () => {
    // The original scaled negatives by 0x8000 and positives by 0x7FFF, so a
    // symmetric input produced an asymmetric output.
    const buf = new MockAudioBuffer(1, 2, SR);
    buf.getChannelData(0).set([0.5, -0.5]);
    const ab = encodeWav(buf, 16, { dither: 'none' });
    const { view, chunks } = parseRiff(ab);
    const a = view.getInt16(chunks.data.offset, true);
    const b = view.getInt16(chunks.data.offset + 2, true);
    expect(a).toBe(-b);
  });

  it('rejects an unsupported bit depth', () => {
    expect(() => encodeWav(toneBuffer(1, 10), 12)).toThrow(RangeError);
  });
});

describe('AIFF encoder', () => {
  it('writes a well-formed 24-bit header', () => {
    const ab = encodeAiff(toneBuffer(2, 1000), { dither: 'none' });
    const { view, chunks, declared } = parseAiff(ab);
    expect(declared).toBe(ab.byteLength - 8);
    expect(chunks.COMM).toBeDefined();
    expect(chunks.SSND).toBeDefined();
    expect(view.getUint16(chunks.COMM.offset, false)).toBe(2); // channels
    expect(view.getUint32(chunks.COMM.offset + 2, false)).toBe(1000); // frames
    expect(view.getUint16(chunks.COMM.offset + 6, false)).toBe(24);
    expect(chunks.SSND.size).toBe(1000 * 2 * 3 + 8);
  });

  it('pads an odd-length SSND chunk', () => {
    const ab = encodeAiff(toneBuffer(1, 333), { dither: 'none' });
    expect(ab.byteLength % 2).toBe(0);
    const { declared } = parseAiff(ab);
    expect(declared).toBe(ab.byteLength - 8);
  });

  it('stores samples big-endian', () => {
    const buf = new MockAudioBuffer(1, 1, SR);
    buf.getChannelData(0)[0] = 0.5;
    const ab = encodeAiff(buf, { dither: 'none' });
    const { view, chunks } = parseAiff(ab);
    const o = chunks.SSND.offset + 8;
    // 0.5 * 2^23 = 0x400000 -> big-endian 40 00 00
    expect(view.getUint8(o)).toBe(0x40);
    expect(view.getUint8(o + 1)).toBe(0x00);
    expect(view.getUint8(o + 2)).toBe(0x00);
  });

  it('encodes standard sample rates as 80-bit extended floats', () => {
    // 44100 -> 400E AC44000000000000, 48000 -> 400E BB80000000000000
    expect([...float80(44100)]).toEqual([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]);
    expect([...float80(48000)]).toEqual([0x40, 0x0e, 0xbb, 0x80, 0, 0, 0, 0, 0, 0]);
    expect([...float80(96000)]).toEqual([0x40, 0x0f, 0xbb, 0x80, 0, 0, 0, 0, 0, 0]);
    expect([...float80(0)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('pad2', () => {
  it('rounds odd lengths up and leaves even lengths alone', () => {
    expect(pad2(0)).toBe(0);
    expect(pad2(1)).toBe(2);
    expect(pad2(998)).toBe(998);
    expect(pad2(999)).toBe(1000);
  });
});

describe('dither', () => {
  it('defaults to TPDF at 16-bit, none at 24-bit, never at 32-bit float', () => {
    expect(resolveDitherMode(undefined, 16)).toBe('tpdf');
    expect(resolveDitherMode(undefined, 24)).toBe('none');
    expect(resolveDitherMode('shaped', 32)).toBe('none');
    expect(resolveDitherMode('bogus', 16)).toBe('tpdf');
    expect(resolveDitherMode('shaped', 16)).toBe('shaped');
  });

  it('decorrelates quantisation error from the signal', () => {
    // A very quiet tone that only spans a few LSBs is the pathological case:
    // undithered, the error is a deterministic function of the signal and
    // shows up as harmonic distortion rather than noise.
    const bits = 16;
    const amplitude = 1.5 / Math.pow(2, bits - 1);
    const n = 1 << 14;
    const signal = sine(1000, n / SR, SR, amplitude);

    const measure = (mode) => {
      const q = createQuantiser(bits, mode, mulberry32(99));
      const err = new Float64Array(n);
      for (let i = 0; i < n; i++) err[i] = q(signal[i]) / Math.pow(2, bits - 1) - signal[i];
      // Correlation between the error and the source signal.
      let se = 0;
      let ss = 0;
      let ses = 0;
      for (let i = 0; i < n; i++) {
        se += err[i] * err[i];
        ss += signal[i] * signal[i];
        ses += err[i] * signal[i];
      }
      return Math.abs(ses) / Math.sqrt(se * ss);
    };

    const undithered = measure('none');
    const dithered = measure('tpdf');
    expect(dithered).toBeLessThan(undithered);
    expect(dithered).toBeLessThan(0.1);
  });

  it('keeps output within the representable integer range', () => {
    const q = createQuantiser(16, 'shaped', mulberry32(5));
    for (let i = 0; i < 5000; i++) {
      const code = q(Math.sin(i * 0.01) * 1.2); // deliberately over-range
      expect(code).toBeGreaterThanOrEqual(-32768);
      expect(code).toBeLessThanOrEqual(32767);
    }
  });

  it('is deterministic for a given RNG, so exports are reproducible', () => {
    const run = () => {
      const q = createQuantiser(16, 'tpdf', mulberry32(1234));
      return Array.from({ length: 100 }, (_, i) => q(Math.sin(i * 0.05) * 0.3));
    };
    expect(run()).toEqual(run());
  });

  it('shaped dither moves noise energy out of the midrange', () => {
    // Quantise silence and compare the error spectrum's midrange vs top octave.
    const n = 1 << 15;
    const energyAbove = (mode, splitHz) => {
      const q = createQuantiser(16, mode, mulberry32(7));
      const err = new Float64Array(n);
      for (let i = 0; i < n; i++) err[i] = q(0) / 32768;
      // Crude two-band split via a one-pole; enough to show the tilt.
      let lp = 0;
      const a = (2 * Math.PI * splitHz) / SR;
      let lowE = 0;
      let highE = 0;
      for (let i = 0; i < n; i++) {
        lp += a * (err[i] - lp);
        lowE += lp * lp;
        const hi = err[i] - lp;
        highE += hi * hi;
      }
      return highE / (lowE + 1e-30);
    };
    expect(energyAbove('shaped', 4000)).toBeGreaterThan(energyAbove('tpdf', 4000));
  });
});
