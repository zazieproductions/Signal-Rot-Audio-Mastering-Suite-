/**
 * Deterministic, redistributable mastering fixtures.
 *
 * Every signal here is synthesised. Nothing depends on a recording, so there is no
 * copyrighted material in the repository and every result is reproducible on any machine.
 *
 * These are *sources* — unprocessed programme surrogates a mastering chain is expected to
 * meet. They exist so a later render can be measured against a known input rather than
 * against "whatever the last commit happened to produce".
 */

import { mulberry32, gaussian } from '../../src/audio/dsp/prng.js';
import {
  make,
  sine,
  fadedSine,
  silence,
  pinkNoise,
  whiteNoise,
  antiPhase,
  transientTrain,
  twoLevelProgramme,
  extremeDynamics,
} from '../helpers/signals.js';

/** Canonical lab sample rate. Browser tests additionally probe other rates. */
export const FIXTURE_SAMPLE_RATE = 48000;

/** Default duration long enough for BS.1770 (400 ms) and Tech 3342 LRA (3 s). */
export const FIXTURE_SECONDS = 4;

/**
 * @typedef {import('../../src/audio/dsp/audio-data.js').AudioData} AudioData
 * @typedef {{id: string, title: string, description: string, tags: string[], generate: (opts?: object) => AudioData}} FixtureSpec
 */

function fadeInPlace(data, fadeSeconds = 0.01) {
  const fade = Math.min(Math.floor(data.length / 8), Math.round(fadeSeconds * data.sampleRate));
  for (const ch of data.channels) {
    for (let i = 0; i < fade; i++) {
      const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
      ch[i] *= w;
      ch[ch.length - 1 - i] *= w;
    }
  }
  return data;
}

/** Unit impulse at frame `at`, stereo by default. */
export function impulse({
  at = 64,
  amplitude = 1,
  seconds = 0.5,
  sampleRate = FIXTURE_SAMPLE_RATE,
  channels = 2,
} = {}) {
  const n = Math.round(seconds * sampleRate);
  const data = make(channels, n, sampleRate);
  const idx = Math.max(0, Math.min(n - 1, at));
  for (const ch of data.channels) ch[idx] = amplitude;
  return data;
}

/**
 * Logarithmic sine sweep from `f0` to `f1`.
 * The instantaneous phase is `2π · f0 · T / ln(k) · (k^{t/T} − 1)` with `k = f1/f0`.
 */
export function sineSweep({
  f0 = 20,
  f1 = 20000,
  amplitude = 0.5,
  seconds = 2,
  sampleRate = FIXTURE_SAMPLE_RATE,
  channels = 2,
} = {}) {
  const n = Math.round(seconds * sampleRate);
  const k = f1 / f0;
  const lnK = Math.log(k);
  const T = seconds;
  const data = make(channels, n, sampleRate, (i) => {
    const t = i / sampleRate;
    const phase = ((2 * Math.PI * f0 * T) / lnK) * (Math.pow(k, t / T) - 1);
    return amplitude * Math.sin(phase);
  });
  return fadeInPlace(data, 0.01);
}

/** Several inharmonic sines — a dense, deterministic "chord" for spectrum tests. */
export function multitone({
  frequencies = [100, 250, 630, 1000, 2500, 6300, 10000],
  amplitude = 0.12,
  seconds = FIXTURE_SECONDS,
  sampleRate = FIXTURE_SAMPLE_RATE,
  channels = 2,
} = {}) {
  const n = Math.round(seconds * sampleRate);
  const data = make(channels, n, sampleRate, (i) => {
    let s = 0;
    for (let k = 0; k < frequencies.length; k++) {
      s += amplitude * Math.sin((2 * Math.PI * frequencies[k] * i) / sampleRate);
    }
    return s;
  });
  return fadeInPlace(data, 0.02);
}

/** Pure bass tone at a named frequency. */
export function bassTone({
  frequency = 60,
  amplitude = 0.5,
  seconds = FIXTURE_SECONDS,
  sampleRate = FIXTURE_SAMPLE_RATE,
  channels = 2,
} = {}) {
  return fadedSine({ amplitude, frequency, seconds, sampleRate, channels });
}

/** Hard-clipped sine — a source that already has no headroom. */
export function clippedSource({
  amplitude = 1.4,
  clip = 0.89,
  frequency = 220,
  seconds = FIXTURE_SECONDS,
  sampleRate = FIXTURE_SAMPLE_RATE,
  channels = 2,
} = {}) {
  const n = Math.round(seconds * sampleRate);
  const data = make(channels, n, sampleRate, (i) => {
    const x = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
    return x > clip ? clip : x < -clip ? -clip : x;
  });
  return fadeInPlace(data, 0.005);
}

/** Dual-mono correlated stereo (r = +1). */
export function correlatedStereo(opts = {}) {
  return sine({
    amplitude: 0.4,
    frequency: 440,
    seconds: FIXTURE_SECONDS,
    sampleRate: FIXTURE_SAMPLE_RATE,
    channels: 2,
    ...opts,
  });
}

/** Hard-panned: energy only on the left (or right) channel. */
export function hardPanned({
  side = 'left',
  amplitude = 0.5,
  frequency = 1000,
  seconds = FIXTURE_SECONDS,
  sampleRate = FIXTURE_SAMPLE_RATE,
} = {}) {
  const n = Math.round(seconds * sampleRate);
  const data = make(2, n, sampleRate, (i, c) => {
    const want = side === 'left' ? 0 : 1;
    if (c !== want) return 0;
    return amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  });
  return fadeInPlace(data, 0.02);
}

/**
 * Wide, diffuse synthetic ambience: independent pink-ish beds plus a slow decorrelated
 * modulation so a correlation meter sits near zero without being anti-phase.
 */
export function wideDiffuseAmbience({
  amplitude = 0.18,
  seconds = FIXTURE_SECONDS,
  sampleRate = FIXTURE_SAMPLE_RATE,
  seed = 91,
} = {}) {
  const n = Math.round(seconds * sampleRate);
  const leftRng = mulberry32(seed);
  const rightRng = mulberry32(seed + 104729);
  let lY = 0;
  let rY = 0;
  const data = make(2, n, sampleRate, (i, c) => {
    const rng = c === 0 ? leftRng : rightRng;
    const leak = c === 0 ? (lY = lY * 0.97 + (rng() * 2 - 1)) : (rY = rY * 0.97 + (rng() * 2 - 1));
    const wow = 1 + 0.04 * Math.sin((2 * Math.PI * (0.37 + c * 0.11) * i) / sampleRate);
    return amplitude * leak * 0.35 * wow;
  });
  return fadeInPlace(data, 0.03);
}

/** Bright synthetic: high-frequency cluster plus a little noise. */
export function brightSynthetic({
  seconds = FIXTURE_SECONDS,
  sampleRate = FIXTURE_SAMPLE_RATE,
  seed = 17,
} = {}) {
  const rng = mulberry32(seed);
  const highs = [4200, 6300, 8800, 12500, 16000];
  const n = Math.round(seconds * sampleRate);
  const data = make(2, n, sampleRate, (i, c) => {
    let s = 0.08 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
    for (let k = 0; k < highs.length; k++) {
      s += 0.11 * Math.sin((2 * Math.PI * highs[k] * i) / sampleRate + c * 0.3);
    }
    s += 0.04 * gaussian(rng);
    return s;
  });
  return fadeInPlace(data, 0.015);
}

/**
 * Dense compressed-programme surrogate: a busy bed of tones + noise, already low-crest,
 * as if a limiter had already been at work. Used to test that a *neutral* chain does not
 * crush it further, and that a creative chain's extra density is measurable.
 */
export function denseCompressedSurrogate({
  seconds = FIXTURE_SECONDS,
  sampleRate = FIXTURE_SAMPLE_RATE,
  seed = 42,
} = {}) {
  const rng = mulberry32(seed);
  const n = Math.round(seconds * sampleRate);
  const data = make(2, n, sampleRate, (i, c) => {
    const t = i / sampleRate;
    let s =
      0.22 * Math.tanh(2.4 * Math.sin(2 * Math.PI * 55 * t)) +
      0.16 * Math.sin(2 * Math.PI * 110 * t + c * 0.2) +
      0.12 * Math.sin(2 * Math.PI * 330 * t) +
      0.09 * Math.sin(2 * Math.PI * 880 * t) +
      0.07 * Math.sin(2 * Math.PI * 1760 * t) +
      0.05 * Math.sin(2 * Math.PI * 3520 * t) +
      0.04 * gaussian(rng);
    // Soft clip to keep crest factor in the "already mastered" region (~8 dB).
    s = Math.tanh(s * 1.6);
    return s * 0.55;
  });
  return fadeInPlace(data, 0.02);
}

/** Highly dynamic programme: loud/quiet halves 18 dB apart, plus occasional transients. */
export function highlyDynamicSurrogate({ seconds = 8, sampleRate = FIXTURE_SAMPLE_RATE } = {}) {
  const data = twoLevelProgramme({
    rangeDb: 18,
    loudAmplitude: 0.55,
    sampleRate,
    channels: 2,
    seconds,
  });
  const spacing = Math.round(sampleRate * 1.7);
  for (let start = Math.round(0.4 * sampleRate); start < data.length - 200; start += spacing) {
    for (let k = 0; k < 80; k++) {
      const env = Math.exp(-k / 12);
      const v = 0.85 * env * Math.sin((2 * Math.PI * 2800 * k) / sampleRate);
      for (const ch of data.channels) ch[start + k] += v;
    }
  }
  return fadeInPlace(data, 0.02);
}

/**
 * Catalogue of every fixture the lab ships. `generate()` is a pure function of the
 * options; the same id always produces the same samples.
 *
 * @type {FixtureSpec[]}
 */
export const FIXTURE_CATALOG = [
  {
    id: 'impulse',
    title: 'Unit impulse',
    description: 'A single full-scale sample. Latency, alignment and impulse-response tests.',
    tags: ['impulse', 'alignment', 'latency'],
    generate: (opts) => impulse(opts),
  },
  {
    id: 'sine-sweep',
    title: 'Logarithmic sine sweep',
    description: '20 Hz–20 kHz chirp. Crossover reconstruction, comb detection, spectral tilt.',
    tags: ['sweep', 'spectrum', 'crossover'],
    generate: (opts) => sineSweep(opts),
  },
  {
    id: 'multitone',
    title: 'Multitone cluster',
    description: 'Seven inharmonic sines. Harmonic analysis and band-energy summaries.',
    tags: ['spectrum', 'tone'],
    generate: (opts) => multitone(opts),
  },
  {
    id: 'bass-40',
    title: '40 Hz bass',
    description: 'Sub-bass sine. LFE routing, limiter LF release, rumble region.',
    tags: ['bass', 'lfe'],
    generate: (opts) => bassTone({ frequency: 40, ...opts }),
  },
  {
    id: 'bass-50',
    title: '50 Hz bass',
    description: 'Mains-adjacent sub sine.',
    tags: ['bass', 'lfe'],
    generate: (opts) => bassTone({ frequency: 50, ...opts }),
  },
  {
    id: 'bass-60',
    title: '60 Hz bass',
    description: 'Mains-adjacent sub sine (60 Hz regions).',
    tags: ['bass', 'lfe'],
    generate: (opts) => bassTone({ frequency: 60, ...opts }),
  },
  {
    id: 'bass-80',
    title: '80 Hz bass',
    description: 'Upper-sub sine. Crossover / bass-mono boundary.',
    tags: ['bass'],
    generate: (opts) => bassTone({ frequency: 80, ...opts }),
  },
  {
    id: 'bass-100',
    title: '100 Hz bass',
    description: 'Kick-fundamental region.',
    tags: ['bass'],
    generate: (opts) => bassTone({ frequency: 100, ...opts }),
  },
  {
    id: 'transient-train',
    title: 'Transient train',
    description: 'Sharp hits on a quiet bed. The hard case for a limiter and a compressor.',
    tags: ['dynamics', 'limiter', 'crest'],
    generate: (opts) =>
      transientTrain({
        seconds: FIXTURE_SECONDS,
        sampleRate: FIXTURE_SAMPLE_RATE,
        ...opts,
      }),
  },
  {
    id: 'clipped-source',
    title: 'Clipped source',
    description: 'Already-squared sine. Tests that the chain does not invent more clipping.',
    tags: ['clip', 'headroom'],
    generate: (opts) => clippedSource(opts),
  },
  {
    id: 'pink-noise',
    title: 'Pink noise',
    description: 'Voss-McCartney −3 dB/octave. Standard broadband loudness / spectrum signal.',
    tags: ['loudness', 'spectrum', 'broadband'],
    generate: (opts) =>
      pinkNoise({
        amplitude: 0.15,
        seconds: FIXTURE_SECONDS,
        sampleRate: FIXTURE_SAMPLE_RATE,
        seed: 3,
        ...opts,
      }),
  },
  {
    id: 'correlated-stereo',
    title: 'Correlated stereo',
    description: 'Dual-mono 440 Hz sine. Correlation +1; mono fold-down is free.',
    tags: ['stereo', 'correlation', 'mono'],
    generate: (opts) => correlatedStereo(opts),
  },
  {
    id: 'anti-correlated-stereo',
    title: 'Anti-correlated stereo',
    description: 'Polarity-inverted pair. Correlation −1; mono fold-down cancels.',
    tags: ['stereo', 'correlation', 'mono'],
    generate: (opts) =>
      antiPhase({
        amplitude: 0.4,
        frequency: 400,
        seconds: FIXTURE_SECONDS,
        sampleRate: FIXTURE_SAMPLE_RATE,
        ...opts,
      }),
  },
  {
    id: 'hard-left',
    title: 'Hard left',
    description: 'Energy only on channel 0. Left/right routing and M/S energy.',
    tags: ['stereo', 'routing'],
    generate: (opts) => hardPanned({ side: 'left', ...opts }),
  },
  {
    id: 'hard-right',
    title: 'Hard right',
    description: 'Energy only on channel 1.',
    tags: ['stereo', 'routing'],
    generate: (opts) => hardPanned({ side: 'right', ...opts }),
  },
  {
    id: 'wide-diffuse',
    title: 'Wide diffuse ambience',
    description: 'Decorrelated synthetic bed. Correlation near 0 without being anti-phase.',
    tags: ['stereo', 'ambience', 'immersive'],
    generate: (opts) => wideDiffuseAmbience(opts),
  },
  {
    id: 'bright-synthetic',
    title: 'Bright synthetic',
    description: 'HF-rich cluster. Saturation aliasing and air-band spectral shift.',
    tags: ['spectrum', 'saturation', 'aliasing'],
    generate: (opts) => brightSynthetic(opts),
  },
  {
    id: 'dense-compressed',
    title: 'Dense compressed programme surrogate',
    description: 'Already-dense, low-crest synthetic mix. A brickwalled-record stand-in.',
    tags: ['dynamics', 'crest', 'programme'],
    generate: (opts) => denseCompressedSurrogate(opts),
  },
  {
    id: 'highly-dynamic',
    title: 'Highly dynamic programme surrogate',
    description: '18 dB two-level programme plus transients. Loudness-range and gating.',
    tags: ['dynamics', 'loudness', 'programme'],
    generate: (opts) => highlyDynamicSurrogate(opts),
  },
  {
    id: 'silence',
    title: 'Digital silence',
    description: 'All zeros. NaN, gate, and DC sanity.',
    tags: ['silence', 'nan'],
    generate: (opts) =>
      silence({ seconds: FIXTURE_SECONDS, sampleRate: FIXTURE_SAMPLE_RATE, ...opts }),
  },
  {
    id: 'white-noise',
    title: 'White Gaussian noise',
    description: 'Seeded white noise. Crest-factor and decorrelation reference.',
    tags: ['broadband', 'crest'],
    generate: (opts) =>
      whiteNoise({
        amplitude: 0.12,
        seconds: FIXTURE_SECONDS,
        sampleRate: FIXTURE_SAMPLE_RATE,
        seed: 1,
        ...opts,
      }),
  },
  {
    id: 'extreme-dynamics',
    title: 'Extreme 60 dB dynamics',
    description: 'Two halves 60 dB apart. The case where correct gating looks like a bug.',
    tags: ['dynamics', 'loudness'],
    generate: (opts) => extremeDynamics({ seconds: 8, sampleRate: FIXTURE_SAMPLE_RATE, ...opts }),
  },
];

const byId = new Map(FIXTURE_CATALOG.map((f) => [f.id, f]));

/** @param {string} id */
export function getFixture(id) {
  return byId.get(id) ?? null;
}

/** Generate every fixture at the canonical rate. */
export function generateAll(opts = {}) {
  return FIXTURE_CATALOG.map((spec) => ({
    id: spec.id,
    title: spec.title,
    description: spec.description,
    tags: spec.tags.slice(),
    data: spec.generate(opts),
  }));
}

export {
  sine,
  fadedSine,
  silence,
  pinkNoise,
  whiteNoise,
  antiPhase,
  transientTrain,
  twoLevelProgramme,
  extremeDynamics,
  make,
};
