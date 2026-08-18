/**
 * Signal Rot — look-ahead true-peak limiter + post-render verification.
 * Pure sample-domain processing (no Web Audio nodes): deterministic and testable.
 */
import { dbToGain, gainToDb, clamp } from './math.js';
import { truePeakAt, truePeakFile } from './dsp.js';

/**
 * In-place stereo-linked look-ahead true-peak limiter.
 *
 *  - 2.5 ms lookahead so the reconstruction filter has room to breathe
 *  - 4× Catmull-Rom oversampling for inter-sample peak detection (linked across channels)
 *  - soft knee opening 1 dB below the ceiling
 *  - program-dependent release (fast on fresh transients, slow on sustained reduction)
 *
 * Returns { maxGainReductionDb } for the render report.
 */
export function truePeakLimit(buffer, ceilingDb) {
  const ceil = dbToGain(ceilingDb);
  const ch = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const n = buffer.length;
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));

  const look = Math.max(1, Math.round(sr * 0.0025));
  const relFast = Math.max(1, Math.round(sr * 0.015));
  const relSlow = Math.max(1, Math.round(sr * 0.15));
  const kneeStart = dbToGain(ceilingDb - 1.0);

  // Per-sample target gain from the 4× oversampled peak (channel-linked maximum).
  const gain = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    let pk = 0;
    for (let c = 0; c < ch; c++) {
      const v = truePeakAt(chans[c], i);
      if (v > pk) pk = v;
    }
    if (pk <= kneeStart) gain[i] = 1;
    else if (pk >= ceil) gain[i] = ceil / pk;
    else {
      const t = (pk - kneeStart) / (ceil - kneeStart);
      const target = ceil / pk;
      gain[i] = 1 - (1 - target) * t * t * (3 - 2 * t); // smoothstep across the knee
    }
  }

  // Lookahead: forward-running minimum over the look window (attack anticipation).
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let mn = gain[i];
    const end = Math.min(n, i + look + 1);
    for (let k = i + 1; k < end; k++) if (gain[k] < mn) mn = gain[k];
    sm[i] = mn;
  }

  // Apply gain with program-dependent release.
  let g = 1;
  let minG = 1;
  let samplesSinceAttack = 0;
  for (let i = 0; i < n; i++) {
    const target = sm[i];
    if (target < g) {
      g = target; // instant attack (already anticipated by lookahead)
      samplesSinceAttack = 0;
    } else {
      samplesSinceAttack++;
      const blend = clamp(samplesSinceAttack / (sr * 0.05), 0, 1);
      const relSamples = relFast * (1 - blend) + relSlow * blend;
      g += (target - g) / relSamples;
    }
    if (g < minG) minG = g;
    for (let c = 0; c < ch; c++) chans[c][i] *= g;
  }

  return { maxGainReductionDb: minG < 1 ? -gainToDb(minG) : 0 };
}

/**
 * Post-render true-peak verification.
 * Returns { measuredTruePeakDbtp, requestedCeilingDbtp, exceeded, headroomDb }.
 * `maxLen` caps the scan for very long files (default: full file).
 */
export function verifyTruePeak(buffer, ceilingDb, maxLen = Infinity) {
  const tp = truePeakFile(buffer, maxLen);
  const measuredTruePeakDbtp = tp > 0 ? gainToDb(tp) : -Infinity;
  const exceeded = measuredTruePeakDbtp > ceilingDb + 0.01; // 0.01 dB tolerance
  return {
    measuredTruePeakDbtp,
    requestedCeilingDbtp: ceilingDb,
    exceeded,
    headroomDb: Number.isFinite(measuredTruePeakDbtp) ? ceilingDb - measuredTruePeakDbtp : Infinity,
  };
}
