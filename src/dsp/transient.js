/**
 * Transient shaper — differential-envelope attack/sustain processor.
 *
 * Runs on a rendered buffer rather than in the live graph because it needs
 * per-sample gain control, which native Web Audio nodes cannot express.
 *
 * The envelope detector is channel-linked (a single gain is derived from the
 * loudest channel and applied to all of them) so the stereo image cannot wander
 * as the processor works.
 *
 * Change from the original: the sustain term used to be driven by the absolute
 * signal level (`min(1, envSlow * 3)`), which meant the control did nothing on
 * quiet material and slammed on loud material — the same setting behaved
 * differently depending on how hot the mix was. It is now driven by the ratio
 * of sustained to peak energy, which is level-independent, so a given setting
 * behaves consistently regardless of input gain.
 */

/**
 * @param {{numberOfChannels:number,length:number,sampleRate:number,getChannelData:(i:number)=>Float32Array}} buffer
 * @param {number} attackPct  -100..+100 (% attack emphasis)
 * @param {number} sustainPct -100..+100 (% sustain emphasis)
 * @param {object} [options]
 * @param {number} [options.fastAttackMs=1]
 * @param {number} [options.slowAttackMs=50]
 * @param {number} [options.fastReleaseMs=20]
 * @param {number} [options.slowReleaseMs=180]
 * @returns {{maxGain:number, minGain:number}} the gain excursion applied
 */
export function transientShape(buffer, attackPct, sustainPct, options = {}) {
  if (!attackPct && !sustainPct) return { maxGain: 1, minGain: 1 };

  const {
    fastAttackMs = 1,
    slowAttackMs = 50,
    fastReleaseMs = 20,
    slowReleaseMs = 180,
  } = options;

  const sr = buffer.sampleRate;
  const n = buffer.length;
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  if (!n || !channels.length) return { maxGain: 1, minGain: 1 };

  const coeff = (ms) => Math.exp(-1 / (sr * (ms / 1000)));
  const aFast = coeff(fastAttackMs);
  const aSlow = coeff(slowAttackMs);
  const rFast = coeff(fastReleaseMs);
  const rSlow = coeff(slowReleaseMs);

  const atk = attackPct / 100;
  const sus = sustainPct / 100;

  let envFast = 0;
  let envSlow = 0;
  let maxGain = 1;
  let minGain = 1;

  for (let i = 0; i < n; i++) {
    let x = 0;
    for (let c = 0; c < channels.length; c++) {
      const v = Math.abs(channels[c][i]);
      if (v > x) x = v;
    }

    envFast = x > envFast ? x + (envFast - x) * aFast : x + (envFast - x) * rFast;
    envSlow = x > envSlow ? x + (envSlow - x) * aSlow : x + (envSlow - x) * rSlow;

    let g = 1;
    if (envFast > 1e-6) {
      // Transient component: how far the fast envelope leads the slow one,
      // normalised so the term is a ratio in 0..1 rather than a level.
      const transient = Math.max(0, envFast - envSlow) / envFast;
      g += atk * transient * 0.9;

      // Sustain component: the complement — how much of the current energy is
      // steady state. Also a ratio, so it is level-independent.
      const sustain = Math.min(1, envSlow / envFast);
      g += sus * sustain * 0.4;
    }

    if (g < 0.25) g = 0.25;
    if (g > 2.2) g = 2.2;
    if (g > maxGain) maxGain = g;
    if (g < minGain) minGain = g;

    for (let c = 0; c < channels.length; c++) channels[c][i] *= g;
  }

  return { maxGain, minGain };
}
