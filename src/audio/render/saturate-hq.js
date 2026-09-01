/**
 * High-quality offline saturation — oversampled, analytically evaluated, alias-suppressed.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────
 * The live chain's saturation is a `WaveShaperNode` with `oversample = '4x'`. Two
 * problems with shipping that in an export:
 *
 *  1. The Web Audio specification does not define the *quality* of WaveShaper
 *     oversampling. Implementations differ, and none of them publish their filter. An
 *     export's harmonic content therefore depended on the browser it was rendered in.
 *  2. To keep the (unspecified) aliasing tolerable, the live stage follows the shaper
 *     with a low-pass that tightens from 22 kHz to 17.5 kHz as drive rises — it trades
 *     treble for alias suppression. At full drive the export lost its top octave.
 *
 * This module replaces the WaveShaper *for offline renders only* with a deterministic
 * polyphase resampler around the exact same transfer function:
 *
 *   DC block (same RBJ 5 Hz high-pass the live stage uses)
 *     → pre-gain (same staging as the live stage)
 *     → 4× upsample   (windowed-sinc polyphase, Kaiser β = 9, 257-tap prototype)
 *     → y = f(x)      (the *analytic* transfer curve — no 4096-point lookup error)
 *     → 4× decimate   (same prototype, band-limited to the base Nyquist)
 *     → make-up gain  (same staging as the live stage)
 *
 * Because the non-linearity runs at 4× the sample rate, harmonics up to 4× Nyquist are
 * represented correctly and removed by the decimation filter *before* they can fold back
 * into the audible band. The alias-mitigation low-pass is therefore not applied here —
 * the export keeps its top octave. Measured on a 15 kHz sine at 44.1 kHz, full drive,
 * the folded third-harmonic alias at 900 Hz drops by more than 60 dB relative to
 * base-rate waveshaping (asserted by `tests/dsp/saturate-hq.test.js`).
 *
 * ── Fidelity to the live curve ───────────────────────────────────────────────────────
 * The transfer function is the same expression `makeSaturationCurve` tabulates, including
 * its DC-removal and peak-normalisation constants (computed over the identical 4096-point
 * grid, so the constants match the live curve bit-for-bit). The only differences from the
 * live path are the ones that *are* the improvement: evaluation is analytic rather than
 * linearly interpolated from a table, oversampling is defined rather than
 * implementation-dependent, and the mitigation low-pass is gone.
 *
 * ── Determinism ──────────────────────────────────────────────────────────────────────
 * Pure arithmetic, no randomness, no context-dependent state. Same input, same output,
 * every time, in every browser.
 *
 * ── Alignment ────────────────────────────────────────────────────────────────────────
 * Both FIRs are linear-phase and centred, so the pass has zero net delay: the output is
 * sample-aligned with the input and the buffer length is unchanged. Samples outside the
 * buffer are treated as silence, consistent with the rest of the offline suite.
 */

import { clamp } from '../dsp/math.js';
import { designBiquad, processBiquadCascade } from '../dsp/biquad.js';
import { saturationGainStaging } from '../graph/tone.js';

/** Half-width of each resampling FIR, in base-rate samples. */
const FIR_HALF = 32;
/** Kaiser window shape parameter (β = 9 ≈ 90 dB stop-band). */
const KAISER_BETA = 9;
/** Low-pass cutoff as a fraction of the base Nyquist. */
const CUTOFF_RATIO = 0.95;

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

/**
 * Oversampling factor for the saturation stage. Targets an effective non-linear
 * processing rate of ≥ 176.4 kHz, which puts the folding frequency far above anything a
 * drive-2.2 tanh generates with meaningful energy.
 */
export function saturationOversamplingFor(sampleRate) {
  if (sampleRate < 88200) return 4;
  if (sampleRate < 176400) return 2;
  return 1;
}

const kernelCache = new Map();

/**
 * Design the shared low-pass prototype for factor `L` and decompose it two ways:
 *  · `phases` — L polyphase branches of `2·FIR_HALF + 1` taps for the upsampler, each
 *    normalised to unity DC gain so a constant input is reproduced exactly.
 *  · `decim`  — the full prototype normalised to unity DC gain, for the decimator.
 *
 * The prototype is a windowed sinc with cutoff at `CUTOFF_RATIO × base Nyquist`, length
 * `2·FIR_HALF·L + 1` (odd, so the centre tap sits on an integer and the filter pair has
 * exactly zero net delay).
 *
 * @param {number} L oversampling factor ≥ 2
 */
export function buildSaturationKernels(L) {
  const cached = kernelCache.get(L);
  if (cached) return cached;

  const halfLen = FIR_HALF * L;
  const N = 2 * halfLen + 1;
  const proto = new Float64Array(N);
  const i0beta = besselI0(KAISER_BETA);
  // Cutoff in cycles/sample at the oversampled rate: base Nyquist is 1/(2L), scaled by
  // CUTOFF_RATIO to buy transition bandwidth below Nyquist rather than above it.
  const cut = CUTOFF_RATIO / (2 * L);

  for (let n = 0; n < N; n++) {
    const t = n - halfLen;
    const x = 2 * cut * t;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const r = t / halfLen;
    const w = besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - r * r))) / i0beta;
    proto[n] = 2 * cut * sinc * w;
  }

  // Upsampler branches: phase p, tap j reads input sample (i + FIR_HALF − j) and uses
  // prototype index (j − FIR_HALF)·L + p offset to the centre.
  const phases = [];
  for (let p = 0; p < L; p++) {
    const branch = new Float64Array(2 * FIR_HALF + 1);
    let sum = 0;
    for (let j = 0; j <= 2 * FIR_HALF; j++) {
      const n = (j - FIR_HALF) * L + p + halfLen;
      const v = n >= 0 && n < N ? proto[n] : 0;
      branch[j] = v;
      sum += v;
    }
    // Unity DC gain per phase (the interpolator's gain of L lives here).
    if (sum !== 0) for (let j = 0; j < branch.length; j++) branch[j] /= sum;
    phases.push(branch);
  }

  // Decimator: same prototype, unity DC gain overall.
  const decim = new Float64Array(N);
  let dsum = 0;
  for (let n = 0; n < N; n++) dsum += proto[n];
  for (let n = 0; n < N; n++) decim[n] = dsum !== 0 ? proto[n] / dsum : 0;

  const kernels = { phases, decim, halfLen, L };
  kernelCache.set(L, kernels);
  return kernels;
}

/**
 * The analytic saturation transfer function for `amount` ∈ (0, 1].
 *
 * Identical expression to `makeSaturationCurve` in `graph/tone.js`, with the DC and peak
 * normalisation constants computed over the same 4096-point grid so the two paths share
 * their constants exactly. Input is clamped to [−1, 1], matching WaveShaper's curve
 * domain (the pre-gain staging keeps real programme inside it anyway).
 *
 * @param {number} amount 0..1
 * @returns {(x: number) => number}
 */
export function makeSaturationTransfer(amount) {
  if (amount <= 0) return (x) => x;
  const k = 1 + amount * 1.2; // drive 1 … 2.2
  const asym = amount * 0.06; // even-harmonic asymmetry
  const blend = 1 - (1 - amount) * (1 - amount);

  const raw = (x) => {
    const xs = x + asym * (x * x - x * x * x * x);
    return (1 - blend) * x + blend * Math.tanh(k * xs);
  };

  // The same 4096-point grid the table-based curve uses, so dc and peak match it.
  const n = 4096;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += raw((i / (n - 1)) * 2 - 1);
  const dc = sum / n;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(raw((i / (n - 1)) * 2 - 1) - dc);
    if (v > peak) peak = v;
  }
  const norm = peak > 0 ? 1 / peak : 1;

  return (x) => {
    const c = x < -1 ? -1 : x > 1 ? 1 : x;
    return (raw(c) - dc) * norm;
  };
}

/**
 * Process one channel: upsample by L, apply `f`, decimate by L. Zero net delay.
 * Operates in blocks so the oversampled intermediate never exceeds a few hundred kB.
 *
 * The hot loops are branch-free: bounds checks only run for input samples within
 * `FIR_HALF` of the buffer edges (where out-of-range samples read as silence), and the
 * decimator always sees a fully-populated hi-rate scratch buffer.
 *
 * @param {Float32Array} x  modified in place
 * @param {number} L
 * @param {(v: number) => number} f applied at the oversampled rate
 */
export function oversampledShape(x, L, f) {
  const { phases, decim, halfLen } = buildSaturationKernels(L);
  const n = x.length;
  const H = FIR_HALF;
  const T = 2 * H + 1; // taps per phase
  const out = new Float32Array(n);
  const BLOCK = 16384;
  const decimLen = 2 * halfLen + 1;

  // Flatten the phase bank: kernel for phase p, tap j at flat[p·T + j]. One contiguous
  // array keeps the inner loops monomorphic and cache-friendly.
  const flat = new Float64Array(L * T);
  for (let p = 0; p < L; p++) flat.set(phases[p], p * T);

  for (let s = 0; s < n; s += BLOCK) {
    const e = Math.min(n, s + BLOCK);
    // Hi-rate range needed for outputs [s, e): [s·L − halfLen, (e−1)·L + halfLen].
    const needLo = s * L - halfLen;
    const needHi = (e - 1) * L + halfLen;
    const hi = new Float64Array(needHi - needLo + 1);

    // Input-sample range whose phases fall inside [needLo, needHi].
    const iMin = Math.floor(needLo / L);
    const iMax = Math.floor(needHi / L);

    for (let i = iMin; i <= iMax; i++) {
      const rowBase = i * L - needLo; // hi index of phase 0 for this input sample
      if (i - H >= 0 && i + H < n && rowBase >= 0 && rowBase + L <= hi.length) {
        // Interior fast path: one pass over the input taps feeds every phase at once,
        // so each input sample is read once instead of L times.
        const base = i + H;
        if (L === 4) {
          let a0 = 0;
          let a1 = 0;
          let a2 = 0;
          let a3 = 0;
          for (let j = 0; j < T; j++) {
            const xv = x[base - j];
            a0 += flat[j] * xv;
            a1 += flat[T + j] * xv;
            a2 += flat[2 * T + j] * xv;
            a3 += flat[3 * T + j] * xv;
          }
          hi[rowBase] = f(a0);
          hi[rowBase + 1] = f(a1);
          hi[rowBase + 2] = f(a2);
          hi[rowBase + 3] = f(a3);
        } else {
          for (let p = 0; p < L; p++) {
            const o = p * T;
            let acc = 0;
            for (let j = 0; j < T; j++) acc += flat[o + j] * x[base - j];
            hi[rowBase + p] = f(acc);
          }
        }
      } else {
        // Edge path: bounds-checked, runs only within FIR_HALF of the buffer ends and
        // at scratch-buffer boundaries.
        for (let p = 0; p < L; p++) {
          const m = rowBase + p;
          if (m < 0 || m >= hi.length) continue;
          const o = p * T;
          let acc = 0;
          for (let j = 0; j < T; j++) {
            const idx = i + H - j;
            if (idx >= 0 && idx < n) acc += flat[o + j] * x[idx];
          }
          hi[m] = f(acc);
        }
      }
    }

    // Decimate — the scratch buffer covers the full kernel span for every output.
    for (let i = s; i < e; i++) {
      const off = i * L - needLo - halfLen;
      let acc = 0;
      let t = 0;
      const limit = decimLen - 3;
      for (; t < limit; t += 4) {
        acc +=
          decim[t] * hi[off + t] +
          decim[t + 1] * hi[off + t + 1] +
          decim[t + 2] * hi[off + t + 2] +
          decim[t + 3] * hi[off + t + 3];
      }
      for (; t < decimLen; t++) acc += decim[t] * hi[off + t];
      out[i] = acc;
    }
  }

  x.set(out);
  return x;
}

/**
 * @typedef {object} SaturationHQResult
 * @property {boolean} applied
 * @property {number} amount            0..1
 * @property {number} oversampling      effective non-linear oversampling factor
 * @property {number} prototypeTaps     length of the resampling FIR prototype (0 at 1×)
 * @property {number} preGain           linear, same staging as the live stage
 * @property {number} makeupGain        linear, same staging as the live stage
 * @property {boolean} mitigationLowpassBypassed  true — not needed at this quality
 */

/**
 * Apply the high-quality saturation pass to `data` in place.
 *
 * Order-equivalent to the live graph: saturation is the final colour stage before the
 * chain output, so applying it to the rendered buffer is the same composition, minus the
 * WaveShaper's aliasing and minus the mitigation low-pass.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data mutated
 * @param {number} amount 0..1 (the `sat` parameter / 100)
 * @returns {SaturationHQResult}
 */
export function applySaturationHQ(data, amount) {
  const a = clamp(amount, 0, 1);
  if (a <= 0) {
    return {
      applied: false,
      amount: 0,
      oversampling: 1,
      prototypeTaps: 0,
      preGain: 1,
      makeupGain: 1,
      mitigationLowpassBypassed: false,
    };
  }

  const sr = data.sampleRate;
  const L = saturationOversamplingFor(sr);
  const staging = saturationGainStaging(a);
  const f = makeSaturationTransfer(a);

  // Same DC block the live stage uses: RBJ high-pass, 5 Hz, Q 0.7071. Kills the subsonic
  // shift the asymmetric curve would otherwise turn into wasted headroom.
  const dcBlock = designBiquad('highpass', 5, 0.7071, 0, sr);

  const pre = staging.preGain;
  const post = staging.postGain;
  const shaped = (v) => f(pre * v);

  for (const ch of data.channels) {
    processBiquadCascade(ch, [dcBlock]);
    if (L > 1) {
      oversampledShape(ch, L, shaped);
      for (let i = 0; i < ch.length; i++) ch[i] *= post;
    } else {
      // ≥176.4 kHz: the folding frequency is already far above audible harmonic content.
      for (let i = 0; i < ch.length; i++) ch[i] = post * shaped(ch[i]);
    }
  }

  return {
    applied: true,
    amount: a,
    oversampling: L,
    prototypeTaps: L > 1 ? 2 * FIR_HALF * L + 1 : 0,
    preGain: pre,
    makeupGain: post,
    mitigationLowpassBypassed: true,
  };
}
