/**
 * Analytic model of the fixed make-up gain inside `DynamicsCompressorNode`.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────
 * The Web Audio `DynamicsCompressorNode` is not a pure downward compressor: per the
 * specification and every implementation (Chromium
 * `third_party/blink/renderer/platform/audio/dynamics_compressor.cc`, WebKit and
 * Firefox's Blink-derived `DynamicsCompressorKernel`), the node applies a fixed,
 * non-configurable gain
 *
 *     linear_post_gain = pow(1 / Saturate(1, k), 0.6)
 *
 * where `Saturate(x, k)` is the node's static compression curve evaluated in the
 * *linear* domain and `k` is chosen so the exponential knee meets the constant-ratio
 * branch with a continuous slope. The gain depends only on (threshold, knee, ratio) —
 * never on the signal — but it is real: measured per-band it is worth +0.8 dB at a
 * ratio of 1.8:1 and +15.4 dB at 5:1 with a −36 dB threshold. A mastering chain that
 * treats the node as a pure compressor therefore adds a hidden, level- and
 * programme-independent boost in every band it engages. `docs/GAIN-STRUCTURE-AUDIT.md`
 * §2.2 traces the audible consequences (low-end make-up the user never asked for, a
 * smile curve across bands, parallel mixes that get louder as `mbMix` rises).
 *
 * This module reproduces the kernel's static-curve parameters *exactly* — the same
 * exponential knee, the same geometric-mean search for `k`, the same dB/linear
 * conversions — so the engine can place an exact compensating gain after each
 * compressor instead of measuring it. `dynamicsCompressorMakeupGainDb` returns the
 * make-up in dB (≥ 0); the node to insert after the compressor carries the inverse.
 *
 * The algorithm below mirrors the engine implementations rather than the simplified
 * straight-line estimate in the audit appendix, because compensation must cancel what
 * the browser actually does. The two agree when the knee is 0 (no soft-knee region).
 */

/** dB → linear amplitude. */
const linear = (db) => Math.pow(10, db / 20);
/** linear amplitude → dB, floored like the engines' ConvertLinearToDecibels(x, -1000). */
const db = (x) => 20 * Math.log10(Math.max(1e-12, x));

/**
 * The static curve's exponential knee:
 * `threshold + (1 − exp(−k·(x − threshold))) / k` above the threshold, linear below.
 * Mirrors `DynamicsCompressorKernel::kneeCurve`.
 *
 * @param {number} x linear input amplitude
 * @param {number} threshold linear threshold (from thresholdDb)
 * @param {number} k knee steepness
 */
function kneeCurve(x, threshold, k) {
  if (x < threshold) return x;
  return threshold + (1 - Math.exp(-k * (x - threshold))) / k;
}

/**
 * Approximate 1st derivative of the knee with both axes in dB — the inverse
 * compression ratio the ratio branch must meet at the knee end for C¹ continuity.
 * Mirrors `DynamicsCompressorKernel::slopeAt` (x·1.001 two-point difference).
 */
function slopeAt(x, threshold, k) {
  if (x < threshold) return 1;
  const x2 = x * 1.001;
  return (db(kneeCurve(x2, threshold, k)) - db(kneeCurve(x, threshold, k))) /
    (db(x2) - db(x));
}

/**
 * Solve for the knee steepness `k` that makes the knee meet the constant-ratio branch
 * with slope `1/ratio`. Mirrors `kAtSlope`: geometric-mean bisection, 15 iterations,
 * over the same [0.1, 10000] bracket the engines use.
 */
function kAtSlope(thresholdDb, kneeDb, ratio) {
  const x = linear(thresholdDb + kneeDb); // knee end, in linear amplitude
  const threshold = linear(thresholdDb);
  const desired = 1 / ratio;
  let minK = 0.1;
  let maxK = 10000;
  let k = 5;
  for (let i = 0; i < 15; i++) {
    const slope = slopeAt(x, threshold, k);
    if (slope < desired) {
      maxK = k; // k too high → slope too shallow
    } else {
      minK = k;
    }
    k = Math.sqrt(minK * maxK);
  }
  return k;
}

/**
 * The static compression curve at full scale, `Saturate(1, k)`.
 * Below the knee end the curve is the exponential knee; above it, a constant
 * `1/ratio` dB slope anchored at the knee end — exactly the engine's `saturate`.
 */
function saturateFullScale(thresholdDb, kneeDb, ratio) {
  const threshold = linear(thresholdDb);
  const kneeThreshold = linear(thresholdDb + kneeDb);
  const k = kAtSlope(thresholdDb, kneeDb, ratio);
  if (1 < kneeThreshold) return kneeCurve(1, threshold, k);
  const yKneeDb = db(kneeCurve(kneeThreshold, threshold, k));
  // Input 1.0 (0 dBFS) in dB is 0; the slope branch runs from the knee end up.
  const yDb = yKneeDb + (1 / ratio) * (0 - (thresholdDb + kneeDb));
  return linear(yDb);
}

/**
 * Fixed make-up gain of a `DynamicsCompressorNode`, in dB.
 *
 * This is the *positive* gain the node applies to every sample:
 * `makeupDb = 0.6 · −dB(Saturate(1, k))`, i.e. `20·log10(pow(1/Saturate(1,k), 0.6))`.
 * Insert a gain of `dbToGain(−makeupDb)` after the compressor to cancel it.
 *
 * @param {number} thresholdDb threshold in dB (≤ 0)
 * @param {number} kneeDb knee width in dB (≥ 0)
 * @param {number} ratio compression ratio (≥ 1; 1 = no compression)
 * @returns {number} make-up gain in dB, ≥ 0
 */
export function dynamicsCompressorMakeupDb(thresholdDb, kneeDb, ratio) {
  if (!Number.isFinite(thresholdDb) || !Number.isFinite(kneeDb) || !Number.isFinite(ratio)) {
    return 0;
  }
  if (ratio <= 1) return 0; // ratio 1:1 compresses nothing and the curve is unity
  const fullScaleDb = db(saturateFullScale(thresholdDb, kneeDb, ratio));
  // makeup = pow(1 / Saturate(1, k), 0.6) → in dB: −0.6 · fullScaleDb (fullScaleDb ≤ 0).
  return Math.max(0, -0.6 * fullScaleDb);
}

/**
 * Convenience: linear gain that cancels the node's fixed make-up.
 * @param {number} thresholdDb
 * @param {number} kneeDb
 * @param {number} ratio
 * @returns {number} gain in [0, 1], 1 when the compressor adds no make-up
 */
export function dynamicsCompressorMakeupCompensation(thresholdDb, kneeDb, ratio) {
  const makeupDb = dynamicsCompressorMakeupDb(thresholdDb, kneeDb, ratio);
  return Math.pow(10, -makeupDb / 20);
}
