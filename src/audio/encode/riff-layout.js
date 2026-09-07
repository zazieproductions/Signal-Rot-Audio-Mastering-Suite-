/**
 * RIFF / RF64 / BW64 container size planning.
 *
 * ── Why this is a separate module ────────────────────────────────────────────────────
 * The 4 GiB question is a *size arithmetic* problem, not an encoding problem. Getting it
 * wrong silently produces a file whose header says one thing and whose bytes say another,
 * which no amount of listening will reveal. Isolating the arithmetic here means it can be
 * tested at the 4 GiB boundary without allocating a 4 GiB buffer — the planner never
 * touches audio, only numbers.
 *
 * ── The three containers ─────────────────────────────────────────────────────────────
 *
 *   `RIFF`  Classic Microsoft RIFF/WAVE. Every size field is unsigned 32-bit, so the
 *           whole file must be < 4 GiB. Universally readable.
 *
 *   `RF64`  EBU Tech 3306. The `RIFF` FourCC becomes `RF64`, the top-level size field and
 *           the `data` chunk size field are both set to `0xFFFFFFFF` ("look elsewhere"),
 *           and a mandatory `ds64` chunk — which must be the *first* chunk after the form
 *           type — carries the real sizes as 64-bit little-endian integers.
 *
 *   `BW64`  ITU-R BS.2088. Byte-identical to RF64 apart from the FourCC, which is `BW64`.
 *           BS.2088 is the container the ADM ecosystem names, so ADM exports that need
 *           64-bit sizes use `BW64` rather than `RF64`.
 *
 * ── ds64 layout (EBU Tech 3306 §3.2) ─────────────────────────────────────────────────
 *   offset  size  field
 *   0       8     riffSize        total file size − 8
 *   8       8     dataSize        `data` chunk payload size
 *   16      8     sampleCount     frames per channel (0 when unknown)
 *   24      4     tableLength     number of 12-byte entries that follow
 *   28      12*n  table           {chunkId, chunkSizeLow, chunkSizeHigh} for any *other*
 *                                 chunk that overflows 32 bits
 *
 * Signal Rot never writes a chunk other than `data` that could overflow 32 bits (the
 * largest is `axml`, bounded by the layout's channel count), so `tableLength` is always 0
 * and `ds64` is always 28 bytes. The table is still parsed and validated on read-back.
 *
 * ── The sentinel value ───────────────────────────────────────────────────────────────
 * `0xFFFFFFFF` in a size field of an RF64/BW64 file means "the real value is in ds64".
 * This module never writes a *wrapped* 32-bit size: if a size does not fit, the container
 * is promoted, and if promotion is refused the plan fails loudly.
 */

/** Unsigned 32-bit maximum — also the RF64 "size lives in ds64" sentinel. */
export const UINT32_MAX = 0xffffffff;

/** Size of the `ds64` payload with an empty chunk-size table. */
export const DS64_MIN_SIZE = 28;

/** Size of one `ds64` chunk-size table entry. */
export const DS64_TABLE_ENTRY_SIZE = 12;

/** Container FourCCs this project understands. */
export const CONTAINER = Object.freeze({
  RIFF: 'RIFF',
  RF64: 'RF64',
  BW64: 'BW64',
});

/**
 * Practical ceiling on a single in-memory buffer.
 *
 * This is *not* a format limit — it is an environment limit. `ArrayBuffer` allocation is
 * capped well below 4 GiB in every shipping browser (Chromium's default maximum is around
 * 2 GiB and Safari's is lower), and every export path in this project materialises the
 * whole file in memory before handing it to `Blob`. Writing RF64 headers is therefore
 * necessary but not sufficient for a genuinely huge export; see docs/LIMITATIONS.md.
 */
export const MAX_BUFFERED_BYTES = 2 * 1024 * 1024 * 1024 - 64;

/**
 * @typedef {object} ChunkSpec
 * @property {string} id        FourCC, exactly 4 ASCII characters
 * @property {number} size      payload size in bytes, excluding the 8-byte header
 */

/**
 * @typedef {object} RiffPlan
 * @property {'RIFF'|'RF64'|'BW64'} container
 * @property {boolean} sixtyFourBit         true when a `ds64` chunk is present
 * @property {number} riffSizeField         value to write in the top-level size field
 * @property {number} totalBytes            exact size of the finished file
 * @property {bigint} riffSizeActual        `totalBytes - 8`
 * @property {bigint} dataSizeActual        `data` payload size
 * @property {number} ds64Size              `ds64` payload size, 0 when absent
 * @property {Array<{id: string, size: number, padded: number, sizeField: number, offset: number}>} chunks
 */

const isFourCc = (id) => typeof id === 'string' && id.length === 4;

/**
 * Round a chunk payload up to the next even byte — RIFF chunks are word-aligned and an
 * odd payload is followed by one pad byte that is *not* counted in the chunk's own size
 * field but *is* counted in the enclosing form size.
 * @param {number} n
 */
export const padTo16Bit = (n) => n + (n % 2);

/**
 * Plan a RIFF/RF64/BW64 container.
 *
 * @param {object} opts
 * @param {ChunkSpec[]} opts.chunks       chunks in the order they will be written,
 *                                        excluding `ds64` (which this function inserts)
 * @param {number} [opts.sampleCount]     frames per channel, for the ds64 field
 * @param {'auto'|'riff'|'rf64'|'bw64'} [opts.mode] default `'auto'`
 * @param {number} [opts.maxBufferedBytes] default {@link MAX_BUFFERED_BYTES};
 *                                        pass `Infinity` to plan without an env. limit
 * @returns {RiffPlan}
 */
export function planRiffContainer(opts) {
  const mode = opts.mode ?? 'auto';
  if (!['auto', 'riff', 'rf64', 'bw64'].includes(mode)) {
    throw new Error(`planRiffContainer: unknown mode "${mode}"`);
  }

  const specs = opts.chunks ?? [];
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error('planRiffContainer: at least one chunk is required');
  }
  for (const c of specs) {
    if (!isFourCc(c.id)) {
      throw new Error(`planRiffContainer: chunk id must be exactly 4 characters, got "${c.id}"`);
    }
    if (!Number.isFinite(c.size) || c.size < 0 || !Number.isInteger(c.size)) {
      throw new Error(`planRiffContainer: chunk "${c.id}" has a non-integer size ${c.size}`);
    }
  }
  if (specs.some((c) => c.id === 'ds64')) {
    throw new Error('planRiffContainer: ds64 is inserted by the planner, do not pass it in');
  }

  const dataSpecs = specs.filter((c) => c.id === 'data');
  if (dataSpecs.length !== 1) {
    throw new Error(`planRiffContainer: exactly one "data" chunk is required`);
  }
  const dataSize = BigInt(dataSpecs[0].size);

  // Body size with a classic RIFF header: form type (4) + every chunk with its header
  // and word-alignment padding.
  let body = 4n;
  for (const c of specs) body += 8n + BigInt(padTo16Bit(c.size));

  const ds64Needed =
    mode === 'rf64' ||
    mode === 'bw64' ||
    body > BigInt(UINT32_MAX) ||
    dataSize > BigInt(UINT32_MAX);

  if (ds64Needed && mode === 'riff') {
    throw new Error(
      'planRiffContainer: the requested RIFF container cannot describe this file — ' +
        'it needs 64-bit sizes (RF64/BW64). Refusing to write a wrapped 32-bit size field.',
    );
  }

  const ds64Size = ds64Needed ? DS64_MIN_SIZE : 0;
  const riffSizeActual = ds64Needed ? body + 8n + BigInt(ds64Size) : body;
  const totalBytesBig = riffSizeActual + 8n;

  const container = ds64Needed
    ? mode === 'rf64'
      ? CONTAINER.RF64
      : // BS.2088 BW64 is the ADM-facing spelling and the default for promoted files.
        CONTAINER.BW64
    : CONTAINER.RIFF;

  const limit = opts.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  if (Number.isFinite(limit) && totalBytesBig > BigInt(Math.floor(limit))) {
    const gib = Number(totalBytesBig) / 1024 ** 3;
    throw new Error(
      `Export would be ${gib.toFixed(2)} GiB, which cannot be held in a single ArrayBuffer ` +
        `in a browser (practical limit ≈ ${(limit / 1024 ** 3).toFixed(2)} GiB). ` +
        'Export a shorter region, a lower sample rate, or a smaller bit depth. ' +
        `The ${container} container itself supports this size — the browser does not. ` +
        'See docs/LIMITATIONS.md.',
    );
  }

  // Byte offsets, so a writer and a reader can agree without re-deriving them.
  const chunks = [];
  let offset = 12; // 'RIFF' + size + 'WAVE'
  if (ds64Needed) {
    chunks.push({
      id: 'ds64',
      size: ds64Size,
      padded: ds64Size,
      sizeField: ds64Size,
      offset,
    });
    offset += 8 + ds64Size;
  }
  for (const c of specs) {
    const padded = padTo16Bit(c.size);
    chunks.push({
      id: c.id,
      size: c.size,
      padded,
      // In an RF64/BW64 file the `data` chunk advertises the sentinel, never a wrapped
      // value; every other chunk in this project is small enough for a real 32-bit size.
      sizeField: ds64Needed && c.id === 'data' ? UINT32_MAX : c.size,
      offset,
    });
    offset += 8 + padded;
  }

  return {
    container,
    sixtyFourBit: ds64Needed,
    riffSizeField: ds64Needed ? UINT32_MAX : Number(riffSizeActual),
    totalBytes: Number(totalBytesBig),
    riffSizeActual,
    dataSizeActual: dataSize,
    sampleCount: BigInt(Math.max(0, Math.trunc(opts.sampleCount ?? 0))),
    ds64Size,
    chunks,
  };
}

/**
 * Write the container header (`RIFF`/`RF64`/`BW64` + size + `WAVE`) and, when the plan
 * calls for it, the `ds64` chunk.
 *
 * @param {DataView} view
 * @param {RiffPlan} plan
 * @returns {number} the offset immediately after the header (and ds64, if present)
 */
export function writeRiffHeader(view, plan) {
  let o = 0;
  const ascii = (s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i) & 0x7f);
    o += s.length;
  };
  ascii(plan.container);
  view.setUint32(o, plan.riffSizeField >>> 0, true);
  o += 4;
  ascii('WAVE');

  if (plan.sixtyFourBit) {
    ascii('ds64');
    view.setUint32(o, plan.ds64Size, true);
    o += 4;
    view.setBigUint64(o, plan.riffSizeActual, true);
    o += 8;
    view.setBigUint64(o, plan.dataSizeActual, true);
    o += 8;
    view.setBigUint64(o, plan.sampleCount, true);
    o += 8;
    view.setUint32(o, 0, true); // tableLength — no other chunk overflows 32 bits
    o += 4;
  }
  return o;
}

/**
 * Human-readable explanation of a plan, for the delivery manifest and the docs.
 * @param {RiffPlan} plan
 */
export function describeRiffPlan(plan) {
  if (!plan.sixtyFourBit) {
    return `RIFF/WAVE, ${plan.totalBytes} bytes, all size fields 32-bit.`;
  }
  return (
    `${plan.container} (64-bit sizes), ${plan.totalBytes} bytes. ` +
    `Top-level and data size fields carry the 0xFFFFFFFF sentinel; ` +
    `the real sizes are in the 28-byte ds64 chunk ` +
    `(riffSize=${plan.riffSizeActual}, dataSize=${plan.dataSizeActual}, ` +
    `sampleCount=${plan.sampleCount}).`
  );
}
