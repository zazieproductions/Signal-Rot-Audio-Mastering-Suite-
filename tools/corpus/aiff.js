/**
 * Minimal AIFF (16-bit PCM) writer for the input corpus.
 *
 * AIFF is big-endian throughout; the COMM chunk stores the sample rate as an
 * IEEE 754 80-bit extended float. Enough for a browser to decode it — not a
 * general-purpose encoder.
 */

/** Encode a positive number as an 80-bit extended float (big-endian, 10 bytes). */
export function extended80(value) {
  const out = new Uint8Array(10);
  if (!(value > 0)) return out;
  const f64 = new DataView(new ArrayBuffer(8));
  f64.setFloat64(0, value, false);
  const hi32 = f64.getUint32(0);
  const lo32 = f64.getUint32(4);
  const sign = hi32 >>> 31;
  const e64 = (hi32 >>> 20) & 0x7ff; // biased by 1023
  // float64 significand: 1.m with a 52-bit m; 80-bit extended keeps 64 mantissa
  // bits after an implicit leading 1, so m64 = m52 << 12.
  // m52 = top 20 bits (from hi32) + lo32. Shifted left 12, split back into halves:
  const mHi = ((hi32 & 0xfffff) << 12) | (lo32 >>> 20); // top 32 of m64
  const mLo = lo32 << 12; // low 32 of m64
  const e80 = e64 - 1023 + 16383;
  out[0] = (sign << 7) | ((e80 >> 8) & 0x7f);
  out[1] = e80 & 0xff;
  new DataView(out.buffer).setUint32(2, mHi >>> 0, false);
  new DataView(out.buffer).setUint32(6, mLo >>> 0, false);
  return out;
}

/**
 * @param {{sampleRate:number, channels:Float32Array[]}} spec
 */
export function buildAiff(spec) {
  const ch = spec.channels.length;
  const frames = spec.channels[0].length;
  const bytesPerSample = 2;
  const dataBytes = frames * ch * bytesPerSample;

  const commSize = 18;
  const ssndHeader = 8;
  const formSize = 6 + (8 + commSize) + (8 + ssndHeader + dataBytes);
  const out = new Uint8Array(8 + formSize);
  const view = new DataView(out.buffer);
  const ascii = (o, s) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };

  ascii(0, 'FORM');
  view.setUint32(4, formSize, false);
  ascii(8, 'AIFF');

  let p = 12;
  ascii(p, 'COMM');
  view.setUint32(p + 4, commSize, false);
  view.setUint32(p + 8, ch, false);
  view.setUint32(p + 12, frames, false);
  out.set(extended80(spec.sampleRate), p + 16);
  view.setUint16(p + 26, 16, false);

  p += 8 + commSize + (commSize & 1);
  ascii(p, 'SSND');
  view.setUint32(p + 4, ssndHeader + dataBytes, false);
  view.setUint32(p + 8, ssndHeader, false); // offset to samples
  view.setUint32(p + 12, ch * bytesPerSample, false);
  let d = p + 8 + ssndHeader;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      let n = Math.round(spec.channels[c][i] * 32767);
      n = Math.max(-32768, Math.min(32767, n));
      view.setInt16(d, n, false);
      d += 2;
    }
  }
  return out;
}
