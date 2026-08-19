/**
 * Deterministic synthetic test signals.
 *
 * Every DSP test in this suite is built from signals generated here. Nothing depends on
 * a recording, so there is no copyrighted material in the repository and every result is
 * reproducible on any machine.
 */

import { mulberry32, gaussian } from '../../src/audio/dsp/prng.js';

/** @returns {import('../../src/audio/dsp/audio-data.js').AudioData} */
export function make(channels, length, sampleRate = 48000, fill) {
  const chans = [];
  for (let c = 0; c < channels; c++) {
    const a = new Float32Array(length);
    if (fill) for (let i = 0; i < length; i++) a[i] = fill(i, c);
    chans.push(a);
  }
  return { sampleRate, length, channels: chans };
}

/** Sine wave. `amplitude` is peak, not RMS. */
export function sine({
  amplitude = 1,
  frequency = 1000,
  seconds = 5,
  sampleRate = 48000,
  channels = 2,
  phase = 0,
}) {
  const n = Math.round(seconds * sampleRate);
  return make(
    channels,
    n,
    sampleRate,
    (i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate + phase),
  );
}

/**
 * Sine with raised-cosine fades, so the interior peak is exact and the ends do not create
 * a step discontinuity for band-limited interpolation to ring on.
 */
export function fadedSine(opts) {
  const data = sine(opts);
  const fade = Math.min(Math.floor(data.length / 8), Math.round(0.02 * data.sampleRate));
  for (const ch of data.channels) {
    for (let i = 0; i < fade; i++) {
      const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
      ch[i] *= w;
      ch[ch.length - 1 - i] *= w;
    }
  }
  return data;
}

/** Digital silence. */
export function silence({ seconds = 5, sampleRate = 48000, channels = 2 } = {}) {
  return make(channels, Math.round(seconds * sampleRate), sampleRate);
}

/** White Gaussian noise, seeded. */
export function whiteNoise({
  amplitude = 0.1,
  seconds = 5,
  sampleRate = 48000,
  channels = 2,
  seed = 1,
} = {}) {
  const rngs = [];
  for (let c = 0; c < channels; c++) rngs.push(mulberry32(seed + c * 7919));
  return make(
    channels,
    Math.round(seconds * sampleRate),
    sampleRate,
    (_i, c) => amplitude * gaussian(rngs[c]) * 0.33,
  );
}

/**
 * Pink noise via the Voss-McCartney algorithm — a −3 dB/octave spectrum, which is the
 * standard broadband test signal for loudness meters.
 */
export function pinkNoise({
  amplitude = 0.1,
  seconds = 5,
  sampleRate = 48000,
  channels = 2,
  seed = 3,
} = {}) {
  const n = Math.round(seconds * sampleRate);
  const chans = [];
  for (let c = 0; c < channels; c++) {
    const rng = mulberry32(seed + c * 104729);
    const rows = new Float64Array(16);
    let runningSum = 0;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // Update the row whose bit changed in the counter.
      let counter = i;
      for (let b = 0; b < 16; b++) {
        if ((counter & 1) === 0) {
          runningSum -= rows[b];
          rows[b] = rng() * 2 - 1;
          runningSum += rows[b];
          break;
        }
        counter >>= 1;
      }
      out[i] = (runningSum / 16) * amplitude * 3;
    }
    chans.push(out);
  }
  return { sampleRate, length: n, channels: chans };
}

/**
 * Gated tone bursts: alternating tone and silence, for exercising the loudness gate.
 * @param {object} opts
 */
export function toneBursts({
  amplitude = 0.5,
  frequency = 1000,
  onSeconds = 1,
  offSeconds = 1,
  cycles = 5,
  sampleRate = 48000,
  channels = 2,
} = {}) {
  const period = Math.round((onSeconds + offSeconds) * sampleRate);
  const on = Math.round(onSeconds * sampleRate);
  const n = period * cycles;
  return make(channels, n, sampleRate, (i) =>
    i % period < on ? amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate) : 0,
  );
}

/** Stereo material with the right channel polarity-inverted (correlation −1). */
export function antiPhase({ amplitude = 0.5, frequency = 400, seconds = 5, sampleRate = 48000 }) {
  const n = Math.round(seconds * sampleRate);
  return make(
    2,
    n,
    sampleRate,
    (i, c) => (c === 1 ? -1 : 1) * amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate),
  );
}

/** Sharp transients on a quiet bed — the hard case for a limiter. */
export function transientTrain({
  bedAmplitude = 0.2,
  peakAmplitude = 1.6,
  seconds = 4,
  sampleRate = 48000,
  hitsPerSecond = 2,
  channels = 2,
} = {}) {
  const n = Math.round(seconds * sampleRate);
  const data = make(
    channels,
    n,
    sampleRate,
    (i) => bedAmplitude * Math.sin((2 * Math.PI * 80 * i) / sampleRate),
  );
  const spacing = Math.round(sampleRate / hitsPerSecond);
  for (let start = spacing; start < n - 200; start += spacing) {
    for (let k = 0; k < 120; k++) {
      const env = Math.exp(-k / 14);
      const v = peakAmplitude * env * Math.sin((2 * Math.PI * 3200 * k) / sampleRate);
      for (const ch of data.channels) ch[start + k] += v;
    }
  }
  return data;
}

/**
 * Two halves at different levels, `rangeDb` apart. Used to exercise loudness range and
 * the relative gate.
 */
export function twoLevelProgramme({
  rangeDb = 15,
  loudAmplitude = 0.5,
  sampleRate = 48000,
  channels = 2,
  seconds = 24,
} = {}) {
  const n = Math.round(seconds * sampleRate);
  const quiet = loudAmplitude * Math.pow(10, -rangeDb / 20);
  return make(channels, n, sampleRate, (i) => {
    const amp = i < n / 2 ? loudAmplitude : quiet;
    return amp * Math.sin((2 * Math.PI * 500 * i) / sampleRate);
  });
}

/** Extreme dynamic range: 60 dB between the two halves. */
export const extremeDynamics = (opts = {}) => twoLevelProgramme({ rangeDb: 60, ...opts });

/** Duplicate a mono channel to stereo. */
export function toDualMono(data) {
  return {
    sampleRate: data.sampleRate,
    length: data.length,
    channels: [Float32Array.from(data.channels[0]), Float32Array.from(data.channels[0])],
  };
}
