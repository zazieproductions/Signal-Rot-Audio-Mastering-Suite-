/**
 * Streaming ADM BWF writer — the disk-backed twin of `writeAdmBwf` in `adm.js`.
 *
 * Chunk order is the BWF convention: `ds64?` (when promoted) → `bext` → `fmt ` →
 * `chna` → `data` → `axml`. Everything through the `data` chunk header is built in one
 * small prefix buffer (a few kilobytes, no matter how long the programme is); the PCM
 * then streams in fixed-size blocks; the variable-length `axml` trailer is written last.
 *
 * As with the plain-WAVE streaming path, the chunk planners and encoders are the shared
 * functions in `adm.js` / `wav.js`, so a streamed ADM BWF is byte-identical to the
 * in-memory one for the same inputs (asserted in `tests/interoperability/stream-round-trip.test.js`).
 */

import { planRiffContainer, writeRiffHeader } from '../encode/riff-layout.js';
import { STREAM_BLOCK_BYTES, STREAMS_TO_DISK } from '../encode/stream-sinks.js';
import { dataViewWriter, encodePcmFrame, writeFmtChunk } from '../encode/wav.js';
import { prepareAdmBwf, writeBextChunk, writeChnaChunk } from './adm.js';

/**
 * Encode an ADM BWF, streaming the bytes through `sink`.
 *
 * The caller owns sink lifecycle: call `sink.finish()` on success; on a thrown error,
 * `sink.abort()` (disk sinks) to tear down the partial file.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data in delivery order
 * @param {import('./adm.js').AdmWriteOptions} opts
 * @param {object} sink CollectSink | StreamSink
 * @returns {Promise<{totalBytes: number, container: string, frames: number, blocks: number}>}
 */
export async function writeAdmBwfStreamed(data, opts, sink) {
  const p = prepareAdmBwf(data, opts);

  const toDisk = sink[STREAMS_TO_DISK] === true;
  const plan = planRiffContainer({
    chunks: p.chunks,
    sampleCount: p.n,
    mode: p.container,
    maxBufferedBytes: toDisk ? Infinity : p.maxBufferedBytes,
  });
  const dataPad = p.dataLen % 2;
  const axmlPad = p.xmlBytes.length % 2;

  // ── Prefix: RIFF/ds64 + bext + fmt + chna + the data-chunk header ──
  // The data payload begins immediately after its 8-byte chunk header.
  const dataChunk = plan.chunks.find((c) => c.id === 'data');
  const prefixLen = dataChunk.offset + 8;
  const prefixAb = new ArrayBuffer(prefixLen);
  const prefixView = new DataView(prefixAb);
  const headerEnd = writeRiffHeader(prefixView, plan);
  const w = dataViewWriter(prefixView, headerEnd);

  writeBextChunk(w, {
    description: p.description,
    originator: p.originator,
    date: p.date,
    loudness: p.loudness,
  });
  writeFmtChunk(w, {
    channels: p.ch,
    sampleRate: p.sr,
    bitDepth: p.bitDepth,
    extensible: true,
    channelMask: 0,
  });
  writeChnaChunk(w, { channels: p.ch, order: p.order });
  w.ascii('data');
  w.u32(dataChunk.sizeField >>> 0);

  if (w.offset !== prefixLen) {
    throw new Error(
      `writeAdmBwfStreamed: prefix layout error (wrote ${w.offset} of ${prefixLen} bytes). ` +
        'Refusing to stream a file whose header and plan disagree.',
    );
  }
  await sink.write(new Uint8Array(prefixAb, 0, prefixLen));

  // ── PCM blocks ──
  const blockBytes = Math.max(1024, opts.blockBytes ?? STREAM_BLOCK_BYTES);
  const framesPerBlock = Math.max(1, Math.floor(blockBytes / p.blockAlign));
  const blockBuf = new ArrayBuffer(framesPerBlock * p.blockAlign);
  const blockView = new DataView(blockBuf);

  let blocks = 0;
  let frame = 0;
  while (frame < p.n) {
    const count = Math.min(framesPerBlock, p.n - frame);
    let po = 0;
    for (let i = 0; i < count; i++) {
      po += encodePcmFrame(blockView, po, data.channels, frame + i, p.ch, p.bitDepth);
    }
    await sink.write(new Uint8Array(blockBuf, 0, po));
    blocks++;
    frame += count;
    opts.onProgress?.(Math.min(1, frame / Math.max(1, p.n)), 'encoding');
  }

  if (dataPad) await sink.write(new Uint8Array(1));

  // ── axml trailer ──
  const trailerLen = 8 + p.xmlBytes.length + axmlPad;
  const trailerAb = new ArrayBuffer(trailerLen);
  const tView = new DataView(trailerAb);
  const t = dataViewWriter(tView, 0);
  t.ascii('axml');
  t.u32(p.xmlBytes.length);
  for (let i = 0; i < p.xmlBytes.length; i++) t.u8(p.xmlBytes[i]);
  if (axmlPad) t.u8(0);
  await sink.write(new Uint8Array(trailerAb, 0, trailerLen));

  if (sink.bytesWritten !== plan.totalBytes) {
    throw new Error(
      `writeAdmBwfStreamed: wrote ${sink.bytesWritten} bytes but the plan says ` +
        `${plan.totalBytes}. Refusing to finish a file whose header and payload disagree.`,
    );
  }

  return { totalBytes: plan.totalBytes, container: plan.container, frames: p.n, blocks };
}
