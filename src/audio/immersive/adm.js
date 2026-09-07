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
import { dataViewWriter, floatToInt, prepareWav, writeFmtChunk } from '../encode/wav.js';
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
 * Write a fixed-length ASCII field, NUL-padded (EBU Tech 3285 §2 style).
 *
 * A non-ASCII code point would silently become mojibake under a naive `& 0x7f` mask, and a
 * NUL inside the field would terminate the string early for every reader, so anything
 * outside printable ASCII becomes '?' and control characters are dropped. Over-long input
 * is truncated, not wrapped.
 *
 * @param {import('../encode/wav.js').ByteWriter} w
 * @param {string|undefined|null} input
 * @param {number} len
 */
function writeFixedField(w, input, len) {
  const text = String(input ?? '');
  let written = 0;
  for (let i = 0; i < text.length && written < len; i++) {
    const code = text.charCodeAt(i);
    if (code === 0) continue; // never embed a NUL inside the field
    w.u8(code >= 0x20 && code <= 0x7e ? code : 0x3f);
    written++;
  }
  for (; written < len; written++) w.u8(0);
}

/**
 * Validate the inputs and derive the geometry/metadata for an ADM BWF. Shared by the
 * in-memory writer and the streaming writer so the two paths cannot disagree about what
 * a valid ADM export is.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data
 * @param {AdmWriteOptions} opts
 * @returns {object} every pre-computed value the chunk writers need
 */
export function prepareAdmBwf(data, opts) {
  const layout = LAYOUTS[opts.layoutId];
  if (!layout) throw new Error(`writeAdmBwf: unknown layout "${opts.layoutId}"`);

  const bitDepth = opts.bitDepth ?? 24;
  const order = opts.order ?? wavChannelOrder(opts.layoutId).order;
  // prepareWav covers the rate/depth/frame/channel-length guard rails; the count check
  // is ADM-specific (channels must match the declared layout order exactly).
  const g = prepareWav(data, bitDepth, { forceExtensible: true });
  if (g.ch !== order.length) {
    throw new Error(`writeAdmBwf: buffer has ${g.ch} channels but layout needs ${order.length}`);
  }
  const { ch, sr, n, blockAlign } = g;
  const dataLen = n * blockAlign;

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

  const chnaLen = 4 + 40 * ch; // 4-byte header + 40 bytes per UID entry
  const chunks = [
    { id: 'bext', size: BEXT_SIZE },
    { id: 'fmt ', size: 40 },
    { id: 'chna', size: chnaLen },
    { id: 'data', size: dataLen },
    { id: 'axml', size: xmlBytes.length },
  ];

  return {
    layout,
    order,
    bitDepth,
    isFloat: bitDepth === 32,
    ch,
    sr,
    n,
    blockAlign,
    dataLen,
    xml,
    xmlBytes,
    chnaLen,
    chunks,
    date: opts.date ?? new Date(),
    loudness: opts.loudness ?? {},
    description: opts.description ?? `SIGNAL ROT // MASTER - ADM BWF ${layout.name}`,
    originator: opts.originator ?? 'SIGNAL ROT // MASTER',
    container: opts.container ?? 'auto',
    maxBufferedBytes: opts.maxBufferedBytes ?? MAX_BUFFERED_BYTES,
  };
}

/**
 * Write the `bext` chunk (EBU Tech 3285 v2, 602 bytes). Returns nothing; the caller knows
 * the size. Shared by the in-memory and streaming writers.
 *
 * @param {import('../encode/wav.js').ByteWriter} w
 * @param {object} spec
 * @param {string} spec.description
 * @param {string} spec.originator
 * @param {Date} spec.date
 * @param {object} spec.loudness `{integrated, range, truePeak, maxMomentary, maxShortTerm}`
 */
export function writeBextChunk(w, spec) {
  const L = spec.loudness;
  const d = spec.date;
  const pad2 = (x) => String(x).padStart(2, '0');
  w.ascii('bext');
  w.u32(BEXT_SIZE);
  const start = w.offset;
  writeFixedField(w, spec.description, 256); // Description
  writeFixedField(w, spec.originator, 32); // Originator
  writeFixedField(w, '', 32); // OriginatorReference
  writeFixedField(
    w,
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    10,
  );
  writeFixedField(
    w,
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`,
    8,
  );
  w.u32(0); // TimeReferenceLow
  w.u32(0); // TimeReferenceHigh
  w.u16(2); // Version 2 — loudness fields only have meaning at v2
  // The 64-byte UMID follows (offset 348..411); this project writes none, so it is left
  // as the buffer's zero fill and the offset jumps straight to the loudness fields.
  w.offset = start + 348 + 64;
  w.i16(loudnessField(L.integrated)); // LoudnessValue
  w.i16(loudnessField(L.range)); // LoudnessRange
  w.i16(loudnessField(L.truePeak)); // MaxTruePeakLevel
  w.i16(loudnessField(L.maxMomentary)); // MaxMomentaryLoudness
  w.i16(loudnessField(L.maxShortTerm)); // MaxShortTermLoudness
  // Reserved (180 bytes) + CodingHistory (none): jump to the end of the payload.
  w.offset = start + BEXT_SIZE;
}

/**
 * Write the `chna` chunk (BS.2088 / Tech 3285 Supplement 5): a 4-byte header followed by
 * 40-byte track-UID entries, one per channel. Shared by the in-memory and streaming
 * writers.
 *
 * @param {import('../encode/wav.js').ByteWriter} w
 * @param {object} spec
 * @param {number} spec.channels
 * @param {string[]} spec.order delivery-order speaker keys
 */
export function writeChnaChunk(w, { channels, order }) {
  w.ascii('chna');
  w.u32(4 + 40 * channels);
  w.u16(channels); // numTracks
  w.u16(channels); // numUIDs
  order.forEach((key, i) => {
    const id = admIdsFor(i + 1);
    w.u16(i + 1); // trackIndex, 1-based
    writeFixedField(w, id.trackUid, 12);
    writeFixedField(w, id.trackFormat, 14);
    writeFixedField(w, ADM_PACK_FORMAT_ID, 11);
    w.u8(0); // pad → 40 bytes per entry
  });
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
 * Write an ADM BWF file into a single in-memory buffer.
 *
 * This is the all-in-memory path (kept synchronous and Blob-returning for the delivery
 * package builder and the fixture tooling). The streaming twin is
 * `writeAdmBwfStreamed` in `adm-stream.js`; both pass through {@link prepareAdmBwf},
 * {@link writeBextChunk}, {@link writeChnaChunk} and the shared `fmt `/PCM helpers, so
 * their bytes cannot diverge.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data channels must already be in delivery order
 * @param {AdmWriteOptions} opts
 * @returns {Blob}
 */
export function writeAdmBwf(data, opts) {
  const p = prepareAdmBwf(data, opts);

  // BS.2088 BW64 is the ADM-facing 64-bit container; ADM exports promote to BW64 (never
  // RF64) when the sizes no longer fit in 32 bits. Small files stay ordinary RIFF.
  const plan = planRiffContainer({
    chunks: p.chunks,
    sampleCount: p.n,
    mode: p.container,
    maxBufferedBytes: p.maxBufferedBytes,
  });
  const dataPad = p.dataLen % 2;
  const axmlPad = p.xmlBytes.length % 2;

  const ab = new ArrayBuffer(plan.totalBytes);
  const view = new DataView(ab);
  const headerEnd = writeRiffHeader(view, plan);
  const w = dataViewWriter(view, headerEnd);

  writeBextChunk(w, {
    description: p.description,
    originator: p.originator,
    date: p.date,
    loudness: p.loudness,
  });
  // fmt is always WAVE_FORMAT_EXTENSIBLE with mask 0: ADM describes routing via chna/axml,
  // and a competing mask would be a second source of truth.
  writeFmtChunk(w, {
    channels: p.ch,
    sampleRate: p.sr,
    bitDepth: p.bitDepth,
    extensible: true,
    channelMask: 0,
  });
  writeChnaChunk(w, { channels: p.ch, order: p.order });

  // data (before axml, so streaming parsers learn the routing without seeking past audio)
  w.ascii('data');
  // 0xFFFFFFFF sentinel in a BW64 file; the real size is in ds64.
  w.u32(plan.chunks.find((c) => c.id === 'data').sizeField >>> 0);
  for (let i = 0; i < p.n; i++) {
    encodePcmFrameIntoWriter(w, data.channels, i, p.ch, p.bitDepth);
  }
  if (dataPad) w.u8(0);

  // axml
  w.ascii('axml');
  w.u32(p.xmlBytes.length);
  for (let i = 0; i < p.xmlBytes.length; i++) w.u8(p.xmlBytes[i]);
  if (axmlPad) w.u8(0);

  if (w.offset !== plan.totalBytes) {
    throw new Error(
      `writeAdmBwf: wrote ${w.offset} bytes but the plan says ${plan.totalBytes}. ` +
        'Refusing to return a file whose header and payload disagree.',
    );
  }

  const blob = new Blob([ab], { type: 'audio/wav' });
  Object.defineProperty(blob, 'riffContainer', { value: plan.container, enumerable: false });
  return blob;
}

/**
 * Encode one interleaved frame through a {@link import('../encode/wav.js').ByteWriter}.
 *
 * The DataView-based `encodePcmFrame` cannot be used directly once the writer has moved
 * past the data payload (chunks follow), and streaming does not have one contiguous view
 * at all — so this mirrors it for the writer surface. Kept here (not exported) because
 * the PCM loop in `writeAdmBwf` and the streaming twin must stay identical; both call
 * this.
 */
export function encodePcmFrameIntoWriter(w, channels, frame, ch, bitDepth) {
  if (bitDepth === 32) {
    for (let c = 0; c < ch; c++) w.f32(channels[c][frame]);
  } else if (bitDepth === 16) {
    for (let c = 0; c < ch; c++) w.i16(floatToInt(channels[c][frame], 16));
  } else {
    for (let c = 0; c < ch; c++) {
      const iv = floatToInt(channels[c][frame], 24);
      w.u8(iv & 0xff);
      w.u8((iv >> 8) & 0xff);
      w.u8((iv >> 16) & 0xff);
    }
  }
}
