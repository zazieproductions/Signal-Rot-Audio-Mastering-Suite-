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
    family: 'creative',
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
      widthHigh: 1.5,
      widthLow: 0.7,
      air: 1.5,
      clarity: 0.8,
      mbHigh: 15,
      mbMix: 60,
      depth: 12,
      sat: 0,
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
    family: 'creative',
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
    family: 'creative',
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
    risk: 'caution',
    description: 'Multiband punch, transient attack, wide sparkle. More vivid than reality.',
    parameters: {
      targetLUFS: -11,
      ceiling: -1.0,
      transAttack: 15,
      mbLow: 25,
      mbMid: 18,
      mbHigh: 20,
      mbMix: 65,
      widthHigh: 1.3,
      clarity: 1.0,
      air: 1.2,
      sat: 3,
      bassMono: 70,
    },
    audit:
      '−11 LUFS is a demanding target; transient attack is +0.9 dB and the multiband ' +
      'sits at glue levels. On dense material the engine backs the target down rather ' +
      'than crushing. The export report shows exactly how much limiting happened.',
  }),
  preset({
    name: 'Ferric Bloom',
    family: 'creative',
    tag: 'dimension',
    description:
      'Magnetic tape warmth, soft saturation, close-room bloom. A small depth field around a forward mid.',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      tape: 35,
      sat: 18,
      warm: 1.6,
      body: 1.0,
      harsh: -0.8,
      air: 1.2,
      depth: 25,
      depthSize: 'small',
      width: 1.2,
      bassMono: 80,
      textureSeed: 0x0f6a1001,
    },
    audit:
      'Tape 35 gives a 60 Hz head bump and moderate wow; sat 18 adds harmonics without level. ' +
      'The small-room depth taps sit at 11/19 ms and are first-arrival bloom, not reverb. ' +
      'Width 120% with bass-mono 80 Hz is mono-safe. Explicit seed keeps the export deterministic.',
  }),
  preset({
    name: 'Ray Field',
    tag: 'dimension',
    description:
      'Large depth bloom, per-band imaging and air. The mix floats in a clean, luminous field.',
    parameters: {
      targetLUFS: -15,
      ceiling: -1.0,
      depth: 45,
      depthSize: 'large',
      width: 1.3,
      widthMid: 1.2,
      widthHigh: 1.4,
      bassMono: 90,
      air: 1.2,
      clarity: 0.8,
      crossfeed: 0.25,
      sat: 0,
    },
    audit:
      'Depth 55 large means the two taps land at 27/47 ms — a wide first-arrival bloom, still no tail. ' +
      'Width 135% with bass-mono 90 Hz keeps the low end intact; the 150% high width is spatial but ' +
      'a mono fold-down will give up some presence. Crossfeed 0.3 makes the bloom headphone-friendly.',
  }),
  preset({
    name: 'Magnetic Memory',
    family: 'creative',
    tag: 'dimension',
    description: 'Medium tape head-bump, a faint hiss bed and a forward low-mid. A cassette that still has its soul.',
    parameters: {
      targetLUFS: -15,
      ceiling: -1.0,
      tape: 50,
      hiss: 15,
      tilt: -0.6,
      warm: 1.2,
      body: 1.8,
      air: -1.0,
      sat: 16,
      width: 1.15,
      bassMono: 90,
      textureSeed: 0x0f6a1002,
    },
    audit:
      'Tape 50 produces ±1.2 ms wow at 0.4 Hz plus the 60 Hz head bump; hiss 15 sits around −58 dBFS, ' +
      'audible in a quiet gap. Tilt −0.6 and air −1.0 keep the top in check. Width 115% with ' +
      'bass-mono 90 Hz is comfortably mono-safe. Explicit seed for byte-identical export.',
  }),
  preset({
    name: 'Aperture',
    tag: 'dimension',
    description:
      'Slow multiband glue with auto make-up, transient attack and a clean, wide image.',
    parameters: {
      targetLUFS: -12,
      ceiling: -1.0,
      drive: 0.5,
      mbLow: 25,
      mbMid: 18,
      mbHigh: 15,
      mbMix: 60,
      mbSpeed: 'slow',
      mbAutoMakeup: true,
      transAttack: 10,
      width: 1.25,
      bassMono: 90,
      clarity: 0.8,
      air: 1.0,
      sat: 3,
    },
    audit:
      'Slow ballistics with auto make-up keeps the parallel mix holding level rather than ' +
      'pumping. transAttack 10 is +0.6 dB of transient emphasis. Width 125% with bass-mono ' +
      '90 Hz keeps the low end anchored. No phase trigger. Retuned conservative.',
  }),
];
