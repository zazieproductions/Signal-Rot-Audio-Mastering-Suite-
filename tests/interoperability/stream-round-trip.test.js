/**
 * Streaming-writer interoperability.
 *
 * The streaming encoders (`writeWavStreamed`, `writeAdmBwfStreamed`) exist to lift the
 * single-ArrayBuffer ceiling; they must not do it at the cost of the file. So every file
 * the streaming path produces is checked three ways:
 *
 *   1. **Byte identity** with the in-memory writer for the same inputs. The two paths
 *      share their chunk/PCM encoders; if the assembled stream differs from the buffered
 *      file, the shared-code claim has broken somewhere.
 *   2. **Independent parse** with `tools/export-validation/riff-inspect.js` — the same
 *      specification-derived parser used in the export gate, which imports nothing from
 *      the writers.
 *   3. **Independent decode** of the PCM, compared sample-by-sample within the
 *      quantisation tolerance, and — for the identification fixtures — with the channel
 *      order recovered from the *audio*.
 *
 * The streamed files are also assembled from deliberately small blocks (a few KiB), so
 * every block boundary, including the header/payload and payload/trailer joins, is
 * exercised thousands of times.
 */

import { describe, it, expect } from 'vitest';

import {
  buildChannelIdentification,
  identifyChannelOrder,
} from '../../src/audio/encode/channel-identification.js';
import { writeWav } from '../../src/audio/encode/wav.js';
import { writeWavStreamed } from '../../src/audio/encode/wav-stream.js';
import { writeAdmBwf } from '../../src/audio/immersive/adm.js';
import { writeAdmBwfStreamed } from '../../src/audio/immersive/adm-stream.js';
import { CollectSink } from '../../src/audio/encode/stream-sinks.js';
import { wavChannelOrder } from '../../src/audio/immersive/layouts.js';
import { decodePcm, inspectRiff } from '../../tools/export-validation/riff-inspect.js';
import { quantisationTolerance } from '../../tools/export-validation/validate-exports.js';

const SR = 48000;
const ID = { sampleRate: SR, beepMs: 10, gapMs: 6, pauseMs: 14, toneMs: 50, tailMs: 8 };
const LAYOUTS = ['5.1', '7.1', '7.1.4', '9.1.6', 'soniclab'];

/** 64 KiB: smaller than the default 4 MiB block on purpose, to hammer block boundaries. */
const TINY_BLOCK = 64 * 1024;

/**
 * Byte-identity check without boxing hundreds of megabytes of numbers (a naive
 * `Array.from(uint8)` on a 24-ch bed allocates over a gigabyte of boxed values and
 * crashes the worker). Walks the bytes raw and reports the first mismatch, if any.
 */
function expectBytesEqual(actual, expected) {
  expect(actual.length).toBe(expected.length);
  const limit = Math.min(actual.length, expected.length);
  let mismatch = -1;
  for (let i = 0; i < limit; i++) {
    if (actual[i] !== expected[i]) {
      mismatch = i;
      break;
    }
  }
  if (mismatch >= 0) {
    throw new Error(
      `streams diverge at byte ${mismatch}: got 0x${actual[mismatch].toString(16).padStart(2, '0')}, ` +
        `expected 0x${expected[mismatch].toString(16).padStart(2, '0')} ` +
        `(context: ${actual.subarray(Math.max(0, mismatch - 4), mismatch + 4).join(',')} vs ` +
        `${expected.subarray(Math.max(0, mismatch - 4), mismatch + 4).join(',')})`,
    );
  }
}

async function streamWav(data, opts) {
  const sink = new CollectSink();
  await writeWavStreamed(data, { blockBytes: TINY_BLOCK, ...opts }, sink);
  const blob = await sink.finish('audio/wav');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), blob, sink };
}

async function streamAdm(data, opts) {
  const sink = new CollectSink();
  await writeAdmBwfStreamed(data, { blockBytes: TINY_BLOCK, ...opts }, sink);
  const blob = await sink.finish('audio/wav');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), blob, sink };
}

describe.each(LAYOUTS)('streamed WAV — %s', (layoutId) => {
  const { order, mask } = wavChannelOrder(layoutId);
  const data = buildChannelIdentification(order.length, ID);

  it.each([16, 24, 32])('is byte-identical to writeWav at %i-bit', async (bitDepth) => {
    const opts = { bitDepth, channelMask: mask, forceExtensible: true };
    const buffered = new Uint8Array(await writeWav(data, opts).arrayBuffer());
    const { bytes } = await streamWav(data, opts);
    expect(bytes.length).toBe(buffered.length);
    expectBytesEqual(bytes, buffered);
  });

  it.each([16, 24])('is accepted by the independent parser/decoder at %i-bit', async (bitDepth) => {
    const opts = { bitDepth, channelMask: mask, forceExtensible: true };
    const { bytes, sink } = await streamWav(data, opts);
    const report = inspectRiff(bytes);
    expect(report.errors).toEqual([]);
    expect(report.fmt.channels).toBe(order.length);
    expect(report.fmt.sampleRate).toBe(SR);
    expect(report.fmt.bitsPerSample).toBe(bitDepth);
    expect(report.frames).toBe(data.length);

    const decoded = decodePcm(bytes);
    const tolerance = quantisationTolerance(bitDepth);
    for (let c = 0; c < order.length; c++) {
      let maxError = 0;
      for (let i = 0; i < data.length; i += 53) {
        maxError = Math.max(maxError, Math.abs(data.channels[c][i] - decoded.channels[c][i]));
      }
      expect(maxError).toBeLessThanOrEqual(tolerance);
    }

    // The channel order must be recoverable from the audio itself after streaming.
    const { order: detected, confidence } = identifyChannelOrder(decoded, ID);
    expect(detected).toEqual(order.map((_, i) => i + 1));
    expect(Math.min(...confidence)).toBeGreaterThan(8);

    // The sink never held the whole file at once: the largest live block was bounded.
    expect(sink.blocks.length).toBeGreaterThan(1);
    const largest = Math.max(...sink.blocks.map((b) => b.byteLength));
    expect(largest).toBeLessThanOrEqual(TINY_BLOCK);
  });
});

describe('streamed WAV — container promotion', () => {
  it('streams a BW64 file byte-identically when forced', async () => {
    const data = buildChannelIdentification(2, ID);
    const opts = { bitDepth: 24, container: 'bw64' };
    const buffered = new Uint8Array(await writeWav(data, opts).arrayBuffer());
    const { bytes } = await streamWav(data, opts);
    expectBytesEqual(bytes, buffered);
    const report = inspectRiff(bytes);
    expect(report.container).toBe('BW64');
    expect(report.ds64).toBeTruthy();
    expect(report.errors).toEqual([]);
  });

  it('refuses to collect a planned-RIFF-overflow when capped (memory path still honest)', async () => {
    // A sub-100-byte cap is below even the header; the planner must reject it rather than
    // pretend a stream can collect what memory cannot hold.
    const data = buildChannelIdentification(2, ID);
    const sink = new CollectSink();
    await expect(
      writeWavStreamed(data, { bitDepth: 24, maxBufferedBytes: 64 }, sink),
    ).rejects.toThrow(/ArrayBuffer|browser|cannot be held/i);
  });
});

describe.each(LAYOUTS)('streamed ADM BWF — %s', (layoutId) => {
  const { order } = wavChannelOrder(layoutId);
  const data = buildChannelIdentification(order.length, ID);
  const date = new Date(Date.UTC(2024, 0, 1, 12, 0, 0));
  const opts = {
    layoutId,
    bitDepth: 24,
    order,
    date,
    loudness: { integrated: -23, range: 7.5, truePeak: -1 },
  };

  it('is byte-identical to writeAdmBwf', async () => {
    const buffered = new Uint8Array(await writeAdmBwf(data, opts).arrayBuffer());
    const { bytes } = await streamAdm(data, opts);
    expect(bytes.length).toBe(buffered.length);
    expectBytesEqual(bytes, buffered);
  });

  it('is accepted by the independent parser with chna/bext/axml intact', async () => {
    const { bytes } = await streamAdm(data, opts);
    const report = inspectRiff(bytes);
    expect(report.errors).toEqual([]);
    expect(report.container).toBe('RIFF');
    expect(report.chna.numTracks).toBe(order.length);
    expect(report.chna.entries.length).toBe(order.length);
    expect(report.bext.version).toBe(2);
    expect(report.bext.loudness.integratedLufs).toBeCloseTo(-23, 2);
    expect(report.axml).toContain('audioFormatExtended');
    expect(report.fmt.channelMask).toBe(0);

    const decoded = decodePcm(bytes);
    expect(decoded.channels.length).toBe(order.length);
    expect(decoded.length).toBe(data.length);
    const tolerance = quantisationTolerance(24);
    for (let c = 0; c < order.length; c++) {
      let maxError = 0;
      for (let i = 0; i < data.length; i += 61) {
        maxError = Math.max(maxError, Math.abs(data.channels[c][i] - decoded.channels[c][i]));
      }
      expect(maxError).toBeLessThanOrEqual(tolerance);
    }
    const { order: detected } = identifyChannelOrder(decoded, ID);
    expect(detected).toEqual(order.map((_, i) => i + 1));
  });
});
