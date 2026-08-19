/**
 * MP3 encoding.
 *
 * ── Dependency ───────────────────────────────────────────────────────────────────────
 * Uses `@breezystack/lamejs`, a pinned, locally installed ES-module fork of lamejs. The
 * previous implementation pulled `lame.min.js` from a CDN at page load, which meant:
 *   · MP3 export silently failed offline;
 *   · the page could not run under a strict `script-src 'self'` Content Security Policy;
 *   · a third party could change the bytes being executed in the user's browser.
 * The encoder is now bundled and loaded through a **dynamic import**, so it is code-split
 * into its own chunk and only fetched when someone actually exports an MP3 — the WAV path
 * pays nothing for it.
 *
 * ── Quality ──────────────────────────────────────────────────────────────────────────
 * LAME is a good encoder, but this is CBR 320 kbit/s through a JavaScript port. It is
 * offered as a convenience for references and revisions, not as a delivery format. MP3 is
 * also a lossy codec whose decoder output can exceed the encoder input by ~1 dB, which is
 * exactly why the default true-peak ceiling is −1.0 dBTP.
 */

/** @type {Promise<any>|null} */
let encoderPromise = null;

/** Load the encoder module once, on demand. */
async function loadEncoder() {
  if (!encoderPromise) {
    encoderPromise = import('@breezystack/lamejs').then((m) => m.default ?? m);
  }
  return encoderPromise;
}

/** True when the MP3 encoder chunk has already been fetched. */
export const isEncoderLoaded = () => encoderPromise !== null;

/**
 * Encode to MP3.
 *
 * lamejs is mono/stereo only. Multichannel input is rejected rather than silently
 * folded down.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data
 * @param {object} [opts]
 * @param {number} [opts.bitrateKbps] default 320
 * @param {(fraction:number)=>void} [opts.onProgress]
 * @returns {Promise<Blob>}
 */
export async function encodeMp3(data, opts = {}) {
  const channels = data.channels.length;
  if (channels > 2) {
    throw new Error(
      `MP3 export supports mono and stereo only (got ${channels} channels). ` +
        'Use multichannel WAV for immersive deliveries.',
    );
  }

  const lamejs = await loadEncoder();
  const bitrate = opts.bitrateKbps ?? 320;
  const encoder = new lamejs.Mp3Encoder(channels, data.sampleRate, bitrate);

  const n = data.length;
  const L = data.channels[0];
  const R = channels > 1 ? data.channels[1] : null;

  // lamejs wants Int16 PCM. Clamp before scaling so +1.0 does not wrap.
  const toInt16 = (src, out, from, count) => {
    for (let i = 0; i < count; i++) {
      const s = src[from + i];
      const v = Math.round((s < -1 ? -1 : s > 1 ? 1 : s) * 32768);
      out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
  };

  const BLOCK = 1152;
  const li = new Int16Array(BLOCK);
  const ri = R ? new Int16Array(BLOCK) : null;
  /** @type {Int8Array[]} */
  const chunks = [];

  for (let i = 0; i < n; i += BLOCK) {
    const count = Math.min(BLOCK, n - i);
    toInt16(L, li, i, count);
    if (R && ri) toInt16(R, ri, i, count);
    const view = count === BLOCK ? li : li.subarray(0, count);
    const rview = ri ? (count === BLOCK ? ri : ri.subarray(0, count)) : null;
    const out = rview ? encoder.encodeBuffer(view, rview) : encoder.encodeBuffer(view);
    if (out.length) chunks.push(out);
    if (opts.onProgress && (i / BLOCK) % 256 === 0) opts.onProgress(i / n);
  }

  const tail = encoder.flush();
  if (tail.length) chunks.push(tail);
  if (opts.onProgress) opts.onProgress(1);

  return new Blob(chunks, { type: 'audio/mpeg' });
}
