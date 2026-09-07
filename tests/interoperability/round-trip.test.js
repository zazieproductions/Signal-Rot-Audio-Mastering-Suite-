/**
 * Multichannel round-trip validation.
 *
 * Signal Rot writes a file; an *independent* parser and decoder — written from the
 * specifications, sharing no code with the writer — reads it back; the recovered PCM is
 * compared against what the writer was given. Then, separately, the channel order is
 * recovered from the decoded *audio* via identification tones and checked against the
 * layout, so a reordering bug cannot hide behind agreeing metadata.
 *
 * These tests are the automated half of the export-validation runner. They run in the
 * ordinary `npm test` sweep so a channel swap fails the build, not just the nightly.
 */

import { describe, it, expect } from 'vitest';
import {
  buildChannelIdentification,
  countIdentificationBeeps,
  identifyChannelOrder,
} from '../../src/audio/encode/channel-identification.js';
import { writeWav } from '../../src/audio/encode/wav.js';
import { writeAdmBwf } from '../../src/audio/immersive/adm.js';
import { SPEAKERS, wavChannelOrder } from '../../src/audio/immersive/layouts.js';
import { findAll, findOne, parseXml } from '../../tools/export-validation/adm-validate.js';
import { decodePcm, inspectRiff } from '../../tools/export-validation/riff-inspect.js';
import { quantisationTolerance } from '../../tools/export-validation/validate-exports.js';

const SR = 48000;
/** Short slots keep the suite fast; the confidence assertions guard against going too far. */
const ID = { sampleRate: SR, beepMs: 10, gapMs: 6, pauseMs: 14, toneMs: 50, tailMs: 8 };

const LAYOUTS = ['5.1', '7.1', '7.1.2', '7.1.4', '9.1.6', 'soniclab'];

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

describe('channel-identification signal', () => {
  it('puts N countable beeps on channel N and silence elsewhere', () => {
    const data = buildChannelIdentification(8, ID);
    for (let c = 0; c < 8; c++) {
      expect(countIdentificationBeeps(data.channels[c], SR, ID).beeps).toBe(c + 1);
      expect(countIdentificationBeeps(data.channels[c], SR, ID).toneBursts).toBe(1);
    }
  });

  it('identifies every channel from the audio alone', () => {
    const data = buildChannelIdentification(24, ID);
    const { order, confidence } = identifyChannelOrder(data, ID);
    expect(order).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    // Every channel's own tone must dominate every other channel's tone by a wide margin,
    // otherwise the swap detection below would be measuring noise.
    expect(Math.min(...confidence)).toBeGreaterThan(8);
  });

  it('detects a swap of two adjacent height channels', () => {
    const data = buildChannelIdentification(12, ID);
    const swapped = { ...data, channels: data.channels.slice() };
    [swapped.channels[8], swapped.channels[9]] = [swapped.channels[9], swapped.channels[8]];
    const { order } = identifyChannelOrder(swapped, ID);
    expect(order[8]).toBe(10);
    expect(order[9]).toBe(9);
  });

  it('detects a left/right swap', () => {
    const data = buildChannelIdentification(6, ID);
    const swapped = { ...data, channels: data.channels.slice() };
    [swapped.channels[0], swapped.channels[1]] = [swapped.channels[1], swapped.channels[0]];
    expect(identifyChannelOrder(swapped, ID).order).toEqual([2, 1, 3, 4, 5, 6]);
  });

  it('detects a rotation of the whole channel set', () => {
    const data = buildChannelIdentification(8, ID);
    const rotated = { ...data, channels: [...data.channels.slice(1), data.channels[0]] };
    expect(identifyChannelOrder(rotated, ID).order).toEqual([2, 3, 4, 5, 6, 7, 8, 1]);
  });

  it('is deterministic across calls', () => {
    const a = buildChannelIdentification(4, ID);
    const b = buildChannelIdentification(4, ID);
    for (let c = 0; c < 4; c++)
      expect(Array.from(a.channels[c])).toEqual(Array.from(b.channels[c]));
  });

  it('refuses implausible channel counts rather than producing something ambiguous', () => {
    for (const n of [0, -1, 1.5, 65, NaN]) {
      expect(() => buildChannelIdentification(n, ID)).toThrow(/channelCount/);
    }
  });
});

describe.each(LAYOUTS)('%s round trip', (layoutId) => {
  const { order, mask, standard } = wavChannelOrder(layoutId);
  const data = buildChannelIdentification(order.length, ID);

  it.each([16, 24, 32])('survives a %i-bit WAV round trip intact', async (bitDepth) => {
    const bytes = await bytesOf(
      writeWav(data, { bitDepth, channelMask: mask, forceExtensible: true }),
    );
    const report = inspectRiff(bytes);
    expect(report.errors).toEqual([]);
    expect(report.fmt.channels).toBe(order.length);
    expect(report.fmt.sampleRate).toBe(SR);
    expect(report.fmt.bitsPerSample).toBe(bitDepth);
    expect(report.frames).toBe(data.length);

    const decoded = decodePcm(bytes);
    expect(decoded.channels.length).toBe(order.length);
    expect(decoded.length).toBe(data.length);

    const tolerance = quantisationTolerance(bitDepth);
    for (let c = 0; c < order.length; c++) {
      let maxError = 0;
      let dot = 0;
      let peakIn = 0;
      let peakOut = 0;
      for (let i = 0; i < data.length; i++) {
        maxError = Math.max(maxError, Math.abs(data.channels[c][i] - decoded.channels[c][i]));
        dot += data.channels[c][i] * decoded.channels[c][i];
        peakIn = Math.max(peakIn, Math.abs(data.channels[c][i]));
        peakOut = Math.max(peakOut, Math.abs(decoded.channels[c][i]));
      }
      expect(maxError).toBeLessThanOrEqual(tolerance);
      expect(dot).toBeGreaterThan(0); // polarity preserved
      expect(peakOut).toBeGreaterThan(0.4); // no unexpected silence
      expect(peakOut).toBeCloseTo(peakIn, 3); // no truncation or gain change
    }
  });

  it.each([16, 24, 32])('keeps the channels in the declared order at %i-bit', async (bitDepth) => {
    const bytes = await bytesOf(
      writeWav(data, { bitDepth, channelMask: mask, forceExtensible: true }),
    );
    const decoded = decodePcm(bytes);
    const { order: detected, confidence } = identifyChannelOrder(decoded, ID);
    expect(detected).toEqual(order.map((_, i) => i + 1));
    expect(Math.min(...confidence)).toBeGreaterThan(8);
  });

  it('writes the mask the layout actually justifies', async () => {
    const bytes = await bytesOf(
      writeWav(data, { bitDepth: 24, channelMask: mask, forceExtensible: true }),
    );
    const report = inspectRiff(bytes);
    expect(report.fmt.channelMask).toBe(standard ? mask : 0);
    if (standard) {
      // Ascending mask-bit order is what WAVE_FORMAT_EXTENSIBLE interleaving means, so
      // the declared order must already be sorted by mask bit.
      const bits = order.map((k) => SPEAKERS[k].wavMaskBit);
      expect(bits).toEqual([...bits].sort((a, b) => a - b));
      expect(report.fmt.channelMaskNames.length).toBe(order.length);
    } else {
      // Mask 0 is deliberate for layouts no mask can describe. An approximate mask would
      // make a player route confidently to the wrong speakers.
      expect(report.fmt.channelMask).toBe(0);
    }
  });

  it('marks LFE / subwoofer channels consistently', async () => {
    const bytes = await bytesOf(
      writeWav(data, { bitDepth: 24, channelMask: mask, forceExtensible: true }),
    );
    const report = inspectRiff(bytes);
    const lfeIndices = order.map((k, i) => (SPEAKERS[k].lfe ? i : -1)).filter((i) => i >= 0);
    expect(lfeIndices.length).toBeGreaterThan(0);
    if (standard) {
      expect(report.fmt.channelMaskNames).toContain('LOW_FREQUENCY');
      // Exactly one channel may claim the standard LFE bit.
      expect(lfeIndices.length).toBe(1);
    }
  });
});

describe('ADM BWF round trip', () => {
  it.each(LAYOUTS)('%s decodes back to the same PCM with intact metadata', async (layoutId) => {
    const { order } = wavChannelOrder(layoutId);
    const data = buildChannelIdentification(order.length, ID);
    const bytes = await bytesOf(
      writeAdmBwf(data, {
        layoutId,
        bitDepth: 24,
        order,
        date: new Date(Date.UTC(2024, 0, 1)),
        loudness: { integrated: -23, range: 7.5, truePeak: -1 },
      }),
    );

    const report = inspectRiff(bytes);
    expect(report.errors).toEqual([]);
    expect(report.chna.numTracks).toBe(order.length);
    expect(report.chna.entries.length).toBe(order.length);
    expect(report.bext.version).toBe(2);
    expect(report.bext.loudness.integratedLufs).toBeCloseTo(-23, 2);
    expect(report.axml).toContain('audioFormatExtended');
    // ADM files carry mask 0: chna/axml define the routing and a mask would compete.
    expect(report.fmt.channelMask).toBe(0);

    const decoded = decodePcm(bytes);
    const tolerance = quantisationTolerance(24);
    for (let c = 0; c < order.length; c++) {
      for (let i = 0; i < data.length; i += 37) {
        expect(Math.abs(data.channels[c][i] - decoded.channels[c][i])).toBeLessThanOrEqual(
          tolerance,
        );
      }
    }
    expect(identifyChannelOrder(decoded, ID).order).toEqual(order.map((_, i) => i + 1));
  });

  it('binds chna track N to the Nth delivery channel, in order', async () => {
    const layoutId = '7.1.4';
    const { order } = wavChannelOrder(layoutId);
    const data = buildChannelIdentification(order.length, ID);
    const bytes = await bytesOf(writeAdmBwf(data, { layoutId, bitDepth: 24, order }));
    const report = inspectRiff(bytes);
    // Parse the XML properly rather than string-matching: an ID also appears inside the
    // pack format's reference list, so a substring search finds the wrong element.
    const { root } = parseXml(report.axml);
    const channelFormats = new Map(
      findAll(root, 'audioChannelFormat').map((cf) => [cf.attrs.audioChannelFormatID, cf]),
    );

    report.chna.entries.forEach((e, i) => {
      expect(e.trackIndex).toBe(i + 1);
      expect(e.uid).toBe(`ATU_${(i + 1).toString(16).toUpperCase().padStart(8, '0')}`);

      // Follow the chna → trackFormat → streamFormat → channelFormat chain the way a
      // renderer would, and confirm it lands on the speaker the delivery order names.
      const trackFormat = findAll(root, 'audioTrackFormat').find(
        (tf) => tf.attrs.audioTrackFormatID === e.trackFormatIdRef,
      );
      expect(trackFormat, `no audioTrackFormat for chna ref ${e.trackFormatIdRef}`).toBeTruthy();
      const streamId = findOne(trackFormat, 'audioStreamFormatIDRef').text.trim();
      const streamFormat = findAll(root, 'audioStreamFormat').find(
        (sf) => sf.attrs.audioStreamFormatID === streamId,
      );
      expect(streamFormat).toBeTruthy();
      const channelId = findOne(streamFormat, 'audioChannelFormatIDRef').text.trim();
      const channelFormat = channelFormats.get(channelId);
      expect(channelFormat).toBeTruthy();

      const speaker = SPEAKERS[order[i]];
      const block = findOne(channelFormat, 'audioBlockFormat');
      expect(findOne(block, 'speakerLabel').text.trim()).toBe(speaker.admSpeakerLabel);
      const azimuth = findAll(block, 'position').find((p) => p.attrs.coordinate === 'azimuth');
      expect(Number(azimuth.text)).toBeCloseTo(speaker.azimuthAdm, 5);
    });
  });
});

describe('RF64 / BW64 write path', () => {
  const small = buildChannelIdentification(2, { ...ID, toneMs: 20 });

  it('writes an ordinary RIFF file by default', async () => {
    const blob = writeWav(small, { bitDepth: 24 });
    expect(blob.riffContainer).toBe('RIFF');
    expect(inspectRiff(await bytesOf(blob)).container).toBe('RIFF');
  });

  it.each(['rf64', 'bw64'])('writes a valid %s file when asked', async (mode) => {
    const blob = writeWav(small, { bitDepth: 24, container: mode });
    const bytes = await bytesOf(blob);
    const report = inspectRiff(bytes);

    expect(report.container).toBe(mode.toUpperCase());
    expect(report.errors).toEqual([]);
    expect(report.declaredSize).toBe(0xffffffff);
    expect(report.ds64.riffSize).toBe(bytes.length - 8);
    expect(report.ds64.dataSize).toBe(small.length * 2 * 3);
    expect(report.ds64.sampleCount).toBe(small.length);
    expect(report.ds64.tableLength).toBe(0);
    expect(report.chunks[0].id).toBe('ds64');
    expect(report.chunks.find((c) => c.id === 'data').sizeField).toBe(0xffffffff);
  });

  it('round-trips PCM identically through the 64-bit container', async () => {
    const riff = decodePcm(await bytesOf(writeWav(small, { bitDepth: 24 })));
    const bw64 = decodePcm(await bytesOf(writeWav(small, { bitDepth: 24, container: 'bw64' })));
    expect(bw64.length).toBe(riff.length);
    for (let c = 0; c < 2; c++) {
      expect(Array.from(bw64.channels[c])).toEqual(Array.from(riff.channels[c]));
    }
  });

  it('writes a BW64 ADM file when asked, keeping chna and axml intact', async () => {
    const layoutId = '5.1';
    const { order } = wavChannelOrder(layoutId);
    const data = buildChannelIdentification(order.length, { ...ID, toneMs: 20 });
    const bytes = await bytesOf(
      writeAdmBwf(data, { layoutId, bitDepth: 24, order, container: 'bw64' }),
    );
    const report = inspectRiff(bytes);
    expect(report.container).toBe('BW64');
    expect(report.errors).toEqual([]);
    expect(report.chna.numTracks).toBe(6);
    expect(report.axml).toContain('audioFormatExtended');
    expect(report.ds64.dataSize).toBe(data.length * 6 * 3);
  });

  it('refuses a size it cannot buffer rather than wrapping it', () => {
    // A lazily-sized fake: `length` claims 1 GiB of frames × 24 channels × 4 bytes
    // ≈ 96 GiB, which no browser can allocate. The planner must reject this before a
    // single byte is written, which is exactly why the size arithmetic is separate from
    // the encoding — the check costs nothing and needs no memory.
    const stub = new Float32Array(0);
    Object.defineProperty(stub, 'length', { value: 2 ** 30 });
    const huge = { sampleRate: SR, length: 2 ** 30, channels: new Array(24).fill(stub) };
    expect(() => writeWav(huge, { bitDepth: 32 })).toThrow(
      /cannot be held in a single ArrayBuffer/,
    );
  });
});
