/**
 * Regression thresholds.
 *
 * These are the numbers that turn a measurement delta into a flag. They are deliberately
 * conservative: a 0.3 dB loudness wiggle on a creative preset is not a defect, a 1.5 dB
 * unexplained loudness jump on a reference/clean path is.
 *
 * Browser nodes (`DynamicsCompressorNode`, `WaveShaperNode`) are implementation-defined.
 * Cross-browser deltas therefore have their own, looser, column.
 */

export const THRESHOLDS = Object.freeze({
  /** Unexplained integrated-loudness jump, LU. */
  loudnessDb: {
    reference: 1.0,
    creative: 3.0,
    browser: 1.5,
  },
  /** True-peak ceiling overshoot, dB. A violation is always a defect. */
  truePeakOvershootDb: 0.15,
  /** Crest-factor collapse (candidate much denser than baseline), dB. */
  crestCollapseDb: {
    reference: 3.0,
    creative: 8.0,
  },
  /** Spectral-band energy shift on a *neutral* path, dB. */
  spectralShiftDb: {
    reference: 1.5,
    creative: 6.0,
    browser: 2.5,
  },
  /** Spectral centroid jump, Hz. */
  centroidHz: {
    reference: 250,
    creative: 1500,
  },
  /** Mono-sum extra loss versus baseline, dB (more negative = worse). */
  monoLossDb: {
    reference: 1.5,
    creative: 6.0,
  },
  /** Correlation collapse (baseline − candidate). */
  correlationDrop: {
    reference: 0.15,
    creative: 0.5,
  },
  /**
   * Absolute DC as a fraction of full scale. Pink and sweeps carry a few thousandths
   * of DC by construction; 0.05 is "the chain introduced a bias you will hear as
   * offset / lost headroom".
   */
  dc: 0.05,
  /** DC growth vs baseline that is worth a note even when still under `dc`. */
  dcGrowth: 0.02,
  /** RMS difference, dB. */
  rmsDb: {
    reference: 1.0,
    creative: 4.0,
    browser: 1.5,
  },
  /** Cross-browser sample-peak difference, dB. */
  browserPeakDb: 1.0,
  /** Cross-browser compressor make-up disagreement vs analytic model, dB. */
  compressorMakeupModelDb: 0.75,
  /** Look-ahead disagreement vs the documented 6 ms, milliseconds. */
  compressorLookaheadMs: 1.5,
  /** Wet/dry impulse alignment, milliseconds. */
  dryWetAlignMs: 0.75,
  /** Crossover reconstruction notch depth at partial mix, dB (magnitude). */
  combNotchDb: 3.0,
});

export const SAMPLE_RATES = Object.freeze([44100, 48000, 88200, 96000, 176400, 192000]);

export const BENCH_RATES = Object.freeze([44100, 48000, 96000, 192000]);

export const BENCH_LAYOUTS = Object.freeze(['stereo', '7.1.4', '9.1.6', 'soniclab']);

export const CEILING_DEFAULT_DBTP = -1.0;
