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
  preset({
    name: 'Bittersweet Glow',
    tag: 'mood',
    description: 'Warm, gently compressed, with a soft airy bloom. Sweet but not bright.',
    parameters: {
      targetLUFS: -15,
      ceiling: -1.0,
      drive: 1,
      warm: 1.6,
      body: 1.0,
      air: 1.8,
      tilt: 0.6,
      mbMid: 15,
      mbMix: 80,
      depth: 15,
      width: 1.15,
      bassMono: 80,
      sat: 10,
    },
    audit:
      'mbMid 15 provides the compression; depth 15 is the soft bloom. Warmth +1.6 and air +1.8 ' +
      'give a warm-then-clear curve, not the rolled-off top of Melancholic Sunset. Width 115% ' +
      'with bass-mono 80 Hz is mono-safe.',
  }),
  preset({
    name: 'Uneasy Calm',
    tag: 'mood',
    description: 'Low-mid tension, withheld brightness, a controlled breath of compression.',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      drive: 1,
      body: 1.6,
      warm: 0.6,
      harsh: -0.8,
      air: -1.2,
      mbMid: 25,
      mbMix: 70,
      width: 1.1,
      bassMono: 80,
      sat: 6,
    },
    audit:
      '+1.6 body sits in the 350 Hz register and −1.2 air withholds the top. mbMid 25 at a 70% ' +
      'parallel mix is the breath, on medium ballistics so it does not pump. Width 110% with ' +
      'bass-mono 80 Hz; no phase risk.',
  }),
  preset({
    name: 'Suspended',
    tag: 'mood',
    description: 'Floating and still. Dynamics preserved, no loudness war, silence stays silent.',
    parameters: {
      targetLUFS: -17,
      ceiling: -1.0,
      normalize: false,
      drive: 0,
      depth: 18,
      depthSize: 'small',
      width: 1.25,
      bassMono: 70,
      air: 0.8,
      sat: 0,
    },
    audit:
      'Normalisation off so the silences are real. Depth small gives a slight air pocket without ' +
      'a tail; width 125% with bass-mono 70 Hz is safe. No saturation.',
  }),
  preset({
    name: 'Hiraeth',
    tag: 'mood',
    description: 'Warm tape, soft hiss and a small-room bloom — longing, not melancholy.',
    parameters: {
      targetLUFS: -16,
      ceiling: -1.0,
      drive: 1,
      tape: 25,
      hiss: 8,
      warm: 1.4,
      body: 0.8,
      harsh: -0.8,
      air: 1.2,
      depth: 12,
      depthSize: 'small',
      sat: 8,
      width: 1.15,
      bassMono: 75,
      textureSeed: 0x0f6a1003,
    },
    audit:
      'Tape 25 gives a gentle head bump and hiss 8 a faint bed; depth small is a 11/19 ms ' +
      'bloom. Width 115% with bass-mono 75 Hz. The top is slightly tamed by −0.8 at 2.8 kHz ' +
      'but keeps +1.2 air, so it is warm rather than dull. Explicit seed for deterministic export.',
  }),
];
