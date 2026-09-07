/**
 * Mastering-oriented measurements of an `AudioData`.
 *
 * These wrap the production analysis modules so a golden, a browser capture and a
 * regression report all speak the same numbers. They do not reimplement loudness or
 * true-peak; they *report* them, plus a handful of summaries the production analyser
 * does not currently expose (DC, M/S energy, spectral centroid, finite-sample audit).
 */

import { analyseLoudness } from '../../src/audio/analysis/loudness.js';
import { analysePeaks } from '../../src/audio/analysis/true-peak.js';
import { rms, rmsDb, crestFactorDb } from '../../src/audio/analysis/rms.js';
import { correlation, monoCompatibility } from '../../src/audio/analysis/correlation.js';
import { fftRadix2, hannWindow } from '../../src/audio/analysis/fft.js';
import { samplePeak as samplePeakLinear } from '../../src/audio/dsp/audio-data.js';
import { gainToDb } from '../../src/audio/dsp/math.js';

/** @typedef {import('../../src/audio/dsp/audio-data.js').AudioData} AudioData */

export const BANDS = Object.freeze([
  { id: 'sub', lo: 20, hi: 60 },
  { id: 'bass', lo: 60, hi: 150 },
  { id: 'low-mid', lo: 150, hi: 400 },
  { id: 'mid', lo: 400, hi: 1500 },
  { id: 'presence', lo: 1500, hi: 5000 },
  { id: 'air', lo: 5000, hi: 16000 },
]);

const jsonNumber = (v, digits = 4) => {
  if (v === Infinity || v === -Infinity || Number.isNaN(v) || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

function energy(channel, start = 0, end = channel.length) {
  let s = 0;
  for (let i = start; i < end; i++) s += channel[i] * channel[i];
  return s;
}

function mean(channel) {
  if (!channel.length) return 0;
  let s = 0;
  for (let i = 0; i < channel.length; i++) s += channel[i];
  return s / channel.length;
}

function auditFinite(data) {
  let nan = 0;
  let inf = 0;
  let samples = 0;
  for (const ch of data.channels) {
    for (let i = 0; i < ch.length; i++) {
      samples++;
      const v = ch[i];
      if (Number.isNaN(v)) nan++;
      else if (!Number.isFinite(v)) inf++;
    }
  }
  return { samples, nan, inf, ok: nan === 0 && inf === 0 };
}

function midSide(data) {
  if (data.channels.length < 2) {
    const e = energy(data.channels[0] ?? new Float32Array(0));
    return { midEnergy: e, sideEnergy: 0, midDb: jsonNumber(gainToDb(Math.sqrt(e))), sideDb: null };
  }
  const [L, R] = data.channels;
  let mid = 0;
  let side = 0;
  const n = Math.min(L.length, R.length);
  for (let i = 0; i < n; i++) {
    const m = 0.5 * (L[i] + R[i]);
    const s = 0.5 * (L[i] - R[i]);
    mid += m * m;
    side += s * s;
  }
  return {
    midEnergy: mid,
    sideEnergy: side,
    midDb: jsonNumber(gainToDb(Math.sqrt(mid / Math.max(1, n)))),
    sideDb: jsonNumber(gainToDb(Math.sqrt(side / Math.max(1, n)))),
    sideToMidDb: jsonNumber(10 * Math.log10((side + 1e-20) / (mid + 1e-20))),
  };
}

/**
 * One-shot magnitude spectrum of a mono-sum, Hann-windowed, power-of-two FFT.
 * Returns band energies (dB, mean-removed) and a spectral centroid in Hz.
 */
export function spectralSummary(data, fftSize = 4096) {
  const n = data.length;
  const sr = data.sampleRate;
  const size = Math.min(fftSize, 1 << Math.floor(Math.log2(Math.max(2, n))));
  if (n < size) {
    return {
      centroidHz: null,
      bandsDb: BANDS.map((b) => ({ ...b, db: null })),
      tooShort: true,
    };
  }
  const hann = hannWindow(size);
  const start = Math.max(0, Math.floor((n - size) / 2));
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const nCh = data.channels.length;
  for (let i = 0; i < size; i++) {
    let s = 0;
    for (let c = 0; c < nCh; c++) s += data.channels[c][start + i];
    re[i] = (s / nCh) * hann[i];
  }
  fftRadix2(re, im);

  const half = size / 2;
  const mag = new Float64Array(half);
  let weighted = 0;
  let total = 0;
  for (let k = 1; k < half; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    mag[k] = p;
    const f = (k * sr) / size;
    weighted += f * p;
    total += p;
  }
  const centroidHz = total > 1e-20 ? weighted / total : null;

  const bandsDb = BANDS.map((b) => {
    if (b.lo >= sr / 2) return { id: b.id, lo: b.lo, hi: b.hi, db: null };
    const k0 = Math.max(1, Math.floor((b.lo * size) / sr));
    const k1 = Math.min(half - 1, Math.ceil((Math.min(b.hi, sr / 2) * size) / sr));
    let e = 0;
    for (let k = k0; k <= k1; k++) e += mag[k];
    return {
      id: b.id,
      lo: b.lo,
      hi: b.hi,
      db: jsonNumber(10 * Math.log10(e / (k1 - k0 + 1) + 1e-20)),
    };
  });

  return { centroidHz: jsonNumber(centroidHz, 2), bandsDb, tooShort: false, fftSize: size };
}

function perChannelEnergy(data) {
  return data.channels.map((ch, index) => {
    const e = energy(ch);
    const peak = samplePeakOf(ch);
    const dc = mean(ch);
    return {
      index,
      rms: jsonNumber(Math.sqrt(e / Math.max(1, ch.length))),
      rmsDb: jsonNumber(gainToDb(Math.sqrt(e / Math.max(1, ch.length)) * Math.SQRT2)),
      peak: jsonNumber(peak),
      peakDb: jsonNumber(gainToDb(peak)),
      dc: jsonNumber(dc, 8),
      silent: peak < 1e-9,
    };
  });
}

function samplePeakOf(ch) {
  let p = 0;
  for (let i = 0; i < ch.length; i++) {
    const a = Math.abs(ch[i]);
    if (a > p) p = a;
  }
  return p;
}

/**
 * Full mastering measurement of an AudioData.
 *
 * @param {AudioData} data
 * @param {object} [meta]
 * @returns {object}
 */
export function measureAudio(data, meta = {}) {
  const finite = auditFinite(data);
  const loudness = analyseLoudness(data);
  const peaks = analysePeaks(data);
  const r = rms(data);
  const rDb = rmsDb(data);
  const crest = crestFactorDb(data);
  const mono =
    data.channels.length >= 2
      ? monoCompatibility(data)
      : { bands: [], overallCorrelation: 1, worstBand: null };
  const corr = data.channels.length >= 2 ? correlation(data.channels[0], data.channels[1]) : 1;
  const ms = midSide(data);
  const spectrum = spectralSummary(data);
  const dc = data.channels.map((ch) => mean(ch));
  const maxAbsDc = Math.max(0, ...dc.map((v) => Math.abs(v)));

  return {
    id: meta.id ?? null,
    title: meta.title ?? null,
    class: meta.class ?? 'source',
    browser: meta.browser ?? null,
    engine: meta.engine ?? 'node',
    sampleRate: data.sampleRate,
    length: data.length,
    durationSeconds: jsonNumber(data.length / data.sampleRate, 6),
    channels: data.channels.length,
    finite,
    loudness: {
      integrated: jsonNumber(loudness.integrated, 3),
      lra: jsonNumber(loudness.lra, 3),
      maxMomentary: jsonNumber(loudness.maxMomentary, 3),
      maxShortTerm: jsonNumber(loudness.maxShortTerm, 3),
      tooShort: loudness.tooShort,
      silent: loudness.silent,
    },
    peak: {
      sample: jsonNumber(peaks.samplePeak, 6),
      sampleDb: jsonNumber(peaks.samplePeakDb, 3),
      truePeak: jsonNumber(peaks.truePeak, 6),
      truePeakDb: jsonNumber(peaks.truePeakDb, 3),
      perChannelTruePeakDb: peaks.perChannelTruePeakDb.map((v) => jsonNumber(v, 3)),
    },
    rms: jsonNumber(r, 6),
    rmsDb: jsonNumber(rDb, 3),
    crestFactorDb: jsonNumber(crest, 3),
    correlation: jsonNumber(corr, 4),
    mono: {
      overallCorrelation: jsonNumber(mono.overallCorrelation, 4),
      worstBand: mono.worstBand
        ? {
            label: mono.worstBand.label,
            monoLossDb: jsonNumber(mono.worstBand.monoLossDb, 3),
          }
        : null,
      bands: mono.bands.map((b) => ({
        label: b.label,
        lo: b.lo,
        hi: b.hi,
        correlation: jsonNumber(b.correlation, 4),
        monoLossDb: jsonNumber(b.monoLossDb, 3),
      })),
    },
    ms,
    spectrum,
    dc: {
      perChannel: dc.map((v) => jsonNumber(v, 8)),
      maxAbs: jsonNumber(maxAbsDc, 8),
    },
    perChannel: perChannelEnergy(data),
    linearSamplePeak: jsonNumber(samplePeakLinear(data), 6),
  };
}

/**
 * Compact harmonic spectrum of a (near-)sine: magnitudes of H1…H8 relative to H1, in dB.
 * `frequency` is the expected fundamental.
 */
export function harmonicSpectrum(channel, sampleRate, frequency, fftSize = 8192) {
  const size = Math.min(fftSize, 1 << Math.floor(Math.log2(Math.max(2, channel.length))));
  const hann = hannWindow(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const start = Math.max(0, Math.floor((channel.length - size) / 2));
  for (let i = 0; i < size; i++) re[i] = channel[start + i] * hann[i];
  fftRadix2(re, im);
  const binHz = sampleRate / size;
  const harmonics = [];
  for (let h = 1; h <= 8; h++) {
    const target = (h * frequency) / binHz;
    const k = Math.round(target);
    if (k <= 0 || k >= size / 2) {
      harmonics.push({ h, hz: h * frequency, db: null });
      continue;
    }
    let peak = 0;
    for (let j = Math.max(1, k - 2); j <= Math.min(size / 2 - 1, k + 2); j++) {
      const p = re[j] * re[j] + im[j] * im[j];
      if (p > peak) peak = p;
    }
    harmonics.push({ h, hz: jsonNumber(h * frequency, 2), mag: peak });
  }
  const h1 = harmonics[0].mag || 1e-30;
  return harmonics.map((x) => ({
    h: x.h,
    hz: x.hz,
    dbRel: x.mag == null ? null : jsonNumber(10 * Math.log10((x.mag + 1e-30) / h1), 2),
  }));
}

export { jsonNumber, energy, mean, auditFinite };
