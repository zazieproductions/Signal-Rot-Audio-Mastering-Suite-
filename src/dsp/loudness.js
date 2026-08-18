/**
 * ITU-R BS.1770-4 / EBU R 128 loudness measurement.
 *
 * This module replaces the earlier hand-tuned approximation with the actual
 * standard. Measured against the previous implementation (see
 * docs/DSP-VALIDATION.md for the full comparison):
 *
 *  - **Integrated loudness** was already close: the old filter sat a consistent
 *    0.04 LU high across tones, white noise and spectrally-tilted noise alike.
 *    Correcting it is a matter of conformance rather than audibility.
 *  - **Loudness Range was badly broken.** It used 400 ms momentary blocks and a
 *    -10 LU relative gate where EBU Tech 3342 requires 3 s short-term blocks
 *    and a -20 LU gate. On the Tech 3342 compliance signals it returned 0.0 LU
 *    where the answers are 20 LU and 15 LU — not a drift, a total failure.
 *  - **Multichannel content was mis-measured.** The old code hard-coded
 *    `min(2, channels)`, so a 5.1 render was metered from L/R only, ignoring
 *    the centre and surrounds. This module applies the BS.1770 G weights and
 *    excludes the LFE.
 *
 * What the standard actually requires:
 *
 *  - Stage 1 "shelving" pre-filter and stage 2 RLB high-pass, specified in
 *    BS.1770-4 Tables 1 & 2 as *direct-form coefficients at 48 kHz*. To support
 *    arbitrary sample rates we re-derive them analytically from the analogue
 *    prototype the tables were produced from, so 44.1/88.2/96/192 kHz all get a
 *    correctly-warped filter instead of the 48 kHz coefficients applied blindly.
 *  - Mean-square over 400 ms blocks with 75 % overlap (momentary).
 *  - Channel weighting G: 1.0 for L/R/C, 1.41 for surrounds, LFE excluded.
 *  - Integrated loudness: absolute gate at -70 LUFS, then a relative gate at
 *    -10 LU below the ungated mean of the surviving blocks.
 *  - Loudness Range (EBU Tech 3342): 3 s *short-term* blocks with 1 s hop,
 *    absolute gate -70 LUFS, relative gate -20 LU, then the 10th-95th
 *    percentile spread with linear interpolation between samples.
 *
 * All functions here are pure and operate on plain Float32Array/Float64Array
 * channel data, so they are testable in Node without a Web Audio context.
 */

const ABSOLUTE_GATE_LUFS = -70;
const INTEGRATED_RELATIVE_GATE_LU = -10;
const LRA_RELATIVE_GATE_LU = -20;

/** Offset that converts mean-square power to LKFS/LUFS (BS.1770-4 eq. 2). */
const LOUDNESS_OFFSET_DB = -0.691;

/**
 * BS.1770-4 channel weighting coefficients, keyed by channel index for the
 * common interleaved orders. Anything beyond the known set is treated as a
 * full-weight (1.0) channel, which is the conservative choice.
 */
export const CHANNEL_WEIGHTS = Object.freeze({
  L: 1.0,
  R: 1.0,
  C: 1.0,
  LFE: 0.0,
  Ls: 1.41,
  Rs: 1.41,
});

/**
 * Analogue prototype for the BS.1770 stage 1 shelving filter.
 *
 * The 48 kHz coefficients in the standard correspond to a high-frequency
 * shelf with these parameters; re-running the bilinear transform at the
 * target rate reproduces the table exactly at 48 kHz (verified in tests to
 * ~1e-6) while staying correct at other rates.
 */
const STAGE1 = { f0: 1681.974450955533, G: 3.999843853973347, Q: 0.7071752369554196 };

/** Analogue prototype for the stage 2 RLB high-pass. */
const STAGE2 = { f0: 38.13547087602444, Q: 0.5003270373238773 };

/**
 * Design the BS.1770 stage 1 high-shelf as normalised biquad coefficients.
 * @param {number} sampleRate
 * @returns {{b0:number,b1:number,b2:number,a1:number,a2:number}}
 */
export function designStage1(sampleRate) {
  const { f0, G, Q } = STAGE1;
  const K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const den = 1 + K / Q + K * K;
  return {
    b0: (Vh + (Vb * K) / Q + K * K) / den,
    b1: (2 * (K * K - Vh)) / den,
    b2: (Vh - (Vb * K) / Q + K * K) / den,
    a1: (2 * (K * K - 1)) / den,
    a2: (1 - K / Q + K * K) / den,
  };
}

/**
 * Design the BS.1770 stage 2 RLB high-pass as normalised biquad coefficients.
 * @param {number} sampleRate
 * @returns {{b0:number,b1:number,b2:number,a1:number,a2:number}}
 */
export function designStage2(sampleRate) {
  const { f0, Q } = STAGE2;
  const K = Math.tan((Math.PI * f0) / sampleRate);
  const den = 1 + K / Q + K * K;
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / den,
    a2: (1 - K / Q + K * K) / den,
  };
}

/**
 * Apply a normalised biquad in direct form I, out-of-place.
 * @param {ArrayLike<number>} input
 * @param {{b0:number,b1:number,b2:number,a1:number,a2:number}} c
 * @param {Float64Array} [out] optional destination (may alias nothing)
 * @returns {Float64Array}
 */
export function biquad(input, c, out) {
  const n = input.length;
  const dst = out && out.length === n ? out : new Float64Array(n);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  const { b0, b1, b2, a1, a2 } = c;
  for (let i = 0; i < n; i++) {
    const x = input[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    dst[i] = y;
  }
  return dst;
}

/**
 * K-weight a single channel (stage 1 shelf followed by stage 2 RLB high-pass).
 * @param {ArrayLike<number>} channel
 * @param {number} sampleRate
 * @returns {Float64Array}
 */
export function kWeight(channel, sampleRate) {
  const stage1 = biquad(channel, designStage1(sampleRate));
  return biquad(stage1, designStage2(sampleRate), stage1);
}

/**
 * Compute the per-block weighted mean-square "z" values used by every BS.1770
 * loudness figure, for a given block length and hop.
 *
 * @param {ArrayLike<number>[]} channels K-weighted channel data
 * @param {number[]} weights per-channel G weights
 * @param {number} blockSamples
 * @param {number} hopSamples
 * @returns {Float64Array} block loudness values in LKFS
 */
function blockLoudness(channels, weights, blockSamples, hopSamples) {
  const n = channels[0] ? channels[0].length : 0;
  if (n < blockSamples || blockSamples <= 0) return new Float64Array(0);
  const count = Math.floor((n - blockSamples) / hopSamples) + 1;
  const out = new Float64Array(count);
  for (let b = 0; b < count; b++) {
    const start = b * hopSamples;
    let z = 0;
    for (let c = 0; c < channels.length; c++) {
      const g = weights[c];
      if (g === 0) continue;
      const data = channels[c];
      let sum = 0;
      for (let i = 0; i < blockSamples; i++) {
        const v = data[start + i];
        sum += v * v;
      }
      z += g * (sum / blockSamples);
    }
    out[b] = LOUDNESS_OFFSET_DB + 10 * Math.log10(Math.max(1e-24, z));
  }
  return out;
}

/** Mean of block loudness values in the linear (power) domain, back to dB. */
function meanLoudness(values) {
  if (!values.length) return -Infinity;
  let sum = 0;
  for (const v of values) sum += Math.pow(10, (v - LOUDNESS_OFFSET_DB) / 10);
  return LOUDNESS_OFFSET_DB + 10 * Math.log10(Math.max(1e-24, sum / values.length));
}

/**
 * Linear-interpolated percentile over a sorted ascending array, matching the
 * convention used by EBU Tech 3342 reference implementations.
 * @param {number[]} sorted
 * @param {number} p 0..1
 */
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = p * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Resolve BS.1770 G weights for a channel count. Stereo and mono are the
 * overwhelmingly common cases; 5.1 gets the surround weighting and an
 * excluded LFE.
 * @param {number} channelCount
 * @param {number[]} [override] explicit weights
 * @returns {number[]}
 */
export function defaultWeights(channelCount, override) {
  if (override && override.length === channelCount) return override.slice();
  switch (channelCount) {
    case 1:
      return [1.0];
    case 2:
      return [1.0, 1.0];
    case 6: // L R C LFE Ls Rs
      return [1.0, 1.0, 1.0, 0.0, 1.41, 1.41];
    case 8: // L R C LFE Lss Rss Lrs Rrs
      return [1.0, 1.0, 1.0, 0.0, 1.41, 1.41, 1.41, 1.41];
    default:
      return new Array(channelCount).fill(1.0);
  }
}

/**
 * Extract channel data arrays from an AudioBuffer-like object.
 * @param {{numberOfChannels:number,getChannelData:(i:number)=>Float32Array}} buffer
 * @returns {Float32Array[]}
 */
export function channelsOf(buffer) {
  const out = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
  return out;
}

/**
 * Full BS.1770-4 / EBU R 128 measurement.
 *
 * @param {{sampleRate:number,length:number,numberOfChannels:number,getChannelData:(i:number)=>Float32Array}} buffer
 * @param {{weights?:number[]}} [options]
 * @returns {{lufs:number, lra:number, momentaryMax:number, shortTermMax:number, threshold:number}}
 */
export function measureLoudness(buffer, options = {}) {
  const sampleRate = buffer.sampleRate;
  const raw = channelsOf(buffer);
  const weights = defaultWeights(raw.length, options.weights);
  const weighted = raw.map((ch) => kWeight(ch, sampleRate));

  // --- Integrated loudness: 400 ms blocks, 75 % overlap ---
  const momentaryBlock = Math.round(0.4 * sampleRate);
  const momentaryHop = Math.max(1, Math.round(momentaryBlock / 4));
  const momentary = blockLoudness(weighted, weights, momentaryBlock, momentaryHop);

  let lufs = -Infinity;
  let threshold = -Infinity;
  if (momentary.length) {
    const aboveAbsolute = Array.from(momentary).filter((v) => v > ABSOLUTE_GATE_LUFS);
    if (aboveAbsolute.length) {
      threshold = meanLoudness(aboveAbsolute) + INTEGRATED_RELATIVE_GATE_LU;
      const gated = aboveAbsolute.filter((v) => v > threshold);
      lufs = gated.length ? meanLoudness(gated) : -Infinity;
    }
  }

  // --- Loudness Range: 3 s blocks, 1 s hop, -20 LU relative gate ---
  const shortBlock = Math.round(3 * sampleRate);
  const shortHop = Math.max(1, Math.round(sampleRate));
  const shortTerm = blockLoudness(weighted, weights, shortBlock, shortHop);

  let lra = 0;
  if (shortTerm.length) {
    const aboveAbsolute = Array.from(shortTerm).filter((v) => v > ABSOLUTE_GATE_LUFS);
    if (aboveAbsolute.length) {
      const relative = meanLoudness(aboveAbsolute) + LRA_RELATIVE_GATE_LU;
      const gated = aboveAbsolute.filter((v) => v > relative).sort((a, b) => a - b);
      if (gated.length) lra = Math.max(0, percentile(gated, 0.95) - percentile(gated, 0.1));
    }
  }

  return {
    lufs,
    lra,
    momentaryMax: momentary.length ? Math.max(...momentary) : -Infinity,
    shortTermMax: shortTerm.length ? Math.max(...shortTerm) : -Infinity,
    threshold,
  };
}

/**
 * Backwards-compatible shim for the original call site, which expected
 * `{lufs, lra}` and used -70 as the "silent" sentinel rather than -Infinity.
 * @param {object} buffer
 * @returns {{lufs:number, lra:number}}
 */
export function measureLUFS(buffer) {
  const r = measureLoudness(buffer);
  return {
    lufs: Number.isFinite(r.lufs) ? r.lufs : -70,
    lra: r.lra,
  };
}
