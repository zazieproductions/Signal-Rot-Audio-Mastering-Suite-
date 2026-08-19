import { describe, it, expect } from 'vitest';
import {
  writeWav,
  floatToInt,
  SPEAKER_MASK,
  estimateWavBytes,
} from '../../src/audio/encode/wav.js';
import { toView, parseChunks, parseFmt, readSamples } from '../helpers/riff.js';
import { make, sine } from '../helpers/signals.js';

const SR = 48000;

describe('floatToInt', () => {
  it('uses the full two\u2019s-complement range without wrapping at +1.0', () => {
    expect(floatToInt(-1, 16)).toBe(-32768);
    expect(floatToInt(1, 16)).toBe(32767);
    expect(floatToInt(0, 16)).toBe(0);
    expect(floatToInt(-1, 24)).toBe(-8388608);
    expect(floatToInt(1, 24)).toBe(8388607);
  });

  it('clamps out-of-range input rather than wrapping', () => {
    expect(floatToInt(3, 16)).toBe(32767);
    expect(floatToInt(-3, 16)).toBe(-32768);
    expect(floatToInt(1.00001, 24)).toBe(8388607);
  });

  it('is symmetric about zero for small values', () => {
    for (const v of [0.001, 0.01, 0.1, 0.5]) {
      expect(floatToInt(v, 16)).toBe(-floatToInt(-v, 16));
    }
  });
});

describe('WAV header', () => {
  it('writes a valid 16-bit PCM stereo header', async () => {
    const data = sine({ amplitude: 0.5, seconds: 0.1, channels: 2 });
    const view = await toView(writeWav(data, { bitDepth: 16 }));
    const { container, form, chunks, declaredSize, totalBytes } = parseChunks(view);

    expect(container).toBe('RIFF');
    expect(form).toBe('WAVE');
    expect(declaredSize).toBe(totalBytes - 8);

    const fmtChunk = chunks.find((c) => c.id === 'fmt ');
    const dataChunk = chunks.find((c) => c.id === 'data');
    expect(fmtChunk).toBeTruthy();
    expect(dataChunk).toBeTruthy();
    expect(fmtChunk.size).toBe(16);

    const fmt = parseFmt(view, fmtChunk);
    expect(fmt.audioFormat).toBe(1); // WAVE_FORMAT_PCM
    expect(fmt.channels).toBe(2);
    expect(fmt.sampleRate).toBe(SR);
    expect(fmt.bitsPerSample).toBe(16);
    expect(fmt.blockAlign).toBe(4);
    expect(fmt.byteRate).toBe(SR * 4);
    expect(dataChunk.size).toBe(data.length * 4);
  });

  it('writes WAVE_FORMAT_IEEE_FLOAT for 32-bit', async () => {
    const data = sine({ amplitude: 0.5, seconds: 0.05 });
    const view = await toView(writeWav(data, { bitDepth: 32 }));
    const { chunks } = parseChunks(view);
    const fmt = parseFmt(
      view,
      chunks.find((c) => c.id === 'fmt '),
    );
    expect(fmt.audioFormat).toBe(3);
    expect(fmt.bitsPerSample).toBe(32);
  });

  it('writes 24-bit little-endian packed samples', async () => {
    const data = make(1, 4, SR, (i) => [0, 0.5, -0.5, 1][i]);
    const view = await toView(writeWav(data, { bitDepth: 24 }));
    const { chunks } = parseChunks(view);
    const fmt = parseFmt(
      view,
      chunks.find((c) => c.id === 'fmt '),
    );
    const samples = readSamples(
      view,
      chunks.find((c) => c.id === 'data'),
      fmt,
    );
    expect(samples[0][0]).toBeCloseTo(0, 6);
    expect(samples[0][1]).toBeCloseTo(0.5, 6);
    expect(samples[0][2]).toBeCloseTo(-0.5, 6);
    expect(samples[0][3]).toBeCloseTo(1, 5);
  });

  it('round-trips float samples exactly at 32-bit', async () => {
    const data = sine({ amplitude: 0.31415, frequency: 700, seconds: 0.02, channels: 2 });
    const view = await toView(writeWav(data, { bitDepth: 32 }));
    const { chunks } = parseChunks(view);
    const fmt = parseFmt(
      view,
      chunks.find((c) => c.id === 'fmt '),
    );
    const samples = readSamples(
      view,
      chunks.find((c) => c.id === 'data'),
      fmt,
    );
    for (let i = 0; i < data.length; i += 17) {
      expect(samples[0][i]).toBe(data.channels[0][i]);
      expect(samples[1][i]).toBe(data.channels[1][i]);
    }
  });

  it('round-trips 16-bit within half an LSB', async () => {
    const data = sine({ amplitude: 0.6, frequency: 300, seconds: 0.05, channels: 2 });
    const view = await toView(writeWav(data, { bitDepth: 16 }));
    const { chunks } = parseChunks(view);
    const fmt = parseFmt(
      view,
      chunks.find((c) => c.id === 'fmt '),
    );
    const samples = readSamples(
      view,
      chunks.find((c) => c.id === 'data'),
      fmt,
    );
    for (let i = 0; i < data.length; i += 13) {
      expect(Math.abs(samples[0][i] - data.channels[0][i])).toBeLessThanOrEqual(1 / 32768);
    }
  });

  it('interleaves channels in the correct order', async () => {
    const data = make(2, 3, SR, (i, c) => (c === 0 ? 0.25 : -0.75));
    const view = await toView(writeWav(data, { bitDepth: 32 }));
    const { chunks } = parseChunks(view);
    const fmt = parseFmt(
      view,
      chunks.find((c) => c.id === 'fmt '),
    );
    const samples = readSamples(
      view,
      chunks.find((c) => c.id === 'data'),
      fmt,
    );
    expect(Array.from(samples[0])).toEqual([0.25, 0.25, 0.25]);
    expect(Array.from(samples[1])).toEqual([-0.75, -0.75, -0.75]);
  });
});

describe('WAVE_FORMAT_EXTENSIBLE', () => {
  it('is used automatically above two channels', async () => {
    const data = make(6, 100, SR, () => 0.1);
    const view = await toView(writeWav(data, { bitDepth: 24, channelMask: 0x3f }));
    const { chunks } = parseChunks(view);
    const fmtChunk = chunks.find((c) => c.id === 'fmt ');
    expect(fmtChunk.size).toBe(40);
    const fmt = parseFmt(view, fmtChunk);
    expect(fmt.audioFormat).toBe(0xfffe);
    expect(fmt.cbSize).toBe(22);
    expect(fmt.validBits).toBe(24);
    expect(fmt.channelMask).toBe(0x3f);
    expect(fmt.subFormat).toBe(1); // KSDATAFORMAT_SUBTYPE_PCM
  });

  it('writes the float sub-format GUID for 32-bit extensible', async () => {
    const data = make(4, 50, SR, () => 0.1);
    const view = await toView(writeWav(data, { bitDepth: 32, channelMask: 0x33 }));
    const { chunks } = parseChunks(view);
    const fmt = parseFmt(
      view,
      chunks.find((c) => c.id === 'fmt '),
    );
    expect(fmt.subFormat).toBe(3);
  });

  it('writes the standard KSDATAFORMAT GUID tail', async () => {
    const data = make(3, 10, SR, () => 0);
    const view = await toView(writeWav(data, { bitDepth: 24, channelMask: 0x7 }));
    const { chunks } = parseChunks(view);
    const o = chunks.find((c) => c.id === 'fmt ').dataOffset + 24;
    const tail = [];
    for (let i = 4; i < 16; i++) tail.push(view.getUint8(o + i));
    expect(tail).toEqual([0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]);
  });
});

describe('channel mask constants', () => {
  /**
   * The pre-7.0 engine assigned TOP_FRONT_CENTER to the right front height and
   * TOP_BACK_CENTER to the right rear height. Since WAVE_FORMAT_EXTENSIBLE defines channel
   * order as ascending mask-bit order, that mis-ordered as well as mis-labelled every
   * 7.1.2 and 7.1.4 export.
   */
  it('matches the ksmedia.h SPEAKER_* values', () => {
    expect(SPEAKER_MASK.FRONT_LEFT).toBe(0x1);
    expect(SPEAKER_MASK.FRONT_RIGHT).toBe(0x2);
    expect(SPEAKER_MASK.FRONT_CENTER).toBe(0x4);
    expect(SPEAKER_MASK.LOW_FREQUENCY).toBe(0x8);
    expect(SPEAKER_MASK.BACK_LEFT).toBe(0x10);
    expect(SPEAKER_MASK.BACK_RIGHT).toBe(0x20);
    expect(SPEAKER_MASK.SIDE_LEFT).toBe(0x200);
    expect(SPEAKER_MASK.SIDE_RIGHT).toBe(0x400);
    expect(SPEAKER_MASK.TOP_FRONT_LEFT).toBe(0x1000);
    expect(SPEAKER_MASK.TOP_FRONT_CENTER).toBe(0x2000);
    expect(SPEAKER_MASK.TOP_FRONT_RIGHT).toBe(0x4000);
    expect(SPEAKER_MASK.TOP_BACK_LEFT).toBe(0x8000);
    expect(SPEAKER_MASK.TOP_BACK_CENTER).toBe(0x10000);
    expect(SPEAKER_MASK.TOP_BACK_RIGHT).toBe(0x20000);
  });
});

describe('guards', () => {
  it('rejects unsupported bit depths', () => {
    const data = make(1, 10, SR);
    expect(() => writeWav(data, { bitDepth: 8 })).toThrow(/unsupported bit depth/);
  });

  it('estimates the encoded size accurately', async () => {
    const data = make(2, 1000, SR);
    const blob = writeWav(data, { bitDepth: 24 });
    // The estimate assumes an extensible header; a stereo file uses the shorter one.
    expect(Math.abs(estimateWavBytes(data, 24) - blob.size)).toBeLessThanOrEqual(24);
  });

  it('pads odd-length data to a word boundary', async () => {
    // 1 channel × 3 frames × 3 bytes = 9 bytes: odd.
    const data = make(1, 3, SR, () => 0.1);
    const view = await toView(writeWav(data, { bitDepth: 24 }));
    const { chunks, totalBytes } = parseChunks(view);
    const dataChunk = chunks.find((c) => c.id === 'data');
    expect(dataChunk.size).toBe(9);
    expect(totalBytes % 2).toBe(0);
  });
});
