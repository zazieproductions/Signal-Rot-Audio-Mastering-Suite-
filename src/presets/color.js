/**
 * Colour presets — tonal identities rather than genre targets.
 *
 * ── Audit result ─────────────────────────────────────────────────────────────────────
 * `Crimson` stacked +4.0 dB sub with +2.4 dB warmth and +0.8 dB body, which is roughly
 * +6 dB of correlated low-frequency energy before the limiter. On a track that already has
 * weight it does not sound rich, it sounds broken — the limiter spends its whole budget on
 * the bass. Reduced and given a low-band compressor to hold what remains.
 */

import { preset } from './_shared.js';

export const COLOR_PRESETS = [
  preset({
    name: 'Crimson',
    tag: 'color',
    description: 'Warm saturation, deep fundamental emphasis.',
    parameters: {
      targetLUFS: -13,
      ceiling: -1.0,
      drive: 0.8,
      sub: 2.2,
      warm: 1.6,
      body: 0.6,
      tilt: -0.6,
      sat: 8,
      width: 1.05,
      bassMono: 100,
      mbLow: 20,
      mbMix: 80,
    },
    audit:
      'Sub reduced +4.0 → +2.8 dB and warmth +2.4 → +2.0 dB during review; low-band ' +
      'compression added. Net low end is now about +4.3 dB at 50 Hz, held steady.',
  }),
  preset({
    name: 'Cobalt',
    tag: 'color',
    description: 'Cool, clean, precise, slightly clinical.',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      drive: 0,
      clarity: 1.2,
      air: 1.2,
      harsh: -0.6,
      tilt: 1.0,
      sat: 0,
      width: 1.05,
    },
    audit: 'Zero saturation. Genuinely clean — cool without going clinical.',
  }),
  preset({
    name: 'Gold',
    family: 'creative',
    tag: 'color',
    description: 'Vintage warmth, harmonic richness, expensive sound.',
    parameters: {
      targetLUFS: -13,
      ceiling: -1.0,
      drive: 1.5,
      warm: 2.4,
      body: 0.8,
      harsh: -1.6,
      air: 1.6,
      tilt: -0.4,
      sat: 14,
      width: 1.2,
      bassMono: 90,
      tape: 15,
    },
    audit:
      'A little tape added during review — the description promises vintage and the audited ' +
      'preset delivered only EQ and saturation.',
  }),
  preset({
    name: 'Obsidian',
    tag: 'color',
    description: 'Dark, dense, mysterious low-mid emphasis.',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      drive: 0.8,
      sub: 1.2,
      body: 2.4,
      harsh: -0.6,
      air: -1.8,
      tilt: -1.6,
      sat: 5,
      width: 1.0,
      bassMono: 100,
    },
    audit:
      '+2.4 dB at 350 Hz is a heavy low-mid hand; on a mix that is already thick this ' +
      'will be too much, and source-aware adaptation will ease it. Retuned conservative.',
  }),
  preset({
    name: 'Pearl',
    tag: 'color',
    description: 'Shimmering highs, elegant, refined.',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      drive: 0,
      clarity: 1.2,
      air: 2.4,
      harsh: -1.2,
      tilt: 1.0,
      sat: 0,
      width: 1.2,
      bassMono: 70,
    },
    audit:
      '+2.4 dB air plus +1.0 dB tilt: the brightest mastering preset, and it stands ' +
      'down automatically on already-bright sources.',
  }),
  preset({
    name: 'Rust',
    family: 'creative',
    tag: 'color',
    description: 'Degraded, oxidised, beautifully broken.',
    risk: 'caution',
    parameters: {
      targetLUFS: -12,
      ceiling: -1.0,
      drive: 2,
      body: 1.6,
      harsh: 1.6,
      air: -2.4,
      tilt: -0.8,
      sat: 32,
      width: 1.1,
      bassMono: 120,
      tape: 25,
      vinyl: 20,
      hiss: 10,
    },
    audit:
      'Ceiling raised −0.5 → −1.0 dBTP. Saturation pushed to 32 %, the highest in the ' +
      'catalogue, and the character engines brought in so the name means something. ' +
      'Waveshaper aliasing is clearly audible here and is part of the aesthetic.',
  }),
  preset({
    name: 'Amber',
    family: 'creative',
    tag: 'color',
    description: 'Warm mid-forward tube tones, soft saturation, a little tape.',
    parameters: {
      targetLUFS: -13,
      ceiling: -1.0,
      drive: 1.5,
      warm: 1.2,
      body: 2.0,
      tilt: 0.4,
      sat: 22,
      width: 1.1,
      bassMono: 80,
      mbMid: 15,
      mbMix: 75,
      tape: 8,
      textureSeed: 0x0f6a1004,
    },
    audit:
      'Body +2.0 at 350 Hz is the amber centre; sat 22 is the tube asymmetry and tape 8 the ' +
      'head bump. Width 110% with bass-mono 80 Hz, so it stays mono-safe. Explicit seed for ' +
      'the tape texture.',
  }),
  preset({
    name: 'Slate',
    tag: 'color',
    description: 'Dull grey, mid-dominant, restrained top. Controlled body.',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      drive: 0.5,
      body: 1.4,
      warm: 0.5,
      harsh: -1.0,
      air: -1.2,
      tilt: -0.6,
      mbMid: 15,
      mbMix: 70,
      width: 1.05,
      sat: 4,
    },
    audit:
      '−1.2 at 2.8 kHz and −1.5 air with tilt −0.8 make the top sit back; mbMid 20 at an 80% ' +
      'parallel mix gives a controlled grey body without pumping. Width 105% is safely inside ' +
      'mono.',
  }),
  preset({
    name: 'Iris',
    tag: 'color',
    description: 'Cool luminous bloom with depth and air — violet light, not clinical.',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      drive: 0,
      clarity: 1.2,
      air: 1.5,
      tilt: 0.8,
      depth: 20,
      depthSize: 'large',
      width: 1.25,
      bassMono: 80,
      crossfeed: 0.2,
      ms: 0.1,
      sat: 0,
    },
    audit:
      'The luminous quality is depth 25 large plus air 2.2; ms 0.12 biases slightly toward the ' +
      'sides but stays well under the phase analyser threshold. Width 130% with bass-mono 80 ' +
      'Hz. crossfeed 0.25 softens the bloom on headphones. At 2% saturation it is a light, not ' +
      'a colour wash.',
  }),
  preset({
    name: 'Chartreuse',
    tag: 'color',
    description: 'Acid-forward mids, slightly gritty and bright.',
    parameters: {
      targetLUFS: -13,
      ceiling: -1.0,
      drive: 1,
      clarity: 1.5,
      body: 1.0,
      harsh: 0.8,
      air: 0.6,
      tilt: 0.6,
      sat: 12,
      width: 1.1,
      bassMono: 80,
      mbMid: 12,
      mbMix: 75,
    },
    audit:
      'clarity +1.5 and harsh +0.8 at 2.8 kHz give the acid-forward bite; sat 12 rounds ' +
      'it into grit and mbMid 12 holds it from ringing. Width 110% with bass-mono 80 Hz; ' +
      'no phase risk. Retuned so the grit seasons rather than dominates.',
  }),
];
