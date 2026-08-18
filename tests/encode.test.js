import { describe, it, expect } from 'vitest';
import {
  writeWAV, writeAIFF, writeWAVMultiExt, writeADMBWF, encodeMP3, f80,
} from '../src/lib/encode.js';
import { channelsOf } from '../src/lib/layouts.js';
import { makeBuffer, sine, parseRIFF, chunkText, readSamples16, blobToArrayBuffer } from './helpers.js';
import { mulberry32 } from '../src/lib/math.js';

function stereo(buf) {
  return buf;
}

describe('writeWAV', () => {
  it('writes a well-formed 16-bit PCM header', async () => {
    const buf = makeBuffer([sine(1000, 48000, 0.1, 0.5), sine(1000, 48000, 0.1, 0.5)], 48000);
    const ab = await blobToArrayBuffer(writeWAV(buf, 16));
    const { form, chunks } = parseRIFF(ab);
    expect(form).toBe('WAVE');
    const ids = chunks.map((c) => c.id);
    expect(ids).toEqual(['fmt ', 'data']);
    const fmt = chunks[0];
    expect(fmt.view.getUint16(fmt.dataOff + 0, true)).toBe(1); // PCM
    expect(fmt.view.getUint16(fmt.dataOff + 2, true)).toBe(2); // channels
    expect(fmt.view.getUint32(fmt.dataOff + 4, true)).toBe(48000);
    expect(fmt.view.getUint16(fmt.dataOff + 14, true)).toBe(16); // bits
    const data = chunks[1];
    expect(data.size).toBe(buf.length * 2 * 2);
    expect(ab.byteLength).toBe(44 + data.size);
  });

  it('writes 32-bit float with format tag 3', async () => {
    const buf = makeBuffer([sine(1000, 48000, 0.05, 0.5)], 48000);
    const ab = await blobToArrayBuffer(writeWAV(buf, 32));
    const { chunks } = parseRIFF(ab);
    expect(chunks[0].view.getUint16(chunks[0].dataOff, true)).toBe(3);
  });

  it('TPDF dither linearizes a sub-LSB signal', async () => {
    const n = 48000;
    const d = new Float32Array(n).fill(0.25 / 32768); // 0.25 LSB @ 16-bit
    const buf = makeBuffer([d], 48000);
    const abNo = await blobToArrayBuffer(writeWAV(buf, 16, { dither: false }));
    const noDither = readSamples16(parseRIFF(abNo).chunks.find((c) => c.id === 'data'), 1)[0];
    // Without dither every sample rounds to zero.
    for (let i = 0; i < n; i++) expect(noDither[i]).toBe(0);

    const abDithered = await blobToArrayBuffer(writeWAV(buf, 16, { dither: true, rng: mulberry32(42) }));
    const dithered = readSamples16(parseRIFF(abDithered).chunks.find((c) => c.id === 'data'), 1)[0];
    // With TPDF dither the average recovers the 0.25 LSB mean.
    let sum = 0;
    for (let i = 0; i < n; i++) sum += dithered[i] * 32768;
    const meanLsb = sum / n;
    expect(meanLsb).toBeGreaterThan(0.15);
    expect(meanLsb).toBeLessThan(0.35);
    // And some samples are non-zero.
    expect(dithered.some((v) => v !== 0)).toBe(true);
  });
});

describe('writeAIFF', () => {
  it('writes FORM/AIFF/COMM/SSND chunks', async () => {
    const buf = makeBuffer([sine(1000, 44100, 0.05, 0.5), sine(1000, 44100, 0.05, 0.5)], 44100);
    const ab = await blobToArrayBuffer(writeAIFF(buf));
    const v = new DataView(ab);
    const txt = (o, n) => {
      let s = '';
      for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(o + i));
      return s;
    };
    expect(txt(0, 4)).toBe('FORM');
    expect(txt(8, 4)).toBe('AIFF');
    expect(txt(12, 4)).toBe('COMM');
    expect(v.getUint16(20, false)).toBe(2); // channels (big-endian)
    expect(v.getUint16(26, false)).toBe(24); // bits
    expect(txt(12 + 8 + 18, 4)).toBe('SSND');
  });

  it('encodes the 80-bit extended sample rate', () => {
    const b = f80(44100);
    // Exponent is big-endian at b[0..1]; mantissa non-zero.
    expect(b[0]).not.toBe(0);
    expect(b.some((x) => x !== 0)).toBe(true);
    expect(f80(0).every((x) => x === 0)).toBe(true);
  });
});

describe('writeWAVMultiExt', () => {
  it('writes a WAVE_FORMAT_EXTENSIBLE header with mask + subformat GUID', async () => {
    const data = [];
    for (let c = 0; c < 6; c++) data.push(sine(1000, 48000, 0.02, 0.4));
    const buf = makeBuffer(data, 48000);
    const ab = await blobToArrayBuffer(writeWAVMultiExt(buf, 24, 0x3f));
    const { chunks } = parseRIFF(ab);
    const fmt = chunks[0];
    expect(fmt.view.getUint16(fmt.dataOff, true)).toBe(0xfffe);
    expect(fmt.view.getUint16(fmt.dataOff + 2, true)).toBe(6);
    expect(fmt.view.getUint32(fmt.dataOff + 20, true)).toBe(0x3f); // mask
    // SubFormat GUID begins 01 00 (PCM).
    expect(fmt.view.getUint8(fmt.dataOff + 24)).toBe(0x01);
    expect(fmt.view.getUint8(fmt.dataOff + 25)).toBe(0x00);
  });
});

describe('writeADMBWF', () => {
  it('writes bext/fmt/data/chna/axml chunks with valid XML and chna count', async () => {
    const layout = '5.1';
    const chans = channelsOf(layout);
    const data = chans.map(() => sine(500, 48000, 0.01, 0.3));
    const buf = makeBuffer(data, 48000);
    const ab = await blobToArrayBuffer(writeADMBWF(buf, layout, chans, 24));
    const { form, chunks } = parseRIFF(ab);
    expect(form).toBe('WAVE');
    const ids = chunks.map((c) => c.id);
    expect(ids).toContain('bext');
    expect(ids).toContain('fmt ');
    expect(ids).toContain('data');
    expect(ids).toContain('chna');
    expect(ids).toContain('axml');

    const chna = chunks.find((c) => c.id === 'chna');
    expect(chna.view.getUint16(chna.dataOff, true)).toBe(chans.length);

    const axml = chunks.find((c) => c.id === 'axml');
    expect(axml.size % 2).toBe(0); // odd-byte padding respected
    const xml = chunkText(axml);
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('typeDefinition="DirectSpeakers"');
    expect(xml).toContain('typeLabel="0001"'); // DirectSpeakers label (not Objects)
    const trackCount = (xml.match(/<audioTrackUID /g) || []).length;
    expect(trackCount).toBe(chans.length);
  });
});

describe('encodeMP3', () => {
  it('encodes a stereo signal to a non-empty MP3 stream', async () => {
    const buf = makeBuffer([sine(1000, 44100, 1.0, 0.5), sine(1000, 44100, 1.0, 0.5)], 44100);
    const blob = encodeMP3(stereo(buf), 320);
    expect(blob.type).toBe('audio/mpeg');
    const ab = await blobToArrayBuffer(blob);
    expect(ab.byteLength).toBeGreaterThan(10000);
    expect(new Uint8Array(ab)[0]).toBe(0xff); // MPEG sync byte
  });
});
