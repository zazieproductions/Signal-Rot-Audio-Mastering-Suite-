/**
 * True-peak (inter-sample peak) measurement.
 *
 * ── The problem ──────────────────────────────────────────────────────────────────────
 * A digital sample stream is a set of points on a band-limited waveform. The waveform
 * between the samples can, and routinely does, exceed the largest sample. A DAC, a
 * sample-rate converter or a lossy codec reconstructs that waveform and clips it. The
 * canonical demonstration is a sine at `fs/4` sampled at ±45°: every sample sits at
 * 0.7071 (−3.01 dBFS) while the waveform reaches 1.0 (0 dBTP).
 *
 * ── The method ───────────────────────────────────────────────────────────────────────
 * BS.1770-4 Annex 2 requires oversampling to ≥192 kHz through a low-pass whose stop-band
 * begins at the original Nyquist, then taking the peak of the oversampled signal. It
 * tabulates one specific 48-tap, 4-phase FIR for the 48 kHz case.
 *
 * This module implements a **windowed-sinc polyphase interpolator**, not the tabulated
 * Annex 2 filter. That is a deliberate, documented deviation:
 *   · It generalises to any oversampling factor and any source rate, which the tabulated
 *     48 kHz filter does not.
 *   · Its measured accuracy is good enough that the deviation is not the limiting factor
 *     (figures below, reproduced by `tests/dsp/true-peak.test.js`).
 *
 * Measured against analytically known answers at 48 kHz, 4× oversampling
 * (24 taps per phase, Kaiser β = 8.6), reproduced by `tests/dsp/true-peak.test.js`:
 *
 * | Test signal                                     | this module | cubic (previous) |
 * | ----------------------------------------------- | ----------- | ---------------- |
 * | 0 dBTP sine at fs/4, sampled at ±45°             | **~−0.17 dB** | **−1.072 dB**  |
 * | 0 dBTP sines, 1–23 kHz × 12 phases, worst case   | ~0 dB       | −1.072 dB        |
 * | DC (interior)                                    | exact       | exact            |
 *
 * The fs/4 row is the one that matters: it is the case a limiter must not miss, and the
 * cubic interpolator it replaces missed it by more than a decibel. A short windowed sinc
 * still under-reads that particular series (1/n tails). The limiter therefore:
 *   · detects with this FIR (fast, per-sample envelope);
 *   · works to a small safety allowance below the requested ceiling;
 *   · verifies with `truePeakChannelExact` (FFT interpolation) on short buffers or a
 *     longer FIR on long ones — an independent meter, not the detector grading itself
 *     (issue #21 / SON-2);
 *   · applies a static trim if the independent meter still sees an over, rather than
 *     crushing the limiter harder.
 *
 * Samples outside the buffer are treated as silence, so a hard-edged block (e.g. constant
 * DC with no fade) reads the genuine reconstruction overshoot at its own discontinuity.
 * That is correct behaviour, not an artefact.
 *
 * **This is not a certified true-peak meter.** It has not been validated against the
 * EBU Tech 3341 compliance set and no compliance claim is made.
 */

import { gainToDb } from '../dsp/math.js';
import { fftRadix2, ifftRadix2 } from './fft.js';

/** Detection FIR: 24 taps/phase. Longer than the original 12, still cheap per sample. */
export const TRUE_PEAK_DETECT_TAPS = 24;
/** Independent verify FIR, used when the buffer is too long for an FFT interpolator. */
export const TRUE_PEAK_VERIFY_TAPS = 48;
/** FFT interpolator is used for verification when `length · factor` stays under this.
 *  ~5.5 s of 48 kHz at 4×; longer files fall back to the 48-tap FIR so export verify
 *  stays bounded. Short worst-case fixtures (fs/4, HF bursts) still get the exact meter. */
const EXACT_MAX_INTERPOLATED = 1 << 20; // 1,048,576

/** Modified Bessel function of the first kind, order 0 — for the Kaiser window. */
function besselI0(x) {
  let sum = 1;
  let term = 1;
  const half = x / 2;
  for (let k = 1; k < 40; k++) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

const filterCache = new Map();

/**
 * Build a polyphase interpolation filter bank.
 *
 * The prototype is a sinc low-pass with cutoff at `1/(2·factor)` of the oversampled rate
 * (i.e. the original Nyquist), windowed with a Kaiser window. It is decomposed into
 * `factor` phases of `tapsPerPhase` taps each; phase 0 is the identity delay, so the
 * original samples are reproduced exactly and only the intermediate points are computed.
 *
 * @param {number} factor oversampling factor (2, 4, 8)
 * @param {number} tapsPerPhase taps per polyphase branch
 * @param {number} beta Kaiser window shape parameter
 * @returns {Float64Array[]} `factor` branches of `tapsPerPhase` coefficients
 */
export function buildPolyphaseFilter(factor = 4, tapsPerPhase = TRUE_PEAK_DETECT_TAPS, beta = 8.6) {
  const key = `${factor}/${tapsPerPhase}/${beta}`;
  const cached = filterCache.get(key);
  if (cached) return cached;

  const N = factor * tapsPerPhase; // total prototype length
  const proto = new Float64Array(N);
  const centre = (N - 1) / 2;
  const i0beta = besselI0(beta);

  for (let n = 0; n < N; n++) {
    const t = (n - centre) / factor; // in original-sample units
    // Normalised sinc at cutoff = original Nyquist.
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    // Kaiser window.
    const r = (2 * n) / (N - 1) - 1;
    const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0beta;
    proto[n] = sinc * w;
  }

  // Normalise each phase to unity DC gain so a constant input is reproduced exactly.
  const phases = [];
  for (let p = 0; p < factor; p++) {
    const branch = new Float64Array(tapsPerPhase);
    let sum = 0;
    for (let k = 0; k < tapsPerPhase; k++) {
      branch[k] = proto[k * factor + p];
      sum += branch[k];
    }
    if (sum !== 0) for (let k = 0; k < tapsPerPhase; k++) branch[k] /= sum;
    phases.push(branch);
  }

  filterCache.set(key, phases);
  return phases;
}

/**
 * Oversampling factor for a given source rate, targeting ≥176.4 kHz effective rate.
 * 44.1/48 kHz → 4×; 88.2/96 kHz → 2×; 176.4 kHz and above → 1× (already sufficient).
 */
export function oversamplingFactorFor(sampleRate) {
  if (sampleRate < 88200) return 4;
  if (sampleRate < 176400) return 2;
  return 1;
}

/**
 * True peak of a single channel, as a linear amplitude.
 *
 * @param {Float32Array} channel
 * @param {number} sampleRate
 * @param {number} [factor] override the oversampling factor
 * @param {number} [tapsPerPhase] override the FIR length (default {@link TRUE_PEAK_DETECT_TAPS})
 * @returns {number} linear amplitude (≥ sample peak)
 */
export function truePeakChannel(channel, sampleRate, factor, tapsPerPhase) {
  const n = channel.length;
  if (n === 0) return 0;

  const f = factor ?? oversamplingFactorFor(sampleRate);
  const tapsN = tapsPerPhase ?? TRUE_PEAK_DETECT_TAPS;

  // Sample peak is always a lower bound and is exact for factor 1.
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(channel[i]);
    if (a > peak) peak = a;
  }
  if (f <= 1) return peak;

  const phases = buildPolyphaseFilter(f, tapsN);
  const taps = phases[0].length;
  const half = taps >> 1;

  // Samples outside the buffer are treated as silence. This is the correct model — the
  // file is preceded and followed by nothing — and it avoids the step discontinuity that
  // clamping to the endpoint sample would invent, which rings and over-reads at HF.
  for (let i = 0; i < n; i++) {
    for (let p = 1; p < f; p++) {
      const branch = phases[p];
      let acc = 0;
      for (let k = 0; k < taps; k++) {
        const idx = i + k - half + 1;
        if (idx < 0 || idx >= n) continue;
        acc += branch[k] * channel[idx];
      }
      const a = Math.abs(acc);
      if (a > peak) peak = a;
    }
  }

  return peak;
}

/**
 * @typedef {object} PeakResult
 * @property {number} samplePeak    linear
 * @property {number} truePeak      linear
 * @property {number} samplePeakDb  dBFS
 * @property {number} truePeakDb    dBTP
 * @property {number[]} perChannelTruePeakDb
 * @property {number} oversamplingFactor
 */

/**
 * Measure sample peak and true peak across every channel.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data
 * @param {number} [factor]
 * @returns {PeakResult}
 */
export function analysePeaks(data, factor) {
  const f = factor ?? oversamplingFactorFor(data.sampleRate);
  let samplePeak = 0;
  let truePeak = 0;
  const perChannel = [];

  for (const ch of data.channels) {
    let sp = 0;
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > sp) sp = a;
    }
    const tp = truePeakChannel(ch, data.sampleRate, f);
    if (sp > samplePeak) samplePeak = sp;
    if (tp > truePeak) truePeak = tp;
    perChannel.push(gainToDb(tp));
  }

  return {
    samplePeak,
    truePeak,
    samplePeakDb: gainToDb(samplePeak),
    truePeakDb: gainToDb(truePeak),
    perChannelTruePeakDb: perChannel,
    oversamplingFactor: f,
  };
}

function nextPow2(n) {
  let p = 1;
  while (p < n) {
    p <<= 1;
    if (p > 1 << 30) throw new Error(`true-peak: length ${n} is too large to interpolate`);
  }
  return p;
}

/**
 * Band-limited peak via frequency-domain interpolation (zero-pad the FFT, IFFT).
 * Independent of the detection FIR — this is the verifier, not the detector.
 *
 * Falls back to a long polyphase FIR when the interpolated buffer would exceed
 * {@link EXACT_MAX_INTERPOLATED} samples (long files).
 *
 * @param {Float32Array} channel
 * @param {number} [factor=4]
 * @returns {number} linear amplitude (≥ sample peak)
 */
export function truePeakChannelExact(channel, factor = 4) {
  const n = channel.length;
  if (n === 0) return 0;
  let samplePeak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(channel[i]);
    if (a > samplePeak) samplePeak = a;
  }
  const f = factor | 0;
  if (f <= 1) return samplePeak;

  const N = nextPow2(n);
  if (N * f > EXACT_MAX_INTERPOLATED) {
    return Math.max(samplePeak, truePeakChannel(channel, 48000, f, TRUE_PEAK_VERIFY_TAPS));
  }

  const reN = new Float64Array(N);
  const imN = new Float64Array(N);
  for (let i = 0; i < n; i++) reN[i] = channel[i];
  fftRadix2(reN, imN);

  const Nf = N * f;
  const re = new Float64Array(Nf);
  const im = new Float64Array(Nf);
  const half = N >> 1;
  for (let k = 0; k < half; k++) {
    re[k] = reN[k];
    im[k] = imN[k];
  }
  // Split the Nyquist bin so the interpolated sequence stays real.
  re[half] = reN[half] * 0.5;
  im[half] = imN[half] * 0.5;
  re[Nf - half] = reN[half] * 0.5;
  im[Nf - half] = -imN[half] * 0.5;
  for (let k = half + 1; k < N; k++) {
    re[Nf - N + k] = reN[k];
    im[Nf - N + k] = imN[k];
  }

  ifftRadix2(re, im);
  let peak = samplePeak;
  const limit = n * f;
  for (let i = 0; i < limit; i++) {
    const a = Math.hypot(re[i] * f, im[i] * f);
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * Independent true-peak measurement used to grade the limiter. Short buffers use
 * FFT interpolation; long buffers use a 48-tap FIR — never the 24-tap detector.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data
 * @param {number} [factor]
 * @returns {PeakResult}
 */
export function analysePeaksVerified(data, factor) {
  const f = factor ?? oversamplingFactorFor(data.sampleRate);
  let samplePeak = 0;
  let truePeak = 0;
  const perChannel = [];

  for (const ch of data.channels) {
    let sp = 0;
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > sp) sp = a;
    }
    const N = nextPow2(Math.max(1, ch.length));
    const independent =
      N * f <= EXACT_MAX_INTERPOLATED
        ? truePeakChannelExact(ch, f)
        : truePeakChannel(ch, data.sampleRate, f, TRUE_PEAK_VERIFY_TAPS);
    // Never grade optimistic vs the detector: a truncated HF sine can make the
    // FFT interpolator miss Gibbs overshoot the FIR sees. Take the hotter read.
    const detect = truePeakChannel(ch, data.sampleRate, f);
    const tp = Math.max(sp, independent, detect);
    if (sp > samplePeak) samplePeak = sp;
    if (tp > truePeak) truePeak = tp;
    perChannel.push(gainToDb(tp));
  }

  return {
    samplePeak,
    truePeak,
    samplePeakDb: gainToDb(samplePeak),
    truePeakDb: gainToDb(truePeak),
    perChannelTruePeakDb: perChannel,
    oversamplingFactor: f,
  };
}

/**
 * A fast, allocation-free true-peak estimate for the real-time meters.
 *
 * The full polyphase pass is far too expensive for a 60 fps animation frame. This variant
 * uses the same filter but strides through the block, which under-reads slightly on very
 * short transients. The live meter is labelled "est." in the UI for exactly this reason;
 * the export path always uses `analysePeaks`.
 *
 * @param {Float32Array} block
 * @param {number} sampleRate
 * @param {number} [stride]
 */
export function truePeakEstimate(block, sampleRate, stride = 2) {
  const f = sampleRate < 88200 ? 4 : 2;
  const phases = buildPolyphaseFilter(f, 8, 7.0);
  const taps = 8;
  const half = taps >> 1;
  const n = block.length;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(block[i]);
    if (a > peak) peak = a;
  }
  for (let i = 0; i < n; i += stride) {
    for (let p = 1; p < f; p++) {
      const branch = phases[p];
      let acc = 0;
      for (let k = 0; k < taps; k++) {
        const idx = i + k - half + 1;
        if (idx < 0 || idx >= n) continue;
        acc += branch[k] * block[idx];
      }
      const a = Math.abs(acc);
      if (a > peak) peak = a;
    }
  }
  return peak;
}
