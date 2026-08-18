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
    parameters: { targetLUFS: -14, ceiling: -1.0, drive: 1.2, clarity: 0.6, air: 0.8, sat: 4 },
    audit: 'Matches the loudness normalisation target used by the major streaming services.',
  }),
  preset({
    name: 'Club / EDM',
    tag: 'loud',
    description: 'Loud, tight mono low end, bright top.',
    parameters: {
      targetLUFS: -9,
      ceiling: -1.0,
      drive: 3,
      bassMono: 120,
      air: 1.8,
      clarity: 1,
      width: 1.1,
      sat: 10,
      mbLow: 20,
    },
    audit:
      'Ceiling raised from −0.5 to −1.0 dBTP during review — a −9 LUFS master is almost ' +
      'certainly going through a lossy codec. Low-band compression added to keep the sub ' +
      'steady under 3 dB of drive.',
  }),
  preset({
    name: 'Hip-Hop',
    tag: 'warm',
    description: 'Thick lows, controlled width, present mids.',
    parameters: {
      targetLUFS: -10,
      ceiling: -1.0,
      drive: 2.5,
      warm: 1.6,
      bassMono: 90,
      clarity: 1.0,
      sat: 8,
    },
    audit: 'Ceiling raised from −0.5 to −1.0 dBTP during review.',
  }),
  preset({
    name: 'Ambient / Drone',
    tag: 'open',
    description: 'Wide, airy, dynamics left alone.',
    parameters: {
      targetLUFS: -18,
      ceiling: -1.0,
      width: 1.35,
      air: 1.5,
      warm: 0.8,
      sat: 3,
      bassMono: 50,
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
    parameters: { targetLUFS: -16, ceiling: -1.0, drive: 0.5, clarity: 0.5, warm: 0.5, sat: 2 },
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
      drive: 3,
      ms: -0.1,
      clarity: 1.5,
      bassMono: 140,
      sat: 14,
    },
    audit:
      'Ceiling raised from −0.5 to −1.0 dBTP. At −9 LUFS with 14 % saturation this will ' +
      'engage the limiter heavily; that is the sound, but check the export report.',
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
];
