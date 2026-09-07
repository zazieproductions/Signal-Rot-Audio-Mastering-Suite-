/**
 * Byte sinks for the streaming encoders.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────
 * The in-memory writers build one `ArrayBuffer` per file, which browsers cap well below
 * 4 GiB (Chromium's default maximum is around 2 GiB, Safari's is lower). A streaming
 * encoder hands small, fixed-size blocks to a sink instead, and the sink decides where
 * the bytes go:
 *
 *   · `StreamSink` wraps a `WritableStream` (the File System Access API's
 *     `createWritable()`, or any spec-compliant stream — Node's `Writable.toWeb()` in
 *     tests). Blocks are awaited in order, so the writer sees backpressure and the peak
 *     live allocation is one block, not the whole file.
 *   · `CollectSink` concatenates the blocks into one `Blob` at the end. It still avoids
 *     the single-giant-`ArrayBuffer` allocation: each block is a separate buffer and the
 *     `Blob` references them rather than copying them. It is the automatic fallback for
 *     browsers without the File System Access API (Firefox, Safari at time of writing),
 *     and the sink used by the in-memory test harness.
 *
 * Both sinks expose the same tiny surface (`write(Uint8Array)` / `finish()`), which is
 * all the streaming encoders need.
 */

/**
 * Default block size for streamed PCM: 4 MiB. Large enough that per-block overhead and
 * backpressure round-trips stay negligible, small enough that peak extra memory stays in
 * the low megabytes even for a 24-channel bed.
 */
export const STREAM_BLOCK_BYTES = 4 * 1024 * 1024;

/**
 * Property tag used to mark sinks that stream straight to disk (and therefore have no
 * in-memory size ceiling). The container planner consults this: a disk-streamed export
 * may legitimately exceed the `ArrayBuffer` ceiling; a collected one must not be planned
 * as if it could.
 */
export const STREAMS_TO_DISK = Symbol.for('signal-rot.streamsToDisk');

/**
 * Collect every written block and concatenate into a single Blob on `finish()`.
 *
 * This deliberately does NOT accumulate into one growing `ArrayBuffer` — that would
 * recreate the very allocation cap the streaming path exists to avoid. `Blob` keeps its
 * constituent parts separate and only the browser's download machinery touches them as a
 * whole.
 */
export class CollectSink {
  constructor() {
    this.blocks = [];
    this.bytesWritten = 0;
    this.finished = false;
    this[STREAMS_TO_DISK] = false;
  }

  /**
   * @param {Uint8Array} bytes
   */
  async write(bytes) {
    if (this.finished) throw new Error('CollectSink: write after finish');
    // Take a copy: encoders hand over scratch buffers they reuse for the next block.
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    this.blocks.push(copy);
    this.bytesWritten += bytes.length;
  }

  /**
   * @param {string} [mime]
   * @returns {Promise<Blob>}
   */
  async finish(mime = 'audio/wav') {
    if (this.finished) throw new Error('CollectSink: finished twice');
    this.finished = true;
    return new Blob(this.blocks, { type: mime });
  }
}

/**
 * Stream blocks to a `WritableStream` (File System Access API in the browser, any web
 * stream elsewhere). Writes are serialised: each block is awaited before the next is
 * encoded, so a slow disk applies backpressure and nothing buffers inside the writer.
 */
export class StreamSink {
  /**
   * @param {WritableStream} writable
   * @param {object} [opts]
   * @param {() => Promise<void>|void} [opts.onClose] called once, after the stream closes
   */
  constructor(writable, opts = {}) {
    if (!writable || typeof writable.getWriter !== 'function') {
      throw new Error('StreamSink: expected a WritableStream (getWriter() missing)');
    }
    this.writer = writable.getWriter();
    this.onClose = opts.onClose;
    this.bytesWritten = 0;
    this.finished = false;
    this[STREAMS_TO_DISK] = true;
  }

  /**
   * @param {Uint8Array} bytes
   */
  async write(bytes) {
    if (this.finished) throw new Error('StreamSink: write after finish');
    // ready is a readiness promise / getter depending on the platform; both await fine.
    await this.writer.ready;
    // No copy needed: the stream either transfers or synchronously copies the bytes,
    // and the encoder does not touch a block again after handing it over.
    await this.writer.write(bytes);
    this.bytesWritten += bytes.length;
  }

  async finish() {
    if (this.finished) throw new Error('StreamSink: finished twice');
    this.finished = true;
    await this.writer.close();
    this.writer.releaseLock();
    if (this.onClose) await this.onClose();
    return this.bytesWritten;
  }

  /**
   * Abort an in-progress export. The partially written file is torn down rather than
   * left on disk looking like a master.
   */
  async abort(error) {
    if (this.finished) return;
    this.finished = true;
    try {
      await this.writer.abort(error ?? new Error('Export aborted'));
    } finally {
      try {
        this.writer.releaseLock();
      } catch {
        /* already released */
      }
      if (this.onClose) await this.onClose();
    }
  }
}

/**
 * Feature detection for the File System Access API save path.
 *
 * `showSaveFilePicker` is Chromium-only at time of writing; Firefox and Safari lack it
 * and the caller falls back to the collected-Blob download path.
 *
 * @param {object} [win] injectable for tests; defaults to `globalThis`
 */
export function supportsStreamingSave(win = globalThis) {
  return (
    typeof win === 'object' &&
    win !== null &&
    typeof win.showSaveFilePicker === 'function' &&
    typeof win.WritableStream === 'function'
  );
}

/**
 * Suggested File System Access API file types for a WAV/BWF export.
 */
export const WAV_SAVE_FILE_TYPE = Object.freeze({
  description: 'WAV / Broadcast Wave audio',
  accept: { 'audio/wav': ['.wav'] },
});

/**
 * Open the "Save as" picker and return a sink streaming to the chosen file.
 *
 * Throws `AbortError` (name === 'AbortError') when the user cancels the picker; the
 * caller treats that as a non-error. Any other failure is a real error and the caller
 * falls back to the ordinary download path.
 *
 * @param {object} opts
 * @param {string} opts.suggestedName
 * @param {(win?: object) => object} [opts.win] injectable for tests; defaults to `globalThis`
 * @returns {Promise<{sink: StreamSink, handle: object}>}
 */
export async function openSaveFileSink({ suggestedName }, win = globalThis) {
  if (!supportsStreamingSave(win)) {
    throw new Error('openSaveFileSink: File System Access API is not available in this browser');
  }
  const handle = await win.showSaveFilePicker({
    suggestedName,
    types: [WAV_SAVE_FILE_TYPE],
  });
  const writable = await handle.createWritable();
  const sink = new StreamSink(writable);
  return { sink, handle };
}
