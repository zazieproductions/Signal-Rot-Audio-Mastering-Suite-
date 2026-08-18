/** Shared test helpers — generated signals only (no copyrighted audio). */

export function makeBuffer(data, sampleRate = 48000) {
  return {
    numberOfChannels: data.length,
    sampleRate,
    length: data[0].length,
    getChannelData: (c) => data[c],
  };
}

export function sine(freq, sr, seconds, amp = 1, phase = 0) {
  const n = Math.round(sr * seconds);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr + phase);
  return d;
}

export function zeros(seconds, sr = 48000) {
  return new Float32Array(Math.round(sr * seconds));
}

export function noise(seconds, sr = 48000, amp = 0.1) {
  const n = Math.round(sr * seconds);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * amp;
  return d;
}

export function maxAbs(d) {
  let m = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (a > m) m = a;
  }
  return m;
}

export async function blobToArrayBuffer(blob) {
  return await blob.arrayBuffer();
}

/** Parse a RIFF/WAVE file into { chunks: [{id, size, dataOff, data:DataView}] }. */
export function parseRIFF(ab) {
  const v = new DataView(ab);
  const txt = (o, n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(o + i));
    return s;
  };
  const chunks = [];
  if (txt(0, 4) !== 'RIFF') return { form: null, chunks };
  const form = txt(8, 4);
  let off = 12;
  while (off + 8 <= ab.byteLength) {
    const id = txt(off, 4);
    const size = v.getUint32(off + 4, true);
    chunks.push({ id, size, dataOff: off + 8, view: v });
    if (id === 'data' && size % 2 === 1) off += 8 + size + 1;
    else off += 8 + size;
  }
  return { form, chunks };
}

export function chunkText(chunk) {
  let s = '';
  for (let i = 0; i < chunk.size; i++) s += String.fromCharCode(chunk.view.getUint8(chunk.dataOff + i));
  return s;
}

/** Read 16-bit PCM samples (interleaved) from a 'data' chunk. */
export function readSamples16(chunk, channels) {
  const frames = Math.floor(chunk.size / (channels * 2));
  const out = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      out[c][i] = chunk.view.getInt16(chunk.dataOff + (i * channels + c) * 2, true) / 32768;
    }
  }
  return out;
}
