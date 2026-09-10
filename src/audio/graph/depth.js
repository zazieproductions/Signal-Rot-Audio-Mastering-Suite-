/**
 * Depth engine — early-reflection bloom.
 *
 * Two depth characters share one stage:
 *
 * ── CLASSIC (the protected baseline, default) ───────────────────────────────────────
 * Two filtered, delayed taps mixed under the direct signal. This is **not a reverb**: it
 * has no diffusion network, no feedback, and no tail. It produces the first-arrival cues
 * a listener uses to judge distance — a small amount of delayed, high-rolled-off energy —
 * without the density that fills the gaps between transients and blurs a master.
 *
 * The tap times are chosen to be prime-ish ratios so the two reflections do not reinforce
 * into an audible pitch, and both are high-frequency-rolled because a real reflection
 * loses top end at every surface. The taps are cross-fed (tap 1 → right, tap 2 → left)
 * so the reflections widen rather than centre. Mixing dry signal with delayed copies is a
 * comb by construction; levels are capped at 0.28 so it is a colouration rather than a
 * cancellation. That colouration is the *point* of the classic character.
 *
 * ── CLEAN (mastering-safe character) ────────────────────────────────────────────────
 * A second wet architecture designed to give front/back dimensionality and air around
 * instruments *without* audible combing, slap or phase collapse:
 *
 *   1. The wet signal is band-shaped first: high-passed at 220 Hz (reflections carry no
 *      useful sub energy — bass smear is the first thing that makes depth sound cheap)
 *      and low-passed at 6.4 kHz (every reflection loses top end).
 *   2. Two in-series all-pass diffusers smear the phase of the wet signal *before* it is
 *      delayed, so the delayed copies are no longer phase-locked copies of the direct
 *      signal. This is what removes the deep, narrow comb notches of the classic taps —
 *      the all-passes spread each notch across frequency while keeping total energy
 *      (all-pass = unity magnitude).
 *   3. Four taps at unequal, prime-ratio delays alternate between the ears at low level
 *      (per-ear wet ≤ 0.12 at full depth), energy being shared rather than stacked.
 *      Unequal delays and low levels mean no obvious slap and no mono collapse: the
 *      mono sum keeps the direct signal and a phase-smeared, band-limited wash.
 *
 * It is still a *small space*, not a reverb: there is no feedback and no tail. The two
 * characters share the same controls (amount + size); `depthMode` selects which wet
 * architecture is audible.
 */

/** Room-size presets for the classic taps: the two tap times in seconds. */
export const DEPTH_SIZES = Object.freeze({
  small: { taps: [0.011, 0.019], label: 'Small — tight room' },
  med: { taps: [0.017, 0.029], label: 'Medium — studio live room' },
  large: { taps: [0.027, 0.047], label: 'Large — hall bloom' },
});

/** Room-size presets for the clean taps: four unequal delays, seconds, ear-alternating. */
export const CLEAN_DEPTH_SIZES = Object.freeze({
  small: { taps: [0.0097, 0.0129, 0.0173, 0.0221], label: 'Small — tight room' },
  med: { taps: [0.0137, 0.0181, 0.0247, 0.0319], label: 'Medium — studio live room' },
  large: { taps: [0.0193, 0.0263, 0.0367, 0.0481], label: 'Large — hall bloom' },
});

/** Clean per-tap gains, ear-alternating (L, R, L, R); sum per ear ≤ 0.12. */
export const CLEAN_TAP_GAINS = Object.freeze([0.06, 0.055, 0.045, 0.04]);

/** Clean wet bus filters. */
export const CLEAN_DEPTH_HP_HZ = 220;
export const CLEAN_DEPTH_LP_HZ = 6400;
/** Clean diffuser all-pass stages (frequency, Q). */
export const CLEAN_DIFFUSERS = Object.freeze([
  { freq: 1050, q: 0.8 },
  { freq: 2180, q: 0.6 },
]);

/**
 * @param {BaseAudioContext} ctx
 */
export function buildDepth(ctx) {
  const input = ctx.createGain();
  const output = ctx.createGain();

  // Direct path.
  input.connect(output);

  // ── Classic wet: two direct filtered taps, cross-fed ──
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

  // ── Clean wet: shaped → diffused → four unequal taps alternating between ears ──
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = CLEAN_DEPTH_HP_HZ;
  hp.Q.value = 0.7071;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = CLEAN_DEPTH_LP_HZ;
  lp.Q.value = 0.7071;
  const ap1 = ctx.createBiquadFilter();
  ap1.type = 'allpass';
  ap1.frequency.value = CLEAN_DIFFUSERS[0].freq;
  ap1.Q.value = CLEAN_DIFFUSERS[0].q;
  const ap2 = ctx.createBiquadFilter();
  ap2.type = 'allpass';
  ap2.frequency.value = CLEAN_DIFFUSERS[1].freq;
  ap2.Q.value = CLEAN_DIFFUSERS[1].q;

  input.connect(hp);
  hp.connect(lp);
  lp.connect(ap1);
  ap1.connect(ap2);

  const splitter = ctx.createChannelSplitter(2);
  ap2.connect(splitter);
  const wetL = ctx.createGain();
  const wetR = ctx.createGain();
  splitter.connect(wetL, 0);
  splitter.connect(wetR, 1);

  const cleanTap = (delaySeconds) => {
    const d = ctx.createDelay(0.25);
    d.delayTime.value = delaySeconds;
    return d;
  };

  // Ear-alternating taps (index 0 → L, 1 → R, …). Each side sums its taps through a
  // shared bus into a merger so mono content can never collapse in the sum.
  const cleanTaps = CLEAN_DEPTH_SIZES.med.taps.map((seconds) => cleanTap(seconds));
  const cleanGains = CLEAN_TAP_GAINS.map(() => ctx.createGain());
  cleanGains.forEach((g) => (g.gain.value = 0));
  const leftBus = ctx.createGain();
  const rightBus = ctx.createGain();
  cleanTaps.forEach((t, i) => {
    const ear = i % 2 === 0 ? wetL : wetR;
    ear.connect(t);
    t.connect(cleanGains[i]);
    if (i % 2 === 0) cleanGains[i].connect(leftBus);
    else cleanGains[i].connect(rightBus);
  });
  const merger = ctx.createChannelMerger(2);
  leftBus.connect(merger, 0, 0);
  rightBus.connect(merger, 0, 1);
  merger.connect(output);

  return {
    input,
    output,
    tap1,
    tap2,
    clean: {
      hp,
      lp,
      ap1,
      ap2,
      taps: cleanTaps,
      gains: cleanGains,
      leftBus,
      rightBus,
      merger,
    },
  };
}

/**
 * @param {ReturnType<typeof buildDepth>} n
 * @param {object} p
 * @param {number} p.depth 0..100
 * @param {'small'|'med'|'large'} p.depthSize
 * @param {'classic'|'clean'} [p.depthMode]
 * @param {boolean} [p.bypass]
 */
export function applyDepth(n, p) {
  const amount = p.bypass ? 0 : Math.max(0, Math.min(100, p.depth)) / 100;
  const size = DEPTH_SIZES[p.depthSize] ?? DEPTH_SIZES.med;
  const cleanSize = CLEAN_DEPTH_SIZES[p.depthSize] ?? CLEAN_DEPTH_SIZES.med;
  const clean = (p.depthMode ?? 'classic') === 'clean' && !p.bypass;

  n.tap1.delay.delayTime.value = size.taps[0];
  n.tap2.delay.delayTime.value = size.taps[1];
  n.tap1.gain.gain.value = clean ? 0 : amount * 0.28;
  n.tap2.gain.gain.value = clean ? 0 : amount * 0.22;

  n.clean.taps.forEach((delayNode, i) => {
    delayNode.delayTime.value = cleanSize.taps[i];
    n.clean.gains[i].gain.value = clean ? amount * CLEAN_TAP_GAINS[i] : 0;
  });
}
