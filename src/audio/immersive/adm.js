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
 *  · The XML is well-formed and **structurally validated** on every CI run by an
 *    independent validator that shares no code with this writer
 *    (`tools/export-validation/adm-validate.js`): namespaces, element nesting, required
 *    attributes, BS.2076 ID grammar, typeLabel ⇄ typeDefinition ⇄ ID-digit agreement,
 *    cross-reference resolution, DirectSpeakers semantics, coordinate ranges and
 *    speakerLabel ⇄ azimuth agreement, plus chna ⇄ axml ⇄ fmt consistency.
 *  · It has **not** been validated against the normative ITU-R BS.2076 XSD (the ITU does
 *    not license it for redistribution, so CI cannot fetch one) and has **not** been
 *    ingested into a commercial renderer as part of this project's CI. Point
 *    `npm run validate:adm -- --xsd <path>` at your own licensed copy to close that gap
 *    locally. See docs/EXPORT-INTEROPERABILITY.md.
 */

import { clamp } from '../dsp/math.js';
import { floatToInt, writeAscii } from '../encode/wav.js';
import { MAX_BUFFERED_BYTES, planRiffContainer, writeRiffHeader } from '../encode/riff-layout.js';
import { LAYOUTS, SPEAKERS, wavChannelOrder } from './layouts.js';

/**
 * Longest programme / content name written into the ADM XML.
 *
 * There is no limit in BS.2076, but an unbounded name is a denial-of-service vector for
 * a downstream parser and a filename-length hazard for the tools that derive filenames
 * from programme names. Names are truncated with an ellipsis rather than rejected: the
 * name is cosmetic metadata and losing an export over it would be worse than shortening.
 */
export const ADM_MAX_NAME_LENGTH = 256;

/**
 * Characters XML 1.0 forbids outright.
 *
 * XML 1.0 §2.2 permits only tab, newline, carriage return and #x20 upwards. A NUL or a
 * #x01 in a programme name — trivially arrivable at from a mangled filename — produces a
 * document that is not well-formed, and every parser in the chain will reject the whole
 * file. Escaping cannot help: `&#0;` is *also* forbidden. They must be removed.
 *
 * Unpaired UTF-16 surrogates are handled separately below; they are equally fatal and
 * arise from truncating a string in the middle of an astral character such as an emoji.
 */
// eslint-disable-next-line no-control-regex
const XML_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Make a string safe to place in XML text or attribute content.
 *
 * Two jobs, in this order:
 *   1. **Sanitise.** Strip characters XML 1.0 cannot represent at all, and replace lone
 *      surrogates with U+FFFD. Skipping this produces a file no parser will open — a
 *      silent, total corruption from a stray byte in a filename.
 *   2. **Escape.** The five predefined entities, so `&`, `<` and quotes in a legitimate
 *      title cannot break out of their context.
 *
 * The result is always well-formed. The function never throws, because the alternative
 * to a sanitised name is a failed export, and a slightly altered title is the lesser
 * harm — but the alteration is deliberate and documented, never silent corruption.
 */
export function xmlEscape(s) {
  return String(s)
    .replace(XML_FORBIDDEN, '')
    .replace(LONE_SURROGATE, '\ufffd')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Clamp a free-text metadata name to a sane length, cutting on a code-point boundary so
 * an astral character is never split into a lone surrogate.
 * @param {string} s
 * @param {number} [max]
 */
export function clampAdmName(s, max = ADM_MAX_NAME_LENGTH) {
  const text = String(s ?? '');
  if (text.length <= max) return text;
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, max - 1).join('')}\u2026`;
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
    channelFormat: `AC_${ADM_TYPE_DIGITS}${hex4(n)}`,
    blockFormat: `AB_${ADM_TYPE_DIGITS}${hex4(n)}_00000001`,
    streamFormat: `AS_${ADM_TYPE_DIGITS}${hex4(n)}`,
    trackFormat: `AT_${ADM_TYPE_DIGITS}${hex4(n)}_01`,
    trackUid: `ATU_${hex8(index)}`,
  };
}

/**
 * BS.2076 typeLabel for `DirectSpeakers`, as four hex digits.
 *
 * This is `0001`. `0003` is `Objects`. Everything this project writes is a fixed
 * loudspeaker bed, so the label, the `typeDefinition` attribute and the four type digits
 * embedded in every `AC_`/`AP_`/`AS_`/`AT_` identifier must all say DirectSpeakers —
 * BS.2076 §5.2 requires the digits and the label to agree, and a mismatch makes the
 * document ambiguous to a conforming renderer. Releases before this one wrote `0003`,
 * which is why the identifiers changed; see docs/EXPORT-INTEROPERABILITY.md.
 */
export const ADM_TYPE_DIGITS = '0001';
/** @deprecated retained for readability at call sites. */
export const ADM_TYPE_DEFINITION = 'DirectSpeakers';

export const ADM_PACK_FORMAT_ID = `AP_${ADM_TYPE_DIGITS}1001`;
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
  // BS.2076 requires audioProgrammeName; an empty attribute is a validation failure.
  // A supplied name can legitimately *become* empty after sanitising — a name made
  // entirely of control characters, or an empty string from a blank form field — so the
  // fallback is applied after sanitising, not before.
  const requestedName = clampAdmName(opts.programmeName ?? '');
  const escapedName = xmlEscape(requestedName).trim();
  const programmeName = escapedName || xmlEscape(`Signal Rot ${layout.name}`);
  const lfeHz = opts.lfeCrossoverHz ?? 120;
  if (!Number.isFinite(lfeHz) || lfeHz <= 0 || lfeHz > 500) {
    throw new Error(
      `buildAdmXml: LFE crossover ${lfeHz} Hz is implausible. Refusing to write metadata ` +
        'that would make a renderer band-limit the wrong way.',
    );
  }
  if (!Number.isInteger(opts.sampleRate) || opts.sampleRate <= 0) {
    throw new Error(`buildAdmXml: invalid sample rate ${opts.sampleRate}`);
  }
  if (!Number.isFinite(opts.durationSeconds) || opts.durationSeconds < 0) {
    throw new Error(`buildAdmXml: invalid duration ${opts.durationSeconds}`);
  }

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
        `typeLabel="${ADM_TYPE_DIGITS}" typeDefinition="${ADM_TYPE_DEFINITION}">
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
    <audioPackFormat audioPackFormatID="${ADM_PACK_FORMAT_ID}" audioPackFormatName="${xmlEscape(layout.name)}" typeLabel="${ADM_TYPE_DIGITS}" typeDefinition="${ADM_TYPE_DEFINITION}">
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
 * @property {'auto'|'riff'|'rf64'|'bw64'} [container] default `'auto'` (RIFF, promoting to BW64)
 * @property {number} [maxBufferedBytes]
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
  if (!Number.isInteger(sr) || sr < 8000 || sr > 768000) {
    throw new Error(
      `writeAdmBwf: sample rate ${sr} is not a plausible audio rate. A fmt chunk declaring ` +
        'it would be ambiguous or unplayable.',
    );
  }
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`writeAdmBwf: invalid frame count ${n}`);
  }
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

  // BS.2088 BW64 is the ADM-facing 64-bit container; ADM exports promote to BW64 (never
  // RF64) when the sizes no longer fit in 32 bits. Small files stay ordinary RIFF.
  const plan = planRiffContainer({
    chunks: [
      { id: 'bext', size: BEXT_SIZE },
      { id: 'fmt ', size: fmtLen },
      { id: 'chna', size: chnaLen },
      { id: 'data', size: dataLen },
      { id: 'axml', size: xmlBytes.length },
    ],
    sampleCount: n,
    mode: opts.container ?? 'auto',
    maxBufferedBytes: opts.maxBufferedBytes ?? MAX_BUFFERED_BYTES,
  });

  const ab = new ArrayBuffer(plan.totalBytes);
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
  // `bext` fields are fixed-length ASCII, NUL-padded (EBU Tech 3285 §2). Masking a
  // non-ASCII code point with `& 0x7f` would silently turn "Ünïcode" into mojibake and a
  // NUL into a premature string terminator, so anything outside printable ASCII becomes
  // '?' and control characters are dropped. Over-long input is truncated, not wrapped.
  const fixedStr = (input, len) => {
    const text = String(input ?? '');
    let w = 0;
    for (let i = 0; i < text.length && w < len; i++) {
      const code = text.charCodeAt(i);
      if (code === 0) continue; // never embed a NUL inside the field
      v.setUint8(o + w, code >= 0x20 && code <= 0x7e ? code : 0x3f);
      w++;
    }
    for (; w < len; w++) v.setUint8(o + w, 0);
    o += len;
  };

  o = writeRiffHeader(v, plan);

  // ── bext ──
  ascii('bext');
  u32(BEXT_SIZE);
  const bextStart = o;
  fixedStr(opts.description ?? `SIGNAL ROT // MASTER - ADM BWF ${layout.name}`, 256);
  fixedStr(opts.originator ?? 'SIGNAL ROT // MASTER', 32);
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
  // 0xFFFFFFFF sentinel in a BW64 file; the real size is in ds64.
  u32(plan.chunks.find((c) => c.id === 'data').sizeField >>> 0);
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

  const blob = new Blob([ab], { type: 'audio/wav' });
  Object.defineProperty(blob, 'riffContainer', { value: plan.container, enumerable: false });
  return blob;
}
