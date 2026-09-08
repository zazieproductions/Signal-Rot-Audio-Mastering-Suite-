/**
 * Corpus self-tests: the generator must be deterministic, legal (round-trips
 * through the reader) and structurally correct for every case — including the
 * intentionally malformed ones, which must be malformed in *exactly* the way
 * the case id promises.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { CORPUS, caseById, buildCorpus } from '../../tools/corpus/cases.js';
import { readWav, buildWav, truncateTail } from '../../tools/corpus/wav.js';
import { extended80 } from '../../tools/corpus/aiff.js';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

describe('input corpus', () => {
  it('has a stable case count and unique ids', () => {
    const ids = CORPUS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CORPUS.length).toBeGreaterThanOrEqual(40);
  });

  it('is deterministic — rebuilding the corpus reproduces identical bytes', () => {
    const again = buildCorpus();
    expect(again.length).toBe(CORPUS.length);
    for (let i = 0; i < CORPUS.length; i++) {
      expect(again[i].id).toBe(CORPUS[i].id);
      expect(sha(again[i].file.bytes)).toBe(sha(CORPUS[i].file.bytes));
    }
  });

  it('covers the required matrix', () => {
    const ids = new Set(CORPUS.map((c) => c.id));
    for (const required of [
      'mono-1s-48k-16',
      'one-sample-441k-16',
      'ten-ms-48k-24',
      'stereo-1s-441k-16',
      'stereo-1s-48k-32f',
      'dual-mono-48k-16',
      'hard-lr-48k-16',
      'opposite-polarity-48k-16',
      'silence-1s-48k-16',
      'dc-offset-48k-16',
      'clipped-48k-16',
      'sub-heavy-48k-16',
      'bright-48k-16',
      'float-above-one-48k-32f',
      'rate-8k-1s-16-mono',
      'rate-22050-1s-16',
      'rate-88200-1s-16',
      'rate-96k-1s-24',
      'rate-176400-half-16',
      'rate-192k-half-24',
      '5-1-1s-48k-16',
      '24ch-1s-48k-16',
      'info-unicode-48k-16',
      'odd-chunk-order-48k-16',
      'truncated-data-48k-16',
      'empty-file',
      'not-audio-bytes',
      'long-3min-441k-16-stereo',
      'mp3-1s-441k-128k',
      'aiff-1s-48k-16',
      'name-unicode-emoji',
      'name-very-long',
    ]) {
      expect(ids, `missing corpus case ${required}`).toContain(required);
    }
  });
});

describe('corpus WAV cases round-trip through the reader', () => {
  // The intentionally malformed cases are covered below on their own terms
  // (NaN/Inf decode fine through this reader, so they stay in the round-trip set).
  const MALFORMED = new Set([
    'truncated-data-48k-16',
    'oversized-data-decl-48k-16',
    'bad-header-48k-16',
  ]);
  it.each(
    CORPUS.filter((c) => c.file.mime === 'audio/wav' && c.shape && !MALFORMED.has(c.id)).map(
      (c) => [c.id, c],
    ),
  )('%s has the shape it declares', (_id, c) => {
    const parsed = readWav(c.file.bytes);
    expect(parsed.channels).toBe(c.shape.channels);
    expect(parsed.sampleRate).toBe(c.shape.sampleRate);
    expect(parsed.frames).toBe(c.shape.frames);
  });

  it('keeps RIFF INFO metadata intact, including Unicode', () => {
    const parsed = readWav(caseById('info-unicode-48k-16').file.bytes);
    expect(parsed.info.INAM).toBe('Träumerei 🎛 — 12" master copy');
    expect(parsed.info.ICMT).toContain('«quotes»');
  });

  it('honours an odd chunk order (data before fmt) and still parses', () => {
    const parsed = readWav(caseById('odd-chunk-order-48k-16').file.bytes);
    expect(parsed.chunks).toEqual(['data', 'fmt ']);
    expect(parsed.frames).toBe(48000);
  });

  it('writes extensible multi-channel fmt chunks with the requested mask', () => {
    const parsed51 = readWav(caseById('5-1-1s-48k-16').file.bytes);
    expect(parsed51.channels).toBe(6);
    expect(parsed51.channelMask).toBe(0x3f);
    const parsed24 = readWav(caseById('24ch-1s-48k-16').file.bytes);
    expect(parsed24.channels).toBe(24);
  });

  it('preserves float values above 1.0 and NaN/Inf when asked', () => {
    const above = readWav(caseById('float-above-one-48k-32f').file.bytes);
    expect(Math.max(...above.channelData[0])).toBeCloseTo(1.5, 5);
    const nan = readWav(caseById('float-nan-48k-32f').file.bytes);
    expect(Number.isNaN(nan.channelData[0][0])).toBe(true);
    const inf = readWav(caseById('float-inf-48k-32f').file.bytes);
    expect(inf.channelData[0][0]).toBe(Number.POSITIVE_INFINITY);
  });

  it('clips 16-bit full-scale to the ±32767/32768 grid', () => {
    const parsed = readWav(caseById('clipped-48k-16').file.bytes);
    const samples = parsed.channelData[0];
    expect(Math.max(...samples)).toBeCloseTo(32767 / 32768, 6);
    expect(Math.min(...samples)).toBeCloseTo(-1, 6);
  });

  it('carries the DC offset unaltered', () => {
    const parsed = readWav(caseById('dc-offset-48k-16').file.bytes);
    const mean = parsed.channelData[0].reduce((s, v) => s + v, 0) / parsed.channelData[0].length;
    expect(mean).toBeCloseTo(0.25, 5);
  });
});

describe('corpus malformed cases are malformed on purpose', () => {
  const magic = (bytes) => String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);

  it('truncated-data is a valid header with a short data chunk', () => {
    const bytes = caseById('truncated-data-48k-16').file.bytes;
    expect(magic(bytes)).toBe('RIFF');
    const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      4,
      true,
    );
    expect(bytes.length - 8).toBeLessThan(declared);
  });

  it('bad-header no longer looks like RIFF', () => {
    const bytes = caseById('bad-header-48k-16').file.bytes;
    expect(magic(bytes)).not.toBe('RIFF');
  });

  it('empty-file is exactly zero bytes', () => {
    expect(caseById('empty-file').file.bytes.length).toBe(0);
  });

  it('not-audio-bytes is plain text', () => {
    const text = new TextDecoder().decode(caseById('not-audio-bytes').file.bytes);
    expect(text.startsWith('this is not audio')).toBe(true);
  });

  it('zero-length-data has a valid fmt and an empty data chunk', () => {
    const parsed = readWav(caseById('zero-length-data-48k-16').file.bytes);
    expect(parsed.frames).toBe(0);
    expect(parsed.channels).toBe(2);
  });
});

describe('wav writer primitives', () => {
  it('builds 24-bit PCM that round-trips sample-exactly on the 24-bit grid', () => {
    const frames = 1000;
    const ch = new Float32Array(frames);
    for (let i = 0; i < frames; i++) ch[i] = Math.sin(i * 0.01) * 0.9;
    const bytes = buildWav({ channels: [ch, ch], sampleRate: 44100, bitDepth: 24 });
    const parsed = readWav(bytes);
    // 24-bit grid step is 1/8388608 ≈ 1.2e-7, so 6 decimal places is the honest bound.
    for (let i = 0; i < frames; i++) {
      expect(parsed.channelData[0][i]).toBeCloseTo(ch[i], 6);
    }
  });

  it('truncateTail removes exactly n bytes', () => {
    const bytes = buildWav({ channels: [new Float32Array(10).fill(0.1)], sampleRate: 8000 });
    expect(truncateTail(bytes, 12).length).toBe(bytes.length - 12);
  });
});

describe('aiff writer', () => {
  it('encodes the 80-bit extended sample rate exactly for common rates', () => {
    for (const rate of [8000, 22050, 44100, 48000, 88200, 96000, 192000]) {
      const bytes = extended80(rate);
      // Decode: sign(1) exponent(15, biased 16383) mantissa(64, implicit leading 1)
      const e80 = ((bytes[0] & 0x7f) << 8) | bytes[1];
      const m = bytes.slice(2);
      let mantissa = 0;
      for (const b of m) mantissa = mantissa * 256 + b;
      const value = (1 + Number(mantissa) / 2 ** 64) * 2 ** (e80 - 16383);
      expect(value, `rate ${rate}`).toBeCloseTo(rate, 9);
    }
  });
});
