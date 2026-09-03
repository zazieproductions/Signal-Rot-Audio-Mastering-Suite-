/**
 * Restoration presets — corrective starting points, not repairs.
 *
 * These sit deliberately outside the colour groups. They are meant to open a source that is
 * dull, harsh, boomy or unstable in mono, then hand the user back to the creative controls
 * once the problem is no longer hiding the mix. None of them add character: saturation is
 * zero or near-zero, no tape / vinyl / hiss, no Haas, no side comb, and every one is
 * declared `safe`.
 *
 * Every audit note is honest that this is a starting point. If a source needs more than a
 * couple of dB of corrective EQ, the correct answer is upstream — this is not a repair tool.
 */

import { preset } from './_shared.js';

export const RESTORATION_PRESETS = [
  preset({
    name: 'Dull Mix Rescue',
    tag: 'restoration',
    description:
      'Air and clarity for a dull source, with a modest low-mid tidy. A starting point, not a repair.',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      drive: 0,
      clarity: 1.4,
      air: 2.0,
      tilt: 0.8,
      body: -0.6,
      harsh: -0.5,
      width: 1.05,
      sat: 0,
    },
    audit:
      'Corrective EQ only: tilt +0.8 hinged at 1 kHz, air +2.0 at 12 kHz, and a small −0.6 ' +
      'tidy at 350 Hz. No multi-band, no transient shaping, no saturation. If the source is ' +
      'still muffled after +2 dB of air, the problem is not this preset.',
  }),
  preset({
    name: 'Harsh / Sibilance Tamer',
    tag: 'restoration',
    description:
      'Pulls the sibilant band down for dialogue and bright vocals. A starting point, not a repair.',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      drive: 0,
      harsh: -2.5,
      air: -1.2,
      clarity: -0.8,
      tilt: -0.5,
      width: 1.0,
      sat: 0,
    },
    audit:
      'The 2.8 kHz band is cut 2.5 dB and the 12 kHz shelf is lowered 1.2 dB, so the "s" ' +
      'region is tamed without touching the body. −0.8 at 5 kHz keeps voices from sounding ' +
      'whispered. No dynamics and no saturation. If a voice still bites, look at the source ' +
      'recording before reaching for more.',
  }),
  preset({
    name: 'Boomy Room Corrective',
    tag: 'restoration',
    description:
      'Pulls excess low-end room out before the limiter. A starting point, not a repair.',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      drive: 0,
      sub: -2.8,
      warm: -1.2,
      body: -1.0,
      bassMono: 120,
      width: 1.05,
      sat: 0,
    },
    audit:
      'Stacked shelves are −4.0 dB at 50 Hz, and the 350 Hz band is down 1 dB to calm the ' +
      'boxy part of a room reading. bass-mono 120 Hz stops the remaining low end from ' +
      'wandering. No compression, no saturation — this is EQ, not a repair. Start with less ' +
      'and let the source tell you how far to go.',
  }),
  preset({
    name: 'Broadcast Mono First',
    tag: 'restoration',
    description:
      'Mono-safe fold-down pass for club and broadcast. No wide tricks, stable low end.',
    parameters: {
      targetLUFS: -13,
      ceiling: -1.0,
      drive: 0.5,
      width: 1.0,
      ms: -0.1,
      bassMono: 160,
      crossfeed: 0.1,
      clarity: 0.8,
      air: 0.8,
      sat: 2,
    },
    audit:
      'Width stays at 100%; ms −0.1 narrows the side slightly and bass-mono 160 Hz makes the ' +
      'infrastructure genuinely mono below that corner. The small crossfeed is headphone ' +
      'only and is not a widening effect. This is a check, not a polish — use it to confirm ' +
      'the fold-down before a club or broadcast delivery.',
  }),
];
