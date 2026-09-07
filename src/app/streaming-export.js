/**
 * Streaming export orchestration.
 *
 * ── The decision ────────────────────────────────────────────────────────────────────
 * A large WAV/BWF export is sent through the File System Access API picker straight to
 * disk: the encoder never holds more than one 4 MiB PCM block, so the browser's ≈2 GiB
 * single-allocation ceiling no longer applies and RF64/BW64 promotion works at the sizes
 * the container was designed for. Small exports keep the instant one-click download —
 * popping a "Save as" dialog for a 3 MB reference would be pure friction.
 *
 * When the picker is unavailable (Firefox, Safari at time of writing) or the user cancels
 * it, the caller-supplied in-memory Blob is downloaded the ordinary way. A failure
 * *during* the stream itself (disk full, write error) is reported and NOT silently
 * retried through the memory path — at these sizes that path is exactly what would take
 * the tab down.
 */

import { downloadBlob } from '../audio/encode/download.js';
import {
  CollectSink,
  openSaveFileSink,
  supportsStreamingSave,
} from '../audio/encode/stream-sinks.js';

/**
 * Estimated encoded size at which a save dialog is offered instead of the instant
 * download. 256 MiB is well under the ~2 GiB allocation ceiling in every shipping
 * browser yet large enough that a straight-to-disk write meaningfully reduces peak
 * memory and fragmentation.
 */
export const STREAM_SAVE_THRESHOLD_BYTES = 256 * 1024 * 1024;

/**
 * Export audio via the streaming path when the environment and size justify it.
 *
 * The caller supplies BOTH ways to produce the file:
 *   · `stream(sink)`  — calls `writeWavStreamed`/`writeAdmBwfStreamed` against the sink
 *   · `encodeBlob()`  — the legacy in-memory encode, used for small files, for browsers
 *                       without the picker, and when the user dismisses the picker
 *
 * @param {object} opts
 * @param {string} opts.filename           sanitised download/picker filename
 * @param {number} opts.estimatedBytes     expected encoded file size
 * @param {(sink: object) => Promise<{totalBytes: number, container: string}>} opts.stream
 * @param {() => Blob|Promise<Blob>} opts.encodeBlob
 * @param {(fraction: number, stage: string) => void} [opts.onProgress]
 * @param {number} [opts.thresholdBytes]
 * @returns {Promise<{mode: 'stream'|'download'|'cancelled', bytes?: number, container?: string, blob?: Blob}>}
 */
export async function exportWithStreaming(opts) {
  const threshold = opts.thresholdBytes ?? STREAM_SAVE_THRESHOLD_BYTES;
  const large = opts.estimatedBytes >= threshold;

  if (!large || !supportsStreamingSave()) {
    const blob = await opts.encodeBlob();
    const result = downloadBlob(blob, opts.filename);
    if (!result.ok) throw result.error ?? new Error('Download failed');
    return { mode: 'download', blob, bytes: blob.size };
  }

  let picked;
  try {
    picked = await openSaveFileSink({ suggestedName: opts.filename });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      // User dismissed the save dialog. Treat it as a cancellation: the caller can fall
      // back to an ordinary download (or to its own "export cancelled" messaging), but a
      // surprise 2 GiB download is never the right default.
      return { mode: 'cancelled' };
    }
    // Picker unavailable or refused permission for a non-cancel reason: fall back to the
    // normal download rather than failing the export outright.
    const blob = await opts.encodeBlob();
    const result = downloadBlob(blob, opts.filename);
    if (!result.ok) throw result.error ?? new Error('Download failed');
    return { mode: 'download', blob, bytes: blob.size };
  }

  const { sink } = picked;
  try {
    const info = await opts.stream(sink);
    await sink.finish();
    return { mode: 'stream', bytes: info.totalBytes, container: info.container };
  } catch (error) {
    await sink.abort(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Convenience wrapper for callers that already hold the encoded bytes as a Blob but want
 * them collected via a streaming encode (tests, and the in-memory fallback when a stream
 * encode is requested without a picker).
 * @param {(sink: object) => Promise<any>} stream
 * @returns {Promise<Blob>}
 */
export async function collectStreamedBlob(stream) {
  const sink = new CollectSink();
  await stream(sink);
  return sink.finish('audio/wav');
}
