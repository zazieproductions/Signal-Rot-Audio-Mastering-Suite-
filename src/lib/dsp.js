/**
 * Signal Rot — core DSP primitives.
 * Pure functions operating on Float32Array / AudioBuffer-like data.
 * No DOM, no Web Audio node access: fully unit-testable in Node via Vitest.
 */
import { clamp } from './math.js';

/** Reference-match mastering bands (Hz). Eight log-spaced bands, 60 Hz → 12 kHz. */
export const MATCH_FREQS = [60, 150, 400, 1000, 2500, 5000, 8000, 12000];

/** Unity WaveShaper curve (linear -1..1 over 1024 points). */
export const IDENTITY_CURVE = (() => {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = (i / (n - 1)) * 2 - 1;
  return c;
})();

/**
 * Build a saturation WaveShaper curve (4096 points).
 *
 * Design goals (see ARCHITECTURE.md, "Saturation"):
 *  - Drive scales 1 → 2.2 (gentler than the original 1 → 4) for cleaner harmonics.
 *  - Quintic-blended soft clip (smoother knee than pure tanh at small signals).
 *  - DC-bias-free asymmetry: even harmonics without lifting the zero crossing.
 *  - Normalized to peak 1.0 so saturation never *adds* level — character only.
 */
export function makeSatCurve(amt) {
  if (amt <= 0) return IDENTITY_CURVE;
  const n = 4096;
  const c = new Float32Array(n);
  const k = 1 + amt * 1.2;
  const asym = amt * 0.06;
  let pk = 0;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const xs = x + asym * (x * x - x * x * x * x);
    const t = Math.tanh(k * xs);
    const blend = 1 - (1 - amt) * (1 - amt);
    const y = (1 - blend) * x + blend * t;
    c[i] = y;
    if (Math.abs(y) > pk) pk = Math.abs(y);
  }
  // Remove DC introduced by the asymmetric shaping term.
  let sum = 0;
  for (let i = 0; i < n; i++) sum += c[i];
  const dc = sum / n;
  for (let i = 0; i < n; i++) c[i] -= dc;
  // Normalize to unity peak.
  pk = 0;
  for (let i = 0; i < n; i++) if (Math.abs(c[i]) > pk) pk = Math.abs(c[i]);
  if (pk > 0 && pk !== 1) for (let i = 0; i < n; i++) c[i] /= pk;
  return c;
}

/* ---------------------------------------------------------------------------
 * True-peak estimation via 4× polyphase oversampling.
 *
 * Cubic (Catmull-Rom) interpolation overshoots ~13 % at 15 kHz and misreads the
 * limiter/meter near Nyquist. Instead we reconstruct with a 100-tap
 * Kaiser-windowed (β = 10) sinc interpolation filter, decomposed into 3 polyphase
 * branches (fractional offsets ¼, ½, ¾). Steady-state magnitude response is flat
 * (≤ 0.001 dB) to 18 kHz, −0.07 dB @ 19 kHz, −0.55 dB @ 20 kHz — no passband
 * overshoot. Startup ringing is the physical D/A reconstruction behavior, so the
 * estimate stays honest for band-limited content.
 * ------------------------------------------------------------------------- */

export const TP_OVERSAMPLE = 4;
export const TP_TAPS = 25; // taps per polyphase branch (100-tap filter total)

function i0(x) {
  let s = 1;
  let t = 1;
  let k = 1;
  while (t > 1e-12) {
    t *= (x * x) / (4 * k * k);
    s += t;
    k++;
  }
  return s;
}

function kaiserWindow(x, beta) {
  const t = 2 * x - 1;
  const arg = beta * Math.sqrt(Math.max(0, 1 - t * t));
  return i0(arg) / i0(beta);
}

/** Build the polyphase interpolation branches (fractional offsets 1/4, 1/2, 3/4). */
export function buildTruePeakPhases(oversample = TP_OVERSAMPLE, taps = TP_TAPS, beta = 10) {
  const fc = 1 / (2 * oversample);
  const Nt = oversample * taps;
  const C = (Nt - 1) / 2;
  const h = new Float32Array(Nt);
  let sum = 0;
  for (let n = 0; n < Nt; n++) {
    const x = 2 * fc * (n - C);
    let v = x === 0 ? 2 * fc : (2 * fc * Math.sin(Math.PI * x)) / (Math.PI * x);
    v *= kaiserWindow(n / (Nt - 1), beta);
    h[n] = v;
    sum += v;
  }
  // Interpolation gain is L (zero-stuffing attenuates by 1/L), so normalize to sum = L.
  for (let n = 0; n < Nt; n++) h[n] = (h[n] * oversample) / sum;
  const phases = [];
  for (let p = 1; p < oversample; p++) {
    const t = [];
    for (let n = p; n < Nt; n += oversample) t.push(h[n]);
    phases.push(Float32Array.from(t));
  }
  return phases;
}

const TP_PHASES = buildTruePeakPhases();

/** Max of |d[i]| and the three 4× interpolated values around sample i. */
export function truePeakAt(d, i) {
  let mx = Math.abs(d[i]);
  for (let p = 0; p < TP_PHASES.length; p++) {
    const c = TP_PHASES[p];
    let acc = 0;
    for (let k = 0; k < c.length; k++) {
      const idx = i - k;
      acc += (idx < 0 ? d[0] : d[idx]) * c[k];
    }
    const a = Math.abs(acc);
    if (a > mx) mx = a;
  }
  return mx;
}

/** Maximum 4× oversampled inter-sample peak over a single block of samples. */
export function truePeakBlock(d) {
  let mx = 0;
  const n = d.length;
  for (let i = 0; i < n; i++) {
    const v = truePeakAt(d, i);
    if (v > mx) mx = v;
  }
  return mx;
}

/**
 * Streaming maximum true peak across an AudioBuffer-like object, up to `maxLen` samples.
 * Uses a branch-free padded pass (one copy per channel) for speed on full tracks.
 */
export function truePeakFile(buf, maxLen = Infinity) {
  let mx = 0;
  const ch = buf.numberOfChannels;
  const n = Math.min(buf.length, maxLen);
  const T = TP_PHASES[0].length;
  const c0 = TP_PHASES[0];
  const c1 = TP_PHASES[1];
  const c2 = TP_PHASES[2];
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    const pd = new Float32Array(n + T - 1);
    pd.set(d.subarray(0, n), T - 1);
    for (let i = 0; i < n; i++) {
      let m = Math.abs(d[i]);
      const b = T - 1 + i;
      let acc = 0;
      for (let k = 0; k < T; k++) acc += pd[b - k] * c0[k];
      let a = Math.abs(acc);
      if (a > m) m = a;
      acc = 0;
      for (let k = 0; k < T; k++) acc += pd[b - k] * c1[k];
      a = Math.abs(acc);
      if (a > m) m = a;
      acc = 0;
      for (let k = 0; k < T; k++) acc += pd[b - k] * c2[k];
      a = Math.abs(acc);
      if (a > m) m = a;
      if (m > mx) mx = m;
    }
  }
  return mx;
}

/**
 * Transient shaper — sample-accurate differential-envelope processor.
 * Channel-linked detection (uses the max |sample| across channels) prevents stereo image wander.
 * Runs on the rendered buffer at export because it needs per-sample control.
 */
export function transientShape(buf, attackPct, sustainPct) {
  if (!attackPct && !sustainPct) return;
  const sr = buf.sampleRate;
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
  const aF = Math.exp(-1 / (sr * 0.001));
  const aS = Math.exp(-1 / (sr * 0.05));
  const rF = Math.exp(-1 / (sr * 0.02));
  const rS = Math.exp(-1 / (sr * 0.18));
  const atk = attackPct / 100;
  const sus = sustainPct / 100;
  let envF = 0;
  let envS = 0;
  for (let i = 0; i < n; i++) {
    let x = 0;
    for (let c = 0; c < ch; c++) {
      const v = Math.abs(chans[c][i]);
      if (v > x) x = v;
    }
    envF = x > envF ? x + (envF - x) * aF : x + (envF - x) * rF;
    envS = x > envS ? x + (envS - x) * aS : x + (envS - x) * rS;
    const tr = Math.max(0, envF - envS);
    const body = envS;
    let g = 1;
    if (envF > 1e-6) {
      g += atk * (tr / (envF + 1e-6)) * 0.9;
      g += sus * Math.min(1, body * 3) * 0.4;
    }
    g = clamp(g, 0.25, 2.2);
    for (let c = 0; c < ch; c++) chans[c][i] *= g;
  }
}

/**
 * ITU-R BS.1770 K-weighting as a cascade of two biquads:
 *   stage 1: +4 dB high shelf @ 1500 Hz (Q = 0.707)
 *   stage 2: highpass @ 38 Hz (Q = 0.5, RLB approximation)
 * Implemented directly (RBJ cookbook) so it is testable and sample-rate aware.
 */
export function kWeight(data, sr) {
  const out = new Float32Array(data.length);
  const q = 0.707;
  const G = 4;
  const A = Math.pow(10, G / 40);
  const f0 = 1500;
  const w0 = (2 * Math.PI * f0) / sr;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const al = sw / (2 * q);
  let b0 = A * ((A + 1) + (A - 1) * cw + 2 * Math.sqrt(A) * al);
  let b1 = -2 * A * ((A - 1) + (A + 1) * cw);
  let b2 = A * ((A + 1) + (A - 1) * cw - 2 * Math.sqrt(A) * al);
  let a0 = (A + 1) - (A - 1) * cw + 2 * Math.sqrt(A) * al;
  let a1 = 2 * ((A - 1) - (A + 1) * cw);
  let a2 = (A + 1) - (A - 1) * cw - 2 * Math.sqrt(A) * al;
  b0 /= a0;
  b1 /= a0;
  b2 /= a0;
  a1 /= a0;
  a2 /= a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  // Stage 2: highpass @ 38 Hz, Q = 0.5.
  x1 = x2 = y1 = y2 = 0;
  const fc = 38;
  const qh = 0.5;
  const wc = (2 * Math.PI * fc) / sr;
  const cwc = Math.cos(wc);
  const swc = Math.sin(wc);
  const alc = swc / (2 * qh);
  let hb0 = (1 + cwc) / 2;
  let hb1 = -(1 + cwc);
  let hb2 = (1 + cwc) / 2;
  let ha0 = 1 + alc;
  let ha1 = -2 * cwc;
  let ha2 = 1 - alc;
  hb0 /= ha0;
  hb1 /= ha0;
  hb2 /= ha0;
  ha1 /= ha0;
  ha2 /= ha0;
  for (let i = 0; i < out.length; i++) {
    const x = out[i];
    const y = hb0 * x + hb1 * x1 + hb2 * x2 - ha1 * y1 - ha2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

/**
 * ITU-R BS.1770 gated integrated loudness + LRA.
 *  - 400 ms blocks, 75 % overlap
 *  - absolute gate at -70 LUFS, then relative gate at -10 LU below the gated mean
 *  - channel weighting 1.0 per channel (correct for stereo L/R; LFE excluded upstream)
 * Returns { lufs, lra }. Silence yields lufs = -Infinity (honest "below measurable"), lra = 0.
 */
export function measureLUFS(buf) {
  const sr = buf.sampleRate;
  const n = buf.length;
  const ch = Math.min(2, buf.numberOfChannels);
  const kd = [];
  for (let c = 0; c < ch; c++) kd.push(kWeight(buf.getChannelData(c), sr));

  const blk = Math.max(1, Math.round(0.4 * sr));
  const hop = Math.max(1, Math.round(blk / 4));
  const loud = [];
  for (let s = 0; s + blk <= n; s += hop) {
    let z = 0;
    for (let c = 0; c < ch; c++) {
      let ms = 0;
      const d = kd[c];
      for (let i = 0; i < blk; i++) {
        const v = d[s + i];
        ms += v * v;
      }
      z += ms / blk;
    }
    loud.push(-0.691 + 10 * Math.log10(Math.max(1e-12, z)));
  }

  if (!loud.length) return { lufs: -Infinity, lra: 0 };

  // Absolute gate at -70 LUFS.
  const g1 = loud.filter((l) => l > -70);
  if (!g1.length) return { lufs: -Infinity, lra: 0 };
  const energy = (a) => a.reduce((s, l) => s + Math.pow(10, l / 10), 0) / a.length;
  const ungated = 10 * Math.log10(Math.max(1e-12, energy(g1)));

  // Relative gate at -10 LU below the absolute-gated mean.
  const relThr = ungated - 10;
  const g2 = g1.filter((l) => l > relThr);
  if (!g2.length) return { lufs: ungated, lra: 0 };
  const integ = 10 * Math.log10(Math.max(1e-12, energy(g2)));

  // LRA: 10th–95th percentile spread of the gated block distribution.
  const sorted = [...g2].sort((a, b) => a - b);
  const pct = (p) => sorted[clamp(Math.floor(p * sorted.length), 0, sorted.length - 1)];
  const lra = sorted.length ? Math.max(0, pct(0.95) - pct(0.1)) : 0;
  return { lufs: integ, lra };
}

/** In-place iterative radix-2 FFT (real/imaginary interleaved arrays). */
export function fftRadix2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

/**
 * Spectral fingerprint of an AudioBuffer-like object:
 * average magnitude over hann-windowed 8192-sample frames, summed into ±½-octave
 * windows around each mastering band. Returns an array of dB values or null if too short.
 */
export function spectrumFingerprint(buf, freqs = MATCH_FREQS) {
  const N = 8192;
  const sr = buf.sampleRate;
  const n = buf.length;
  const ch = buf.numberOfChannels;
  if (n < N) return null;
  const hann = new Float32Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const mag = new Float64Array(N / 2);
  const frames = Math.min(24, Math.max(4, Math.floor(n / N)));
  const hop = Math.max(1, Math.floor((n - N) / frames));
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let used = 0;
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    if (off + N > n) break;
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) s += data[c][off + i];
      re[i] = (s / ch) * hann[i];
      im[i] = 0;
    }
    fftRadix2(re, im);
    for (let k = 0; k < N / 2; k++) mag[k] += re[k] * re[k] + im[k] * im[k];
    used++;
  }
  if (!used) return null;
  return freqs.map((fc) => {
    const k0 = Math.max(1, Math.floor((fc / Math.SQRT2 / sr) * N));
    const k1 = Math.min(N / 2 - 1, Math.ceil((fc * Math.SQRT2 / sr) * N));
    let e = 0;
    let cnt = 0;
    for (let k = k0; k <= k1; k++) {
      e += mag[k];
      cnt++;
    }
    return 10 * Math.log10(e / Math.max(1, cnt) / used + 1e-12);
  });
}

/**
 * Derive a mastering-band correction curve from two fingerprints.
 *  - diff = ref − current
 *  - net-gain bias removed (so the curve does not silently change overall level)
 *  - clamped to ±8 dB per band
 * This is broad tonal matching — not cloning.
 */
export function computeMatchGains(cur, ref, maxDb = 8) {
  let diff = ref.map((r, i) => r - cur[i]);
  const mean = diff.reduce((a, b) => a + b, 0) / diff.length;
  diff = diff.map((d) => clamp(d - mean, -maxDb, maxDb));
  return diff.map((d) => Math.round(d * 10) / 10);
}
