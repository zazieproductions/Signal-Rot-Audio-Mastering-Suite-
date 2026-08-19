/**
 * ADM (Audio Definition Model) BWF writer — ITU-R BS.2076 metadata in an EBU Tech 3285
 * Broadcast Wave file.
 *
 * ── What this produces ───────────────────────────────────────────────────────────────
 * A RIFF/WAVE file containing:
 *   `bext`  Broadcast Audio Extension (EBU Tech 3285 v2, 602 bytes), including the
 *           loudness metadata fields, which are populated from the actual analysis.
 *   `fmt `  WAVE_FORMAT_EXTENSIBLE
 *   `chna`  Channel allocation (BS.2088 / Tech 3285 Supplement 5) — binds each physical
 *           track to an `audioTrackUID`
 *   `data`  PCM
 *   `axml`  the ADM XML document itself (EBU Core / BS.2076)
 *
 * `chna` is written **before** `data` so a streaming parser can learn the routing without
 * seeking past the audio. `axml` is written after, which is conventional because it is
 * variable-length. Both chunks are padded to even lengths per the RIFF specification, and
 * the pad byte is excluded from the chunk size.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────────────
 * **This is a channel-bed ADM file. It is not a Dolby Atmos master.**
 *
 *  · Every channel is declared `typeDefinition="DirectSpeakers"` — a fixed loudspeaker
 *    bed. There are no audio *objects*, no positional automation, no object metadata.
 *    Object-based authoring requires a renderer this project does not contain.
 *  · A Dolby Atmos deliverable (`.atmos` / IMF IAB / a DAMF set) is produced by licensed
 *    Dolby tooling from a session with object metadata. An ADM BWF *can* be an ingest
 *    format for those tools; it is not itself a certified master.
 *  · Height channels in these exports carry **synthesised** ambience derived from the
 *    stereo side signal. Stereo contains no height information. This is a creative
 *    up-mix, and the ADM says nothing about that because ADM has no way to say it.
 *  · The XML is well-formed and structurally checked by `tests/format/adm.test.js`
 *    (ID cross-references, UID uniqueness, chunk sizes, padding, channel counts). It has
 *    **not** been validated against an official BS.2076 schema or ingested into a
 *    commercial renderer as part of this project's CI.
 */

import { LIMITS } from '../../app/constants.js';
import { clamp } from '../dsp/math.js';
import { floatToInt, writeAscii } from '../encode/wav.js';
import { LAYOUTS, SPEAKERS, wavChannelOrder } from './layouts.js';

/** Escape a string for use in XML text or attribute content. */
export function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const hex4 = (n) => (n >>> 0).toString(16).toUpperCase().padStart(4, '0');
const hex8 = (n) => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

/**
 * BS.2076 identifier set for one channel.
 *
 * Custom (non-common-definition) IDs must use the value range 0x1000 and above; the lower
 * range is reserved for the ITU common definitions. Index 1 therefore becomes 0x1001.
 *
 * @param {number} index 1-based channel index
 */
export function admIdsFor(index) {
  const n = 0x1000 + index;
  return {
    channelFormat: `AC_0003${hex4(n)}`,
    blockFormat: `AB_0003${hex4(n)}_00000001`,
    streamFormat: `AS_0003${hex4(n)}`,
    trackFormat: `AT_0003${hex4(n)}_01`,
    trackUid: `ATU_${hex8(index)}`,
  };
}

export const ADM_PACK_FORMAT_ID = 'AP_00031001';
export const ADM_PROGRAMME_ID = 'APR_1001';
export const ADM_CONTENT_ID = 'ACO_1001';
export const ADM_OBJECT_ID = 'AO_1001';

/**
 * Format seconds as the ADM `hh:mm:ss.nnnnnnnnn` timecode string.
 */
export function admDuration(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const nanos = Math.round((s - Math.floor(s)) * 1e9);
  return (
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:` +
    `${String(sec).padStart(2, '0')}.${String(nanos).padStart(9, '0')}`
  );
}

/**
 * Build the ADM XML document for a layout.
 *
 * @param {object} opts
 * @param {string} opts.layoutId
 * @param {number} opts.sampleRate
 * @param {number} opts.bitDepth
 * @param {number} opts.durationSeconds
 * @param {number} [opts.lfeCrossoverHz]
 * @param {string} [opts.programmeName]
 * @param {string[]} [opts.order] delivery order override
 * @returns {string}
 */
export function buildAdmXml(opts) {
  const layout = LAYOUTS[opts.layoutId];
  if (!layout) throw new Error(`buildAdmXml: unknown layout "${opts.layoutId}"`);
  const order = opts.order ?? wavChannelOrder(opts.layoutId).order;
  const duration = admDuration(opts.durationSeconds);
  const programmeName = xmlEscape(opts.programmeName ?? `Signal Rot ${layout.name}`);
  const lfeHz = opts.lfeCrossoverHz ?? 120;

  const channelFormats = [];
  const streamFormats = [];
  const trackFormats = [];
  const trackUids = [];
  const packRefs = [];
  const objectTrackRefs = [];

  order.forEach((key, i) => {
    const sp = SPEAKERS[key];
    const id = admIdsFor(i + 1);
    const freq = sp.lfe ? `\n        <frequency typeDefinition="lowPass">${lfeHz}</frequency>` : '';

    channelFormats.push(
      `    <audioChannelFormat audioChannelFormatID="${id.channelFormat}" ` +
        `audioChannelFormatName="${xmlEscape(sp.admSpeakerLabel)}" ` +
        `typeLabel="0003" typeDefinition="DirectSpeakers">
      <audioBlockFormat audioBlockFormatID="${id.blockFormat}" rtime="00:00:00.000000000" duration="${duration}">
        <speakerLabel>${xmlEscape(sp.admSpeakerLabel)}</speakerLabel>
        <position coordinate="azimuth">${sp.azimuthAdm.toFixed(1)}</position>
        <position coordinate="elevation">${sp.elevation.toFixed(1)}</position>
        <position coordinate="distance">1.0</position>${freq}
      </audioBlockFormat>
    </audioChannelFormat>`,
    );

    streamFormats.push(
      `    <audioStreamFormat audioStreamFormatID="${id.streamFormat}" ` +
        `audioStreamFormatName="PCM_${xmlEscape(sp.id)}" formatLabel="0001" formatDefinition="PCM">
      <audioChannelFormatIDRef>${id.channelFormat}</audioChannelFormatIDRef>
      <audioTrackFormatIDRef>${id.trackFormat}</audioTrackFormatIDRef>
    </audioStreamFormat>`,
    );

    trackFormats.push(
      `    <audioTrackFormat audioTrackFormatID="${id.trackFormat}" ` +
        `audioTrackFormatName="PCM_${xmlEscape(sp.id)}" formatLabel="0001" formatDefinition="PCM">
      <audioStreamFormatIDRef>${id.streamFormat}</audioStreamFormatIDRef>
    </audioTrackFormat>`,
    );

    trackUids.push(
      `    <audioTrackUID UID="${id.trackUid}" sampleRate="${opts.sampleRate}" bitDepth="${opts.bitDepth}">
      <audioTrackFormatIDRef>${id.trackFormat}</audioTrackFormatIDRef>
      <audioPackFormatIDRef>${ADM_PACK_FORMAT_ID}</audioPackFormatIDRef>
    </audioTrackUID>`,
    );

    packRefs.push(`      <audioChannelFormatIDRef>${id.channelFormat}</audioChannelFormatIDRef>`);
    objectTrackRefs.push(`      <audioTrackUIDRef>${id.trackUid}</audioTrackUIDRef>`);
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<ebuCoreMain xmlns="urn:ebu:metadata-schema:ebuCore_2016" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <coreMetadata>
    <format>
      <audioFormatExtended version="ITU-R_BS.2076-2">
    <audioProgramme audioProgrammeID="${ADM_PROGRAMME_ID}" audioProgrammeName="${programmeName}" start="00:00:00.000000000" end="${duration}">
      <audioContentIDRef>${ADM_CONTENT_ID}</audioContentIDRef>
    </audioProgramme>
    <audioContent audioContentID="${ADM_CONTENT_ID}" audioContentName="${xmlEscape(layout.name)} bed">
      <audioObjectIDRef>${ADM_OBJECT_ID}</audioObjectIDRef>
    </audioContent>
    <audioObject audioObjectID="${ADM_OBJECT_ID}" audioObjectName="${xmlEscape(layout.name)} bed" start="00:00:00.000000000" duration="${duration}">
      <audioPackFormatIDRef>${ADM_PACK_FORMAT_ID}</audioPackFormatIDRef>
${objectTrackRefs.join('\n')}
    </audioObject>
    <audioPackFormat audioPackFormatID="${ADM_PACK_FORMAT_ID}" audioPackFormatName="${xmlEscape(layout.name)}" typeLabel="0003" typeDefinition="DirectSpeakers">
${packRefs.join('\n')}
    </audioPackFormat>
${channelFormats.join('\n')}
${streamFormats.join('\n')}
${trackFormats.join('\n')}
${trackUids.join('\n')}
      </audioFormatExtended>
    </format>
  </coreMetadata>
</ebuCoreMain>
`;
}

/** Length of the EBU Tech 3285 v2 `bext` chunk. */
export const BEXT_SIZE = 602;
/** Byte offset of the `Version` field inside `bext`. */
export const BEXT_VERSION_OFFSET = 346;
/** Byte offset of `LoudnessValue` inside `bext`. */
export const BEXT_LOUDNESS_OFFSET = 412;

/**
 * `bext` loudness fields are signed 16-bit integers in units of 0.01 dB/LU.
 * A value that would overflow is clamped rather than wrapped.
 */
function loudnessField(value) {
  if (!Number.isFinite(value)) return 0x7fff; // "not measured" sentinel used in practice
  return clamp(Math.round(value * 100), -32768, 32767);
}

/**
 * @typedef {object} AdmWriteOptions
 * @property {string} layoutId
 * @property {16|24|32} [bitDepth] default 24
 * @property {string[]} [order]
 * @property {number} [lfeCrossoverHz]
 * @property {string} [programmeName]
 * @property {string} [originator]
 * @property {string} [description]
 * @property {object} [loudness] `{integrated, range, truePeak, maxMomentary, maxShortTerm}`
 * @property {Date} [date]
 */

/**
 * Write an ADM BWF file.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data channels must already be in delivery order
 * @param {AdmWriteOptions} opts
 * @returns {Blob}
 */
export function writeAdmBwf(data, opts) {
  const layout = LAYOUTS[opts.layoutId];
  if (!layout) throw new Error(`writeAdmBwf: unknown layout "${opts.layoutId}"`);

  const bitDepth = opts.bitDepth ?? 24;
  if (![16, 24, 32].includes(bitDepth)) {
    throw new Error(`writeAdmBwf: unsupported bit depth ${bitDepth}`);
  }
  const order = opts.order ?? wavChannelOrder(opts.layoutId).order;
  const ch = data.channels.length;
  if (ch !== order.length) {
    throw new Error(`writeAdmBwf: buffer has ${ch} channels but layout needs ${order.length}`);
  }

  const sr = data.sampleRate;
  const n = data.length;
  const isFloat = bitDepth === 32;
  const bps = bitDepth / 8;
  const blockAlign = ch * bps;
  const dataLen = n * blockAlign;
  const dataPad = dataLen % 2;

  const xml = buildAdmXml({
    layoutId: opts.layoutId,
    sampleRate: sr,
    bitDepth,
    durationSeconds: n / sr,
    lfeCrossoverHz: opts.lfeCrossoverHz,
    programmeName: opts.programmeName,
    order,
  });
  const xmlBytes = new TextEncoder().encode(xml);
  const axmlPad = xmlBytes.length % 2;

  // chna: 4-byte header (numTracks, numUIDs) + 40 bytes per UID entry.
  const chnaLen = 4 + 40 * ch;
  const fmtLen = 40;

  const riffSize =
    4 +
    (8 + BEXT_SIZE) +
    (8 + fmtLen) +
    (8 + chnaLen) +
    (8 + dataLen + dataPad) +
    (8 + xmlBytes.length + axmlPad);

  if (riffSize + 8 > LIMITS.RIFF_MAX_BYTES) {
    throw new Error('ADM BWF would exceed the 4 GB RIFF limit (RF64/BW64 is not implemented).');
  }

  const ab = new ArrayBuffer(8 + riffSize);
  const v = new DataView(ab);
  let o = 0;
  const ascii = (s) => {
    o = writeAscii(v, o, s);
  };
  const u32 = (x) => {
    v.setUint32(o, x, true);
    o += 4;
  };
  const u16 = (x) => {
    v.setUint16(o, x, true);
    o += 2;
  };
  const fixedStr = (s, len) => {
    for (let i = 0; i < len; i++) v.setUint8(o + i, i < s.length ? s.charCodeAt(i) & 0x7f : 0);
    o += len;
  };

  ascii('RIFF');
  u32(riffSize);
  ascii('WAVE');

  // ── bext ──
  ascii('bext');
  u32(BEXT_SIZE);
  const bextStart = o;
  fixedStr(opts.description ?? `SIGNAL ROT // MASTER — ADM BWF ${layout.name}`, 256); // Description
  fixedStr(opts.originator ?? 'SIGNAL ROT // MASTER', 32); // Originator
  fixedStr('', 32); // OriginatorReference
  const d = opts.date ?? new Date();
  const pad2 = (x) => String(x).padStart(2, '0');
  fixedStr(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`, 10);
  fixedStr(`${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`, 8);
  u32(0); // TimeReferenceLow
  u32(0); // TimeReferenceHigh
  v.setUint16(o, 2, true); // Version 2 — required for the loudness fields to be meaningful
  o += 2;
  o = bextStart + 348 + 64; // skip UMID (64 bytes of zero)
  const L = opts.loudness ?? {};
  v.setInt16(o, loudnessField(L.integrated), true);
  o += 2; // LoudnessValue
  v.setInt16(o, loudnessField(L.range), true);
  o += 2; // LoudnessRange
  v.setInt16(o, loudnessField(L.truePeak), true);
  o += 2; // MaxTruePeakLevel
  v.setInt16(o, loudnessField(L.maxMomentary), true);
  o += 2; // MaxMomentaryLoudness
  v.setInt16(o, loudnessField(L.maxShortTerm), true);
  o += 2; // MaxShortTermLoudness
  o = bextStart + BEXT_SIZE; // Reserved (180 bytes) + CodingHistory (none)

  // ── fmt (extensible; mask 0 because ADM describes routing via chna/axml) ──
  ascii('fmt ');
  u32(fmtLen);
  u16(0xfffe);
  u16(ch);
  u32(sr);
  u32(sr * blockAlign);
  u16(blockAlign);
  u16(bitDepth);
  u16(22);
  u16(bitDepth);
  u32(0);
  u16(isFloat ? 3 : 1);
  u16(0);
  for (const b of [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]) {
    v.setUint8(o++, b);
  }

  // ── chna (before data, so streaming parsers see the routing first) ──
  ascii('chna');
  u32(chnaLen);
  u16(ch); // numTracks
  u16(ch); // numUIDs
  order.forEach((key, i) => {
    const id = admIdsFor(i + 1);
    u16(i + 1); // trackIndex, 1-based
    fixedStr(id.trackUid, 12);
    fixedStr(id.trackFormat, 14);
    fixedStr(ADM_PACK_FORMAT_ID, 11);
    v.setUint8(o++, 0); // pad → 40 bytes total
  });

  // ── data ──
  ascii('data');
  u32(dataLen);
  const chans = data.channels;
  if (isFloat) {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        v.setFloat32(o, chans[c][i], true);
        o += 4;
      }
    }
  } else if (bitDepth === 16) {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        v.setInt16(o, floatToInt(chans[c][i], 16), true);
        o += 2;
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        const iv = floatToInt(chans[c][i], 24);
        v.setUint8(o, iv & 0xff);
        v.setUint8(o + 1, (iv >> 8) & 0xff);
        v.setUint8(o + 2, (iv >> 16) & 0xff);
        o += 3;
      }
    }
  }
  if (dataPad) v.setUint8(o++, 0);

  // ── axml ──
  ascii('axml');
  u32(xmlBytes.length);
  for (let i = 0; i < xmlBytes.length; i++) v.setUint8(o++, xmlBytes[i]);
  if (axmlPad) v.setUint8(o++, 0);

  return new Blob([ab], { type: 'audio/wav' });
}
