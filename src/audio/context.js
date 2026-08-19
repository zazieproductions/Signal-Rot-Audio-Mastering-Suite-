/**
 * Audio context creation and capability probing.
 *
 * ── Browser reality ──────────────────────────────────────────────────────────────────
 *  · `webkitAudioContext` / `webkitOfflineAudioContext` still need a fallback for older
 *    WebKit builds.
 *  · Safari's `OfflineAudioContext` historically rejects sample rates outside a limited
 *    range; the 192 kHz export path can throw there. `probeOfflineSampleRate` tests a
 *    one-frame context before committing to a long render, so the user gets a clear
 *    message instead of an exception halfway through.
 *  · `AudioContext` must be created — and resumed — from a user gesture, or autoplay
 *    policy leaves it suspended and everything is silent with no error.
 */

/** @type {AudioContext|null} */
let sharedContext = null;

/** Construct (or return) the shared live `AudioContext`. */
export function getAudioContext() {
  if (sharedContext) return sharedContext;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) {
    throw new Error(
      'Web Audio is not available in this browser. Signal Rot needs Chrome 111+, ' +
        'Firefox 128+, Safari 16.4+ or Edge 111+.',
    );
  }
  sharedContext = new Ctor();
  return sharedContext;
}

/** True when a context already exists — avoids creating one outside a user gesture. */
export const hasAudioContext = () => sharedContext !== null;

/**
 * Resume the shared context. Safe to call repeatedly; must be called from a user gesture
 * the first time.
 */
export async function resumeAudioContext() {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch (error) {
      console.warn('[signal-rot] AudioContext.resume failed:', error);
    }
  }
  return ctx;
}

/**
 * Create an `OfflineAudioContext`.
 *
 * @param {number} channels
 * @param {number} length frames
 * @param {number} sampleRate
 */
export function createOfflineContext(channels, length, sampleRate) {
  const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctor) throw new Error('OfflineAudioContext is not available in this browser.');
  return new Ctor(channels, Math.max(1, Math.ceil(length)), sampleRate);
}

const probeCache = new Map();

/**
 * Test whether this browser will accept a given offline sample rate.
 * Costs one one-frame context and is memoised.
 *
 * @param {number} sampleRate
 * @returns {boolean}
 */
export function probeOfflineSampleRate(sampleRate) {
  if (probeCache.has(sampleRate)) return probeCache.get(sampleRate);
  let ok = false;
  try {
    createOfflineContext(1, 1, sampleRate);
    ok = true;
  } catch {
    ok = false;
  }
  probeCache.set(sampleRate, ok);
  return ok;
}

/**
 * Report what this browser can actually do, for the compatibility panel and for
 * `docs/BROWSER-COMPATIBILITY.md` to be checked against rather than guessed at.
 */
export function probeCapabilities() {
  const caps = {
    audioContext: !!(window.AudioContext || window.webkitAudioContext),
    offlineAudioContext: !!(window.OfflineAudioContext || window.webkitOfflineAudioContext),
    audioWorklet: false,
    webWorker: typeof Worker !== 'undefined',
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    sampleRates: /** @type {Record<number, boolean>} */ ({}),
    decoderHints: [],
  };

  try {
    const ctx = sharedContext;
    caps.audioWorklet = !!(ctx && ctx.audioWorklet);
  } catch {
    caps.audioWorklet = false;
  }

  for (const rate of [44100, 48000, 88200, 96000, 192000]) {
    caps.sampleRates[rate] = probeOfflineSampleRate(rate);
  }

  // `canPlayType` is the only decode-capability signal the platform gives us, and it is
  // about *playback*, not `decodeAudioData`. It is a hint, which is what it is labelled.
  if (typeof document !== 'undefined') {
    const a = document.createElement('audio');
    for (const [label, mime] of [
      ['WAV', 'audio/wav'],
      ['MP3', 'audio/mpeg'],
      ['FLAC', 'audio/flac'],
      ['AAC / M4A', 'audio/mp4; codecs="mp4a.40.2"'],
      ['Ogg Vorbis', 'audio/ogg; codecs="vorbis"'],
      ['Opus', 'audio/ogg; codecs="opus"'],
      ['AIFF', 'audio/aiff'],
    ]) {
      const support = a.canPlayType(mime);
      caps.decoderHints.push({ label, mime, support: support || 'no' });
    }
  }

  return caps;
}

/** Release the shared context. Used by tests and by the teardown path. */
export async function closeAudioContext() {
  if (!sharedContext) return;
  try {
    await sharedContext.close();
  } catch {
    /* already closed */
  }
  sharedContext = null;
}
