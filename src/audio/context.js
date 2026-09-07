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
const compressorLatencyCache = new Map(); // sampleRate -> seconds | null (unmeasurable)

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
 * Measure this engine's `DynamicsCompressorNode` look-ahead latency at a sample rate.
 *
 * The compressor delays the signal by a fixed pre-delay, but the value is engine
 * folklore, not spec: Chromium/WebKit/Gecko share a 6 ms kernel constant (measured
 * 6.000 ms in Chromium — finding A-2), while the headless QA engine measures 8.7 / 8.0
 * / 6.7 / 6.0 ms at 44.1 / 48 / 96 / 192 kHz (block-processing latency in the
 * reimplementation, not a look-ahead design). The multiband dry path must match the
 * *running* engine, so this is measured, not assumed. Costs one ~50 ms scratch render
 * per sample rate and is memoised; returns `null` when unmeasurable (no offline
 * context, e.g. unit tests) so callers can fall back to the documented constant.
 *
 * The latency is structural — identical at threshold 0 / ratio 1 and at threshold −24 /
 * ratio 3 — so neutral settings are used and the impulse passes through at unity.
 *
 * @param {number} sampleRate
 * @returns {Promise<number|null>} latency in seconds, or null when unmeasurable
 */
export async function measureCompressorLatency(sampleRate) {
  if (compressorLatencyCache.has(sampleRate)) return compressorLatencyCache.get(sampleRate);
  let latency = null;
  try {
    const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctor) return null;
    const length = Math.max(256, Math.ceil(0.05 * sampleRate));
    const ctx = new Ctor(1, length, sampleRate);
    const at = 64;
    const src = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, length, sampleRate);
    buf.getChannelData(0).fill(0);
    buf.getChannelData(0)[at] = 1;
    src.buffer = buf;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = 0;
    comp.ratio.value = 1;
    comp.knee.value = 12;
    comp.attack.value = 0.015;
    comp.release.value = 0.3;
    src.connect(comp);
    comp.connect(ctx.destination);
    src.start(0);
    const rendered = await ctx.startRendering();
    const ch = rendered.getChannelData(0);
    let peak = 0;
    let index = -1;
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) {
        peak = a;
        index = i;
      }
    }
    // Sanity: the peak must exist, be near unity (neutral settings are transparent),
    // and sit within a plausible look-ahead window.
    if (index >= at && peak > 0.5 && index - at <= Math.ceil(0.05 * sampleRate)) {
      latency = (index - at) / sampleRate;
    }
  } catch {
    latency = null;
  }
  compressorLatencyCache.set(sampleRate, latency);
  return latency;
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
