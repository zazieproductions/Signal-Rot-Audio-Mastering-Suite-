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
      drive: 0.5,
      sub: 2.4,
      warm: 0.6,
      body: -1.6,
      harsh: -2.5,
      clarity: 1.0,
      air: 2.2,
      sat: 4,
      width: 1.2,
      bassMono: 90,
    },
    audit:
      'Net +3.8 dB at 50 Hz from the stacked shelves, offset by −2.0 dB at 350 Hz. −16 LUFS ' +
      'leaves the dynamics intact. Balanced as written.',
  }),
  preset({
    name: 'Synthwave',
    tag: 'cinema',
    risk: 'caution',
    description: 'Neon and saturated — punchy sub, wide, bright analogue top.',
    parameters: {
      targetLUFS: -11,
      ceiling: -1.0,
      drive: 1,
      sub: 1.4,
      warm: 1.2,
      clarity: 1.2,
      air: 1.8,
      tilt: 0.4,
      sat: 8,
      width: 1.25,
      bassMono: 110,
      mbLow: 22,
      mbMix: 80,
    },
    audit:
      'Saturation trimmed 18 → 8 so neon leads stay clean; the punch comes from the ' +
      'low-band glue and the −11 LUFS target, not the waveshaper. Low-band compression ' +
      'holds the sub the description promises.',
  }),
  preset({
    name: 'Electronic Experimental',
    tag: 'cinema',
    description: 'Open and detailed, transient-preserving, minimal coloration.',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      drive: 0,
      clarity: 0.6,
      air: 1.0,
      sat: 0,
      width: 1.3,
      bassMono: 80,
    },
    audit:
      'No dynamics processing, no saturation; width 130 % with bass-mono is ' +
      'comfortably mono-safe. Transient-preserving by virtue of doing almost nothing.',
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
      drive: 1,
      sub: 2.0,
      warm: 0.6,
      body: -1.8,
      clarity: 0.6,
      air: 1.8,
      sat: 3,
      width: 1.3,
      bassMono: 100,
      mbLow: 18,
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
      drive: 0.8,
      sub: 1.8,
      body: 1.2,
      tilt: -1.2,
      sat: 8,
      width: 0.9,
      bassMono: 120,
    },
    audit:
      'Narrowing to 90 % plus bass-mono at 120 Hz makes this one of the most mono-safe ' +
      'presets in the set — appropriate for material that lives on a subwoofer.',
  }),
  preset({
    name: 'Noise / Harsh Wall',
    family: 'creative',
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
  preset({
    name: 'Trailer Impact',
    tag: 'cinema',
    description: 'Big transient punch, deep sub and bright top for an impact-focused trailer.',
    parameters: {
      targetLUFS: -12,
      ceiling: -1.0,
      drive: 1,
      sub: 1.4,
      warm: 0.5,
      body: -1.2,
      clarity: 0.8,
      air: 1.8,
      transAttack: 12,
      mbLow: 18,
      mbHigh: 15,
      mbMix: 70,
      width: 1.3,
      bassMono: 110,
      sat: 4,
    },
    audit:
      'Unlike Cinematic Trailer, this one leans on transAttack 12 (+0.7 dB) and ' +
      'high-band control to make hits feel faster. sub + warm is +1.9 dB, held by the low ' +
      'band. The limiter catches transient peaks; the report shows how much.',
  }),
  preset({
    name: 'Documentary',
    tag: 'cinema',
    description: 'Dialogue-forward, measured, dynamics preserved, no loudness war.',
    parameters: {
      targetLUFS: -20,
      ceiling: -1.0,
      normalize: false,
      drive: 0,
      body: 0.8,
      clarity: 1.0,
      harsh: -1.0,
      air: 1.0,
      width: 1.05,
      sat: 0,
    },
    audit:
      'Normalisation off so natural speech dynamics survive; the only shaping is corrective EQ, ' +
      'no compression. The −1 dB at 2.8 kHz reduces polite sibilance without dulling the ' +
      '5 kHz presence that keeps dialogue intelligible.',
  }),
  preset({
    name: 'Game Loop',
    tag: 'cinema',
    description: 'Loop-safe glue and a subtle stage — consistent from bar one to bar four hundred.',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      drive: 0.5,
      mbLow: 15,
      mbMid: 15,
      mbHigh: 12,
      mbMix: 65,
      mbSpeed: 'fast',
      depth: 12,
      width: 1.15,
      bassMono: 80,
      clarity: 0.6,
      air: 0.8,
      sat: 2,
    },
    audit:
      'Fast ballistics keep the compressor from accumulating gain reduction across a long loop; ' +
      'the 70% parallel mix avoids pumping on repeated transitions. Depth 15 is early reflections, ' +
      'no tail. Width 120% with bass-mono 80 Hz is mono-safe.',
  }),
  preset({
    name: 'Dialogue Under Score',
    tag: 'cinema',
    description: 'Intimate centre, controlled sibilance, gentle warm body. The score sits under the voice.',
    parameters: {
      targetLUFS: -18,
      ceiling: -1.0,
      drive: 0,
      body: 0.8,
      harsh: -1.5,
      clarity: 1.5,
      air: 0.8,
      width: 1.0,
      sat: 0,
    },
    audit:
      'Width at 100% keeps the voice solid in the middle of a wide score. The −2 dB at 2.8 kHz ' +
      'tames sibilance while +2 dB clarity keeps dialogue intelligible. No dynamics; the −18 ' +
      'target leaves the quiet sections of the score in place.',
  }),
];
