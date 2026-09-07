/**
 * Stereo correlation, mono-compatibility and phase-risk analysis.
 *
 * The correlation coefficient reported here is the Pearson correlation between L and R
 * over a window:
 *
 *   r = Σ(L·R) / √(ΣL² · ΣR²)
 *
 *   r = +1  identical channels (mono)
 *   r =  0  uncorrelated (fully decorrelated stereo — still mono-safe in level terms)
 *   r = −1  polarity-inverted (cancels completely in mono)
 *
 * A correlation meter alone is not a mono-compatibility test: a signal can sit at r ≈ 0
 * and still lose a specific band entirely when summed. `monoCompatibility()` therefore
 * measures the actual level lost by summing, per band, which is what an engineer checking
 * a club or broadcast fold-down actually cares about.
 */

import { designBiquad, processBiquadCascade } from '../dsp/biquad.js';

/**
 * Pearson correlation of two channels over a window.
 * Returns 1 for a silent window (silence is trivially mono-compatible).
 */
export function correlation(left, right, start = 0, end = left.length) {
  const from = Math.max(0, start);
  const to = Math.min(left.length, right.length, end);
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = from; i < to; i++) {
    lr += left[i] * right[i];
    ll += left[i] * left[i];
    rr += right[i] * right[i];
  }
  const den = Math.sqrt(ll * rr);
  if (den < 1e-20) return 1;
  return lr / den;
}

/**
 * Correlation over time, one value per hop. Feeds the correlation-history strip.
 * @returns {{values: Float32Array, hopSeconds: number}}
 */
export function correlationEnvelope(data, windowSeconds = 0.05, hopSeconds = 0.025) {
  if (data.channels.length < 2) {
    return { values: new Float32Array(0), hopSeconds };
  }
  const [L, R] = data.channels;
  const win = Math.max(1, Math.round(windowSeconds * data.sampleRate));
  const hop = Math.max(1, Math.round(hopSeconds * data.sampleRate));
  const count = Math.max(0, Math.floor((data.length - win) / hop) + 1);
  const out = new Float32Array(count);
  for (let b = 0; b < count; b++) out[b] = correlation(L, R, b * hop, b * hop + win);
  return { values: out, hopSeconds: hop / data.sampleRate };
}

/** Octave-ish bands used for the mono-compatibility report. */
const MONO_BANDS = [
  { label: 'sub', lo: 20, hi: 60 },
  { label: 'bass', lo: 60, hi: 150 },
  { label: 'low-mid', lo: 150, hi: 400 },
  { label: 'mid', lo: 400, hi: 1500 },
  { label: 'presence', lo: 1500, hi: 5000 },
  { label: 'air', lo: 5000, hi: 16000 },
];

function bandpassCopy(channel, lo, hi, sampleRate) {
  const out = Float32Array.from(channel);
  // Linear Q on purpose: this is pure offline analysis with no `BiquadFilterNode`
  // counterpart, so the RBJ-linear convention of `designBiquad` is the right one here
  // (node Q units only apply to nodes — see `dsp/biquad.js`).
  processBiquadCascade(out, [
    designBiquad('highpass', lo, 0.7071, 0, sampleRate),
    designBiquad('highpass', lo, 0.7071, 0, sampleRate),
    designBiquad('lowpass', hi, 0.7071, 0, sampleRate),
    designBiquad('lowpass', hi, 0.7071, 0, sampleRate),
  ]);
  return out;
}

function energy(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return s;
}

/**
 * @typedef {object} MonoBandResult
 * @property {string} label
 * @property {number} lo
 * @property {number} hi
 * @property {number} correlation
 * @property {number} monoLossDb  level lost by summing to mono, negative = loss
 */

/**
 * Per-band mono-compatibility.
 *
 * For each band we compare the energy of `(L+R)/2` against the energy of the wider of the
 * two channels. −3 dB is what perfectly decorrelated material gives and is fine; anything
 * below about −6 dB in a band means real cancellation.
 *
 * @param {import('../dsp/audio-data.js').AudioData} data
 * @returns {{bands: MonoBandResult[], overallCorrelation: number, worstBand: MonoBandResult|null}}
 */
export function monoCompatibility(data) {
  if (data.channels.length < 2) {
    return { bands: [], overallCorrelation: 1, worstBand: null };
  }
  const [L, R] = data.channels;
  const sr = data.sampleRate;
  const nyquist = sr / 2;
  const bands = [];

  for (const b of MONO_BANDS) {
    if (b.lo >= nyquist) continue;
    const hi = Math.min(b.hi, nyquist * 0.98);
    const bl = bandpassCopy(L, b.lo, hi, sr);
    const br = bandpassCopy(R, b.lo, hi, sr);
    const eL = energy(bl);
    const eR = energy(br);
    const ref = Math.max(eL, eR);
    let eM = 0;
    for (let i = 0; i < bl.length; i++) {
      const m = (bl[i] + br[i]) * 0.5;
      eM += m * m;
    }
    bands.push({
      label: b.label,
      lo: b.lo,
      hi,
      correlation: correlation(bl, br),
      monoLossDb: ref < 1e-20 ? 0 : 10 * Math.log10(Math.max(1e-20, eM / ref)),
    });
  }

  let worst = null;
  for (const b of bands) if (!worst || b.monoLossDb < worst.monoLossDb) worst = b;

  return { bands, overallCorrelation: correlation(L, R), worstBand: worst };
}

/**
 * Turn a set of stereo parameters into human-readable phase warnings.
 *
 * Signal Rot deliberately allows destructive settings — that is the point of a rot
 * laboratory — so these are *warnings*, never silent corrections. The distinction the
 * brief asks for (intentional experimentation vs accidental technical failure) is drawn
 * by severity: `caution` is a legitimate creative zone, `danger` will not survive a
 * mono fold-down.
 *
 * @param {object} p parameter snapshot
 * @returns {{level:'ok'|'caution'|'danger', messages:string[]}}
 */
export function phaseRiskFromParameters(p) {
  const messages = [];
  let level = 'ok';
  const raise = (l) => {
    if (l === 'danger' || (l === 'caution' && level === 'ok')) level = l;
  };

  if (p.width > 1.8) {
    messages.push(`Width ${Math.round(p.width * 100)} % — side content dominates; expect
      significant level loss in mono.`);
    raise(p.width > 2.2 ? 'danger' : 'caution');
  }
  if (p.width > 1.3 && p.bassMono <= 0) {
    messages.push('Wide image with no bass-mono: low frequencies will wander and may cancel.');
    raise('caution');
  }
  if (p.haas > 8) {
    messages.push(
      `Haas delay ${p.haas.toFixed(1)} ms is applied to a whole channel — this comb-filters
       on mono fold-down.`,
    );
    raise(p.haas > 20 ? 'danger' : 'caution');
  }
  if (p.phaseRot > 0.5) {
    messages.push('Side all-pass blend above 50 % is an intentional comb filter.');
    raise('caution');
  }
  if (p.ms > 0.5) {
    messages.push('Mid/side balance strongly favours side — the centre image will be hollow.');
    raise('caution');
  }
  if (p.widthLow > 1.4) {
    messages.push('Low-band width above 140 % puts bass energy out of phase.');
    raise('danger');
  }
  return { level, messages };
}
