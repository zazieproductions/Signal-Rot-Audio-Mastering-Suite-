/**
 * SHA-256 for exported deliverables.
 *
 * ── What a checksum here is and is not ───────────────────────────────────────────────
 * These hashes are **file-integrity checks**. They answer exactly one question: "are the
 * bytes I received the bytes that were sent?" That is the question that matters for venue
 * delivery, archival, installation work and collaboration over unreliable transports.
 *
 * They are **not** audio fingerprints. Re-rendering the same master at a different bit
 * depth, re-wrapping the same PCM in a different container, or writing a different
 * `bext` origination timestamp all produce a completely different hash for identical
 * audio. Do not use these to decide whether two files "sound the same"; use them to
 * decide whether a file arrived intact.
 *
 * ── Implementation ───────────────────────────────────────────────────────────────────
 * `crypto.subtle.digest` when available (every modern browser on a secure origin, and
 * Node ≥ 15), with a compact, dependency-free FIPS 180-4 fallback for the insecure-origin
 * case — `crypto.subtle` is undefined on plain `http://`, and a mastering tool served
 * from a LAN address should still be able to hash a delivery.
 */

/** Lower-case hex of a byte array. */
export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * FIPS 180-4 SHA-256, synchronous, over a byte array.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} 32-byte digest
 */
export function sha256Bytes(bytes) {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = bytes.length * 8;
  // Padded length: message + 0x80 + zeros + 8-byte big-endian bit count, to a 64-byte block.
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  // The high word supports messages above 512 MiB, which is within this project's limits.
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32), false);
  dv.setUint32(padded.length - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(block + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i], false);
  return out;
}

/** Hex SHA-256 of a byte array, synchronously. */
export const sha256Hex = (bytes) => toHex(sha256Bytes(bytes));

/**
 * Hex SHA-256 of a Blob, ArrayBuffer, Uint8Array or string.
 *
 * Uses `crypto.subtle` when it exists — it is constant-time-ish, native and far faster on
 * a 500 MB export — and falls back to the pure-JS implementation otherwise.
 *
 * @param {Blob|ArrayBuffer|Uint8Array|string} input
 * @returns {Promise<string>} 64 lower-case hex characters
 */
export async function sha256(input) {
  let buffer;
  if (typeof input === 'string') {
    buffer = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    buffer = input;
  } else if (input instanceof ArrayBuffer) {
    buffer = new Uint8Array(input);
  } else if (input && typeof input.arrayBuffer === 'function') {
    buffer = new Uint8Array(await input.arrayBuffer());
  } else {
    throw new TypeError('sha256: expected a Blob, ArrayBuffer, Uint8Array or string');
  }

  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const view =
        buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength
          ? buffer.buffer
          : buffer.slice().buffer;
      return toHex(new Uint8Array(await subtle.digest('SHA-256', view)));
    } catch {
      // Insecure origin, disabled algorithm, or a hostile policy — fall through.
    }
  }
  return sha256Hex(buffer);
}

/**
 * A `sha256sum`-compatible checksum file.
 *
 * The two-space separator and binary-mode marker are what GNU coreutils, BusyBox and
 * `shasum -a 256 -c` all expect, so a recipient can verify a delivery with a tool they
 * already have:
 *
 *   `sha256sum -c SHA256SUMS.txt`
 *
 * @param {Array<{filename: string, sha256: string}>} entries
 */
export function formatChecksumFile(entries) {
  return entries
    .filter((e) => e && e.sha256 && e.filename)
    .map((e) => `${e.sha256}  ${e.filename}\n`)
    .join('');
}
