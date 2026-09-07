/**
 * Streaming-export orchestration.
 *
 * `exportWithStreaming` decides between a straight-to-disk stream (File System Access
 * API, large exports) and the ordinary Blob download (small files, unsupported browsers,
 * picker open failure). These tests drive a fake picker and a minimal fake
 * WritableStream so the policy — not the browser — is under test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/audio/encode/download.js', () => ({
  downloadBlob: vi.fn(() => ({ ok: true })),
}));

import { downloadBlob } from '../../src/audio/encode/download.js';
import {
  exportWithStreaming,
  STREAM_SAVE_THRESHOLD_BYTES,
} from '../../src/app/streaming-export.js';

/** Minimal WritableStream: enough surface for StreamSink (getWriter/ready/write/close/abort). */
class FakeWritableStream {
  constructor(sink = {}) {
    this.sink = sink;
    this.closed = false;
    this.aborted = false;
    this.writes = [];
    const self = this;
    this.writer = {
      ready: Promise.resolve(),
      async write(chunk) {
        self.writes.push(chunk);
        await sink.write?.(chunk);
      },
      async close() {
        self.closed = true;
        await sink.close?.();
      },
      async abort(error) {
        self.aborted = true;
        await sink.abort?.(error);
      },
      releaseLock() {},
    };
  }
  getWriter() {
    return this.writer;
  }
}

function installGlobals(picker) {
  globalThis.WritableStream = FakeWritableStream;
  globalThis.showSaveFilePicker = picker;
}

const blob = () => new Blob([new Uint8Array(16)], { type: 'audio/wav' });
const abortError = () => Object.assign(new Error('user cancelled'), { name: 'AbortError' });

beforeEach(() => {
  downloadBlob.mockClear();
});

afterEach(() => {
  delete globalThis.showSaveFilePicker;
  delete globalThis.WritableStream;
});

describe('exportWithStreaming policy', () => {
  it('downloads small files directly even when the picker exists', async () => {
    installGlobals(async () => {
      throw abortError();
    });
    const stream = vi.fn(async () => ({ totalBytes: 10 }));
    const encodeBlob = vi.fn(blob);

    const result = await exportWithStreaming({
      filename: 'small.wav',
      estimatedBytes: 1024,
      stream,
      encodeBlob,
    });

    expect(result.mode).toBe('download');
    expect(stream).not.toHaveBeenCalled();
    expect(encodeBlob).toHaveBeenCalledOnce();
    expect(downloadBlob).toHaveBeenCalledOnce();
  });

  it('streams large files through the picker sink on a supporting browser', async () => {
    let created;
    installGlobals(async () => {
      created = new FakeWritableStream();
      return {
        async createWritable() {
          return created;
        },
      };
    });
    const result = await exportWithStreaming({
      filename: 'huge.wav',
      estimatedBytes: STREAM_SAVE_THRESHOLD_BYTES + 1,
      stream: async (sink) => {
        await sink.write(new Uint8Array(100));
        return { totalBytes: 100, container: 'BW64' };
      },
      encodeBlob: vi.fn(blob),
    });
    expect(result.mode).toBe('stream');
    expect(result.container).toBe('BW64');
    expect(created.closed).toBe(true);
    expect(created.writes.length).toBeGreaterThan(0);
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('reports cancellation without downloading when the user dismisses the picker', async () => {
    installGlobals(async () => {
      throw abortError();
    });
    const encodeBlob = vi.fn(blob);
    const stream = vi.fn();
    const result = await exportWithStreaming({
      filename: 'huge.wav',
      estimatedBytes: STREAM_SAVE_THRESHOLD_BYTES * 2,
      stream,
      encodeBlob,
    });
    expect(result.mode).toBe('cancelled');
    // No surprise fallback download after an explicit cancel, and no encode work either.
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(encodeBlob).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it('falls back to a normal download if the picker fails for a non-cancel reason', async () => {
    installGlobals(async () => {
      throw new Error('SecurityError: cross-origin directory');
    });
    const result = await exportWithStreaming({
      filename: 'huge.wav',
      estimatedBytes: STREAM_SAVE_THRESHOLD_BYTES * 2,
      stream: vi.fn(),
      encodeBlob: blob,
    });
    expect(result.mode).toBe('download');
    expect(downloadBlob).toHaveBeenCalledOnce();
  });

  it('downloads when streaming support is absent entirely', async () => {
    // No globals installed: supportsStreamingSave() is false.
    const result = await exportWithStreaming({
      filename: 'huge.wav',
      estimatedBytes: STREAM_SAVE_THRESHOLD_BYTES * 10,
      stream: vi.fn(),
      encodeBlob: blob,
    });
    expect(result.mode).toBe('download');
    expect(downloadBlob).toHaveBeenCalledOnce();
  });

  it('propagates mid-stream write failures, aborts the file, and does not download', async () => {
    let created;
    installGlobals(async () => {
      created = new FakeWritableStream({
        write() {
          throw new Error('disk full');
        },
      });
      return {
        async createWritable() {
          return created;
        },
      };
    });
    await expect(
      exportWithStreaming({
        filename: 'huge.wav',
        estimatedBytes: STREAM_SAVE_THRESHOLD_BYTES + 1,
        stream: async (sink) => {
          await sink.write(new Uint8Array(10));
          return { totalBytes: 10 };
        },
        encodeBlob: vi.fn(blob),
      }),
    ).rejects.toThrow(/disk full/);
    expect(created.aborted).toBe(true);
    expect(created.closed).toBe(false);
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
