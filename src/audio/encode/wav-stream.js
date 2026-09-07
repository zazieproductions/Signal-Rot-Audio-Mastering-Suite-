/**
 * Streaming RIFF/WAVE encoder.
 *
 * `writeWav` in `wav.js` builds the whole file in one `ArrayBuffer`. This encoder emits
 * the *same bytes* through a sink in fixed-size PCM blocks, so an export's peak live
 * memory is one block (4 MiB by default) plus the small header buffer, not the whole
 * file. Backed by a `StreamSink` onto the File System Access API, this lifts the practical
 * export ceiling from "whatever a single ArrayBuffer holds" (≈2 GiB in Chromium) to
 * whatever RF64/BW64 and the disk can describe.
 *
 * Byte identity with `writeWav` is guaranteed by construction and checked in
 * `tests/format/wav-stream.test.js`: the container plan, the `fmt ` chunk and every PCM
 * frame come from the shared helpers in `wav.js` / `riff-layout.js`; only the destination
 * of the bytes differs.
 */

import { MAX_BUFFERED_BYTES, planRiffContainer, writeRiffHeader } from './riff-layout.js';
import { STREAM_BLOCK_BYTES, STREAMS_TO_DISK } from './stream-sinks.js';
import { dataViewWriter, encodePcmFrame, prepareWav, writeFmtChunk } from './wav.js';

/**
 * Encode `AudioData` as RIFF/WAVE, streaming the bytes through `sink`.
 *
 * The sink is NOT finished by this function on success beyond the final write — call
 * `sink.finish()` to close the stream. Throwing does not close the sink either; a
 * disk-backed sink should be `abort()`ed by the caller so no partial file survives.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data
 * @param {object} opts
 * @param {16|24|32} opts.bitDepth
 * @param {number} [opts.channelMask]
 * @param {boolean} [opts.forceExtensible]
 * @param {'auto'|'riff'|'rf64'|'bw64'} [opts.container]
 * @param {number} [opts.blockBytes] PCM bytes per streamed block (default 4 MiB)
 * @param {(fraction: number, stage: string) => void} [opts.onProgress]
 * @param {object} sink an object matching the CollectSink/StreamSink surface
 *   (`write(Uint8Array): Promise`)
 * @returns {Promise<{totalBytes: number, container: string, frames: number, blocks: number}>}
 */
export async function writeWavStreamed(data, opts, sink) {
  const { bitDepth } = opts;
  const g = prepareWav(data, bitDepth, opts);
  const { ch, sr, n, dataLen, extensible, fmtLen } = g;

  // A sink that streams to disk has no in-memory ceiling; a collecting sink is only as
  // good as the Blob it accumulates and stays subject to the environment limit.
  const toDisk = sink[STREAMS_TO_DISK] === true;
  const plan = planRiffContainer({
    chunks: [
      { id: 'fmt ', size: fmtLen },
      { id: 'data', size: dataLen },
    ],
    sampleCount: n,
    mode: opts.container ?? 'auto',
    // A disk-streamed sink never accumulates the file, so by default the ArrayBuffer
    // ceiling does not apply; a collecting sink stays subject to it. An explicit
    // override always wins, so the boundary can be tested against either sink kind.
    maxBufferedBytes: opts.maxBufferedBytes ?? (toDisk ? Infinity : MAX_BUFFERED_BYTES),
  });
  const dataPad = dataLen % 2;

  // ── Header: RIFF/RF64/BW64 + ds64? + fmt + the data-chunk header ──
  // Built in a buffer sized for the header prefix only — never plan.totalBytes, which
  // for a large export would re-create the single-giant-allocation this path exists to
  // avoid. The data payload begins immediately after the chunk header.
  const dataChunk = plan.chunks.find((c) => c.id === 'data');
  const headerLen = dataChunk.offset + 8;
  const headerAb = new ArrayBuffer(headerLen);
  const headerView = new DataView(headerAb);
  let o = writeRiffHeader(headerView, plan);
  const w = dataViewWriter(headerView, o);
  writeFmtChunk(w, {
    channels: ch,
    sampleRate: sr,
    bitDepth,
    extensible,
    channelMask: opts.channelMask ?? 0,
  });
  o = w.offset;
  w.ascii('data');
  // In an RF64/BW64 file this is the 0xFFFFFFFF sentinel and the real size is in ds64.
  w.u32(dataChunk.sizeField >>> 0);
  o = w.offset;

  // `dataChunk.offset` is the offset of the chunk header; payload begins 8 bytes later.
  if (o !== headerLen) {
    throw new Error(
      `writeWavStreamed: internal header layout error (header ends at ${o}, ` +
        `data payload expected at ${dataChunk.offset + 8}). Refusing to stream a file ` +
        'whose header and plan disagree.',
    );
  }
  await sink.write(new Uint8Array(headerAb, 0, o));

  // ── PCM blocks ──
  // Frames per block is derived from the block byte budget so a block never straddles a
  // frame — the interleaved payload of `framesPerBlock` whole frames is written, then a
  // fresh block starts.
  const blockBytes = Math.max(1024, opts.blockBytes ?? STREAM_BLOCK_BYTES);
  const framesPerBlock = Math.max(1, Math.floor(blockBytes / g.blockAlign));
  const blockBuf = new ArrayBuffer(framesPerBlock * g.blockAlign);
  const blockView = new DataView(blockBuf);

  let blocks = 0;
  let frame = 0;
  while (frame < n) {
    const count = Math.min(framesPerBlock, n - frame);
    let po = 0;
    for (let i = 0; i < count; i++) {
      po += encodePcmFrame(blockView, po, data.channels, frame + i, ch, bitDepth);
    }
    await sink.write(new Uint8Array(blockBuf, 0, po));
    blocks++;
    frame += count;
    opts.onProgress?.(Math.min(1, frame / Math.max(1, n)), 'encoding');
  }

  // ── Word-alignment pad byte, when the data payload is odd ──
  if (dataPad) {
    const pad = new Uint8Array(1);
    await sink.write(pad);
  }

  if (sink.bytesWritten !== plan.totalBytes) {
    throw new Error(
      `writeWavStreamed: wrote ${sink.bytesWritten} bytes but the container plan says ` +
        `${plan.totalBytes}. Refusing to finish a file whose header and payload disagree.`,
    );
  }

  return { totalBytes: plan.totalBytes, container: plan.container, frames: n, blocks };
}
