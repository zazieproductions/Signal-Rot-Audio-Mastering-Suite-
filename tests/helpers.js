/**
 * Test helpers: minimal AudioBuffer stand-in and signal generators.
 *
 * The DSP modules are deliberately written against the small surface
 * (`sampleRate`, `length`, `numberOfChannels`, `getChannelData`) that an
 * AudioBuffer exposes, so they can be exercised in Node without a browser.
 */

export class MockAudioBuffer {
  /**
   * @param {number} numberOfChannels
   * @param {number} length
   * @param {number} sampleRate
   */
  constructor(numberOfChannels, length, sampleRate) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(i) {
    return this._data[i];
  }

  static fromChannels(channels, sampleRate) {
    const buf = new MockAudioBuffer(channels.length, channels[0].length, sampleRate);
    channels.forEach((ch, i) => buf._data[i].set(ch));
    return buf;
  }
}

/**
 * Generate a sine tone.
 * @param {number} freq
 * @param {number} seconds
 * @param {number} sampleRate
 * @param {number} amplitude linear peak amplitude
 * @param {number} [phase] radians
 */
export function sine(freq, seconds, sampleRate, amplitude = 1, phase = 0) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const w = (2 * Math.PI * freq) / sampleRate;
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin(w * i + phase);
  return out;
}

/** A stereo buffer with the same tone in both channels. */
export function stereoSine(freq, seconds, sampleRate, amplitude = 1) {
  const ch = sine(freq, seconds, sampleRate, amplitude);
  return MockAudioBuffer.fromChannels([ch, Float32Array.from(ch)], sampleRate);
}

/** Convert a dBFS value to the linear amplitude of a sine's peak. */
export const dbfsAmplitude = (db) => Math.pow(10, db / 20);

/** Concatenate Float32Arrays. */
export function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

/** Deterministic pseudo-random generator so noise-based tests are stable. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** White noise in [-amplitude, amplitude]. */
export function noise(seconds, sampleRate, amplitude = 1, seed = 1) {
  const rand = mulberry32(seed);
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rand() * 2 - 1) * amplitude;
  return out;
}

/**
 * Apply a raised-cosine fade to both ends of a signal.
 *
 * True-peak measurement zero-pads outside the buffer, so a signal that starts
 * or ends abruptly at a non-zero value contains a genuine step discontinuity
 * whose reconstruction overshoot dominates the reading. Fading isolates the
 * steady-state behaviour under test.
 */
export function fade(x, fadeSamples = 2000) {
  const y = Float32Array.from(x);
  const f = Math.min(fadeSamples, Math.floor(y.length / 2));
  for (let i = 0; i < f; i++) {
    const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / f);
    y[i] *= w;
    y[y.length - 1 - i] *= w;
  }
  return y;
}
