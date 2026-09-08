/**
 * Deterministic WAV writer for the real-world input corpus.
 *
 * Pure Node (ESM, no dependencies) so the same bytes can be:
 *   · written to disk for manual inspection,
 *   · piped into the browser test suite via `page.setInputFiles`,
 *   · re-parsed in unit tests (see `readWav`) to verify the generator itself.
 *
 * The writer produces every shape the corpus needs — 16/24/32f bit depths,
 * arbitrary channel counts (including WAVE_FORMAT_EXTENSIBLE), RIFF INFO
 * metadata with Unicode, odd chunk orderings — and `corrupt.js`-style helpers
 * below mangle the result in controlled ways (truncated data, broken header).
 *
 * Nothing here is a production encoder; it only has to be *correct enough* that
 * browsers decode it, and *wrong enough* that their decoders complain.
 */

/** Channel masks for WAVE_FORMAT_EXTENSIBLE. */
export const CHANNEL_MASKS = Object.freeze({
  mono: 0x4,
  stereo: 0x3,
  5.1: 0x3f,
  7.1: 0x63f,
});

function fourcc(view, offset, str) {
  for (let i = 0; i < 4; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function evenSize(n) {
  return n + (n & 1);
}

function bytesOf(str) {
  return new TextEncoder().encode(str);
}

/**
 * @typedef {object} WavSpec
 * @property {number} sampleRate
 * @property {Float32Array[]} channels  equal-length, one array per channel
 * @property {16|24|32} [bitDepth] 32 = IEEE 754 float
 * @property {object} [info]  RIFF INFO sub-chunks (INAM, IART, …) → {tag: value}
 * @property {string[]} [chunkOrder]  chunk ids in write order; default
 *   `['fmt ', 'LIST', 'data']` (LIST only when info is present)
 * @property {number} [channelMask]  when set, the fmt chunk is WAVE_FORMAT_EXTENSIBLE
 * @property {number} [declaredDataFrames]  lie about how many frames the data chunk holds
 */
export function buildWav(spec) {
  const channels = spec.channels;
  const ch = channels.length;
  const frames = channels[0].length;
  const bitDepth = spec.bitDepth ?? 16;
  const bytesPerSample = bitDepth === 32 ? 4 : bitDepth === 24 ? 3 : 2;

  /* fmt — payload only; the assembler adds the 8-byte chunk header */
  const extensible = spec.channelMask !== undefined;
  const fmtSize = extensible ? 40 : 16;
  const fmt = new Uint8Array(fmtSize);
  const fv = new DataView(fmt.buffer);
  fv.setUint16(0, extensible ? 0xfffe : 1, true);
  fv.setUint16(2, ch, true);
  fv.setUint32(4, spec.sampleRate, true);
  fv.setUint32(8, spec.sampleRate * ch * bytesPerSample, true);
  fv.setUint16(12, ch * bytesPerSample, true);
  fv.setUint16(14, bitDepth, true);
  if (extensible) {
    fv.setUint16(16, 22, true); // cbSize
    fv.setUint16(18, bitDepth, true);
    fv.setUint32(20, spec.channelMask, true);
    // KSD sub-format GUID for PCM (first 8 bytes) + the fixed tail.
    fourcc(fv, 24, 'f468');
    fv.setUint16(28, 0xd37d, true);
    fv.setUint8(30, 0xa5);
    fv.setUint8(31, 0xa0);
    fv.setUint8(32, 0x62);
    fv.setUint8(33, 0x3a);
    fv.setUint8(34, 0x42);
    fv.setUint8(35, 0x0);
  }

  /* data — write min(actual, declared) frames so `declaredDataFrames` can lie */
  const declaredFrames = spec.declaredDataFrames ?? frames;
  const writtenFrames = Math.min(frames, declaredFrames);
  const data = new Uint8Array(declaredFrames * ch * bytesPerSample);
  const dv = new DataView(data.buffer);
  let o = 0;
  for (let i = 0; i < writtenFrames; i++) {
    for (let c = 0; c < ch; c++) {
      const value = channels[c][i];
      if (bitDepth === 32) {
        dv.setFloat32(o, value, true);
      } else {
        const scale = bitDepth === 24 ? 8388608 : 32768;
        let n = Math.round(value * scale);
        // 24/16-bit WAV convention: full scale is +0x7FFF… and −full-scale wraps,
        // so clamp to [−scale, scale−1] exactly as every encoder does.
        n = Math.max(-scale, Math.min(scale - 1, n));
        let u = n < 0 ? n + (1 << (bitDepth + 1)) : n;
        for (let k = 0; k < bytesPerSample; k++) {
          dv.setUint8(o + k, u & 0xff);
          u >>= 8;
        }
      }
      o += bytesPerSample;
    }
  }

  /* optional INFO (LIST) chunk payload with Unicode text sub-chunks */
  let list = null;
  if (spec.info && Object.keys(spec.info).length) {
    const subs = Object.entries(spec.info).map(([tag, value]) => ({ tag, bytes: bytesOf(value) }));
    const payload = subs.reduce((s, sub) => s + 8 + evenSize(sub.bytes.length), 0);
    list = new Uint8Array(payload);
    const lv = new DataView(list.buffer);
    let p = 0;
    for (const sub of subs) {
      fourcc(lv, p, sub.tag);
      lv.setUint32(p + 4, evenSize(sub.bytes.length), true);
      list.set(sub.bytes, p + 8);
      p += 8 + evenSize(sub.bytes.length);
    }
  }

  const parts = [
    { id: 'fmt ', payload: fmt },
    ...(list ? [{ id: 'LIST', payload: list }] : []),
    { id: 'data', payload: data },
  ];
  const order = spec.chunkOrder
    ? spec.chunkOrder.filter((id) => parts.some((pt) => pt.id === id))
    : parts.map((pt) => pt.id);
  if (!order.includes('fmt ') || !order.includes('data')) {
    throw new Error(`buildWav: chunkOrder must keep "fmt " and "data": ${spec.chunkOrder}`);
  }
  const ordered = order.map((id) => parts.find((pt) => pt.id === id));

  const total = 12 + ordered.reduce((s, pt) => s + 8 + pt.payload.length, 0);
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  fourcc(ov, 0, 'RIFF');
  ov.setUint32(4, total - 8, true);
  fourcc(ov, 8, 'WAVE');
  let p = 12;
  for (const pt of ordered) {
    fourcc(ov, p, pt.id);
    ov.setUint32(p + 4, pt.payload.length, true);
    out.set(pt.payload, p + 8);
    p += 8 + pt.payload.length;
  }
  return out;
}

/* ── corruption helpers (pure byte surgery) ─────────────────────────────── */

/** Copy of `bytes` with the final `n` bytes removed. */
export function truncateTail(bytes, n) {
  return bytes.slice(0, Math.max(0, bytes.length - n));
}

/** Replace the leading RIFF/WAVE markers with non-audio garbage. */
export function corruptHeader(bytes) {
  const out = bytes.slice();
  [0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77].forEach((v, i) => {
    out[i] = v;
  });
  return out;
}

/** Make the `data` chunk claim `extraBytes` more than the file actually contains. */
export function declareOversizedData(bytes, extraBytes) {
  const out = bytes.slice();
  const view = new DataView(out.buffer);
  for (let p = 12; p + 8 <= out.length; p += 8 + view.getUint32(p + 4, true)) {
    if (out[p] === 0x64 && out[p + 1] === 0x61 && out[p + 2] === 0x74 && out[p + 3] === 0x61) {
      view.setUint32(p + 4, view.getUint32(p + 4, true) + extraBytes, true);
      return out;
    }
  }
  return out;
}

/** Overwrite a 4-byte little-endian float at absolute byte offset `offset`. */
export function patchFloat32LE(bytes, offset, floatValue) {
  const out = bytes.slice();
  new DataView(out.buffer).setFloat32(offset, floatValue, true);
  return out;
}

/* ── reader (validation of the generator, and corpus expectations) ───────── */

/**
 * Parse the WAV produced by `buildWav`. Strict enough to catch writer bugs
 * (wrong sizes, truncated tails), lenient about chunk order.
 *
 * @returns {{sampleRate:number, channels:number, bitDepth:number, frames:number,
 *            channelData:Float32Array[], chunks:string[], info:Record<string,string>}}
 */
export function readWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0x52494646 /* RIFF */) throw new Error('not a RIFF file');
  if (view.getUint32(8, false) !== 0x57415645 /* WAVE */) throw new Error('not a WAVE file');
  const riffDeclared = view.getUint32(4, true);
  if (riffDeclared + 8 !== bytes.length) {
    throw new Error(`RIFF size mismatch: declares ${riffDeclared}, file is ${bytes.length - 8}`);
  }

  let fmt = null;
  let dataStart = -1;
  let dataDeclared = 0;
  const chunks = [];
  const info = {};

  for (let p = 12; p + 8 <= bytes.length; ) {
    const id = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    const size = view.getUint32(p + 4, true);
    if (p + 8 + size > bytes.length) throw new Error(`chunk ${id} runs past end of file`);
    chunks.push(id);
    if (id === 'fmt ') {
      const format = view.getUint16(p + 8, true);
      if (format !== 1 && format !== 0xfffe) throw new Error(`unsupported format tag ${format}`);
      fmt = {
        format,
        channels: view.getUint16(p + 10, true),
        sampleRate: view.getUint32(p + 12, true),
        bitDepth: view.getUint16(p + 22, true),
      };
      if (format === 0xfffe) fmt.channelMask = view.getUint32(p + 28, true);
    } else if (id === 'data') {
      dataStart = p + 8;
      dataDeclared = size;
    } else if (id === 'LIST') {
      for (let q = p + 8; q + 8 <= p + 8 + size; ) {
        const tag = String.fromCharCode(bytes[q], bytes[q + 1], bytes[q + 2], bytes[q + 3]);
        const tsize = view.getUint32(q + 4, true);
        info[tag] = new TextDecoder().decode(
          bytes.subarray(q + 8, q + 8 + tsize).filter((b) => b !== 0),
        );
        q += 8 + tsize + (tsize & 1);
      }
    }
    p += 8 + size + (size & 1);
  }

  if (!fmt) throw new Error('no fmt chunk');
  if (dataStart < 0) throw new Error('no data chunk');
  const available = bytes.length - dataStart;
  const usable = Math.min(available, dataDeclared);
  const bytesPerSample = fmt.bitDepth === 32 ? 4 : fmt.bitDepth === 24 ? 3 : 2;
  const total = Math.floor(usable / bytesPerSample);
  const frames = Math.floor(total / fmt.channels);
  const channelData = [];
  for (let c = 0; c < fmt.channels; c++) channelData.push(new Float32Array(frames));
  let o = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      if (fmt.bitDepth === 32) {
        channelData[c][i] = view.getFloat32(dataStart + o, true);
      } else if (fmt.bitDepth === 24) {
        let n = 0;
        for (let k = 0; k < 3; k++) n |= bytes[dataStart + o + k] << (8 * k);
        channelData[c][i] = (n & 0x800000 ? n - 0x1000000 : n) / 8388608;
      } else {
        channelData[c][i] = view.getInt16(dataStart + o, true) / 32768;
      }
      o += bytesPerSample;
    }
  }
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitDepth: fmt.bitDepth,
    frames,
    channelData,
    chunks,
    info,
    channelMask: fmt.channelMask,
    truncated: available < dataDeclared,
  };
}
