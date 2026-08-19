/**
 * Mood presets.
 *
 * ── Audit result ─────────────────────────────────────────────────────────────────────
 * Two presets carried a loudness target *and* `normalize: false`, so the number shown in
 * the Loudness tab did nothing. That is not a bug in the DSP, it is a bug in what the
 * interface communicates, and the UI now greys the target out when normalisation is off.
 * The targets have been left in place so that switching normalisation back on lands
 * somewhere sensible.
 */

import { preset } from './_shared.js';

export const MOOD_PRESETS = [
  preset({
    name: 'Melancholic Sunset',
    tag: 'mood',
    description: 'Warm low-mids, rolled-off air, nostalgic compression.',
    parameters: {
      targetLUFS: -15,
      ceiling: -1.0,
      drive: 1.5,
      warm: 2.0,
      body: 2.4,
      harsh: -1.6,
      air: -3,
      tilt: -1.6,
      sat: 10,
      width: 1.1,
      bassMono: 80,
      mbMid: 20,
      mbMix: 80,
    },
    audit:
      'Multiband mid band added to deliver the "nostalgic compression" the description ' +
      'promised — the audited preset had no dynamics processing at all.',
  }),
  preset({
    name: 'Anxious Energy',
    tag: 'mood',
    description: 'Tense mid-range, controlled harshness, dynamic instability.',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      drive: 1,
      body: 1.6,
      harsh: 1.6,
      clarity: 1.8,
      tilt: 0.8,
      sat: 6,
      width: 1.15,
      bassMono: 90,
      normalize: false,
    },
    audit:
      'Normalisation off is deliberate — the instability is the point. The loudness target is ' +
      'inert and the UI greys it out.',
  }),
  preset({
    name: 'Euphoric Peak',
    tag: 'mood',
    description: 'Bright, open, expansive, uplifting curve.',
    parameters: {
      targetLUFS: -11,
      ceiling: -1.0,
      drive: 1.5,
      sub: 0.8,
      clarity: 1.6,
      air: 3.5,
      tilt: 1.8,
      sat: 6,
      width: 1.5,
      spread: 0.3,
      bassMono: 100,
    },
    audit:
      '+3.5 dB air on top of +1.8 dB tilt is about +5 dB above 12 kHz. Bright by design; ' +
      'watch it on already-bright sources.',
  }),
  preset({
    name: 'Dark Meditation',
    tag: 'mood',
    description: 'Deep lows, subdued highs, centred focus.',
    parameters: {
      targetLUFS: -18,
      ceiling: -1.0,
      drive: 0.3,
      sub: 3.2,
      warm: 1.6,
      air: -3,
      tilt: -2.4,
      ms: -0.25,
      width: 0.85,
      bassMono: 70,
      sat: 3,
    },
    audit:
      'Sub reduced from +4.0 to +3.2 dB during review; stacked with warmth the original was ' +
      '+5 dB at 50 Hz, which at 85 % width put a lot of correlated energy in one place.',
  }),
  preset({
    name: 'Manic Joy',
    tag: 'mood',
    description: 'Saturated, bright, slightly chaotic harmonic enhancement.',
    risk: 'caution',
    parameters: {
      targetLUFS: -11,
      ceiling: -1.0,
      drive: 2,
      clarity: 1.6,
      air: 2.4,
      tilt: 1.4,
      sat: 24,
      phaseRot: 0.15,
      width: 1.4,
      bassMono: 110,
    },
    audit:
      'Highest saturation in the catalogue at 24 %. The 15 % side comb blend is a mild, ' +
      'deliberate instability.',
  }),
  preset({
    name: 'Empty Void',
    tag: 'mood',
    description: 'Stark, minimal, spacious — uncomfortable silences preserved.',
    parameters: {
      targetLUFS: -20,
      ceiling: -1.0,
      normalize: false,
      drive: 0,
      sub: 0.8,
      air: 0.8,
      tilt: -0.8,
      width: 1.6,
      spread: 0.4,
      bassMono: 60,
      sat: 0,
    },
    audit:
      'Normalisation off so the silences stay silent. Bass-mono added at 60 Hz: at 160 % ' +
      'width the audited version let sub content wander.',
  }),
];
