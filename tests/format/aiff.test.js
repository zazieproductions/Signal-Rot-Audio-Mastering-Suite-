import { describe, it, expect } from 'vitest';
import { writeAiff, encodeExtended80, decodeExtended80 } from '../../src/audio/encode/aiff.js';
import { toView, parseChunks, parseComm, ascii } from '../helpers/riff.js';
import { make, sine } from '../helpers/signals.js';

const SR = 48000;

describe('IEEE 754 80-bit extended encoding', () => {
  it('encodes 44100 Hz as the canonical byte sequence', () => {
    const bytes = Array.from(encodeExtended80(44100));
    expect(bytes).toEqual([0x40, 0x0e, 0xac, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  });

  it('encodes 48000 Hz as the canonical byte sequence', () => {
    const bytes = Array.from(encodeExtended80(48000));
    expect(bytes).toEqual([0x40, 0x0e, 0xbb, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  });

  it('round-trips every rate the application offers', () => {
    for (const rate of [8000, 11025, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000]) {
      expect(decodeExtended80(encodeExtended80(rate))).toBe(rate);
    }
  });

  it('encodes zero as all-zero bytes', () => {
    expect(Array.from(encodeExtended80(0))).toEqual(new Array(10).fill(0));
    expect(decodeExtended80(encodeExtended80(0))).toBe(0);
  });
});

describe('AIFF structure', () => {
  it('writes a valid FORM/COMM/SSND file', async () => {
    const data = sine({ amplitude: 0.5, seconds: 0.1, channels: 2 });
    const view = await toView(writeAiff(data, { bitDepth: 24 }));
    const { container, form, chunks, declaredSize, totalBytes } = parseChunks(view, false);

    expect(container).toBe('FORM');
    expect(form).toBe('AIFF');
    expect(declaredSize).toBe(totalBytes - 8);

    const comm = chunks.find((c) => c.id === 'COMM');
    const ssnd = chunks.find((c) => c.id === 'SSND');
    expect(comm).toBeTruthy();
    expect(ssnd).toBeTruthy();
    expect(comm.size).toBe(18);

    const info = parseComm(view, comm);
    expect(info.channels).toBe(2);
    expect(info.frames).toBe(data.length);
    expect(info.bitsPerSample).toBe(24);
    expect(decodeExtended80(info.sampleRateBytes)).toBe(SR);
    expect(ssnd.size).toBe(8 + data.length * 2 * 3);
  });

  it('writes SSND offset and blockSize as zero', async () => {
    const data = make(1, 16, SR, () => 0.1);
    const view = await toView(writeAiff(data, { bitDepth: 24 }));
    const { chunks } = parseChunks(view, false);
    const ssnd = chunks.find((c) => c.id === 'SSND');
    expect(view.getUint32(ssnd.dataOffset, false)).toBe(0);
    expect(view.getUint32(ssnd.dataOffset + 4, false)).toBe(0);
  });

  it('writes samples big-endian', async () => {
    // +0.5 at 24-bit is 0x400000; big-endian that is 40 00 00.
    const data = make(1, 1, SR, () => 0.5);
    const view = await toView(writeAiff(data, { bitDepth: 24 }));
    const { chunks } = parseChunks(view, false);
    const o = chunks.find((c) => c.id === 'SSND').dataOffset + 8;
    expect(view.getUint8(o)).toBe(0x40);
    expect(view.getUint8(o + 1)).toBe(0x00);
    expect(view.getUint8(o + 2)).toBe(0x00);
  });

  it('writes negative samples in two\u2019s complement, big-endian', async () => {
    // −1.0 at 24-bit is −8388608 = 0x800000.
    const data = make(1, 1, SR, () => -1);
    const view = await toView(writeAiff(data, { bitDepth: 24 }));
    const { chunks } = parseChunks(view, false);
    const o = chunks.find((c) => c.id === 'SSND').dataOffset + 8;
    expect(view.getUint8(o)).toBe(0x80);
    expect(view.getUint8(o + 1)).toBe(0x00);
    expect(view.getUint8(o + 2)).toBe(0x00);
  });

  /**
   * The IFF specification requires chunk contents to be padded to an even length, with the
   * pad byte excluded from the chunk size. 24-bit mono with an odd frame count produces an
   * odd SSND payload; the pre-7.0 writer emitted an unaligned file.
   */
  it('pads an odd-length SSND payload without changing the declared size', async () => {
    const data = make(1, 5, SR, () => 0.25); // 5 × 3 = 15 bytes + 8 header = 23, odd
    const view = await toView(writeAiff(data, { bitDepth: 24 }));
    const { chunks, totalBytes, declaredSize } = parseChunks(view, false);
    const ssnd = chunks.find((c) => c.id === 'SSND');
    expect(ssnd.size).toBe(23);
    expect(totalBytes % 2).toBe(0);
    expect(declaredSize).toBe(totalBytes - 8);
  });

  it('supports 16-bit as well as 24-bit', async () => {
    const data = make(2, 32, SR, () => 0.5);
    const view = await toView(writeAiff(data, { bitDepth: 16 }));
    const { chunks } = parseChunks(view, false);
    expect(
      parseComm(
        view,
        chunks.find((c) => c.id === 'COMM'),
      ).bitsPerSample,
    ).toBe(16);
  });

  it('rejects unsupported bit depths', () => {
    expect(() => writeAiff(make(1, 4, SR), { bitDepth: 32 })).toThrow(/unsupported bit depth/);
  });

  it('places every chunk id in the ASCII range', async () => {
    const view = await toView(
      writeAiff(
        make(2, 64, SR, () => 0.1),
        { bitDepth: 24 },
      ),
    );
    const { chunks } = parseChunks(view, false);
    for (const chunk of chunks) {
      expect(chunk.id).toMatch(/^[\x20-\x7e]{4}$/);
    }
    expect(ascii(view, 0, 4)).toBe('FORM');
  });
});
