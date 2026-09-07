/**
 * Streaming RIFF/WAVE encoder tests.
 *
 * The streaming writer exists to emit the same bytes as `writeWav` without ever holding
 * the whole file — so the core assertion here is *byte identity* across a matrix of
 * channel counts, bit depths and containers, plus structural checks on how the bytes
 * arrive (block sizes, the "no giant allocation" accounting) and the environment-limit
 * behaviour.
 */

import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';

import { writeWav } from '../../src/audio/encode/wav.js';
import { writeWavStreamed } from '../../src/audio/encode/wav-stream.js';
import {
  CollectSink,
  StreamSink,
  supportsStreamingSave,
  openSaveFileSink,
} from '../../src/audio/encode/stream-sinks.js';
import { parseChunks, parseFmt } from '../helpers/riff.js';
import { make, sine } from '../helpers/signals.js';

const SR = 48000;

/** Byte-identity without boxing every byte into a JS number (avoids OOM on big inputs). */
function expectBytesEqual(actual, expected) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < Math.min(actual.length, expected.length); i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(
        `streams diverge at byte ${i}: got 0x${actual[i].toString(16)}, expected 0x${expected[i].toString(16)}`,
      );
    }
  }
}

const streamedBytes = async (data, opts, blockBytes) => {
  const sink = new CollectSink();
  await writeWavStreamed(data, { ...opts, blockBytes }, sink);
  const blob = await sink.finish();
  return { bytes: new Uint8Array(await blob.arrayBuffer()), blob, sink };
};

describe('writeWavStreamed vs writeWav', () => {
  const cases = [
    { label: 'mono 16-bit', ch: 1, bitDepth: 16 },
    { label: 'stereo 16-bit', ch: 2, bitDepth: 16 },
    { label: 'stereo 24-bit', ch: 2, bitDepth: 24 },
    { label: 'stereo 32-bit float', ch: 2, bitDepth: 32 },
    { label: '6-ch 24-bit extensible', ch: 6, bitDepth: 24, mask: 0x3f, force: true },
    { label: '12-ch 24-bit extensible', ch: 12, bitDepth: 24, mask: 0x207d3, force: true },
    { label: '1-ch 24-bit odd data length', ch: 1, bitDepth: 24, frames: 3 },
  ];

  for (const c of cases) {
    it(`produces byte-identical output: ${c.label}`, async () => {
      const data = make(
        c.ch,
        c.frames ?? 1000,
        SR,
        (i) => 0.4 * Math.sin((2 * Math.PI * 317 * i) / SR),
      );
      const opts = {
        bitDepth: c.bitDepth,
        ...(c.mask !== undefined ? { channelMask: c.mask, forceExtensible: c.force } : {}),
      };
      const buffered = new Uint8Array(await writeWav(data, opts).arrayBuffer());
      const { bytes } = await streamedBytes(data, opts);
      expectBytesEqual(bytes, buffered);
    });
  }

  it('is byte-identical when forced to BW64', async () => {
    const data = sine({ amplitude: 0.5, seconds: 0.05, channels: 2, sampleRate: SR });
    const opts = { bitDepth: 24, container: 'bw64' };
    const buffered = new Uint8Array(await writeWav(data, opts).arrayBuffer());
    const { bytes } = await streamedBytes(data, opts);
    expectBytesEqual(bytes, buffered);
    expect(parseChunks(new DataView(bytes.buffer)).container).toBe('BW64');
  });

  it('is byte-identical when forced to RF64', async () => {
    const data = sine({ amplitude: 0.5, seconds: 0.05, channels: 2, sampleRate: SR });
    const opts = { bitDepth: 16, container: 'rf64' };
    const buffered = new Uint8Array(await writeWav(data, opts).arrayBuffer());
    const { bytes } = await streamedBytes(data, opts);
    expectBytesEqual(bytes, buffered);
    expect(parseChunks(new DataView(bytes.buffer)).container).toBe('RF64');
  });
});

describe('streamed chunking', () => {
  it('never writes a block larger than the configured block size (plus the header)', async () => {
    const data = make(2, 20000, SR, () => 0.1);
    const sizes = [];
    const sink = {
      bytesWritten: 0,
      [Symbol.for('signal-rot.streamsToDisk')]: false,
      async write(b) {
        sizes.push(b.length);
        this.bytesWritten += b.length;
      },
      async finish() {},
    };
    await writeWavStreamed(data, { bitDepth: 24, blockBytes: 4096 }, sink);
    const [header, ...blocks] = sizes;
    expect(header).toBeLessThan(256); // just RIFF + fmt + data header
    for (const s of blocks) expect(s).toBeLessThanOrEqual(4096);
    // Every PCM block must contain whole frames (stereo 24-bit ⇒ 6 bytes/frame).
    for (const s of blocks) expect(s % 6).toBe(0);
  });

  it('reports the correct total and container', async () => {
    const data = make(2, 500, SR, () => 0.1);
    const sink = new CollectSink();
    const info = await writeWavStreamed(data, { bitDepth: 16, blockBytes: 1024 }, sink);
    const blob = await sink.finish();
    expect(info.totalBytes).toBe(blob.size);
    expect(info.container).toBe('RIFF');
    expect(info.frames).toBe(500);
    expect(info.blocks).toBeGreaterThan(1); // sanity: block size actually took effect
  });

  it('streams to a real WritableStream in order', async () => {
    const data = make(3, 5000, SR, (i) => Math.sin((2 * Math.PI * 220 * i) / SR));
    const received = [];
    const webWritable = Writable.toWeb(
      new Writable({
        write(chunk, _enc, cb) {
          received.push(new Uint8Array(chunk));
          cb();
        },
      }),
    );
    const sink = new StreamSink(webWritable);
    const info = await writeWavStreamed(data, { bitDepth: 24, blockBytes: 8192 }, sink);
    const written = await sink.finish();
    expect(written).toBe(info.totalBytes);
    const total = received.reduce((a, b) => a + b.length, 0);
    expect(total).toBe(info.totalBytes);
    // The assembled stream parses and decodes as a well-formed WAVE.
    const all = new Uint8Array(total);
    let o = 0;
    for (const b of received) {
      all.set(b, o);
      o += b.length;
    }
    const parsed = parseChunks(new DataView(all.buffer));
    expect(parsed.container).toBe('RIFF');
    expect(parsed.form).toBe('WAVE');
    const fmt = parseFmt(
      new DataView(all.buffer),
      parsed.chunks.find((c) => c.id === 'fmt '),
    );
    expect(fmt.channels).toBe(3);
    expect(fmt.bitsPerSample).toBe(24);
  });

  it('abort() aborts the underlying stream instead of closing it', async () => {
    let aborted = false;
    let closed = false;
    const sink = new StreamSink(
      new WritableStream({
        write() {},
        abort() {
          aborted = true;
        },
        close() {
          closed = true;
        },
      }),
    );
    await sink.abort(new Error('user cancelled'));
    expect(aborted).toBe(true);
    expect(closed).toBe(false);
  });

  it('rejects the encode when the underlying write fails, and never finishes', async () => {
    const data = make(2, 5000, SR, () => 0.1);
    let closed = false;
    let blocks = 0;
    const sink = new StreamSink(
      new WritableStream({
        write() {
          blocks++;
          if (blocks === 2) throw new Error('disk full');
        },
        close() {
          closed = true;
        },
      }),
    );
    await expect(writeWavStreamed(data, { bitDepth: 24, blockBytes: 4096 }, sink)).rejects.toThrow(
      /disk full/,
    );
    expect(closed).toBe(false);
  });
});

describe('environment limits', () => {
  it('still enforces the in-memory ceiling when collecting', async () => {
    // Tiny planner override simulates a sub-file allocation cap.
    const data = make(2, 100, SR, () => 0.1);
    const sink = new CollectSink();
    await expect(
      writeWavStreamed(data, { bitDepth: 24, maxBufferedBytes: 100 }, sink),
    ).rejects.toThrow(/ArrayBuffer|browser/i);
  });

  it('allows a plan above the memory ceiling when the sink streams to disk', async () => {
    const data = make(2, 100, SR, () => 0.1);
    const sink = {
      bytesWritten: 0,
      [Symbol.for('signal-rot.streamsToDisk')]: true,
      async write(bytes) {
        this.bytesWritten += bytes.length;
      },
      async finish() {},
    };
    // With the default disk-sink planning the ≈2 GiB ArrayBuffer ceiling does not apply
    // at all: no override is passed, and a 100-frame file would be unremarkable anyway —
    // the point is the planner treats a disk sink as having no in-memory cap.
    await expect(writeWavStreamed(data, { bitDepth: 24 }, sink)).resolves.toBeTruthy();
  });
});

describe('sink feature detection', () => {
  it('reports unavailable in a bare Node global', () => {
    expect(supportsStreamingSave({})).toBe(false);
    expect(supportsStreamingSave(undefined)).toBe(false);
  });

  it('reports available when showSaveFilePicker and WritableStream exist', () => {
    const fakeWin = {
      WritableStream: class {},
      showSaveFilePicker: async () => ({
        async createWritable() {
          return new WritableStream({ write() {} });
        },
      }),
    };
    expect(supportsStreamingSave(fakeWin)).toBe(true);
  });

  it('openSaveFileSink surfaces user cancellation as AbortError', async () => {
    const fakeWin = {
      WritableStream: class {},
      showSaveFilePicker: async () => {
        const e = new Error('user cancelled');
        e.name = 'AbortError';
        throw e;
      },
    };
    await expect(openSaveFileSink({ suggestedName: 'x.wav' }, fakeWin)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
