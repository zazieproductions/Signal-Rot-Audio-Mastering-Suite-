/**
 * Source-aware spatial profiling (§7).
 *
 * Measures a stereo `AudioData` object and turns it into the compact description the
 * spatial up-mixer needs. Everything here is deterministic, pure JS over real samples,
 * and every number is an *energy/correlation* estimate — no FFT, no windowing choices
 * that drift between browsers.
 *
 * Bands (the engine's extraction regions):
 *   sub ≤ 100 Hz · low 100–300 · low-mid 300–900 · mid 900–3k · presence 3k–8k · air ≥ 8k
 * Each band reports the mid and side RMS, and the mid↔side short-term correlation shape
 * (which doubles as a mono-safety readout: strongly correlated side = "phasey" material,
 * which must receive *less* decorrelation).
 *
 * Globals:
 *   brightnessAirDb        air-band share of total energy (loudness of the top end)
 *   centreDominance        how much of the image is centred (mid share, weighted low)
 *   ambientRatio           decorrelated-energy share (1 − |correlation|, window-averaged)
 *   bassCoherence          sub/low band correlation (0 = incoherent bass → never widen)
 *   sideAsymmetryDb        L vs R energy imbalance
 *   transientDensity       1/s onset count in the presence band (the "transient anchor")
 *   widthEnvelope          average |side|/|mid| ratio across mid/presence (image width)
 */

import { designBiquad, processBiquadCascade } from '../dsp/biquad.js';

/** Region crossover frequencies, low edge → high edge. */
export const SPATIAL_BANDS = Object.freeze([
  { id: 'sub', lo: 20, hi: 100 },
  { id: 'low', lo: 100, hi: 300 },
  { id: 'lowmid', lo: 300, hi: 900 },
  { id: 'mid', lo: 900, hi: 3000 },
  { id: 'pres', lo: 3000, hi: 8000 },
  { id: 'air', lo: 8000, hi: 20000 },
]);

/** LR4 (two cascaded biquads per edge) band-pass for one band region. */
function bandFilters(sampleRate, lo, hi) {
  const chain = [];
  if (lo > 20) {
    chain.push(designBiquad('highpass', lo, Math.SQRT1_2, 0, sampleRate));
    chain.push(designBiquad('highpass', lo, Math.SQRT1_2, 0, sampleRate));
  }
  if (hi < 20000) {
    chain.push(designBiquad('lowpass', hi, Math.SQRT1_2, 0, sampleRate));
    chain.push(designBiquad('lowpass', hi, Math.SQRT1_2, 0, sampleRate));
  }
  return chain;
}

/**
 * @param {import('../dsp/audio-data.js').AudioData} data stereo (or mono; mono is
 *   treated as perfectly centred — every side metric reads zero)
 * @returns {object} profile described above
 */
export function measureSpatialProfile(data) {
  const { sampleRate } = data;
  const n = data.length;
  const stereo = data.channels.length >= 2;
  const L = data.channels[0];
  const R = stereo ? data.channels[1] : data.channels[0];

  const mid = new Float32Array(n);
  const side = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = L[i];
    const r = stereo ? R[i] : L[i];
    mid[i] = 0.5 * (l + r);
    side[i] = 0.5 * (l - r);
  }

  const bands = SPATIAL_BANDS.map((band) => {
    const filters = bandFilters(sampleRate, band.lo, band.hi);
    const m = Float32Array.from(mid);
    const s = Float32Array.from(side);
    if (filters.length) {
      processBiquadCascade(m, filters);
      processBiquadCascade(s, filters);
    }
    // Block-wise (50 ms) correlation between mid and side; the reported correlation is
    // the RMS-weighted mean of |corr| so phasey material is not hidden by averaging.
    const block = Math.max(64, Math.round(sampleRate * 0.05));
    let weighted = 0;
    let weightSum = 0;
    let mAcc = 0;
    let sAcc = 0;
    for (let b = 0; b + block <= n; b += block) {
      let mm = 0;
      let ss = 0;
      let ms = 0;
      for (let i = b; i < b + block; i++) {
        mm += m[i] * m[i];
        ss += s[i] * s[i];
        ms += m[i] * s[i];
      }
      mAcc += mm;
      sAcc += ss;
      const denom = Math.sqrt(mm * ss);
      if (denom > 1e-12) {
        weighted += Math.abs(ms / denom) * denom;
        weightSum += denom;
      }
    }
    const rmsM = Math.sqrt(mAcc / n);
    const rmsS = Math.sqrt(sAcc / n);
    return {
      id: band.id,
      rmsM,
      rmsS,
      // 0 = decorrelated side (true stereo ambience), 1 = mid/side correlated
      // ("phasey": anti-phase-derived side is strongly |correlated| to mid as well —
      // what matters for decorrelation decisions is that the side is *structured*).
      corr: weightSum > 0 ? weighted / weightSum : 0,
    };
  });

  const totalEnergy = bands.reduce((a, b) => a + b.rmsM * b.rmsM + b.rmsS * b.rmsS, 0);
  const airEnergy = bands[5].rmsM * bands[5].rmsM + bands[5].rmsS * bands[5].rmsS;
  const bassEnergy =
    bands[0].rmsM * bands[0].rmsM +
    bands[0].rmsS * bands[0].rmsS +
    bands[1].rmsM * bands[1].rmsM +
    bands[1].rmsS * bands[1].rmsS;
  const lowBands = [bands[0], bands[1]];

  // Centre dominance: low-frequency mid energy is a "stable centre" indicator, and so
  // is correlated mid-band content; weight low bands higher than air.
  const midWeighted = lowBands.reduce((a, b) => a + b.rmsM * b.rmsM, 0);
  const allMid = bands.reduce((a, b) => a + b.rmsM * b.rmsM, 0);
  const allSide = bands.reduce((a, b) => a + b.rmsS * b.rmsS, 0);
  const centreDominance = midWeighted / (bassEnergy + 1e-12);
  const widthEnvelope = (bands[3].rmsS + bands[4].rmsS) / (bands[3].rmsM + bands[4].rmsM + 1e-12);

  // Side asymmetry: L vs R energy difference (full band).
  let lAcc = 0;
  let rAcc = 0;
  for (let i = 0; i < n; i++) {
    lAcc += L[i] * L[i];
    rAcc += R[i] * R[i];
  }
  const sideAsymmetryDb = 10 * Math.log10((lAcc + 1e-12) / (rAcc + 1e-12));

  // Bass coherence: short-block mid/side correlation in sub+low (what bass-mono
  // protects). 0 = incoherent bass.
  const bassBlock = Math.max(64, Math.round(sampleRate * 0.04));
  const bassMid = new Float32Array(n);
  const bassSide = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    bassMid[i] = mid[i];
    bassSide[i] = side[i];
  }
  const bassFilters = bandFilters(sampleRate, 20, 300);
  processBiquadCascade(bassMid, bassFilters);
  processBiquadCascade(bassSide, bassFilters);
  let bcWeighted = 0;
  let bcWeightSum = 0;
  for (let b = 0; b + bassBlock <= n; b += bassBlock) {
    let mm = 0;
    let ss = 0;
    let ms = 0;
    for (let i = b; i < b + bassBlock; i++) {
      mm += bassMid[i] * bassMid[i];
      ss += bassSide[i] * bassSide[i];
      ms += bassMid[i] * bassSide[i];
    }
    const denom = Math.sqrt(mm * ss);
    if (denom > 1e-12) {
      bcWeighted += Math.abs(ms / denom) * denom;
      bcWeightSum += denom;
    }
  }
  const bassCoherence = bcWeightSum > 0 ? bcWeighted / bcWeightSum : 0;

  // Transient density: onsets per second in the presence band (side + mid envelope).
  const envFast = 1 - Math.exp(-1 / (sampleRate * 0.008));
  const envSlow = 1 - Math.exp(-1 / (sampleRate * 0.08));
  const presence = Float32Array.from(mid);
  const presenceFilters = bandFilters(sampleRate, 3000, 8000);
  processBiquadCascade(presence, presenceFilters);
  let fast = 0;
  let slow = 0;
  let onsets = 0;
  let inOnset = false;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(presence[i]);
    fast += envFast * (a - fast);
    slow += envSlow * (a - slow);
    const ratio = slow > 1e-6 ? fast / (slow + 1e-12) : 1;
    if (ratio > 2.5 && !inOnset) {
      inOnset = true;
      onsets++;
    } else if (ratio < 1.6) {
      inOnset = false;
    }
  }
  const duration = n / sampleRate;

  // Ambient ratio: window-averaged decorrelation of the *side* vs itself across two
  // 12 ms-spaced taps is complex; use the simpler honest proxy — the fraction of side
  // energy that is not coherent with mid at any lag 0 (short-block, amplitude-weighted).
  let ambWeighted = 0;
  let ambWeightSum = 0;
  const block2 = Math.max(64, Math.round(sampleRate * 0.02));
  for (let b = 0; b + block2 <= n; b += block2) {
    let mm = 0;
    let ss = 0;
    let ms = 0;
    for (let i = b; i < b + block2; i++) {
      mm += mid[i] * mid[i];
      ss += side[i] * side[i];
      ms += mid[i] * side[i];
    }
    const denom = Math.sqrt(mm * ss);
    if (denom > 1e-12) {
      ambWeighted += (1 - Math.abs(ms / denom)) * denom;
      ambWeightSum += denom;
    }
  }

  return {
    bands,
    brightnessAirDb: Math.max(-60, totalEnergy > 1e-12 ? 10 * Math.log10((airEnergy + 1e-12) / totalEnergy) : -60),
    centreDominance: Number.isFinite(centreDominance) ? Math.min(centreDominance, 10) : 0,
    ambientRatio: ambWeightSum > 0 ? ambWeighted / ambWeightSum : 0,
    bassCoherence,
    sideAsymmetryDb,
    transientDensity: onsets / Math.max(0.5, duration),
    widthEnvelope: Number.isFinite(widthEnvelope) ? Math.min(widthEnvelope, 10) : 0,
    energyMidSideDb: allSide > 1e-12 ? 10 * Math.log10((allMid + 1e-12) / allSide) : 20,
  };
}
