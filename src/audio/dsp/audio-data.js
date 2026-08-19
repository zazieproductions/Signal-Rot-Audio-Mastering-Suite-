/**
 * `AudioData` — the plain, environment-independent audio container used by every pure DSP
 * routine in this codebase.
 *
 * Why not just pass `AudioBuffer` around? Because `AudioBuffer` only exists inside a
 * browser with a live `BaseAudioContext`. Every numeric routine here — loudness, true
 * peak, limiter, transient shaper, encoders, dither — operates on `AudioData` instead, so
 * the whole DSP layer is testable in Node with zero mocking. The two adapters below are
 * the only places that touch the Web Audio types.
 *
 * @typedef {object} AudioData
 * @property {number} sampleRate
 * @property {number} length      frames per channel
 * @property {Float32Array[]} channels  non-interleaved, `channels.length` = channel count
 */

/**
 * @param {number} channels
 * @param {number} length
 * @param {number} sampleRate
 * @returns {AudioData}
 */
export function createAudioData(channels, length, sampleRate) {
  const chans = [];
  for (let c = 0; c < channels; c++) chans.push(new Float32Array(length));
  return { sampleRate, length, channels: chans };
}

/**
 * Zero-copy view over an `AudioBuffer`. `getChannelData` returns the live backing store,
 * so writes through the returned `AudioData` mutate the `AudioBuffer` — which is exactly
 * what the render pipeline wants (no duplicated 400 MB arrays).
 *
 * @param {AudioBuffer} buffer
 * @returns {AudioData}
 */
export function fromAudioBuffer(buffer) {
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return { sampleRate: buffer.sampleRate, length: buffer.length, channels };
}

/**
 * Copy an `AudioData` into a fresh `AudioBuffer` owned by `ctx`.
 * @param {AudioData} data
 * @param {BaseAudioContext} ctx
 */
export function toAudioBuffer(data, ctx) {
  const buf = ctx.createBuffer(data.channels.length, data.length, data.sampleRate);
  for (let c = 0; c < data.channels.length; c++) buf.copyToChannel(data.channels[c], c);
  return buf;
}

/** Deep copy — use when a routine must not mutate its input. */
export function cloneAudioData(data) {
  return {
    sampleRate: data.sampleRate,
    length: data.length,
    channels: data.channels.map((c) => Float32Array.from(c)),
  };
}

/** Duration in seconds. */
export const durationOf = (data) => data.length / data.sampleRate;

/** True when every sample in every channel is exactly zero. */
export function isSilent(data) {
  for (const ch of data.channels) {
    for (let i = 0; i < ch.length; i++) if (ch[i] !== 0) return false;
  }
  return true;
}

/** Highest absolute sample value across all channels (sample peak, not true peak). */
export function samplePeak(data) {
  let peak = 0;
  for (const ch of data.channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/** Multiply every sample by `gain`, in place. */
export function applyGain(data, gain) {
  if (gain === 1) return data;
  for (const ch of data.channels) {
    for (let i = 0; i < ch.length; i++) ch[i] *= gain;
  }
  return data;
}
