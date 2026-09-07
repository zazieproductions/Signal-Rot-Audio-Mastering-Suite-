/**
 * Biquad filter design, frequency response and time-domain processing.
 *
 * Coefficient formulae follow Robert Bristow-Johnson's *Cookbook formulae for audio EQ
 * biquad filter coefficients*, which is also the normative reference for the Web Audio
 * `BiquadFilterNode` (see the Web Audio API specification, "Filter characteristics").
 * Designing here with the same formulae means an offline analysis of a filter matches the
 * `BiquadFilterNode` the live graph actually instantiates — that is what makes the
 * crossover-reconstruction diagnostic meaningful rather than decorative.
 *
 * ── Q units: read this before touching any filter ────────────────────────────────
 * `designBiquad` takes a **linear** Q (the RBJ cookbook convention: a Butterworth
 * section is Q = 1/√2 ≈ 0.7071). `BiquadFilterNode.Q`, however, is **not** linear for
 * every type. Measured in the headless engine (and corroborated by the Chromium A-6
 * capture for lowpass/highpass):
 *
 *   lowpass / highpass   Q is resonance in **dB**: gain at fc equals Q exactly, so a
 *                        Butterworth section needs Q = 20·log10(1/√2) = −3.0103, and
 *                        Q = 0.7071 builds a section that peaks +0.71 dB (issue #19).
 *   allpass / peaking / bandpass   Q is **linear**, matching `designBiquad` exactly.
 *   lowshelf / highshelf           Q is **ignored** (fixed S = 1 slope, which coincides
 *                        with RBJ-linear Q = 0.7071 — the value every tone shelf uses).
 *
 * `designNodeBiquad` below models *what the node builds* from a node Q value; anything
 * that claims to predict graph behaviour must use it, not `designBiquad` directly.
 * Pure-offline analysis with no node counterpart (e.g. the mono-compatibility band
 * split) keeps using `designBiquad` with linear Q.
 *
 * Coefficients are stored normalised by a0 as `{b0, b1, b2, a1, a2}` and the difference
 * equation is the Direct Form I:
 *
 *   y[n] = b0·x[n] + b1·x[n−1] + b2·x[n−2] − a1·y[n−1] − a2·y[n−2]
 */

/**
 * @typedef {{b0:number,b1:number,b2:number,a1:number,a2:number}} BiquadCoeffs
 * @typedef {'lowpass'|'highpass'|'bandpass'|'peaking'|'lowshelf'|'highshelf'|'allpass'|'notch'} BiquadType
 */

/**
 * The `BiquadFilterNode.Q` value of a Butterworth (maximally flat) lowpass/highpass
 * section: 20·log10(1/√2) ≈ −3.0103. Every `lr4`-style helper and every flat-intent
 * lowpass/highpass in the graph uses this — never a bare 0.7071, which the node reads
 * as +0.71 dB of resonance (issue #19).
 */
export const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2);

/** Linear Q → node Q (dB) for lowpass/highpass. */
export const linearQToDb = (qLinear) => 20 * Math.log10(Math.max(1e-9, qLinear));

/** Node Q (dB) → linear Q for lowpass/highpass. */
export const dbQToLinear = (qDb) => Math.pow(10, qDb / 20);

/**
 * Design a biquad.
 *
 * @param {BiquadType} type
 * @param {number} freq   centre / corner frequency in Hz
 * @param {number} Q      quality factor (shelves: shelf slope parameter S = 1 at Q = 0.7071)
 * @param {number} gainDb peaking/shelf gain in dB (ignored by other types)
 * @param {number} sampleRate
 * @returns {BiquadCoeffs}
 */
export function designBiquad(type, freq, Q, gainDb, sampleRate) {
  // Clamp to a stable region: the bilinear transform degenerates at and above Nyquist.
  const nyquist = sampleRate / 2;
  const f0 = Math.min(Math.max(freq, 1e-4), nyquist * 0.999);
  const q = Math.max(1e-4, Q);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * q);

  let b0, b1, b2, a0, a1, a2;

  switch (type) {
    case 'lowpass':
      b0 = (1 - cw) / 2;
      b1 = 1 - cw;
      b2 = (1 - cw) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cw) / 2;
      b1 = -(1 + cw);
      b2 = (1 + cw) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
    case 'bandpass': // constant 0 dB peak gain
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
    case 'notch':
      b0 = 1;
      b1 = -2 * cw;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
    case 'allpass':
      b0 = 1 - alpha;
      b1 = -2 * cw;
      b2 = 1 + alpha;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
    case 'peaking': {
      const A = Math.pow(10, gainDb / 40);
      b0 = 1 + alpha * A;
      b1 = -2 * cw;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cw;
      a2 = 1 - alpha / A;
      break;
    }
    case 'lowshelf': {
      const A = Math.pow(10, gainDb / 40);
      const sqA2a = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cw + sqA2a);
      b1 = 2 * A * (A - 1 - (A + 1) * cw);
      b2 = A * (A + 1 - (A - 1) * cw - sqA2a);
      a0 = A + 1 + (A - 1) * cw + sqA2a;
      a1 = -2 * (A - 1 + (A + 1) * cw);
      a2 = A + 1 + (A - 1) * cw - sqA2a;
      break;
    }
    case 'highshelf': {
      const A = Math.pow(10, gainDb / 40);
      const sqA2a = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cw + sqA2a);
      b1 = -2 * A * (A - 1 + (A + 1) * cw);
      b2 = A * (A + 1 + (A - 1) * cw - sqA2a);
      a0 = A + 1 - (A - 1) * cw + sqA2a;
      a1 = 2 * (A - 1 - (A + 1) * cw);
      a2 = A + 1 - (A - 1) * cw - sqA2a;
      break;
    }
    default:
      throw new Error(`designBiquad: unknown type "${type}"`);
  }

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * Design the biquad a `BiquadFilterNode` actually builds from a node Q value.
 *
 * This is `designBiquad` with the node's Q convention applied: dB→linear conversion
 * for `lowpass`/`highpass`, linear pass-through otherwise (see the module header for
 * the per-type semantics table). Use this — not `designBiquad` — for anything that
 * models graph behaviour, and pass the same Q constant the graph assigns to the node.
 *
 * Shelf caveat: the headless engine ignores shelf Q (fixed S = 1); this function passes
 * shelf Q through to the RBJ formulae, which matches the node exactly at Q = 0.7071
 * (the value every production shelf uses) and is unverified against Chromium elsewhere.
 *
 * @param {BiquadType} type
 * @param {number} freq corner / centre frequency in Hz
 * @param {number} nodeQ the value assigned to `BiquadFilterNode.Q`
 * @param {number} gainDb peaking/shelf gain in dB (ignored by other types)
 * @param {number} sampleRate
 * @returns {BiquadCoeffs}
 */
export function designNodeBiquad(type, freq, nodeQ, gainDb, sampleRate) {
  const q =
    type === 'lowpass' || type === 'highpass' ? dbQToLinear(nodeQ) : nodeQ;
  return designBiquad(type, freq, q, gainDb, sampleRate);
}

/**
 * Complex frequency response H(e^{jω}) of one biquad at `freq`.
 * @returns {[number, number]} `[real, imaginary]`
 */
export function biquadResponse(c, freq, sampleRate) {
  const w = (2 * Math.PI * freq) / sampleRate;
  const c1 = Math.cos(-w);
  const s1 = Math.sin(-w);
  const c2 = Math.cos(-2 * w);
  const s2 = Math.sin(-2 * w);
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2;
  const ni = c.b1 * s1 + c.b2 * s2;
  const dr = 1 + c.a1 * c1 + c.a2 * c2;
  const di = c.a1 * s1 + c.a2 * s2;
  const den = dr * dr + di * di || Number.MIN_VALUE;
  return [(nr * dr + ni * di) / den, (ni * dr - nr * di) / den];
}

/** Complex multiply. */
export const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
/** Complex add. */
export const cadd = (a, b) => [a[0] + b[0], a[1] + b[1]];
/** Complex magnitude. */
export const cabs = (a) => Math.hypot(a[0], a[1]);

/** Cascade response of a chain of biquads at one frequency. */
export function cascadeResponse(coeffsList, freq, sampleRate) {
  let acc = [1, 0];
  for (const c of coeffsList) acc = cmul(acc, biquadResponse(c, freq, sampleRate));
  return acc;
}

/**
 * Process a signal in place through a biquad cascade, Direct Form I.
 * State is per-call, so a stream must be processed in one pass (which is how every
 * offline routine in this codebase uses it).
 *
 * @param {Float32Array} data modified in place
 * @param {BiquadCoeffs[]} coeffsList
 */
export function processBiquadCascade(data, coeffsList) {
  for (const c of coeffsList) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < data.length; i++) {
      const x = data[i];
      const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      data[i] = y;
    }
  }
  return data;
}
