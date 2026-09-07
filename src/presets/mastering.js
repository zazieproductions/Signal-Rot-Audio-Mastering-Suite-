/**
 * Mastering presets — the pristine, professional family.
 *
 * These are the presets to reach for when Signal Rot should behave like a serious
 * mastering system: transparency over loudness, depth over density, headroom over
 * maximum level. Every preset in this group is `family: 'mastering'`, which means:
 *
 *  · No degradation DSP, ever — tape, hiss, vinyl, Haas and the side comb are zero and
 *    the runtime re-zeroes them on apply even if a hand-edited file sets them.
 *  · Conservative dynamics: gentle multiband glue, modest limiter activity, transients
 *    preserved. Typical gain reduction on ordinary material is 0–2 dB.
 *  · LUFS targets are guidelines. If the source cannot reach one transparently, the
 *    engine delivers a quieter master rather than a crushed one.
 *
 * REFERENCE HD is the flagship and the baseline against which the other mastering
 * presets are designed. On an already excellent mix it is comfortable doing almost
 * nothing.
 */

import { preset } from './_shared.js';

export const MASTERING_PRESETS = [
  preset({
    name: 'Reference HD',
    tag: 'mastering',
    family: 'mastering',
    description:
      'Flagship transparent master — controlled low end, smooth highs, natural stereo dimension. On a great mix it does almost nothing.',
    parameters: {
      targetLUFS: -15,
      ceiling: -1.0,
      drive: 0,
      mbLow: 12,
      mbMid: 10,
      mbHigh: 8,
      mbMix: 50,
      mbSpeed: 'slow',
      bassMono: 80,
      width: 1.0,
      sat: 0,
      transAttack: 0,
      transSustain: 0,
    },
    audit:
      'No saturation, no drive, no EQ moves, no degradation DSP. Slow-ballistics ' +
      'multiband glue at a 50 % parallel mix typically shows 0–1 dB of reduction; ' +
      'bass-mono at 80 Hz anchors the sub. −15 LUFS sits inside the −16…−14 ' +
      'reference window. This is the baseline preset.',
  }),
  preset({
    name: 'Balanced Modern',
    tag: 'mastering',
    family: 'mastering',
    description:
      'Polished contemporary master — gentle glue, a breath of presence and air, tasteful width.',
    parameters: {
      targetLUFS: -13,
      ceiling: -1.0,
      drive: 0,
      mbLow: 15,
      mbMid: 12,
      mbHigh: 10,
      mbMix: 60,
      mbSpeed: 'med',
      clarity: 0.4,
      air: 0.5,
      bassMono: 80,
      width: 1.05,
      sat: 0,
      transAttack: 5,
    },
    audit:
      'Presence and air stay at or under +0.5 dB and are removed automatically on ' +
      'already-bright sources. Transient emphasis is +0.3 dB — felt, not heard. −13 ' +
      'LUFS sits inside the −14…−11 balanced window.',
  }),
  preset({
    name: 'Modern Loud',
    tag: 'mastering',
    family: 'mastering',
    risk: 'caution',
    description:
      'Firm competitive master for dense modern mixes — assertive but not crushed. Choose it deliberately.',
    parameters: {
      targetLUFS: -11,
      ceiling: -1.0,
      drive: 0.5,
      mbLow: 20,
      mbMid: 15,
      mbHigh: 12,
      mbMix: 70,
      mbSpeed: 'med',
      clarity: 0.6,
      air: 0.6,
      bassMono: 100,
      width: 1.05,
      sat: 2,
      transAttack: 8,
    },
    audit:
      'The loudest mastering preset and the only one carrying a caution flag: −11 ' +
      'LUFS will work the limiter on dense material, and the export report shows ' +
      'exactly how much. Saturation is 2 % — colour, not crunch. If the limiter ' +
      'would have to work constantly to hold this target, the engine delivers a ' +
      'quieter master instead.',
  }),
  preset({
    name: 'Quiet Dynamics',
    tag: 'mastering',
    family: 'mastering',
    description:
      'Open and dynamic master for acoustic, jazz and classical — peaks protected, silences untouched.',
    parameters: {
      targetLUFS: -18,
      ceiling: -1.0,
      normalize: false,
      drive: 0,
      mbLow: 0,
      mbMid: 0,
      mbHigh: 0,
      clarity: 0.3,
      warm: 0.3,
      bassMono: 60,
      width: 1.05,
      sat: 0,
    },
    audit:
      'Normalisation off so quiet passages stay quiet and dynamics are preserved end ' +
      'to end; the limiter still runs as peak protection. No compression at all — ' +
      'two ±0.3 dB EQ moves and a centred sub are the entire process.',
  }),
];
