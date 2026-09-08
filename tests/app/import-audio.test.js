/**
 * Import-boundary tests: the functions that decide what may become a working
 * buffer, and what must be refused — with which words.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  preflightFile,
  validateDecodedBuffer,
  describeDecodeError,
  describeReadError,
  looksLikeAudio,
  decodeAudioFile,
  formatRateKhz,
  buildMasterName,
  uniqueName,
  MAX_INPUT_CHANNELS,
} from '../../src/app/import-audio.js';

function makeBuffer({ channels = 2, frames = 4800, sampleRate = 48000, fill = 0.1 } = {}) {
  const data = [];
  for (let c = 0; c < channels; c++) data.push(new Float32Array(frames).fill(fill));
  return {
    numberOfChannels: channels,
    length: frames,
    sampleRate,
    duration: frames / sampleRate,
    getChannelData: (c) => data[c],
  };
}

function makeFile({
  name = 'track.wav',
  size,
  type = 'audio/wav',
  bytes = new Uint8Array(64),
  readError,
} = {}) {
  return {
    name,
    type,
    size: size ?? bytes.length,
    arrayBuffer: async () => {
      if (readError) throw readError;
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function makeCtx({ decoded, decodeError } = {}) {
  return {
    decodeAudioData: vi.fn(async () => {
      if (decodeError) throw decodeError;
      return decoded;
    }),
  };
}

/**
 * A buffer that *claims* a size without allocating it — for exercising the
 * duration and memory preflight paths on hour-long files without giving the
 * test runner a gigabyte.
 */
function ghostBuffer({ channels = 2, frames, sampleRate = 48000 } = {}) {
  return {
    numberOfChannels: channels,
    length: frames,
    sampleRate,
    duration: frames / sampleRate,
    getChannelData: () => new Float32Array(0),
  };
}

describe('preflightFile (pre-decode)', () => {
  it('refuses an empty file with a specific message', () => {
    const { errors } = preflightFile(makeFile({ size: 0 }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/empty \(0 bytes\)/);
  });

  it('refuses an oversized file before any decode', () => {
    const { errors } = preflightFile(makeFile({ size: 600 * 1024 * 1024 }));
    expect(errors[0]).toMatch(/limit/);
  });

  it('passes a normal file', () => {
    const { errors } = preflightFile(makeFile({ size: 1024 * 1024 }));
    expect(errors).toEqual([]);
  });
});

describe('validateDecodedBuffer', () => {
  const BUDGET = { memoryBudgetBytes: 256 * 1024 * 1024 };

  it('accepts an ordinary stereo file with no noise', () => {
    const v = validateDecodedBuffer(makeBuffer(), { name: 'ok.wav', ...BUDGET });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(v.notes).toEqual([]);
  });

  it('explains mono routing explicitly', () => {
    const v = validateDecodedBuffer(makeBuffer({ channels: 1 }), { name: 'm.wav', ...BUDGET });
    expect(v.errors).toEqual([]);
    expect(v.notes.join(' ')).toMatch(/mono.*dual-mono routing/i);
  });

  it('explains multichannel fold-down explicitly', () => {
    const v = validateDecodedBuffer(makeBuffer({ channels: 6 }), { name: 's.wav', ...BUDGET });
    expect(v.errors).toEqual([]);
    expect(v.notes.join(' ')).toMatch(/6 channels/);
    expect(v.notes.join(' ')).toMatch(/fold/i);
  });

  it('refuses channels above the ceiling', () => {
    const v = validateDecodedBuffer(makeBuffer({ channels: MAX_INPUT_CHANNELS + 8 }), {
      name: 'wide.wav',
      ...BUDGET,
    });
    expect(v.errors[0]).toMatch(/up to \d+/);
  });

  it('refuses a buffer with no samples', () => {
    const v = validateDecodedBuffer(makeBuffer({ frames: 0 }), { name: 'void.wav', ...BUDGET });
    expect(v.errors[0]).toMatch(/no audio samples/i);
  });

  it('refuses NaN samples', () => {
    const buf = makeBuffer();
    buf.getChannelData(1)[123] = Number.NaN;
    const v = validateDecodedBuffer(buf, { name: 'bad.wav', ...BUDGET });
    expect(v.errors[0]).toMatch(/non-finite/i);
    expect(v.errors[0]).toMatch(/frame 123 of channel 2/);
  });

  it('refuses ±Infinity samples', () => {
    const buf = makeBuffer();
    buf.getChannelData(0)[7] = Number.NEGATIVE_INFINITY;
    const v = validateDecodedBuffer(buf, { name: 'bad.wav', ...BUDGET });
    expect(v.errors[0]).toMatch(/non-finite/i);
  });

  it('warns (does not refuse) on very long files', () => {
    // 40 minutes — a ghost buffer, so the test does not allocate 900 MB
    const v = validateDecodedBuffer(ghostBuffer({ frames: 40 * 60 * 48000 }), {
      name: 'long.wav',
      ...BUDGET,
    });
    expect(v.errors).toEqual([]);
    expect(v.warnings.join(' ')).toMatch(/slow and memory-hungry/i);
  });

  it('refuses files beyond the hard duration ceiling', () => {
    const v = validateDecodedBuffer(ghostBuffer({ frames: 61 * 60 * 48000 }), {
      name: 'too-long.wav',
      ...BUDGET,
    });
    expect(v.errors[0]).toMatch(/limit is 1:00:00/);
  });

  it('notes unusual sample rates', () => {
    const v = validateDecodedBuffer(makeBuffer({ sampleRate: 12345, frames: 12345 }), {
      name: 'odd.wav',
      ...BUDGET,
    });
    expect(v.notes.join(' ')).toMatch(/Unusual sample rate \(12345 Hz\)/);
  });

  it('flags renders that will not fit in memory', () => {
    // 10 minutes, 192 kHz stereo: ~2.7 GB across source+DSP+output with a 256 MB budget
    const v = validateDecodedBuffer(ghostBuffer({ frames: 10 * 60 * 192000, sampleRate: 192000 }), {
      name: 'heavy.wav',
      ...BUDGET,
    });
    expect(v.errors).toEqual([]);
    expect(v.warnings.join(' ')).toMatch(/may exceed available memory/i);
    expect(v.memory.classification).toBe('LIKELY UNSAFE');
  });

  it('does not flag a modest file', () => {
    const v = validateDecodedBuffer(makeBuffer(), { name: 'ok.wav', ...BUDGET });
    expect(v.memory.classification).toBe('SAFE');
  });
});

describe('decode error classification', () => {
  it('maps EncodingError to corruption language', () => {
    const msg = describeDecodeError(new DOMException('x', 'EncodingError'), 'broken.wav');
    expect(msg).toMatch(/truncated or corrupted/i);
  });

  it('maps NotSupportedError to codec language and never claims universal support', () => {
    const msg = describeDecodeError(new DOMException('x', 'NotSupportedError'), 'm4a.m4a');
    expect(msg).toMatch(/not supported by this browser/i);
    expect(msg).toMatch(/WAV and MP3 work everywhere/i);
  });

  it('maps read errors to file-access language', () => {
    const msg = describeReadError(new DOMException('x', 'ReadError'), 'gone.wav');
    expect(msg).toMatch(/could not be read/i);
  });

  it('falls back to a specific message with the file name for unknown errors', () => {
    const msg = describeDecodeError(new Error('weird'), 'x.wav');
    expect(msg).toMatch(/Could not decode “x\.wav”/);
  });

  it('sanitises the file name in every message', () => {
    const msg = describeDecodeError(new DOMException('x', 'EncodingError'), '../../etc/passwd');
    expect(msg).not.toContain('..');
    expect(msg).not.toContain('/');
  });
});

describe('looksLikeAudio', () => {
  it('accepts audio/* MIME types', () => {
    expect(looksLikeAudio({ type: 'audio/wav', name: 'a' })).toBe(true);
    expect(looksLikeAudio({ type: 'audio/x-flac', name: 'a' })).toBe(true);
  });

  it('accepts extension-only files (drop events often have no MIME)', () => {
    expect(looksLikeAudio({ type: '', name: 'A.MP3' })).toBe(true);
    expect(looksLikeAudio({ type: '', name: 'a.aifc' })).toBe(true);
    expect(looksLikeAudio({ type: '', name: 'noextension' })).toBe(false);
  });

  it('refuses declared non-audio files', () => {
    expect(looksLikeAudio({ type: 'text/plain', name: 'notes.txt' })).toBe(false);
    expect(looksLikeAudio({ type: 'application/pdf', name: 'doc.pdf' })).toBe(false);
  });

  it('defers to the decoder when MIME and extension disagree', () => {
    expect(looksLikeAudio({ type: 'application/octet-stream', name: 'mystery.wav' })).toBe(true);
  });

  it('rejects null/undefined', () => {
    expect(looksLikeAudio(null)).toBe(false);
    expect(looksLikeAudio(undefined)).toBe(false);
  });
});

describe('decodeAudioFile (the whole boundary)', () => {
  it('refuses empty files without calling the decoder', async () => {
    const ctx = makeCtx();
    const result = await decodeAudioFile(ctx, makeFile({ size: 0 }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/empty/);
    expect(ctx.decodeAudioData).not.toHaveBeenCalled();
  });

  it('refuses read failures with access language', async () => {
    const ctx = makeCtx();
    const result = await decodeAudioFile(
      ctx,
      makeFile({ readError: new DOMException('gone', 'ReadError') }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/could not be read/i);
  });

  it('refuses decoder failures with the classified message', async () => {
    const ctx = makeCtx({ decodeError: new DOMException('bad', 'EncodingError') });
    const result = await decodeAudioFile(ctx, makeFile({ bytes: new Uint8Array(100) }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/truncated or corrupted/i);
  });

  it('refuses a decode that yields no samples', async () => {
    const ctx = makeCtx({ decoded: makeBuffer({ frames: 0 }) });
    const result = await decodeAudioFile(ctx, makeFile());
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/no audio samples/i);
  });

  it('refuses non-finite decodes', async () => {
    const buf = makeBuffer();
    buf.getChannelData(0)[0] = Number.NaN;
    const ctx = makeCtx({ decoded: buf });
    const result = await decodeAudioFile(ctx, makeFile());
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/non-finite/i);
  });

  it('delivers the buffer plus notes for a clean mono file', async () => {
    const buf = makeBuffer({ channels: 1 });
    const ctx = makeCtx({ decoded: buf });
    const result = await decodeAudioFile(ctx, makeFile({ name: 'solo.wav' }));
    expect(result.ok).toBe(true);
    expect(result.buffer).toBe(buf);
    expect(result.notes.join(' ')).toMatch(/dual-mono routing/i);
  });

  it('delivers the decoded buffer unmodified (fidelity)', async () => {
    const buf = makeBuffer({ fill: 0.3 });
    const before = buf.getChannelData(0).slice(0, 8);
    const ctx = makeCtx({ decoded: buf });
    const result = await decodeAudioFile(ctx, makeFile());
    expect(result.ok).toBe(true);
    expect(result.buffer).toBe(buf); // no copy, no re-quantisation, no re-ordering
    expect(Array.from(result.buffer.getChannelData(0).slice(0, 8))).toEqual(Array.from(before));
  });
});

describe('output naming', () => {
  it('formats rates the way a mastering folder should read', () => {
    expect(formatRateKhz(48000)).toBe('48k');
    expect(formatRateKhz(44100)).toBe('44.1k');
    expect(formatRateKhz(22050)).toBe('22.05k');
    expect(formatRateKhz(176400)).toBe('176.4k');
    expect(formatRateKhz(192000)).toBe('192k');
  });

  const wav24 = { container: 'wav', bitDepth: 24, ext: 'wav', label: 'WAV 24-bit' };
  const mp3 = { container: 'mp3', bitDepth: 16, ext: 'mp3', label: 'MP3 320' };

  it('builds professional, predictable names', () => {
    expect(buildMasterName({ base: 'My Track.wav', sampleRate: 48000, format: wav24 })).toBe(
      'My Track_master_24bit_48k.wav',
    );
    expect(buildMasterName({ base: 'My Track.wav', sampleRate: 44100, format: mp3 })).toBe(
      'My Track_master_320k_44.1k.mp3',
    );
  });

  it('sanitises hostile base names but keeps Unicode', () => {
    const name = buildMasterName({
      base: '<img src=x onerror=alert(1)>.wav',
      sampleRate: 48000,
      format: wav24,
    });
    expect(name).not.toContain('<');
    expect(name).not.toContain('>');
    expect(name).toMatch(/_master_24bit_48k\.wav$/);
    expect(buildMasterName({ base: 'Träumerei 🎛.wav', sampleRate: 96000, format: wav24 })).toBe(
      'Träumerei 🎛_master_24bit_96k.wav',
    );
  });

  it('truncates absurdly long base names without breaking the suffix', () => {
    const name = buildMasterName({
      base: `${'a'.repeat(400)}.wav`,
      sampleRate: 48000,
      format: wav24,
    });
    // base is capped at 120 chars by sanitisation; the suffix must survive intact
    expect(name.length).toBe(120 + '_master_24bit_48k.wav'.length);
    expect(name).toMatch(/_master_24bit_48k\.wav$/);
  });

  it('deduplicates within a session instead of trusting the browser', () => {
    const used = new Set();
    const candidate = 'track_master_24bit_48k.wav';
    expect(uniqueName(candidate, used)).toBe(candidate);
    expect(uniqueName(candidate, used)).toBe('track_master_24bit_48k_2.wav');
    expect(uniqueName(candidate, used)).toBe('track_master_24bit_48k_3.wav');
  });
});
