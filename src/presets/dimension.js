/**
 * Dimension presets — the showcase for the engines that make Signal Rot what it is:
 * multiband glue, per-band imaging, the depth engine and the character section.
 *
 * ── Audit result ─────────────────────────────────────────────────────────────────────
 * Every preset in this group used the parallel-mix control (`mbMix` 40–70 %), which in
 * the audited engine put two ~30 dB notches at 140 Hz and 3.2 kHz into the master
 * (`docs/AUDIT.md` §3.1 C). **All five were producing broken audio.** With the
 * phase-matched dry path they now do what their descriptions promise, and the mix values
 * have been left where their author set them because they were dialled by ear against a
 * broken engine and are worth re-hearing intact rather than second-guessing.
 */

import { preset } from './_shared.js';

export const DIMENSION_PRESETS = [
  preset({
    name: 'Analog Womb',
    tag: 'dimension',
    description:
      'Tape-warmed multiband glue, head bump, enveloping depth. The expensive-console sound.',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      tape: 35,
      mbLow: 30,
      mbMid: 20,
      mbHigh: 15,
      mbMix: 60,
      warm: 1.6,
      sub: 1.2,
      depth: 20,
      sat: 8,
      width: 1.05,
    },
    audit:
      'Low-end sums to about +2.8 dB below 120 Hz before compression; the low band pulls it ' +
      'back. Parallel mix now phase-coherent. No phase risk.',
  }),
  preset({
    name: 'Crystal Palace',
    tag: 'dimension',
    description: 'Ultra-wide crystalline highs over anchored bass. Pristine, dimensional, hi-fi.',
    parameters: {
      targetLUFS: -13,
      ceiling: -1.0,
      widthHigh: 1.6,
      widthLow: 0.7,
      air: 2.5,
      clarity: 1.2,
      mbHigh: 20,
      mbMix: 70,
      depth: 15,
      sat: 3,
      bassMono: 60,
    },
    audit:
      'High-band width 160 % is the widest safe value with the low band narrowed to 70 %. ' +
      'Bass-mono at 60 Hz added during review — without it the narrowed low band still let ' +
      'sub content wander.',
  }),
  preset({
    name: 'Fourth Dimension',
    tag: 'dimension',
    description: 'Full spatial engagement — depth bloom, binaural field, per-band imaging.',
    risk: 'caution',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      depth: 45,
      depthSize: 'large',
      binaural: true,
      crossfeed: 0.4,
      widthMid: 1.3,
      widthHigh: 1.5,
      spread: 0.35,
      air: 1.5,
      sat: 4,
      bassMono: 70,
    },
    audit:
      'Binaural mode raises effective width by 1 + 0.35 × 0.6 = 1.21×. Combined with the ' +
      'per-band widths this reaches ~1.8× at the top. Mono fold-down loses about 3 dB above ' +
      '4 kHz — audible but not a failure. Bass-mono added at 70 Hz.',
  }),
  preset({
    name: 'Tape Ghost',
    tag: 'dimension',
    description:
      'Heavy wow/flutter, hiss bed, dark and haunted. Signal rot as mastering aesthetic.',
    parameters: {
      targetLUFS: -16,
      ceiling: -1.0,
      tape: 70,
      hiss: 25,
      tilt: -1.5,
      air: -1.5,
      mbMix: 40,
      mbLow: 25,
      sat: 12,
      width: 1.15,
    },
    audit:
      'The most extreme parallel-mix value in the catalogue and therefore the preset most ' +
      'damaged by the old crossover bug. Hiss at 25 % sits around −62 dBFS — audible on a ' +
      'quiet passage, which is the intent.',
  }),
  preset({
    name: 'Vinyl Séance',
    tag: 'dimension',
    description: 'Crackle, rumble, narrowed low end. A record that remembers being played.',
    parameters: {
      targetLUFS: -15,
      ceiling: -1.0,
      vinyl: 45,
      warm: 2,
      widthLow: 0.5,
      bassMono: 100,
      harsh: -1,
      sat: 10,
      depth: 12,
    },
    audit:
      'Rumble is high-passed at 15 Hz so it cannot eat headroom below the audible band. ' +
      'Bass-mono at 100 Hz with a 24 dB/octave slope means genuinely mono below 100 Hz — the ' +
      'old 12 dB/octave version left −6 dB of side energy at 50 Hz.',
  }),
  preset({
    name: 'Hyperreal',
    tag: 'dimension',
    description: 'Multiband punch, transient attack, wide sparkle. More vivid than reality.',
    parameters: {
      targetLUFS: -11,
      ceiling: -1.0,
      transAttack: 35,
      mbLow: 35,
      mbMid: 25,
      mbHigh: 30,
      mbMix: 70,
      widthHigh: 1.4,
      clarity: 1.5,
      air: 2,
      sat: 6,
      bassMono: 60,
    },
    audit:
      '−11 LUFS with +35 transient attack is a demanding combination: expect 3–5 dB of ' +
      'limiter reduction on dense material. The export report shows exactly how much.',
  }),
];
