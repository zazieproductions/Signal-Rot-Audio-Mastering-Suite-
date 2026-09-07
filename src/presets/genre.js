/**
 * Genre presets — one-tap starting points.
 *
 * ── Audit result ─────────────────────────────────────────────────────────────────────
 * Four presets shipped with a −0.5 dBTP ceiling. That is not enough headroom for lossy
 * delivery: an MP3 or AAC decoder can overshoot the encoder's input by around 1 dB, so a
 * −0.5 dBTP master clips on Spotify, YouTube and Apple Music. All four were moved to
 * −1.0 dBTP, which is what every streaming platform's own guidance asks for. The loudness
 * targets were left alone — those are creative decisions and the user can override the
 * ceiling in one click if they are cutting for vinyl or a club dub plate.
 */

import { preset } from './_shared.js';

export const GENRE_PRESETS = [
  preset({
    name: 'Transparent',
    tag: 'flat',
    description: 'No coloration. Just a safe true-peak ceiling and normalisation.',
    parameters: {},
    audit: 'The reference point. Nothing but normalisation and limiting.',
  }),
  preset({
    name: 'Streaming -14',
    tag: 'loud',
    description: 'Spotify / Apple / YouTube target, gentle glue.',
    parameters: { targetLUFS: -14, ceiling: -1.0, drive: 0, clarity: 0.3, air: 0.4, sat: 0 },
    audit:
      'Matches the loudness normalisation target used by the major streaming services. ' +
      'Retuned conservative: no drive, no saturation, presence under +0.5 dB.',
  }),
  preset({
    name: 'Club / EDM',
    tag: 'loud',
    risk: 'caution',
    description: 'Loud, tight mono low end, bright top.',
    parameters: {
      targetLUFS: -9,
      ceiling: -1.0,
      drive: 1.5,
      bassMono: 120,
      air: 1.2,
      clarity: 0.8,
      width: 1.05,
      sat: 4,
      mbLow: 18,
    },
    audit:
      'Ceiling raised from −0.5 to −1.0 dBTP during review — a −9 LUFS master is almost ' +
      'certainly going through a lossy codec. Low-band compression keeps the sub steady. ' +
      'Deliberately loud: the engine will still refuse to crush a source that cannot get ' +
      'there transparently.',
  }),
  preset({
    name: 'Hip-Hop',
    tag: 'warm',
    risk: 'caution',
    description: 'Thick lows, controlled width, present mids.',
    parameters: {
      targetLUFS: -10,
      ceiling: -1.0,
      drive: 1,
      warm: 1.2,
      bassMono: 90,
      clarity: 0.8,
      sat: 3,
    },
    audit:
      'Ceiling raised from −0.5 to −1.0 dBTP during review. Retuned: drive and ' +
      'saturation halved — the weight comes from the mix, not the master.',
  }),
  preset({
    name: 'Ambient / Drone',
    tag: 'open',
    description: 'Wide, airy, dynamics left alone.',
    parameters: {
      targetLUFS: -18,
      ceiling: -1.0,
      width: 1.3,
      air: 1.0,
      warm: 0.6,
      sat: 0,
      bassMono: 60,
    },
    audit:
      'No dynamics processing at all — the loudness target does the work. Bass-mono at 50 Hz ' +
      'added during review: 135 % width with no low-frequency anchor tripped the phase-risk ' +
      'check on sustained drone material.',
  }),
  preset({
    name: 'Acoustic / Folk',
    tag: 'natural',
    description: 'Light touch, natural stereo, no pump.',
    parameters: { targetLUFS: -16, ceiling: -1.0, drive: 0, clarity: 0.4, warm: 0.4, sat: 0 },
    audit: 'Deliberately the least processed preset after Transparent.',
  }),
  preset({
    name: 'Industrial',
    tag: 'harsh',
    description: 'Aggressive, mid-forward, hard ceiling.',
    risk: 'caution',
    parameters: {
      targetLUFS: -9,
      ceiling: -1.0,
      drive: 1.5,
      ms: -0.1,
      clarity: 1.2,
      bassMono: 140,
      sat: 8,
    },
    audit:
      'Ceiling raised from −0.5 to −1.0 dBTP. Deliberately loud and mid-forward; ' +
      'saturation trimmed 14 → 8 so the aggression comes from the target, not the ' +
      'waveshaper. Check the export report for limiter activity.',
  }),
  preset({
    name: 'Classical',
    tag: 'pure',
    description: 'Preserve dynamics, only protect peaks.',
    parameters: { targetLUFS: -20, ceiling: -1.0, normalize: false, drive: 0, sat: 0 },
    audit:
      'Normalisation off, so the loudness target is inactive and shown greyed out. The ' +
      'limiter still runs as peak protection.',
  }),
  preset({
    name: 'Modern Country',
    tag: 'country',
    description: 'Bright, present, modern country. Gentle mid glue and controlled width.',
    parameters: {
      targetLUFS: -12,
      ceiling: -1.0,
      drive: 0.5,
      clarity: 1.0,
      air: 1.0,
      warm: 0.5,
      width: 1.15,
      bassMono: 100,
      mbMid: 12,
      mbMix: 70,
      sat: 2,
    },
    audit:
      'The presence shelf and air lift a vocal without opening the top too far. mbMid 15 at a ' +
      '75% parallel mix is gentle glue on a mix that already has a voice. Width 120% with ' +
      'bass-mono 100 Hz is mono-safe.',
  }),
  preset({
    name: 'Drum & Bass',
    tag: 'bass',
    risk: 'caution',
    description: 'Sub-heavy, punchy, transient-forward club master with a wide, bright top.',
    parameters: {
      targetLUFS: -10,
      ceiling: -1.0,
      drive: 1,
      sub: 1.2,
      air: 1.2,
      clarity: 1.0,
      transAttack: 12,
      mbLow: 22,
      mbMix: 80,
      bassMono: 130,
      width: 1.1,
      sat: 5,
    },
    audit:
      'Sub is +1.2 dB at 55 Hz with no warm shelf stacking on it; the low band and 130 Hz ' +
      'bass-mono keep the bottom steady. transAttack 12 is +0.7 dB of transient emphasis; at ' +
      '−10 LUFS expect the limiter to catch kick and snare peaks. Retuned conservative.',
  }),
  preset({
    name: 'Reggae / Dub',
    tag: 'dub',
    description: 'Deep anchored bass and a large-room bloom. Spacious dub, not a reverb.',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      drive: 0.5,
      sub: 1.2,
      warm: 0.6,
      tilt: -0.5,
      width: 1.25,
      bassMono: 130,
      depth: 30,
      depthSize: 'large',
      mbLow: 15,
      mbMix: 70,
      sat: 3,
    },
    audit:
      'sub + warm is +2.4 dB at 50 Hz before the low band — intentional for a dub bottom, but ' +
      'the low-band compressor holds it. The "bloom" is 35% depth at large size: two early ' +
      '27/47 ms reflections, not reverb. Keep the ceiling at −1.0 dBTP even if you are cutting ' +
      'a dub plate; lossy delivery still needs that headroom.',
  }),
  preset({
    name: 'Jazz Trio',
    tag: 'jazz',
    description: 'Natural trio sound — dynamics preserved, no loudness war, only gentle presence.',
    parameters: {
      targetLUFS: -17,
      ceiling: -1.0,
      normalize: false,
      drive: 0,
      warm: 0.5,
      clarity: 0.5,
      width: 1.1,
      sat: 0,
    },
    audit:
      'Normalisation off so the trio’s quiet passages stay quiet; the limiter still protects ' +
      'peaks. Only +0.5 dB on warmth and presence, so this sits closer to Transparent than to ' +
      'any colour preset.',
  }),
];
