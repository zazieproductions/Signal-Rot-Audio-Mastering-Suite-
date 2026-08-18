/**
 * Dither and noise shaping for fixed-point export.
 *
 * The original exporters rounded 32-bit float straight to 16- or 24-bit
 * integers. Undithered truncation correlates the quantisation error with the
 * signal, which is audible on fades and reverb tails as gritty, granular
 * distortion rather than benign noise — the classic reason a master sounds
 * fine in the DAW and grainy on the CD.
 *
 * Two options are provided:
 *
 *  - **TPDF** (triangular probability density, ±1 LSB): the safe default.
 *    Fully decorrelates the error and eliminates noise modulation, at the cost
 *    of ~4.8 dB more noise than truncation.
 *  - **Noise-shaped TPDF**: pushes that noise out of the ear's most sensitive
 *    region (~3-4 kHz) into the top octave, buying roughly 10-15 dB of
 *    perceived noise-floor improvement at 16-bit.
 *
 * At 24 bits the noise floor is already below anything audible, so dither is
 * off by default there and offered only for completeness. At 32-bit float no
 * quantisation happens at all and dither is never applied.
 */

/**
 * Second-order error-feedback noise shaping coefficients (Lipshitz et al.,
 * "Minimally Audible Noise Shaping"). Modest order keeps the shaped noise
 * well behaved without the ultrasonic build-up of aggressive curves.
 */
const SHAPING_COEFFS = [1.623, -0.982, 0.109];

/** Dither modes accepted by the encoders. */
export const DITHER_MODES = Object.freeze(['none', 'tpdf', 'shaped']);

/**
 * Create a stateful quantiser for one channel.
 *
 * Each channel needs its own instance: sharing dither noise across channels
 * would correlate the noise between them, collapsing it to the centre of the
 * stereo image instead of spreading it.
 *
 * @param {number} bitDepth 16 or 24
 * @param {'none'|'tpdf'|'shaped'} mode
 * @param {() => number} [random] uniform [0,1) source, injectable for tests
 * @returns {(sample:number) => number} function returning an integer code
 */
export function createQuantiser(bitDepth, mode = 'tpdf', random = Math.random) {
  const maxCode = Math.pow(2, bitDepth - 1) - 1;
  const minCode = -Math.pow(2, bitDepth - 1);
  const scale = Math.pow(2, bitDepth - 1);
  const lsb = 1 / scale;

  const history = [0, 0, 0];

  return function quantise(sample) {
    let x = sample;

    if (mode === 'shaped') {
      // Error feedback: subtract a filtered version of past quantisation
      // errors so the residual noise is spectrally tilted away from the
      // midrange.
      x += SHAPING_COEFFS[0] * history[0] + SHAPING_COEFFS[1] * history[1] + SHAPING_COEFFS[2] * history[2];
    }

    let dithered = x;
    if (mode === 'tpdf' || mode === 'shaped') {
      // Two independent uniform variates sum to a triangular distribution
      // spanning +/-1 LSB.
      dithered = x + (random() + random() - 1) * lsb;
    }

    let code = Math.round(dithered * scale);
    if (code > maxCode) code = maxCode;
    if (code < minCode) code = minCode;

    if (mode === 'shaped') {
      // The error we must feed back is (quantised output - shaped input),
      // measured against the pre-shaping sample.
      const error = code / scale - dithered;
      history[2] = history[1];
      history[1] = history[0];
      history[0] = error;
    }

    return code;
  };
}

/**
 * Validate and normalise a dither mode, defaulting sensibly per bit depth.
 * @param {string|undefined} mode
 * @param {number} bitDepth
 * @returns {'none'|'tpdf'|'shaped'}
 */
export function resolveDitherMode(mode, bitDepth) {
  if (bitDepth === 32) return 'none'; // float output is not quantised
  if (mode && DITHER_MODES.includes(mode)) return mode;
  return bitDepth === 16 ? 'tpdf' : 'none';
}
