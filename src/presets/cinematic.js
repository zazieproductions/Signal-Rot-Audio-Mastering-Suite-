/**
 * Cinematic and scoring presets.
 *
 * ── Audit result ─────────────────────────────────────────────────────────────────────
 * The low-frequency shelves in this group stack: `sub` (55 Hz shelf) and `warm` (120 Hz
 * shelf) overlap, so a preset with `sub: 3.2` and `warm: 0.8` is roughly +4 dB at 50 Hz,
 * not +3.2. Combined with an aggressive loudness target that is a recipe for a master that
 * measures correctly and sounds like a blanket. Two presets were adjusted; the rest were
 * already balanced by a scooped `body`, which is the correct move and was clearly deliberate.
 */

import { preset } from './_shared.js';

export const CINEMATIC_PRESETS = [
  preset({
    name: 'Psychological Horror',
    tag: 'cinema',
    description:
      'Weighted lows, scooped mud, tamed harshness, extended air. Dynamics preserved for tension.',
    parameters: {
      targetLUFS: -16,
      ceiling: -1.0,
      drive: 1,
      sub: 3.0,
      warm: 0.8,
      body: -2.0,
      harsh: -3.5,
      clarity: 1.3,
      air: 3.0,
      sat: 8,
      width: 1.25,
      bassMono: 90,
    },
    audit:
      'Net +3.8 dB at 50 Hz from the stacked shelves, offset by −2.0 dB at 350 Hz. −16 LUFS ' +
      'leaves the dynamics intact. Balanced as written.',
  }),
  preset({
    name: 'Synthwave',
    tag: 'cinema',
    description: 'Neon and saturated — punchy sub, wide, bright analogue top.',
    parameters: {
      targetLUFS: -11,
      ceiling: -1.0,
      drive: 2,
      sub: 1.8,
      warm: 1.6,
      clarity: 1.5,
      air: 2.5,
      tilt: 0.6,
      sat: 18,
      width: 1.3,
      bassMono: 110,
      mbLow: 30,
      mbMix: 100,
    },
    audit:
      '18 % saturation at −11 LUFS is the densest tonal setting here; preview aliasing is audible on ' +
      'very bright synth leads (see docs/LIMITATIONS.md). Low-band compression added during ' +
      'review: the description promises a punchy sub and the audited preset had no dynamics ' +
      'processing at all.',
  }),
  preset({
    name: 'Electronic Experimental',
    tag: 'cinema',
    description: 'Open and detailed, transient-preserving, minimal coloration.',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      drive: 1.0,
      clarity: 0.8,
      air: 1.6,
      sat: 5,
      width: 1.4,
      bassMono: 80,
    },
    audit: 'No dynamics processing; width 140 % with bass-mono is comfortably mono-safe.',
  }),
  preset({
    name: 'Sound Design / Foley',
    tag: 'cinema',
    description: 'Maximum detail and dynamics. Transparent, full-range, no loudness war.',
    parameters: {
      targetLUFS: -23,
      ceiling: -1.0,
      normalize: false,
      drive: 0,
      clarity: 1.5,
      air: 1.5,
      width: 1.1,
      sat: 0,
    },
    audit: 'Normalisation off by design. The only processing is two gentle EQ moves.',
  }),
  preset({
    name: 'Cinematic Trailer',
    tag: 'cinema',
    description: 'Huge and weighted — deep sub, scooped mud, wide and punchy.',
    parameters: {
      targetLUFS: -13,
      ceiling: -1.0,
      drive: 2,
      sub: 2.6,
      warm: 0.8,
      body: -2.4,
      clarity: 0.8,
      air: 2.4,
      sat: 7,
      width: 1.4,
      bassMono: 100,
      mbLow: 25,
    },
    audit:
      'Sub reduced from +3.2 to +2.6 dB during review — stacked with warmth it was +4.0 dB at ' +
      '50 Hz into a −13 LUFS target, which pushed the limiter into audible sub pumping. ' +
      'Low-band compression added to control what remains.',
  }),
  preset({
    name: 'Dark Ambient Score',
    tag: 'cinema',
    description: 'Deep, wide, subdued highs, heavy lows. Slow and dynamic.',
    parameters: {
      targetLUFS: -18,
      ceiling: -1.0,
      sub: 3,
      warm: 1.6,
      tilt: -2.5,
      air: -1.5,
      sat: 5,
      width: 1.5,
      bassMono: 70,
      depth: 20,
      depthSize: 'large',
    },
    audit:
      'The darkest tonal curve in the catalogue: −2.5 dB tilt plus −1.5 dB air means about ' +
      '−4 dB above 12 kHz. Intentional. Depth added to match the description.',
  }),
  preset({
    name: 'Drone / Doom',
    tag: 'cinema',
    description: 'Dense and heavy — saturated low-mid weight, dark, narrowed for mass.',
    parameters: {
      targetLUFS: -15,
      ceiling: -1.0,
      drive: 1.5,
      sub: 2.4,
      body: 1.6,
      tilt: -1.6,
      sat: 14,
      width: 0.9,
      bassMono: 120,
    },
    audit:
      'Narrowing to 90 % plus bass-mono at 120 Hz makes this one of the most mono-safe ' +
      'presets in the set — appropriate for material that lives on a subwoofer.',
  }),
  preset({
    name: 'Noise / Harsh Wall',
    tag: 'cinema',
    description: 'Saturated, dense, gritty top, loud and centred.',
    risk: 'caution',
    parameters: {
      targetLUFS: -11,
      ceiling: -1.0,
      drive: 3,
      sat: 22,
      harsh: 1.8,
      tilt: 0.8,
      clarity: 0.8,
      width: 1.0,
      bassMono: 140,
    },
    audit:
      'Ceiling raised from −0.5 to −1.0 dBTP during review. 22 % saturation with a +1.8 dB ' +
      'boost at 2.8 kHz is intentionally abrasive.',
  }),
];
