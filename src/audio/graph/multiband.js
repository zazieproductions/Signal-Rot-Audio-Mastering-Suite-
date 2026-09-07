/**
 * Three-band mastering compressor.
 *
 * ── Crossover topology ───────────────────────────────────────────────────────────────
 * Two cascaded Butterworth biquads give a 4th-order Linkwitz-Riley section. A Butterworth
 * section needs linear Q = 1/√2, but `BiquadFilterNode.Q` is resonance in **dB** for
 * `lowpass`/`highpass`, so the nodes get `BUTTERWORTH_Q_DB` = 20·log10(1/√2) ≈ −3.0103 —
 * assigning 0.7071 builds a section that peaks +0.71 dB and sums +7.4 dB at the corner
 * (issues #19 / #12). The `allpass` compensation keeps linear Q = 1/√2: allpass Q *is*
 * linear in the node, and the LR4-sum identity requires the same linear Q throughout.
 * An LR4 two-way split reconstructs with **flat magnitude** and an **all-pass phase**:
 *
 *     LP4(f) + HP4(f)  =  all-pass of order 2   (|H| = 1, arg H sweeps 360°)
 *
 * The bands are built *serially*, not in parallel:
 *
 *     low   = LP4(fLow)  → AP2(fHigh)     ← all-pass compensation, see below
 *     mid   = HP4(fLow)  → LP4(fHigh)
 *     high  = HP4(fLow)  → HP4(fHigh)
 *
 * The all-pass on the low band is what makes the three-way sum correct. Without it the
 * low band has not seen the second crossover's phase rotation while the mid and high
 * bands have, so their sum is only *approximately* flat and the error grows as the
 * crossovers move closer together. With it the reconstruction is exact by construction:
 *
 *     low + mid + high = LP4(fLow)·AP2(fHigh) + HP4(fLow)·[LP4(fHigh) + HP4(fHigh)]
 *                      = LP4(fLow)·AP2(fHigh) + HP4(fLow)·AP2(fHigh)
 *                      = AP2(fHigh)·[LP4(fLow) + HP4(fLow)]
 *                      = AP2(fLow)·AP2(fHigh)
 *
 * — an exact all-pass at every frequency, with no approximation anywhere.
 *
 * ── The dry path ─────────────────────────────────────────────────────────────────────
 * That total response is all-pass, **not unity**. Mixing a straight dry wire against it
 * for parallel compression is a comb filter with 30 dB notches at both crossovers — this
 * was the single worst defect in the audited implementation (see `docs/AUDIT.md` §3.1 C).
 *
 * The dry path here runs through `AP2(fLow) · AP2(fHigh)`: bit-for-bit the same transfer
 * function the band sum collapses to, with no dynamics in it. Wet and dry are then
 * phase-coherent and the mix control does what its label says.
 * `tests/dsp/multiband-crossover.test.js` asserts flat reconstruction at every mix
 * position and reproduces the old failure for comparison.
 *
 * ── Delay matching ───────────────────────────────────────────────────────────────────
 * `DynamicsCompressorNode` is a *look-ahead* compressor: every engine delays the signal
 * by a fixed pre-delay (`kPreDelay = 0.006 s` in Chromium, and the same constant in the
 * WebKit/Gecko kernels). Phase coherence is not enough for a parallel mix — a wet path
 * arriving late against an undelayed dry path is a delay comb with notches starting at
 * 83 Hz, which sits exactly in the kick-fundamental and body region
 * (`docs/GAIN-STRUCTURE-AUDIT.md` §2.4). The dry path therefore also runs through a
 * `DelayNode` before the all-passes. All three band compressors share the same
 * look-ahead, so the band *sum* is internally consistent; only the dry path needs the
 * explicit delay.
 *
 * The delay is matched to the *measured* compressor latency of the running engine
 * (`resolveDryDelaySeconds`), not hard-coded: real browsers measure 6.000 ms, but other
 * engines differ (the headless QA engine's reimplementation measures 8.7 / 8.0 / 6.7 /
 * 6.0 ms at 44.1 / 48 / 96 / 192 kHz), and a fixed 6 ms against those is a 2 ms comb at
 * partial mix. When the latency cannot be measured the documented 6 ms constant is used.
 *
 * ── Compressor nodes ─────────────────────────────────────────────────────────────────
 * The per-band dynamics use `DynamicsCompressorNode`. That node is a fixed-topology
 * feed-forward compressor with its own internal detector, a fixed 6 ms look-ahead and —
 * critically — a fixed, non-configurable **make-up gain** of
 * `pow(1 / Saturate(1, k), 0.6)` that is a pure function of (threshold, knee, ratio)
 * (see `src/audio/dsp/dynamics-compressor.js`). It is **not** a pure downward
 * compressor, and it is **not** a mastering-grade compressor. It is used because it is
 * the only per-sample dynamics processor available without an `AudioWorklet`, and it
 * does glue convincingly at modest settings — but every band carries an exact
 * compensating gain node (`specMakeupLow/Mid/High`) so the browser's fixed make-up is
 * cancelled and the *only* make-up in the signal path is the user's `mbAutoMakeup`.
 * `docs/GAIN-STRUCTURE-AUDIT.md` §2.2 measures what that hidden gain was doing
 * (+0.8 … +15.4 dB per band, stacked on top of each other). `reduction` is still
 * metered per band so the user can see exactly how much is happening.
 */

import { MB_CROSSOVER_LOW, MB_CROSSOVER_HIGH } from '../../app/constants.js';
import {
  designBiquad,
  designNodeBiquad,
  cascadeResponse,
  cadd,
  cabs,
  BUTTERWORTH_Q_DB,
} from '../dsp/biquad.js';
import { measureCompressorLatency } from '../context.js';

/** Ballistics presets. Attack/release in seconds. */
export const MB_BALLISTICS = Object.freeze({
  fast: { attack: 0.006, release: 0.12, label: 'Fast — transparent grip' },
  med: { attack: 0.015, release: 0.3, label: 'Medium — musical glue' },
  slow: { attack: 0.03, release: 0.45, label: 'Slow — deep breathing' },
});

/**
 * Documented look-ahead pre-delay of `DynamicsCompressorNode` in seconds, from the
 * engine sources (`kPreDelay = 0.006f` in Chromium, identical constant in WebKit/Gecko).
 * This is the dry-path delay when the running engine's latency cannot be measured;
 * production graphs resolve the real value via `resolveDryDelaySeconds`.
 */
export const MB_COMPRESSOR_LOOKAHEAD_S = 0.006;

/**
 * Resolve the dry-path delay for a render at `sampleRate`: the measured compressor
 * latency of the running engine, or `MB_COMPRESSOR_LOOKAHEAD_S` when unmeasurable.
 * Memoised per sample rate by the underlying probe — repeated calls are free.
 *
 * @param {number} sampleRate
 * @returns {Promise<{seconds:number, measured:boolean, latencySeconds:number|null}>}
 *   `measured` tells whether the value came from the engine or the documented default,
 *   so the render report can say which (a guessed 6 ms and a measured 6.000 ms are not
 *   the same claim).
 */
export async function resolveDryDelay(sampleRate) {
  let latency = null;
  try {
    latency = await measureCompressorLatency(sampleRate);
  } catch {
    latency = null;
  }
  if (latency == null || !(latency >= 0) || latency > 0.05) {
    return {
      seconds: MB_COMPRESSOR_LOOKAHEAD_S,
      measured: false,
      latencySeconds: latency,
    };
  }
  return { seconds: latency, measured: true, latencySeconds: latency };
}

/** `resolveDryDelay` reduced to the delay value, for graph wiring. */
export async function resolveDryDelaySeconds(sampleRate) {
  return (await resolveDryDelay(sampleRate)).seconds;
}

/**
 * Map the 0–100 "amount" control onto threshold and ratio.
 *
 * Exposed as a pure function so the UI can display the *actual* threshold and ratio next
 * to the slider instead of a meaningless 0–100 number, and so the mapping is testable.
 *
 * @param {number} amount 0..100
 * @returns {{thresholdDb:number, ratio:number, kneeDb:number}}
 */
export function bandAmountToSettings(amount) {
  const a = Math.max(0, Math.min(100, amount));
  return {
    // 0 → 0 dB (the compressor never engages), 100 → −24 dB (firm, obvious compression).
    // `a === 0 ? 0` avoids producing negative zero, which would show up as "-0" in the
    // render report JSON.
    thresholdDb: a === 0 ? 0 : -a * 0.24,
    // 1:1 → 3:1. Above about 3:1 a mastering multiband stops sounding like glue.
    ratio: 1 + a * 0.02,
    kneeDb: 12,
  };
}

/** Build an LR4 section (two cascaded Butterworth biquads, node Q in dB). */
function lr4Section(ctx, type, freq) {
  const a = ctx.createBiquadFilter();
  a.type = type;
  a.frequency.value = freq;
  a.Q.value = BUTTERWORTH_Q_DB;
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = freq;
  b.Q.value = BUTTERWORTH_Q_DB;
  a.connect(b);
  return { in: a, out: b, sections: [a, b] };
}

/**
 * @typedef {object} MultibandNodes
 * @property {GainNode} input
 * @property {GainNode} output
 * @property {DynamicsCompressorNode} compLow
 * @property {DynamicsCompressorNode} compMid
 * @property {DynamicsCompressorNode} compHigh
 * @property {GainNode} specMakeupLow  exact inverse of the node's fixed spec make-up
 * @property {GainNode} specMakeupMid
 * @property {GainNode} specMakeupHigh
 * @property {GainNode} lowMakeup     optional user auto make-up (the only make-up heard)
 * @property {GainNode} midMakeup
 * @property {GainNode} highMakeup
 * @property {GainNode} lowSolo
 * @property {GainNode} midSolo
 * @property {GainNode} highSolo
 * @property {DelayNode} dryDelay     delay-matches the dry path to the compressor look-ahead
 * @property {GainNode} wet
 * @property {GainNode} dry
 * @property {BiquadFilterNode[]} crossoverNodes
 */

/**
 * Construct the multiband section.
 *
 * @param {BaseAudioContext} ctx
 * @param {object} [opts]
 * @param {number} [opts.lowHz]
 * @param {number} [opts.highHz]
 * @param {number} [opts.dryDelaySeconds] dry-path delay; default is the documented
 *   6 ms constant, production renders pass `resolveDryDelaySeconds(sampleRate)`
 * @returns {MultibandNodes}
 */
export function buildMultiband(ctx, opts = {}) {
  const fLow = opts.lowHz ?? MB_CROSSOVER_LOW;
  const fHigh = opts.highHz ?? MB_CROSSOVER_HIGH;
  const dryDelaySeconds = opts.dryDelaySeconds ?? MB_COMPRESSOR_LOOKAHEAD_S;

  const input = ctx.createGain();
  const output = ctx.createGain();
  const wet = ctx.createGain();
  const dry = ctx.createGain();
  wet.gain.value = 0;
  dry.gain.value = 1;

  // ── Band split ──
  const lpLow = lr4Section(ctx, 'lowpass', fLow);
  const hpLow = lr4Section(ctx, 'highpass', fLow);
  const lpHigh = lr4Section(ctx, 'lowpass', fHigh);
  const hpHigh = lr4Section(ctx, 'highpass', fHigh);
  // All-pass compensation for the low band (matches AP4 at fHigh).
  const apHighForLow = lr4AllpassNodes(ctx, fHigh);

  input.connect(lpLow.in);
  lpLow.out.connect(apHighForLow.in);

  input.connect(hpLow.in);
  hpLow.out.connect(lpHigh.in);
  hpLow.out.connect(hpHigh.in);

  // ── Per-band dynamics, spec make-up compensation, solo/bypass and make-up ──
  const mk = () => {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = 0;
    c.ratio.value = 1;
    c.knee.value = 12;
    c.attack.value = 0.015;
    c.release.value = 0.3;
    return c;
  };
  const compLow = mk();
  const compMid = mk();
  const compHigh = mk();

  const lowSolo = ctx.createGain();
  const midSolo = ctx.createGain();
  const highSolo = ctx.createGain();
  // Exact inverse of the browser's fixed spec make-up, set by `applyParameters` from the
  // same (threshold, knee, ratio) the compressor was given. Ratio 1:1 ⇒ gain 1 ⇒ the
  // node is bit-transparent when a band is inactive or bypassed.
  const specMakeupLow = ctx.createGain();
  const specMakeupMid = ctx.createGain();
  const specMakeupHigh = ctx.createGain();
  specMakeupLow.gain.value = 1;
  specMakeupMid.gain.value = 1;
  specMakeupHigh.gain.value = 1;
  const lowMakeup = ctx.createGain();
  const midMakeup = ctx.createGain();
  const highMakeup = ctx.createGain();

  apHighForLow.out.connect(compLow);
  compLow.connect(specMakeupLow);
  specMakeupLow.connect(lowMakeup);
  lowMakeup.connect(lowSolo);
  lowSolo.connect(wet);

  lpHigh.out.connect(compMid);
  compMid.connect(specMakeupMid);
  specMakeupMid.connect(midMakeup);
  midMakeup.connect(midSolo);
  midSolo.connect(wet);

  hpHigh.out.connect(compHigh);
  compHigh.connect(specMakeupHigh);
  specMakeupHigh.connect(highMakeup);
  highMakeup.connect(highSolo);
  highSolo.connect(wet);

  // ── Delay-matched dry path ──
  // The compressors look ahead, so the wet path emerges late. The dry path carries the
  // same delay so a parallel mix is delay-matched as well as phase-matched.
  const dryDelay = ctx.createDelay(0.05);
  dryDelay.delayTime.value = dryDelaySeconds;
  const dryAp1 = lr4AllpassNodes(ctx, fLow);
  const dryAp2 = lr4AllpassNodes(ctx, fHigh);
  input.connect(dryDelay);
  dryDelay.connect(dryAp1.in);
  dryAp1.out.connect(dryAp2.in);
  dryAp2.out.connect(dry);

  wet.connect(output);
  dry.connect(output);

  return {
    input,
    output,
    compLow,
    compMid,
    compHigh,
    specMakeupLow,
    specMakeupMid,
    specMakeupHigh,
    lowSolo,
    midSolo,
    highSolo,
    lowMakeup,
    midMakeup,
    highMakeup,
    dryDelay,
    wet,
    dry,
    crossoverFrequencies: { low: fLow, high: fHigh },
    crossoverNodes: [
      ...lpLow.sections,
      ...hpLow.sections,
      ...lpHigh.sections,
      ...hpHigh.sections,
      ...apHighForLow.sections,
      ...dryAp1.sections,
      ...dryAp2.sections,
    ],
  };
}

/**
 * The all-pass equivalent of an LR4 crossover sum.
 *
 * In the analogue prototype, with `LP2 = 1/(s²+√2s+1)` and `HP2 = s²/(s²+√2s+1)`:
 *
 *     LP4 + HP4 = LP2² + HP2² = (1 + s⁴)/(s²+√2s+1)²
 *               = (s²−√2s+1)(s²+√2s+1)/(s²+√2s+1)²
 *               = (s²−√2s+1)/(s²+√2s+1)
 *
 * which is **one** 2nd-order all-pass at the same corner frequency and Q = 1/√2 — the
 * numerator's zeros are the denominator's poles mirrored into the right half-plane. Note
 * that `LP2 + HP2` on its own is *not* all-pass (it is a notch at f₀); the fourth-order
 * pairing is what produces the cancellation. Cascading two all-pass sections here would
 * double the phase rotation and reintroduce the comb this whole design exists to remove.
 */
function lr4AllpassNodes(ctx, freq) {
  const a = ctx.createBiquadFilter();
  a.type = 'allpass';
  a.frequency.value = freq;
  // Linear: allpass Q is linear in the node (verified by phase measurement), and the
  // LR4-sum identity needs this to be the same linear Q as the crossover sections.
  a.Q.value = Math.SQRT1_2;
  return { in: a, out: a, sections: [a] };
}

/* ────────────────────────────────────────────────────────────────────────────────────
 * Analytical diagnostics
 *
 * These mirror the node graph above using the same RBJ coefficient formulae the Web Audio
 * `BiquadFilterNode` uses, *in the node's Q convention* (`designNodeBiquad`), so a test
 * on these functions is a test of the real crossover. Modelling the graph with linear Q
 * here while the nodes take dB is exactly the mistake that hid issue #19.
 * ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * Complex response of the serial three-band split plus the phase-matched dry path.
 *
 * @param {number} freq
 * @param {number} sampleRate
 * @param {object} [opts]
 * @param {number} [opts.lowHz]
 * @param {number} [opts.highHz]
 * @param {number} [opts.mix] 0 = fully dry, 1 = fully wet
 * @param {number[]} [opts.bandGains] linear gain per band [low, mid, high], default all 1
 * @returns {{low:[number,number], mid:[number,number], high:[number,number], sum:[number,number], total:[number,number]}}
 */
export function multibandResponse(freq, sampleRate, opts = {}) {
  const fLow = opts.lowHz ?? MB_CROSSOVER_LOW;
  const fHigh = opts.highHz ?? MB_CROSSOVER_HIGH;
  const mix = opts.mix ?? 1;
  const [gL, gM, gH] = opts.bandGains ?? [1, 1, 1];

  // Node Q values, exactly as `lr4Section`/`lr4AllpassNodes` assign them.
  const lp = (f) => designNodeBiquad('lowpass', f, BUTTERWORTH_Q_DB, 0, sampleRate);
  const hp = (f) => designNodeBiquad('highpass', f, BUTTERWORTH_Q_DB, 0, sampleRate);
  const ap = (f) => designNodeBiquad('allpass', f, Math.SQRT1_2, 0, sampleRate);

  const low = cascadeResponse([lp(fLow), lp(fLow), ap(fHigh)], freq, sampleRate);
  const mid = cascadeResponse([hp(fLow), hp(fLow), lp(fHigh), lp(fHigh)], freq, sampleRate);
  const high = cascadeResponse([hp(fLow), hp(fLow), hp(fHigh), hp(fHigh)], freq, sampleRate);
  const dry = cascadeResponse([ap(fLow), ap(fHigh)], freq, sampleRate);

  const scale = (c, g) => [c[0] * g, c[1] * g];
  const sum = cadd(cadd(scale(low, gL), scale(mid, gM)), scale(high, gH));
  const total = cadd(scale(sum, mix), scale(dry, 1 - mix));

  return { low, mid, high, sum, total };
}

/**
 * The *previous* parallel topology, kept so the regression test can demonstrate the bug
 * it fixed rather than merely asserting the new behaviour.
 */
export function legacyMultibandResponse(freq, sampleRate, opts = {}) {
  const fLow = opts.lowHz ?? MB_CROSSOVER_LOW;
  const fHigh = opts.highHz ?? MB_CROSSOVER_HIGH;
  const mix = opts.mix ?? 1;
  // Ideal linear Q on purpose: this models the old *topology* with ideal filters to
  // demonstrate the dry-wire comb, independently of node Q units (issue #19).
  const Q = Math.SQRT1_2;
  const lp = (f) => designBiquad('lowpass', f, Q, 0, sampleRate);
  const hp = (f) => designBiquad('highpass', f, Q, 0, sampleRate);

  const low = cascadeResponse([lp(fLow), lp(fLow)], freq, sampleRate);
  const mid = cascadeResponse([hp(fLow), hp(fLow), lp(fHigh), lp(fHigh)], freq, sampleRate);
  const high = cascadeResponse([hp(fHigh), hp(fHigh)], freq, sampleRate);
  const sum = cadd(cadd(low, mid), high);
  // Dry was a straight wire: [1, 0].
  return [sum[0] * mix + (1 - mix), sum[1] * mix];
}

/**
 * Sample the reconstruction magnitude over a log frequency grid.
 * Used by the crossover diagnostic in the UI and by the tests.
 *
 * @returns {{freqs: Float64Array, magnitudeDb: Float64Array, worstDeviationDb: number, worstFreq: number}}
 */
export function crossoverReconstruction(sampleRate, opts = {}) {
  const points = opts.points ?? 512;
  const fMin = opts.fMin ?? 20;
  const fMax = Math.min(opts.fMax ?? 22000, sampleRate / 2 - 1);
  const freqs = new Float64Array(points);
  const magnitudeDb = new Float64Array(points);
  let worst = 0;
  let worstFreq = 0;
  for (let i = 0; i < points; i++) {
    const f = fMin * Math.pow(fMax / fMin, i / (points - 1));
    freqs[i] = f;
    const r = multibandResponse(f, sampleRate, opts);
    const db = 20 * Math.log10(Math.max(1e-12, cabs(r.total)));
    magnitudeDb[i] = db;
    if (Math.abs(db) > Math.abs(worst)) {
      worst = db;
      worstFreq = f;
    }
  }
  return { freqs, magnitudeDb, worstDeviationDb: worst, worstFreq };
}
