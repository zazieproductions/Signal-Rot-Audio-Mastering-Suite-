/**
 * Minimal RIFF / IFF chunk readers used to *verify* the encoders rather than trust them.
 *
 * These are deliberately independent implementations: if the writer and the reader shared
 * code, a test could only prove they were consistent, not correct.
 */

/** Read a Blob into a DataView (Node's Blob supports arrayBuffer()). */
export async function toView(blob) {
  return new DataView(await blob.arrayBuffer());
}

export function ascii(view, offset, length) {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/**
 * Walk a RIFF file and return every chunk with its offset and size.
 * @param {DataView} view
 * @param {boolean} littleEndian
 */
export function parseChunks(view, littleEndian = true) {
  const container = ascii(view, 0, 4);
  const declaredSize = view.getUint32(4, littleEndian);
  const form = ascii(view, 8, 4);
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = ascii(view, offset, 4);
    const size = view.getUint32(offset + 4, littleEndian);
    chunks.push({ id, size, dataOffset: offset + 8 });
    // Chunks are word-aligned: an odd size is followed by one pad byte.
    offset += 8 + size + (size % 2);
  }
  return { container, declaredSize, form, chunks, totalBytes: view.byteLength };
}

/** Parse a WAVE `fmt ` chunk. */
export function parseFmt(view, chunk) {
  const o = chunk.dataOffset;
  const fmt = {
    audioFormat: view.getUint16(o, true),
    channels: view.getUint16(o + 2, true),
    sampleRate: view.getUint32(o + 4, true),
    byteRate: view.getUint32(o + 8, true),
    blockAlign: view.getUint16(o + 12, true),
    bitsPerSample: view.getUint16(o + 14, true),
  };
  if (chunk.size >= 40) {
    fmt.cbSize = view.getUint16(o + 16, true);
    fmt.validBits = view.getUint16(o + 18, true);
    fmt.channelMask = view.getUint32(o + 20, true);
    fmt.subFormat = view.getUint16(o + 24, true);
  }
  return fmt;
}

/** Read interleaved PCM samples back out as normalised floats. */
export function readSamples(view, dataChunk, fmt) {
  const bytesPerSample = fmt.bitsPerSample / 8;
  const frames = dataChunk.size / (bytesPerSample * fmt.channels);
  const out = [];
  for (let c = 0; c < fmt.channels; c++) out.push(new Float32Array(frames));
  let o = dataChunk.dataOffset;
  const isFloat = fmt.audioFormat === 3 || fmt.subFormat === 3;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      if (isFloat) {
        out[c][i] = view.getFloat32(o, true);
        o += 4;
      } else if (fmt.bitsPerSample === 16) {
        out[c][i] = view.getInt16(o, true) / 32768;
        o += 2;
      } else {
        const b0 = view.getUint8(o);
        const b1 = view.getUint8(o + 1);
        const b2 = view.getUint8(o + 2);
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v -= 0x1000000;
        out[c][i] = v / 8388608;
        o += 3;
      }
    }
  }
  return out;
}

/** Parse an AIFF `COMM` chunk (big-endian). */
export function parseComm(view, chunk) {
  const o = chunk.dataOffset;
  const extended = [];
  for (let i = 0; i < 10; i++) extended.push(view.getUint8(o + 8 + i));
  return {
    channels: view.getUint16(o, false),
    frames: view.getUint32(o + 2, false),
    bitsPerSample: view.getUint16(o + 6, false),
    sampleRateBytes: extended,
  };
}

/** Parse a `chna` chunk into its UID entries. */
export function parseChna(view, chunk) {
  const o = chunk.dataOffset;
  const numTracks = view.getUint16(o, true);
  const numUIDs = view.getUint16(o + 2, true);
  const entries = [];
  for (let i = 0; i < numUIDs; i++) {
    const base = o + 4 + i * 40;
    entries.push({
      trackIndex: view.getUint16(base, true),
      uid: ascii(view, base + 2, 12).replace(/\0+$/, ''),
      trackFormatIdRef: ascii(view, base + 14, 14).replace(/\0+$/, ''),
      packFormatIdRef: ascii(view, base + 28, 11).replace(/\0+$/, ''),
    });
  }
  return { numTracks, numUIDs, entries };
}

/** Extract the axml payload as a UTF-8 string. */
export function readAxml(view, chunk) {
  const bytes = new Uint8Array(view.buffer, chunk.dataOffset, chunk.size);
  return new TextDecoder().decode(bytes);
}
