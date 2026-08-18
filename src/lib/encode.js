/**
 * Signal Rot — PCM/ADM encoders.
 * Operate on AudioBuffer-like objects ({ numberOfChannels, sampleRate, length, getChannelData }).
 * Pure (Blob/ArrayBuffer construction only) and unit-tested in tests/encode.test.js.
 */
import { Mp3Encoder } from '@breezystack/lamejs';
import { clamp } from './math.js';

/**
 * Triangular-probability-density (TPDF) dither for integer word-length reduction.
 * Adds (r1 − r2) LSB where r1, r2 ∈ [0,1). `rng` defaults to Math.random; pass a
 * seeded PRNG for deterministic exports.
 */
export function tpdfNoise(lsb, rng = Math.random) {
  return (rng() - rng()) * lsb;
}

function quantize16(s, rng, dither) {
  let v = s;
  if (dither) v += tpdfNoise(1 / 32768, rng);
  v = clamp(v, -1, 1);
  return Math.round(v < 0 ? v * 0x8000 : v * 0x7fff);
}

function quantize24(s, rng, dither) {
  let v = s;
  if (dither) v += tpdfNoise(1 / 8388608, rng);
  v = clamp(v, -1, 1);
  return Math.round(v < 0 ? v * 0x800000 : v * 0x7fffff);
}

/** Standard PCM WAV writer. bitDepth ∈ {16, 24} (int) or 32 (float, no dither). */
export function writeWAV(buf, bitDepth, opts = {}) {
  const ch = buf.numberOfChannels;
  const sr = buf.sampleRate;
  const n = buf.length;
  const isFloat = bitDepth === 32;
  const bps = bitDepth / 8;
  const dataLen = n * ch * bps;
  const blockAlign = ch * bps;
  const rng = opts.rng || Math.random;
  const dither = opts.dither === true && !isFloat;
  const ab = new ArrayBuffer(44 + dataLen);
  const v = new DataView(ab);
  const ws = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ws(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  ws(8, 'WAVE');
  ws(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, isFloat ? 3 : 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitDepth, true);
  ws(36, 'data');
  v.setUint32(40, dataLen, true);
  let off = 44;
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = data[c][i];
      if (isFloat) {
        v.setFloat32(off, s, true);
        off += 4;
      } else if (bitDepth === 16) {
        v.setInt16(off, quantize16(s, rng, dither), true);
        off += 2;
      } else {
        const iv = quantize24(s, rng, dither);
        v.setUint8(off, iv & 0xff);
        v.setUint8(off + 1, (iv >> 8) & 0xff);
        v.setUint8(off + 2, (iv >> 16) & 0xff);
        off += 3;
      }
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/** 80-bit IEEE-754 extended sample-rate encoding for AIFF COMM chunk. */
export function f80(sr) {
  const b = new Uint8Array(10);
  if (sr <= 0) return b;
  let e = 0;
  let m = sr;
  while (m < 0x80000000) {
    m *= 2;
    e++;
  }
  const exp = 16383 + 31 - e;
  b[0] = (exp >> 8) & 0xff;
  b[1] = exp & 0xff;
  const mant = Math.floor(m);
  for (let i = 0; i < 4; i++) b[2 + i] = (mant >>> (24 - i * 8)) & 0xff;
  return b;
}

/** AIFF writer (24-bit big-endian PCM). */
export function writeAIFF(buf, opts = {}) {
  const ch = buf.numberOfChannels;
  const sr = buf.sampleRate;
  const n = buf.length;
  const bps = 3;
  const dataLen = n * ch * bps;
  const ssnd = dataLen + 8;
  const total = 4 + (8 + 18) + (8 + ssnd);
  const rng = opts.rng || Math.random;
  const dither = opts.dither === true;
  const ab = new ArrayBuffer(8 + total);
  const v = new DataView(ab);
  let o = 0;
  const ws = (s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i));
  };
  const u32 = (x) => {
    v.setUint32(o, x, false);
    o += 4;
  };
  const u16 = (x) => {
    v.setUint16(o, x, false);
    o += 2;
  };
  ws('FORM');
  u32(total);
  ws('AIFF');
  ws('COMM');
  u32(18);
  u16(ch);
  u32(n);
  u16(24);
  const ext = f80(sr);
  for (let i = 0; i < 10; i++) v.setUint8(o++, ext[i]);
  ws('SSND');
  u32(ssnd);
  u32(0);
  u32(0);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const iv = quantize24(data[c][i], rng, dither);
      v.setUint8(o++, (iv >> 16) & 0xff);
      v.setUint8(o++, (iv >> 8) & 0xff);
      v.setUint8(o++, iv & 0xff);
    }
  }
  return new Blob([ab], { type: 'audio/aiff' });
}

/** MP3 encoder (320 kbps CBR) via the locally bundled @breezystack/lamejs. */
export function encodeMP3(buf, kbps = 320) {
  const ch = Math.min(2, buf.numberOfChannels);
  const sr = buf.sampleRate;
  const enc = new Mp3Encoder(ch, sr, kbps);
  const L = buf.getChannelData(0);
  const R = ch > 1 ? buf.getChannelData(1) : L;
  const li = new Int16Array(L.length);
  const ri = new Int16Array(L.length);
  for (let i = 0; i < L.length; i++) {
    li[i] = clamp(L[i], -1, 1) * 32767;
    ri[i] = clamp(R[i], -1, 1) * 32767;
  }
  const blk = 1152;
  const out = [];
  for (let i = 0; i < li.length; i += blk) {
    const lc = li.subarray(i, i + blk);
    const rc = ri.subarray(i, i + blk);
    const mp3 = ch > 1 ? enc.encodeBuffer(lc, rc) : enc.encodeBuffer(lc);
    if (mp3.length) out.push(mp3);
  }
  const end = enc.flush();
  if (end.length) out.push(end);
  return new Blob(out, { type: 'audio/mpeg' });
}

const PCM_SUBFORMAT_GUID = [0x01, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];
const FLOAT_SUBFORMAT_GUID = [0x03, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];

/** Multichannel WAVE_FORMAT_EXTENSIBLE writer (int 24-bit or float 32-bit). */
export function writeWAVMultiExt(buf, bitDepth, mask, opts = {}) {
  const ch = buf.numberOfChannels;
  const sr = buf.sampleRate;
  const n = buf.length;
  const isFloat = bitDepth === 32;
  const bps = bitDepth / 8;
  const blockAlign = ch * bps;
  const dataLen = n * blockAlign;
  const fmtLen = 40;
  const rng = opts.rng || Math.random;
  const dither = opts.dither === true && !isFloat;
  const ab = new ArrayBuffer(12 + (8 + fmtLen) + (8 + dataLen));
  const v = new DataView(ab);
  const ws = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ws(0, 'RIFF');
  v.setUint32(4, 4 + (8 + fmtLen) + (8 + dataLen), true);
  ws(8, 'WAVE');
  ws(12, 'fmt ');
  v.setUint32(16, fmtLen, true);
  v.setUint16(20, 0xfffe, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitDepth, true);
  v.setUint16(36, 22, true); // cbSize
  v.setUint16(38, bitDepth, true); // valid bits per sample
  v.setUint32(40, mask >>> 0, true);
  const guid = isFloat ? FLOAT_SUBFORMAT_GUID : PCM_SUBFORMAT_GUID;
  guid.forEach((b, i) => v.setUint8(44 + i, b));
  ws(60, 'data');
  v.setUint32(64, dataLen, true);
  let off = 68;
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = data[c][i];
      if (isFloat) {
        v.setFloat32(off, s, true);
        off += 4;
      } else {
        const iv = quantize24(s, rng, dither);
        v.setUint8(off, iv & 0xff);
        v.setUint8(off + 1, (iv >> 8) & 0xff);
        v.setUint8(off + 2, (iv >> 16) & 0xff);
        off += 3;
      }
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/**
 * ADM (ITU-R BS.2076) audioFormatExtended XML for a DirectSpeakers bed.
 * This is a well-formed interchange document (chna/axml), not a certified Dolby master.
 */
export function buildADMxml(layout, channels, sr, bitDepth) {
  const hx = (n) => n.toString(16).toUpperCase().padStart(4, '0');
  let chFmt = '';
  let strFmt = '';
  let trFmt = '';
  let trUID = '';
  let packRefs = '';
  let objUID = '';
  channels.forEach((c, i) => {
    const idx = i + 1;
    const AC = 'AC_0003' + hx(0x1000 + idx);
    const AT = 'AT_0003' + hx(0x1000 + idx) + '_01';
    const AS = 'AS_0003' + hx(0x1000 + idx);
    const ATU = 'ATU_' + idx.toString(16).toUpperCase().padStart(8, '0');
    const freq = c.lfe ? '\n      <frequency typeDefinition="lowPass">120</frequency>' : '';
    chFmt += `    <audioChannelFormat audioChannelFormatID="${AC}" audioChannelFormatName="${c.adm}" typeLabel="0001" typeDefinition="DirectSpeakers">\n      <audioBlockFormat audioBlockFormatID="AB_0003${hx(0x1000 + idx)}_00000001">\n        <speakerLabel>${c.adm}</speakerLabel>\n        <position coordinate="azimuth">${c.aAz.toFixed(1)}</position>\n        <position coordinate="elevation">${c.el.toFixed(1)}</position>\n        <position coordinate="distance">1.0</position>${freq}\n      </audioBlockFormat>\n    </audioChannelFormat>\n`;
    strFmt += `    <audioStreamFormat audioStreamFormatID="${AS}" audioStreamFormatName="PCM_${c.adm}" formatLabel="0001" formatDefinition="PCM">\n      <audioChannelFormatIDRef>${AC}</audioChannelFormatIDRef>\n      <audioTrackFormatIDRef>${AT}</audioTrackFormatIDRef>\n    </audioStreamFormat>\n`;
    trFmt += `    <audioTrackFormat audioTrackFormatID="${AT}" audioTrackFormatName="PCM_${c.adm}" formatLabel="0001" formatDefinition="PCM">\n      <audioStreamFormatIDRef>${AS}</audioStreamFormatIDRef>\n    </audioTrackFormat>\n`;
    trUID += `    <audioTrackUID UID="${ATU}" sampleRate="${sr}" bitDepth="${bitDepth}">\n      <audioTrackFormatIDRef>${AT}</audioTrackFormatIDRef>\n      <audioPackFormatIDRef>AP_00031001</audioPackFormatIDRef>\n    </audioTrackUID>\n`;
    packRefs += `      <audioChannelFormatIDRef>${AC}</audioChannelFormatIDRef>\n`;
    objUID += `      <audioTrackUIDRef>${ATU}</audioTrackUIDRef>\n`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ebuCoreMain xmlns="urn:ebu:metadata-schema:ebuCore_2016">\n <coreMetadata><format><audioFormatExtended version="ITU-R_BS.2076-2">\n    <audioProgramme audioProgrammeID="APR_1001" audioProgrammeName="Immersive Master"><audioContentIDRef>ACO_1001</audioContentIDRef></audioProgramme>\n    <audioContent audioContentID="ACO_1001" audioContentName="Bed ${layout}"><audioObjectIDRef>AO_1001</audioObjectIDRef></audioContent>\n    <audioObject audioObjectID="AO_1001" audioObjectName="Bed ${layout}">\n      <audioPackFormatIDRef>AP_00031001</audioPackFormatIDRef>\n${objUID}    </audioObject>\n    <audioPackFormat audioPackFormatID="AP_00031001" audioPackFormatName="${layout}" typeLabel="0001" typeDefinition="DirectSpeakers">\n${packRefs}    </audioPackFormat>\n${chFmt}${strFmt}${trFmt}${trUID} </audioFormatExtended></format></coreMetadata>\n</ebuCoreMain>`;
}

/**
 * ADM BWF writer: bext + fmt (extensible) + data + chna + axml chunks.
 * `channels` is the ordered channel list for `layout` (from layouts.js).
 */
export function writeADMBWF(buf, layout, channels, bitDepth = 24, opts = {}) {
  const ch = buf.numberOfChannels;
  const sr = buf.sampleRate;
  const n = buf.length;
  const bps = bitDepth / 8;
  const blockAlign = ch * bps;
  const dataLen = n * blockAlign;
  const rng = opts.rng || Math.random;
  const dither = opts.dither === true;
  const xml = buildADMxml(layout, channels, sr, bitDepth);
  const xmlBytes = new TextEncoder().encode(xml);
  const axmlLen = xmlBytes.length + (xmlBytes.length % 2);
  const numUIDs = channels.length;
  const chnaLen = 4 + 40 * numUIDs;
  const bextLen = 602;
  const fmtLen = 40;
  const total = 4 + (8 + bextLen) + (8 + fmtLen) + (8 + dataLen) + (8 + chnaLen) + (8 + axmlLen);
  const ab = new ArrayBuffer(8 + total);
  const v = new DataView(ab);
  let o = 0;
  const ws = (s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i));
  };
  const u32 = (x) => {
    v.setUint32(o, x, true);
    o += 4;
  };
  const u16 = (x) => {
    v.setUint16(o, x, true);
    o += 2;
  };
  const writeStr = (s, len) => {
    for (let i = 0; i < len; i++) v.setUint8(o++, i < s.length ? s.charCodeAt(i) : 0);
  };
  ws('RIFF');
  u32(total);
  ws('WAVE');
  ws('bext');
  u32(bextLen);
  {
    const bstart = o;
    writeStr('SIGNAL ROT // MASTER — ADM BWF ' + layout, 256);
    o = bstart + 346;
    v.setUint16(o, 1, true); // bext version
    o = bstart + bextLen;
  }
  ws('fmt ');
  u32(fmtLen);
  u16(0xfffe);
  u16(ch);
  u32(sr);
  u32(sr * blockAlign);
  u16(blockAlign);
  u16(bitDepth);
  u16(22);
  u16(bitDepth);
  u32(0); // channel mask 0 — ADM self-describes routing via chna
  PCM_SUBFORMAT_GUID.forEach((b) => v.setUint8(o++, b));
  ws('data');
  u32(dataLen);
  {
    const data = [];
    for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        const iv = quantize24(data[c][i], rng, dither);
        v.setUint8(o++, iv & 0xff);
        v.setUint8(o++, (iv >> 8) & 0xff);
        v.setUint8(o++, (iv >> 16) & 0xff);
      }
    }
  }
  ws('chna');
  u32(chnaLen);
  u16(numUIDs);
  u16(numUIDs);
  channels.forEach((c, i) => {
    const idx = i + 1;
    const hx = (nn) => nn.toString(16).toUpperCase().padStart(4, '0');
    u16(idx);
    writeStr('ATU_' + idx.toString(16).toUpperCase().padStart(8, '0'), 12);
    writeStr('AT_0003' + hx(0x1000 + idx) + '_01', 14);
    writeStr('AP_00031001', 11);
    v.setUint8(o++, 0);
  });
  ws('axml');
  u32(axmlLen);
  for (let i = 0; i < xmlBytes.length; i++) v.setUint8(o++, xmlBytes[i]);
  if (axmlLen > xmlBytes.length) v.setUint8(o++, 0);
  return new Blob([ab], { type: 'audio/wav' });
}
