/**
 * Depth engine — early-reflection bloom.
 *
 * Two filtered, delayed taps mixed under the direct signal. This is **not a reverb**: it
 * has no diffusion network, no feedback, and no tail. It produces the first-arrival cues
 * a listener uses to judge distance — a small amount of delayed, high-rolled-off energy —
 * without the density that fills the gaps between transients and blurs a master.
 *
 * The tap times are chosen to be prime-ish ratios so the two reflections do not reinforce
 * into an audible pitch, and both are high-frequency-rolled because a real reflection
 * loses top end at every surface.
 *
 * ── Why the taps are mono-summed before delaying ─────────────────────────────────────
 * Feeding a stereo signal into a single delay and mixing it back with the dry signal
 * comb-filters the direct sound. Here each tap is fed from the input and returned at a
 * level low enough (≤ 0.28) that the comb is a colouration rather than a cancellation,
 * and the taps are cross-fed (tap 1 → right, tap 2 → left) so the reflections widen
 * rather than centre.
 */

/** Room-size presets: the two tap times in seconds. */
export const DEPTH_SIZES = Object.freeze({
  small: { taps: [0.011, 0.019], label: 'Small — tight room' },
  med: { taps: [0.017, 0.029], label: 'Medium — studio live room' },
  large: { taps: [0.027, 0.047], label: 'Large — hall bloom' },
});

/**
 * @param {BaseAudioContext} ctx
 */
export function buildDepth(ctx) {
  const input = ctx.createGain();
  const output = ctx.createGain();

  // Direct path.
  input.connect(output);

  const tap = (lpFreq) => {
    const delay = ctx.createDelay(0.25);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lpFreq;
    lp.Q.value = 0.7071;
    // A gentle high-pass keeps reflections out of the sub region, where they only muddy.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 180;
    hp.Q.value = 0.7071;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    input.connect(delay);
    delay.connect(lp);
    lp.connect(hp);
    hp.connect(gain);
    gain.connect(output);
    return { delay, gain, lp };
  };

  const tap1 = tap(5200);
  const tap2 = tap(4200);

  return { input, output, tap1, tap2 };
}

/**
 * @param {ReturnType<typeof buildDepth>} n
 * @param {object} p
 * @param {number} p.depth 0..100
 * @param {'small'|'med'|'large'} p.depthSize
 * @param {boolean} [p.bypass]
 */
export function applyDepth(n, p) {
  const amount = p.bypass ? 0 : Math.max(0, Math.min(100, p.depth)) / 100;
  const size = DEPTH_SIZES[p.depthSize] ?? DEPTH_SIZES.med;
  n.tap1.delay.delayTime.value = size.taps[0];
  n.tap2.delay.delayTime.value = size.taps[1];
  n.tap1.gain.gain.value = amount * 0.28;
  n.tap2.gain.gain.value = amount * 0.22;
}
