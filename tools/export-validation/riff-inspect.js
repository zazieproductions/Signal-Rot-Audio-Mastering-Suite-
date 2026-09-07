/**
 * Independent RIFF / RF64 / BW64 inspector.
 *
 * ── Independence ─────────────────────────────────────────────────────────────────────
 * This file imports **nothing** from `src/`. It is written from the specifications
 * (Microsoft RIFF/WAVE, EBU Tech 3306 RF64, ITU-R BS.2088 BW64, EBU Tech 3285 bext,
 * Tech 3285 Supplement 5 chna) so that agreement between it and Signal Rot's writer is
 * evidence, not tautology. If the writer and the reader shared a constant, a test could
 * only prove they were self-consistent.
 *
 * It reports *findings*, never throws on bad input: a corrupt file should produce a
 * diagnosis, not a stack trace.
 */

/** WAVE format tags. */
const WAVE_FORMAT = { PCM: 0x0001, IEEE_FLOAT: 0x0003, EXTENSIBLE: 0xfffe };

const KSDATAFORMAT_GUID_TAIL = [
  0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

/** Standard channel-mask bit names, ascending. */
export const MASK_BITS = Object.freeze([
  'FRONT_LEFT',
  'FRONT_RIGHT',
  'FRONT_CENTER',
  'LOW_FREQUENCY',
  'BACK_LEFT',
  'BACK_RIGHT',
  'FRONT_LEFT_OF_CENTER',
  'FRONT_RIGHT_OF_CENTER',
  'BACK_CENTER',
  'SIDE_LEFT',
  'SIDE_RIGHT',
  'TOP_CENTER',
  'TOP_FRONT_LEFT',
  'TOP_FRONT_CENTER',
  'TOP_FRONT_RIGHT',
  'TOP_BACK_LEFT',
  'TOP_BACK_CENTER',
  'TOP_BACK_RIGHT',
]);

const ascii = (view, offset, length) => {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
};

const cstr = (view, offset, length) =>
  ascii(view, offset, length)
    .replace(/\0[\s\S]*$/, '')
    .trim();

/** Decode a channel mask into ordered speaker names. */
export function decodeChannelMask(mask) {
  const out = [];
  for (let i = 0; i < 32; i++) {
    if ((mask >>> i) & 1) out.push(MASK_BITS[i] ?? `RESERVED_BIT_${i}`);
  }
  return out;
}

/**
 * Parse a whole file.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {object} a structural description plus `errors` and `warnings`
 */
export function inspectRiff(input) {
  const buf =
    input instanceof Uint8Array
      ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
      : input;
  const view = new DataView(buf);
  const errors = [];
  const warnings = [];
  /** @type {any} */
  const result = {
    totalBytes: view.byteLength,
    container: null,
    form: null,
    declaredSize: null,
    chunks: [],
    fmt: null,
    ds64: null,
    bext: null,
    chna: null,
    axml: null,
    errors,
    warnings,
  };

  // `valid` is defined up front and recomputed on the way out, so every early return —
  // including the ones for garbage input — still answers the question the caller asked.
  const bail = () => {
    result.valid = errors.length === 0;
    return result;
  };

  if (view.byteLength < 12) {
    errors.push('File is shorter than a 12-byte RIFF header.');
    return bail();
  }

  const container = ascii(view, 0, 4);
  result.container = container;
  result.declaredSize = view.getUint32(4, true);
  result.form = ascii(view, 8, 4);

  if (!['RIFF', 'RF64', 'BW64'].includes(container)) {
    errors.push(`Unknown container FourCC "${container}" (expected RIFF, RF64 or BW64).`);
    return bail();
  }
  if (result.form !== 'WAVE') {
    errors.push(`Form type is "${result.form}", expected "WAVE".`);
  }

  const sixtyFour = container === 'RF64' || container === 'BW64';

  // ── Chunk walk ──
  let offset = 12;
  let truncated = false;
  while (offset + 8 <= view.byteLength) {
    const id = ascii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const chunk = { id, sizeField: size, dataOffset: offset + 8 };
    if (!/^[\x20-\x7e]{4}$/.test(id)) {
      errors.push(`Non-printable chunk id at offset ${offset}: ${JSON.stringify(id)}.`);
      break;
    }
    let effective = size;
    if (sixtyFour && id === 'data' && size === 0xffffffff) {
      chunk.sentinel = true;
      effective = null; // resolved from ds64 below
    }
    chunk.size = effective;
    result.chunks.push(chunk);
    if (effective === null) break; // ds64 must be resolved before the walk can continue
    if (offset + 8 + effective > view.byteLength) {
      errors.push(
        `Chunk "${id}" declares ${effective} bytes at offset ${offset + 8} but only ` +
          `${view.byteLength - offset - 8} remain — the file is truncated.`,
      );
      truncated = true;
      break;
    }
    if (effective % 2 === 1) {
      // Word alignment: an odd payload must be followed by one pad byte.
      if (offset + 8 + effective >= view.byteLength) {
        errors.push(`Chunk "${id}" has odd size ${effective} and no word-alignment pad byte.`);
      } else if (view.getUint8(offset + 8 + effective) !== 0) {
        warnings.push(`Pad byte after odd-sized chunk "${id}" is not zero.`);
      }
    }
    offset += 8 + effective + (effective % 2);
  }

  const find = (id) => result.chunks.find((c) => c.id === id);

  // ── ds64 ──
  const ds64 = find('ds64');
  if (sixtyFour) {
    if (!ds64) {
      errors.push(`${container} file has no ds64 chunk (EBU Tech 3306 requires one).`);
    } else {
      if (result.chunks[0].id !== 'ds64') {
        errors.push('ds64 must be the first chunk after the WAVE form type.');
      }
      if (ds64.sizeField < 28) {
        errors.push(`ds64 is ${ds64.sizeField} bytes; the minimum is 28.`);
      } else {
        const o = ds64.dataOffset;
        const tableLength = view.getUint32(o + 24, true);
        const table = [];
        for (let i = 0; i < tableLength && o + 28 + i * 12 + 12 <= view.byteLength; i++) {
          const b = o + 28 + i * 12;
          table.push({
            id: ascii(view, b, 4),
            size: view.getUint32(b + 4, true) + view.getUint32(b + 8, true) * 2 ** 32,
          });
        }
        result.ds64 = {
          riffSize: Number(view.getBigUint64(o, true)),
          dataSize: Number(view.getBigUint64(o + 8, true)),
          sampleCount: Number(view.getBigUint64(o + 16, true)),
          tableLength,
          table,
        };
        if (ds64.sizeField !== 28 + tableLength * 12) {
          errors.push(
            `ds64 size ${ds64.sizeField} does not match 28 + 12 × tableLength (${tableLength}).`,
          );
        }
        if (result.declaredSize !== 0xffffffff) {
          errors.push(
            `${container} top-level size field is ${result.declaredSize}, expected the ` +
              '0xFFFFFFFF sentinel.',
          );
        }
        if (result.ds64.riffSize !== view.byteLength - 8) {
          errors.push(
            `ds64 riffSize ${result.ds64.riffSize} ≠ actual file size − 8 (${view.byteLength - 8}).`,
          );
        }
        // Resolve the sentinel and finish the walk.
        const dataChunk = find('data');
        if (dataChunk && dataChunk.sentinel) {
          dataChunk.size = result.ds64.dataSize;
          let o2 = dataChunk.dataOffset + dataChunk.size + (dataChunk.size % 2);
          while (o2 + 8 <= view.byteLength) {
            const id = ascii(view, o2, 4);
            const size = view.getUint32(o2 + 4, true);
            if (!/^[\x20-\x7e]{4}$/.test(id)) break;
            result.chunks.push({ id, sizeField: size, size, dataOffset: o2 + 8 });
            o2 += 8 + size + (size % 2);
          }
        }
      }
    }
  } else {
    if (ds64) errors.push('A plain RIFF file must not contain a ds64 chunk.');
    if (result.declaredSize !== view.byteLength - 8) {
      errors.push(
        `RIFF size field is ${result.declaredSize} but the file is ${view.byteLength} bytes ` +
          `(expected ${view.byteLength - 8}).`,
      );
    }
    if (result.declaredSize === 0xffffffff) {
      errors.push('RIFF size field is the RF64 sentinel — the container should be RF64/BW64.');
    }
  }

  // ── fmt ──
  const fmtChunk = find('fmt ');
  if (!fmtChunk) {
    errors.push('No "fmt " chunk.');
  } else if (fmtChunk.size < 16) {
    errors.push(`"fmt " chunk is ${fmtChunk.size} bytes; the minimum is 16.`);
  } else {
    const o = fmtChunk.dataOffset;
    const fmt = {
      formatTag: view.getUint16(o, true),
      channels: view.getUint16(o + 2, true),
      sampleRate: view.getUint32(o + 4, true),
      byteRate: view.getUint32(o + 8, true),
      blockAlign: view.getUint16(o + 12, true),
      bitsPerSample: view.getUint16(o + 14, true),
      chunkSize: fmtChunk.size,
    };
    if (fmt.formatTag === WAVE_FORMAT.EXTENSIBLE) {
      if (fmtChunk.size < 40) {
        errors.push(`WAVE_FORMAT_EXTENSIBLE requires a 40-byte fmt chunk, got ${fmtChunk.size}.`);
      } else {
        fmt.cbSize = view.getUint16(o + 16, true);
        fmt.validBitsPerSample = view.getUint16(o + 18, true);
        fmt.channelMask = view.getUint32(o + 20, true) >>> 0;
        fmt.subFormatTag = view.getUint16(o + 24, true);
        fmt.channelMaskNames = decodeChannelMask(fmt.channelMask);
        const guidOk = KSDATAFORMAT_GUID_TAIL.every((b, i) => view.getUint8(o + 28 + i) === b);
        fmt.guidTailValid = guidOk;
        if (!guidOk) errors.push('SubFormat GUID tail is not KSDATAFORMAT_SUBTYPE_*.');
        if (fmt.cbSize !== 22) errors.push(`cbSize is ${fmt.cbSize}, expected 22.`);
        if (fmt.validBitsPerSample > fmt.bitsPerSample) {
          errors.push(
            `wValidBitsPerSample (${fmt.validBitsPerSample}) exceeds wBitsPerSample ` +
              `(${fmt.bitsPerSample}).`,
          );
        }
        if (![WAVE_FORMAT.PCM, WAVE_FORMAT.IEEE_FLOAT].includes(fmt.subFormatTag)) {
          errors.push(`Unknown SubFormat tag 0x${fmt.subFormatTag.toString(16)}.`);
        }
        const maskBits = fmt.channelMaskNames.length;
        if (fmt.channelMask !== 0 && maskBits !== fmt.channels) {
          errors.push(
            `Channel mask 0x${fmt.channelMask.toString(16).toUpperCase()} names ${maskBits} ` +
              `speakers but the file has ${fmt.channels} channels.`,
          );
        }
      }
    } else if (fmt.channels > 2) {
      warnings.push(
        `${fmt.channels} channels without WAVE_FORMAT_EXTENSIBLE — channel routing is undefined.`,
      );
    }
    fmt.isFloat =
      fmt.formatTag === WAVE_FORMAT.IEEE_FLOAT || fmt.subFormatTag === WAVE_FORMAT.IEEE_FLOAT;

    if (fmt.channels === 0) errors.push('fmt declares 0 channels.');
    if (fmt.sampleRate === 0) errors.push('fmt declares a 0 Hz sample rate.');
    if (![8, 16, 24, 32, 64].includes(fmt.bitsPerSample)) {
      warnings.push(`Unusual bit depth ${fmt.bitsPerSample}.`);
    }
    const expectedAlign = (fmt.channels * fmt.bitsPerSample) / 8;
    if (fmt.blockAlign !== expectedAlign) {
      errors.push(`blockAlign is ${fmt.blockAlign}, expected ${expectedAlign}.`);
    }
    if (fmt.byteRate !== fmt.sampleRate * fmt.blockAlign) {
      errors.push(
        `byteRate is ${fmt.byteRate}, expected ${fmt.sampleRate * fmt.blockAlign} ` +
          '(sampleRate × blockAlign).',
      );
    }
    result.fmt = fmt;
  }

  // ── data ──
  const dataChunk = find('data');
  if (!dataChunk) {
    errors.push('No "data" chunk.');
  } else if (result.fmt && !truncated) {
    const align = result.fmt.blockAlign || 1;
    if (dataChunk.size % align !== 0) {
      errors.push(
        `data chunk size ${dataChunk.size} is not a multiple of blockAlign ${align} — ` +
          'the final frame is incomplete.',
      );
    }
    result.frames = Math.floor(dataChunk.size / align);
    result.durationSeconds = result.fmt.sampleRate ? result.frames / result.fmt.sampleRate : null;
    if (result.ds64 && result.ds64.sampleCount && result.ds64.sampleCount !== result.frames) {
      errors.push(
        `ds64 sampleCount ${result.ds64.sampleCount} ≠ frames derived from data size ` +
          `(${result.frames}).`,
      );
    }
  }

  // ── bext (EBU Tech 3285) ──
  const bextChunk = find('bext');
  if (bextChunk) {
    if (bextChunk.size < 602) {
      errors.push(`bext is ${bextChunk.size} bytes; Tech 3285 v2 requires at least 602.`);
    } else {
      const o = bextChunk.dataOffset;
      const version = view.getUint16(o + 346, true);
      result.bext = {
        size: bextChunk.size,
        description: cstr(view, o, 256),
        originator: cstr(view, o + 256, 32),
        originatorReference: cstr(view, o + 288, 32),
        originationDate: cstr(view, o + 320, 10),
        originationTime: cstr(view, o + 330, 8),
        timeReference: view.getUint32(o + 338, true) + view.getUint32(o + 342, true) * 2 ** 32,
        version,
        codingHistory: cstr(view, o + 602, Math.max(0, bextChunk.size - 602)),
      };
      if (version >= 2) {
        const s16 = (off) => {
          const v = view.getInt16(off, true);
          return v === 0x7fff ? null : v / 100; // 0x7FFF is the "not measured" sentinel
        };
        result.bext.loudness = {
          integratedLufs: s16(o + 412),
          loudnessRangeLu: s16(o + 414),
          maxTruePeakDbtp: s16(o + 416),
          maxMomentaryLufs: s16(o + 418),
          maxShortTermLufs: s16(o + 420),
        };
      }
      if (version > 2) warnings.push(`bext version ${version} is newer than Tech 3285 v2.`);
      const date = result.bext.originationDate;
      if (date && !/^\d{4}[-:]\d{2}[-:]\d{2}$/.test(date)) {
        errors.push(`bext OriginationDate "${date}" is not yyyy-mm-dd.`);
      }
      const time = result.bext.originationTime;
      if (time && !/^\d{2}[-:]\d{2}[-:]\d{2}$/.test(time)) {
        errors.push(`bext OriginationTime "${time}" is not hh:mm:ss.`);
      }
    }
  }

  // ── chna (Tech 3285 Supplement 5 / BS.2088) ──
  const chnaChunk = find('chna');
  if (chnaChunk) {
    const o = chnaChunk.dataOffset;
    const numTracks = view.getUint16(o, true);
    const numUIDs = view.getUint16(o + 2, true);
    const expected = 4 + 40 * numUIDs;
    if (chnaChunk.size !== expected) {
      errors.push(
        `chna is ${chnaChunk.size} bytes but declares ${numUIDs} UIDs (expected ${expected}).`,
      );
    }
    const entries = [];
    for (let i = 0; i < numUIDs && o + 4 + i * 40 + 40 <= view.byteLength; i++) {
      const b = o + 4 + i * 40;
      entries.push({
        trackIndex: view.getUint16(b, true),
        uid: cstr(view, b + 2, 12),
        trackFormatIdRef: cstr(view, b + 14, 14),
        packFormatIdRef: cstr(view, b + 28, 11),
      });
    }
    result.chna = { numTracks, numUIDs, entries };

    if (result.fmt && numTracks !== result.fmt.channels) {
      errors.push(`chna numTracks ${numTracks} ≠ fmt channel count ${result.fmt.channels}.`);
    }
    const seen = new Set();
    entries.forEach((e, i) => {
      if (e.trackIndex !== i + 1) {
        errors.push(`chna entry ${i} has trackIndex ${e.trackIndex}, expected ${i + 1}.`);
      }
      if (seen.has(e.uid)) errors.push(`chna audioTrackUID "${e.uid}" is duplicated.`);
      seen.add(e.uid);
      if (!/^ATU_[0-9A-Fa-f]{8}$/.test(e.uid)) {
        errors.push(`chna audioTrackUID "${e.uid}" does not match ATU_xxxxxxxx (BS.2076).`);
      }
      if (!/^AT_[0-9A-Fa-f]{8}_[0-9A-Fa-f]{2}$/.test(e.trackFormatIdRef)) {
        errors.push(`chna audioTrackFormatIDRef "${e.trackFormatIdRef}" is malformed.`);
      }
      if (!/^AP_[0-9A-Fa-f]{8}$/.test(e.packFormatIdRef)) {
        errors.push(`chna audioPackFormatIDRef "${e.packFormatIdRef}" is malformed.`);
      }
    });
  }

  // ── axml ──
  const axmlChunk = find('axml');
  if (axmlChunk) {
    const bytes = new Uint8Array(buf, axmlChunk.dataOffset, axmlChunk.size);
    result.axml = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (!result.axml.trimStart().startsWith('<')) {
      errors.push('axml payload does not begin with an XML declaration or element.');
    }
    if (result.axml.length !== result.axml.replace(/\0/g, '').length) {
      errors.push('axml payload contains NUL bytes.');
    }
  }
  if (result.chna && !result.axml) {
    warnings.push('chna present without axml — the track UIDs reference nothing.');
  }

  // ── Chunk-order rules ──
  const ids = result.chunks.map((c) => c.id);
  const fmtIdx = ids.indexOf('fmt ');
  const dataIdx = ids.indexOf('data');
  if (fmtIdx >= 0 && dataIdx >= 0 && fmtIdx > dataIdx) {
    errors.push('"fmt " must precede "data".');
  }
  const chnaIdx = ids.indexOf('chna');
  if (chnaIdx >= 0 && dataIdx >= 0 && chnaIdx > dataIdx) {
    warnings.push('chna appears after data; streaming parsers prefer it before.');
  }
  if (new Set(ids.filter((i) => i === 'fmt ')).size && ids.filter((i) => i === 'fmt ').length > 1) {
    errors.push('More than one "fmt " chunk.');
  }
  if (ids.filter((i) => i === 'data').length > 1) errors.push('More than one "data" chunk.');

  return bail();
}

/**
 * Read interleaved PCM back out as normalised float channels — an independent decoder
 * used by the round-trip tests.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{sampleRate: number, length: number, channels: Float32Array[]}|null}
 */
export function decodePcm(input) {
  const report = inspectRiff(input);
  if (!report.fmt) return null;
  const dataChunk = report.chunks.find((c) => c.id === 'data');
  if (!dataChunk) return null;
  const buf =
    input instanceof Uint8Array
      ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
      : input;
  const view = new DataView(buf);
  const { channels: ch, bitsPerSample: bits, isFloat, sampleRate } = report.fmt;
  const bps = bits / 8;
  const frames = Math.floor(dataChunk.size / (bps * ch));
  const out = [];
  for (let c = 0; c < ch; c++) out.push(new Float32Array(frames));
  let o = dataChunk.dataOffset;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      if (isFloat && bits === 32) {
        out[c][i] = view.getFloat32(o, true);
      } else if (bits === 16) {
        out[c][i] = view.getInt16(o, true) / 32768;
      } else if (bits === 24) {
        let v = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getUint8(o + 2) << 16);
        if (v & 0x800000) v -= 0x1000000;
        out[c][i] = v / 8388608;
      } else if (bits === 8) {
        out[c][i] = (view.getUint8(o) - 128) / 128;
      }
      o += bps;
    }
  }
  return { sampleRate, length: frames, channels: out };
}
