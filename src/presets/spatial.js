/**
 * Spatial presets — imaging experiments, several of them deliberately destructive.
 *
 * ── Audit result ─────────────────────────────────────────────────────────────────────
 * This is the group where Signal Rot's "let me make a strange master" philosophy meets
 * mono compatibility. Three presets here will lose significant level when folded to mono.
 * That is the intent, so they are tagged `destructive` rather than tamed, and the phase
 * warning system flags them the moment they are applied. What was *not* intentional was
 * the absence of any indication — the audited build applied `width: 2.4` with a 14 ms Haas
 * delay and said nothing at all.
 */

import { preset } from './_shared.js';

export const SPATIAL_PRESETS = [
  preset({
    name: 'Cathedral',
    tag: 'spatial',
    description: 'Natural bloom on the sides plus air, no added reverb.',
    parameters: {
      targetLUFS: -15,
      ceiling: -1.0,
      width: 1.3,
      ms: 0.18,
      air: 2.0,
      warm: 0.6,
      bassMono: 80,
      sat: 3,
      depth: 25,
      depthSize: 'large',
    },
    audit:
      'Depth engine raised from 0 to 25 % during review — the description promised bloom and ' +
      'the preset delivered only width.',
  }),
  preset({
    name: 'Binaural Deep',
    tag: 'spatial',
    description: '3D headphone optimisation — crossfeed plus interaural delay.',
    risk: 'caution',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      binaural: true,
      crossfeed: 0.55,
      spread: 0.45,
      width: 1.2,
      haas: 4,
      air: 1.0,
      sat: 4,
    },
    audit:
      'A 4 ms Haas delay is inside the fusion window and will not be heard as an echo, but it ' +
      'does comb-filter in mono. Headphone preset — check on speakers before delivery.',
  }),
  preset({
    name: 'Inverse Phase',
    tag: 'spatial',
    description: 'Creative side comb filtering — surreal imaging.',
    risk: 'destructive',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      phaseRot: 0.65,
      width: 1.4,
      ms: 0.25,
      sat: 5,
      bassMono: 90,
    },
    audit:
      'Intentionally destructive. The side all-pass blend at 65 % is a comb filter, not a ' +
      'phase rotation, and the control has been renamed to say so. Bass-mono at 90 Hz added ' +
      'during review — the comb was reaching into the low end, which is not the interesting ' +
      'part of the effect.',
  }),
  preset({
    name: 'Holographic',
    tag: 'spatial',
    description: 'Extreme mid/side separation, 3D soundstage.',
    risk: 'destructive',
    parameters: {
      targetLUFS: -13,
      ceiling: -1.0,
      width: 2.1,
      ms: 0.4,
      bassMono: 110,
      air: 1.4,
      sat: 5,
    },
    audit:
      'Width 210 % with a +0.4 side bias: measured mono fold-down loses 6–9 dB in the ' +
      'presence band on typical material. Bass-mono at 110 Hz keeps the low end intact.',
  }),
  preset({
    name: 'Tunnel Vision',
    tag: 'spatial',
    description: 'Focused mono centre, atmospheric wide edges.',
    risk: 'caution',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      ms: -0.3,
      width: 1.6,
      bassMono: 160,
      haas: 8,
      air: 0.8,
      sat: 4,
    },
    audit:
      'The −0.3 mid/side bias and 160 % width partly cancel — net effect is a narrower centre ' +
      'with wide edges, which is what the name promises. Haas at 8 ms is the warning threshold.',
  }),
  preset({
    name: 'Panoramic',
    tag: 'spatial',
    description: '180° → 360° widefield — Haas plus decorrelated sides.',
    risk: 'destructive',
    parameters: {
      targetLUFS: -13,
      ceiling: -1.0,
      width: 2.4,
      haas: 14,
      spread: 0.7,
      crossfeed: 0.2,
      bassMono: 120,
      sat: 5,
    },
    audit:
      'The most destructive preset in the catalogue. 14 ms of Haas on a whole channel plus ' +
      '240 % width: mono fold-down is severely comb-filtered. Use it because you want that.',
  }),
  preset({
    name: 'Depth Lens',
    tag: 'spatial',
    description: 'A large depth lens — early reflections pull the mix apart without reverb.',
    parameters: {
      targetLUFS: -15,
      ceiling: -1.0,
      depth: 60,
      depthSize: 'large',
      width: 1.3,
      bassMono: 90,
      ms: 0.15,
      warm: 0.6,
      air: 1.5,
      crossfeed: 0.2,
      sat: 5,
    },
    audit:
      'Depth 60 is near maximum; the taps at 27/47 ms and their low-passed, cross-fed returns ' +
      'are first-arrival bloom only. ms +0.15 biases a touch toward the sides; width 130% with ' +
      'bass-mono 90 Hz anchors the low end. No phase trigger on the analyser.',
  }),
  preset({
    name: 'Wide Awake',
    tag: 'spatial',
    description: 'Top-heavy spatial crown — high width and air, anchored low end.',
    risk: 'caution',
    parameters: {
      targetLUFS: -13,
      ceiling: -1.0,
      widthHigh: 2.0,
      widthMid: 1.35,
      widthLow: 0.85,
      width: 1.2,
      bassMono: 110,
      air: 1.5,
      sat: 4,
    },
    audit:
      'The analyser does not monitor widthHigh, so widthHigh 200% is my own risk call: a mono ' +
      'fold-down will lose significant presence above 4 kHz. bass-mono 110 Hz and widthLow 0.85 ' +
      'keep the bottom and the lower mid stable. Declared caution, not destructive, because ' +
      'the top-only loss is recoverable by the delivery chain.',
  }),
  preset({
    name: 'Binaural Stage',
    tag: 'spatial',
    description: 'Headphone monitor stage — binaural spread, headphone glue and small-room depth.',
    risk: 'caution',
    parameters: {
      targetLUFS: -14,
      ceiling: -1.0,
      binaural: true,
      spread: 0.6,
      crossfeed: 0.6,
      depth: 20,
      depthSize: 'small',
      width: 1.1,
      air: 0.8,
      sat: 3,
    },
    audit:
      'binaural true forces crossfeed to at least 0.35 and lifts air through the spread term; ' +
      'effective side width is about 1.1 × 1.36 = 1.50×. On speakers this reads as width, not ' +
      'depth. Check the mono fold-down before delivery; declared caution.',
  }),
  preset({
    name: 'Polar Maze',
    tag: 'spatial',
    description: 'Spatial comb labyrinth — wide, phase-blended, low-band image split.',
    risk: 'destructive',
    parameters: {
      targetLUFS: -13,
      ceiling: -1.0,
      phaseRot: 0.75,
      width: 1.6,
      widthLow: 1.5,
      ms: 0.3,
      bassMono: 100,
      air: 1.0,
      sat: 5,
    },
    audit:
      'widthLow 1.5 sends the analyser to danger on purpose: below 250 Hz the side channel is ' +
      'enlarged 150% and the all-pass blend is 75%, so both low-mid and side content comb-filter ' +
      'in mono. Declared destructive. bass-mono 100 Hz protects only the <100 Hz region; the ' +
      '100–250 Hz band is the field being manipulated.',
  }),
];
