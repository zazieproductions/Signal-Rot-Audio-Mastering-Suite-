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
      drive: 1.5,
      sub: 2.8,
      warm: 2.0,
      body: 0.8,
      tilt: -0.8,
      sat: 16,
      width: 1.1,
      bassMono: 100,
      mbLow: 28,
      mbMix: 100,
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
      drive: 0.8,
      clarity: 1.6,
      air: 1.6,
      harsh: -0.8,
      tilt: 1.6,
      sat: 0,
      width: 1.1,
    },
    audit: 'The only preset with zero saturation. Genuinely clean.',
  }),
  preset({
    name: 'Gold',
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
      drive: 1.5,
      sub: 1.6,
      body: 3.2,
      harsh: -0.8,
      air: -2.4,
      tilt: -2.4,
      sat: 12,
      width: 1.0,
      bassMono: 100,
    },
    audit:
      '+3.2 dB at 350 Hz is the largest single band boost in the catalogue. On a mix that is ' +
      'already thick this will be too much; that is what the control is for.',
  }),
  preset({
    name: 'Pearl',
    tag: 'color',
    description: 'Shimmering highs, elegant, refined.',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      drive: 0.8,
      clarity: 1.6,
      air: 3.6,
      harsh: -1.6,
      tilt: 1.6,
      sat: 3,
      width: 1.25,
      bassMono: 70,
    },
    audit: '+3.6 dB air plus +1.6 dB tilt: the brightest preset in the catalogue.',
  }),
  preset({
    name: 'Rust',
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
      'Waveshaper aliasing colours the live preview here; the export runs the clean oversampled engine.',
  }),
];
