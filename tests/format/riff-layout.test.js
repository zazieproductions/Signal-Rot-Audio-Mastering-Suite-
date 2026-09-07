/**
 * RIFF / RF64 / BW64 container planning.
 *
 * The whole point of `planRiffContainer` is that the 4 GiB boundary can be tested with
 * arithmetic instead of with a 4 GiB buffer. Every test here runs in microseconds and
 * allocates nothing, which is why the boundary conditions can be covered exhaustively.
 */

import { describe, it, expect } from 'vitest';
import {
  CONTAINER,
  DS64_MIN_SIZE,
  UINT32_MAX,
  describeRiffPlan,
  padTo16Bit,
  planRiffContainer,
  writeRiffHeader,
} from '../../src/audio/encode/riff-layout.js';

const plan = (dataSize, extra = {}) =>
  planRiffContainer({
    chunks: [
      { id: 'fmt ', size: 40 },
      { id: 'data', size: dataSize },
    ],
    sampleCount: Math.floor(dataSize / 8),
    maxBufferedBytes: Infinity,
    ...extra,
  });

describe('padTo16Bit', () => {
  it('rounds odd sizes up and leaves even sizes alone', () => {
    expect(padTo16Bit(0)).toBe(0);
    expect(padTo16Bit(1)).toBe(2);
    expect(padTo16Bit(2)).toBe(2);
    expect(padTo16Bit(4097)).toBe(4098);
  });
});

describe('container selection', () => {
  it('uses plain RIFF for ordinary files', () => {
    const p = plan(48000 * 2 * 3 * 60); // one minute of 24-bit stereo
    expect(p.container).toBe(CONTAINER.RIFF);
    expect(p.sixtyFourBit).toBe(false);
    expect(p.ds64Size).toBe(0);
    expect(p.riffSizeField).toBe(p.totalBytes - 8);
  });

  it('promotes to BW64 once the body no longer fits in 32 bits', () => {
    // 4 GiB of data: the body (4 + fmt + data + headers) overflows uint32.
    const p = plan(0x100000000);
    expect(p.container).toBe(CONTAINER.BW64);
    expect(p.sixtyFourBit).toBe(true);
    expect(p.ds64Size).toBe(DS64_MIN_SIZE);
  });

  it('honours an explicit rf64 request even for a small file', () => {
    const p = plan(1000, { mode: 'rf64' });
    expect(p.container).toBe(CONTAINER.RF64);
    expect(p.sixtyFourBit).toBe(true);
  });

  it('honours an explicit bw64 request even for a small file', () => {
    expect(plan(1000, { mode: 'bw64' }).container).toBe(CONTAINER.BW64);
  });

  it('refuses to write a wrapped 32-bit size when RIFF is forced', () => {
    expect(() => plan(0x100000000, { mode: 'riff' })).toThrow(/wrapped 32-bit size/);
  });
});

describe('the 4 GiB boundary', () => {
  // body = 4 (form) + 8+40 (fmt chunk) + 8 (data header) + padTo16Bit(dataSize).
  const OVERHEAD = 4 + 48 + 8;
  // An odd payload is padded, so the largest data size a RIFF body can carry is the
  // largest EVEN value that leaves the body at or below 0xFFFFFFFF.
  const largest32 = UINT32_MAX - OVERHEAD - ((UINT32_MAX - OVERHEAD) % 2);

  it('stays RIFF at the largest representable size', () => {
    const p = plan(largest32);
    expect(p.container).toBe(CONTAINER.RIFF);
    expect(p.riffSizeField).toBe(largest32 + OVERHEAD);
    expect(p.riffSizeField).toBeLessThanOrEqual(UINT32_MAX);
    expect(p.totalBytes).toBe(p.riffSizeField + 8);
  });

  it('promotes as soon as the padded body would exceed 32 bits', () => {
    // +1 is odd and pads back up to +2, so both overflow.
    expect(plan(largest32 + 1).container).toBe(CONTAINER.BW64);
    expect(plan(largest32 + 2).container).toBe(CONTAINER.BW64);
  });

  it('never emits a size field that has wrapped', () => {
    for (const size of [largest32 - 1, largest32, largest32 + 2, 0x100000000, 0x1ffffffff]) {
      const p = plan(size);
      // Either the field is a truthful 32-bit value, or it is the sentinel.
      if (p.sixtyFourBit) {
        expect(p.riffSizeField).toBe(UINT32_MAX);
        expect(Number(p.riffSizeActual)).toBe(p.totalBytes - 8);
      } else {
        expect(p.riffSizeField).toBe(p.totalBytes - 8);
        expect(p.riffSizeField).toBeLessThanOrEqual(UINT32_MAX);
      }
    }
  });

  it('carries the real sizes in ds64 rather than in the 32-bit fields', () => {
    const dataSize = 0x2_0000_0000; // 8 GiB
    const p = plan(dataSize);
    expect(p.dataSizeActual).toBe(BigInt(dataSize));
    expect(p.chunks.find((c) => c.id === 'data').sizeField).toBe(UINT32_MAX);
    expect(p.sampleCount).toBe(BigInt(Math.floor(dataSize / 8)));
  });

  it('places ds64 first, immediately after the WAVE form type', () => {
    const p = plan(0x100000000);
    expect(p.chunks[0].id).toBe('ds64');
    expect(p.chunks[0].offset).toBe(12);
    expect(p.chunks[1].offset).toBe(12 + 8 + DS64_MIN_SIZE);
  });

  it('accounts for ds64 in the total size', () => {
    const small = plan(1000);
    const forced = plan(1000, { mode: 'bw64' });
    expect(forced.totalBytes - small.totalBytes).toBe(8 + DS64_MIN_SIZE);
  });
});

describe('the browser buffer ceiling', () => {
  it('refuses a plan that cannot be held in one ArrayBuffer', () => {
    expect(() =>
      planRiffContainer({
        chunks: [
          { id: 'fmt ', size: 40 },
          { id: 'data', size: 0x100000000 },
        ],
        maxBufferedBytes: 2 * 1024 ** 3,
      }),
    ).toThrow(/cannot be held in a single ArrayBuffer/);
  });

  it('says clearly that the container, not the format, is the limit', () => {
    let message = '';
    try {
      planRiffContainer({
        chunks: [
          { id: 'fmt ', size: 40 },
          { id: 'data', size: 0x100000000 },
        ],
        maxBufferedBytes: 2 * 1024 ** 3,
      });
    } catch (e) {
      message = e.message;
    }
    expect(message).toMatch(/BW64 container itself supports this size — the browser does not/);
  });
});

describe('input validation', () => {
  it('requires exactly one data chunk', () => {
    expect(() => planRiffContainer({ chunks: [{ id: 'fmt ', size: 16 }] })).toThrow(
      /exactly one "data" chunk/,
    );
    expect(() =>
      planRiffContainer({
        chunks: [
          { id: 'data', size: 2 },
          { id: 'data', size: 2 },
        ],
      }),
    ).toThrow(/exactly one "data" chunk/);
  });

  it('rejects malformed FourCCs', () => {
    expect(() =>
      planRiffContainer({
        chunks: [
          { id: 'fmt', size: 16 },
          { id: 'data', size: 2 },
        ],
      }),
    ).toThrow(/exactly 4 characters/);
  });

  it('rejects non-integer and negative sizes', () => {
    for (const size of [-1, 1.5, NaN, Infinity]) {
      expect(() => planRiffContainer({ chunks: [{ id: 'data', size }] })).toThrow(
        /non-integer size/,
      );
    }
  });

  it('refuses a caller-supplied ds64', () => {
    expect(() =>
      planRiffContainer({
        chunks: [
          { id: 'ds64', size: 28 },
          { id: 'data', size: 2 },
        ],
      }),
    ).toThrow(/inserted by the planner/);
  });

  it('rejects an unknown mode', () => {
    expect(() => plan(100, { mode: 'wav64' })).toThrow(/unknown mode/);
  });
});

describe('writeRiffHeader', () => {
  const read = (view, offset, length) => {
    let s = '';
    for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
    return s;
  };

  it('writes a plain RIFF header with no ds64', () => {
    const p = plan(1000);
    const view = new DataView(new ArrayBuffer(p.totalBytes));
    const after = writeRiffHeader(view, p);
    expect(read(view, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(p.totalBytes - 8);
    expect(read(view, 8, 4)).toBe('WAVE');
    expect(after).toBe(12);
  });

  it('writes a BW64 header with a correct ds64 chunk', () => {
    const p = plan(1000, { mode: 'bw64' });
    const view = new DataView(new ArrayBuffer(p.totalBytes));
    const after = writeRiffHeader(view, p);

    expect(read(view, 0, 4)).toBe('BW64');
    expect(view.getUint32(4, true)).toBe(UINT32_MAX);
    expect(read(view, 8, 4)).toBe('WAVE');
    expect(read(view, 12, 4)).toBe('ds64');
    expect(view.getUint32(16, true)).toBe(DS64_MIN_SIZE);
    expect(Number(view.getBigUint64(20, true))).toBe(p.totalBytes - 8);
    expect(Number(view.getBigUint64(28, true))).toBe(1000);
    expect(Number(view.getBigUint64(36, true))).toBe(125);
    expect(view.getUint32(44, true)).toBe(0); // tableLength
    expect(after).toBe(48);
  });

  it('writes RF64 when RF64 was planned', () => {
    const p = plan(1000, { mode: 'rf64' });
    const view = new DataView(new ArrayBuffer(p.totalBytes));
    writeRiffHeader(view, p);
    expect(read(view, 0, 4)).toBe('RF64');
  });
});

describe('describeRiffPlan', () => {
  it('describes a plain file without mentioning ds64', () => {
    expect(describeRiffPlan(plan(1000))).toMatch(/RIFF\/WAVE.*32-bit/);
  });

  it('names the sentinel and the real sizes for a 64-bit file', () => {
    const text = describeRiffPlan(plan(1000, { mode: 'bw64' }));
    expect(text).toMatch(/BW64/);
    expect(text).toMatch(/0xFFFFFFFF sentinel/);
    expect(text).toMatch(/dataSize=1000/);
  });
});
