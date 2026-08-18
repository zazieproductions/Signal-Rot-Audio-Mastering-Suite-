/**
 * Immersive speaker layouts.
 *
 * ── Two coordinate conventions, kept apart ───────────────────────────────────────────
 *   `azimuthAdm`  positive = LEFT   (ITU-R BS.2076 / BS.2051)
 *   `azimuthHrtf` positive = RIGHT  (Web Audio PannerNode +X axis)
 * See `sonic-lab.js` for the full explanation. Never derive one from the other ad hoc.
 *
 * ── WAVEFORMATEXTENSIBLE channel masks ───────────────────────────────────────────────
 * The audited implementation assigned `TOP_FRONT_CENTER` (0x2000) to the right front
 * height and `TOP_BACK_CENTER` (0x10000) to the right rear height. Since channel order in
 * a `WAVE_FORMAT_EXTENSIBLE` file is defined as *ascending mask-bit order*, that bug
 * mis-ordered as well as mis-labelled every 7.1.2 and 7.1.4 export. Correct values are
 * `TOP_FRONT_RIGHT` (0x4000) and `TOP_BACK_RIGHT` (0x20000); see `tests/format/wav.test.js`.
 *
 * Layouts that cannot be expressed with the standard mask (9.1.6 has top-middle speakers
 * with no assigned bit; Sonic Lab is not a standard layout at all) declare `mask: 0` and
 * are written in *layout order* with a documented channel map, which is what the mask's
 * absence means in practice.
 */

import { SPEAKER_MASK } from '../encode/wav.js';
import { SONIC_LAB_SPEAKERS } from './sonic-lab.js';

const M = SPEAKER_MASK;

/**
 * @typedef {import('./sonic-lab.js').SpeakerDefinition} SpeakerDefinition
 */

const speaker = (
  id,
  azimuthAdm,
  elevation,
  admSpeakerLabel,
  wavMaskBit,
  description,
  extra = {},
) => ({
  id,
  label: id,
  description,
  azimuthAdm,
  // `|| 0` normalises negative zero, which JSON.stringify would silently turn into 0
  // and which would make a serialised channel map unequal to the object it came from.
  azimuthHrtf: -azimuthAdm || 0,
  elevation,
  admSpeakerLabel,
  wavMaskBit,
  ring: elevation > 20 ? 'roof' : elevation > 0 ? 'height' : 'ear',
  ...extra,
});

/**
 * Standard speaker definitions, keyed by id.
 * ADM speaker labels follow BS.2051 (`M` = middle layer, `U` = upper, `B` = bottom),
 * with the azimuth in the label using the same positive-is-left convention.
 */
export const SPEAKERS = Object.freeze({
  L: speaker('L', 30, 0, 'M+030', M.FRONT_LEFT, 'Front left'),
  R: speaker('R', -30, 0, 'M-030', M.FRONT_RIGHT, 'Front right'),
  C: speaker('C', 0, 0, 'M+000', M.FRONT_CENTER, 'Front centre'),
  LFE: speaker('LFE', 0, -15, 'LFE1', M.LOW_FREQUENCY, 'Low-frequency effects', { lfe: true }),
  Ls: speaker('Ls', 110, 0, 'M+110', M.BACK_LEFT, 'Surround left (5.1)'),
  Rs: speaker('Rs', -110, 0, 'M-110', M.BACK_RIGHT, 'Surround right (5.1)'),
  Lss: speaker('Lss', 90, 0, 'M+090', M.SIDE_LEFT, 'Side surround left'),
  Rss: speaker('Rss', -90, 0, 'M-090', M.SIDE_RIGHT, 'Side surround right'),
  // BS.2051 System D/E place the rear surrounds at ±135°. The audited code carried the
  // label 'M+135' with an azimuth of 150°; the metadata and the renderer disagreed.
  Lrs: speaker('Lrs', 135, 0, 'M+135', M.BACK_LEFT, 'Rear surround left'),
  Rrs: speaker('Rrs', -135, 0, 'M-135', M.BACK_RIGHT, 'Rear surround right'),
  Lw: speaker('Lw', 60, 0, 'M+060', M.FRONT_LEFT_OF_CENTER, 'Wide left'),
  Rw: speaker('Rw', -60, 0, 'M-060', M.FRONT_RIGHT_OF_CENTER, 'Wide right'),
  Ltf: speaker('Ltf', 45, 45, 'U+045', M.TOP_FRONT_LEFT, 'Top front left'),
  Rtf: speaker('Rtf', -45, 45, 'U-045', M.TOP_FRONT_RIGHT, 'Top front right'),
  Ltm: speaker('Ltm', 90, 60, 'U+090', 0, 'Top middle left (no standard mask bit)'),
  Rtm: speaker('Rtm', -90, 60, 'U-090', 0, 'Top middle right (no standard mask bit)'),
  Ltr: speaker('Ltr', 135, 45, 'U+135', M.TOP_BACK_LEFT, 'Top rear left'),
  Rtr: speaker('Rtr', -135, 45, 'U-135', M.TOP_BACK_RIGHT, 'Top rear right'),
  ...Object.fromEntries(SONIC_LAB_SPEAKERS.map((s) => [s.id, s])),
});

/**
 * @typedef {object} LayoutDefinition
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string[]} channels      speaker ids in *layout order*
 * @property {boolean} standardMask   whether a WAVEFORMATEXTENSIBLE mask fully describes it
 * @property {string} [admPackFormat] BS.2051 common-definition pack, when one applies
 * @property {string} notes
 */

/** @type {Record<string, LayoutDefinition>} */
export const LAYOUTS = Object.freeze({
  5.1: {
    id: '5.1',
    name: '5.1 surround',
    description: 'L R C LFE Ls Rs',
    channels: ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'],
    standardMask: true,
    admPackFormat: 'AP_00010003',
    notes: 'BS.2051 System B. Widely supported; a safe channel-bed delivery.',
  },
  7.1: {
    id: '7.1',
    name: '7.1 surround',
    description: 'L R C LFE Lss Rss Lrs Rrs',
    channels: ['L', 'R', 'C', 'LFE', 'Lss', 'Rss', 'Lrs', 'Rrs'],
    standardMask: true,
    admPackFormat: 'AP_00010004',
    notes: 'BS.2051 System C-adjacent. Side and rear surrounds are separate feeds.',
  },
  '7.1.2': {
    id: '7.1.2',
    name: '7.1.2 with front heights',
    description: '7.1 plus two front height channels',
    channels: ['L', 'R', 'C', 'LFE', 'Lss', 'Rss', 'Lrs', 'Rrs', 'Ltf', 'Rtf'],
    standardMask: true,
    notes: 'A common Atmos bed size. Height content here is synthesised — see below.',
  },
  '7.1.4': {
    id: '7.1.4',
    name: '7.1.4 with four heights',
    description: '7.1 plus four height channels',
    channels: ['L', 'R', 'C', 'LFE', 'Lss', 'Rss', 'Lrs', 'Rrs', 'Ltf', 'Rtf', 'Ltr', 'Rtr'],
    standardMask: true,
    notes: 'The standard Atmos home bed. Height content here is synthesised.',
  },
  '9.1.6': {
    id: '9.1.6',
    name: '9.1.6 with wides and six heights',
    description: '7.1 plus wides plus six height channels',
    channels: [
      'L',
      'R',
      'C',
      'LFE',
      'Lss',
      'Rss',
      'Lrs',
      'Rrs',
      'Lw',
      'Rw',
      'Ltf',
      'Rtf',
      'Ltm',
      'Rtm',
      'Ltr',
      'Rtr',
    ],
    standardMask: false,
    notes:
      'Top-middle speakers have no WAVEFORMATEXTENSIBLE mask bit, so the mask is written ' +
      'as 0 and the file must be routed using the exported channel map.',
  },
  soniclab: {
    id: 'soniclab',
    name: 'Sonic Lab 20.4',
    description: 'Anton Bruckner Privatuniversität, Linz — 24-channel periphonic',
    channels: SONIC_LAB_SPEAKERS.map((s) => s.id),
    standardMask: false,
    notes:
      'Venue-specific layout. Not a standard. Always deliver with the exported channel ' +
      'map (Immersive → Export channel map).',
  },
});

/** Ordered list for UI menus. */
export const LAYOUT_IDS = Object.freeze(Object.keys(LAYOUTS));

/** @param {string} id */
export const getLayout = (id) => LAYOUTS[id] ?? null;

/** Channel count of a layout. */
export const channelCount = (id) => (LAYOUTS[id] ? LAYOUTS[id].channels.length : 0);

/** Indices of LFE / subwoofer channels within a layout's delivery order. */
export function lfeChannelIndices(layoutId, order) {
  const keys = order ?? LAYOUTS[layoutId]?.channels ?? [];
  const out = [];
  keys.forEach((k, i) => {
    if (SPEAKERS[k] && SPEAKERS[k].lfe) out.push(i);
  });
  return out;
}

/**
 * Determine the WAV channel order and mask for a layout.
 *
 * `WAVE_FORMAT_EXTENSIBLE` defines the interleave order as ascending mask-bit order, so
 * when a layout maps cleanly onto standard bits the channels must be *re-sorted* out of
 * layout order into mask order. When it does not, we keep layout order and emit mask 0.
 *
 * @param {string} layoutId
 * @returns {{order: string[], mask: number, standard: boolean}}
 */
export function wavChannelOrder(layoutId) {
  const layout = LAYOUTS[layoutId];
  if (!layout) return { order: [], mask: 0, standard: false };

  const usable =
    layout.standardMask && layout.channels.every((k) => (SPEAKERS[k]?.wavMaskBit ?? 0) > 0);

  if (!usable) return { order: layout.channels.slice(), mask: 0, standard: false };

  const bits = layout.channels.map((k) => SPEAKERS[k].wavMaskBit);
  // A duplicate bit would mean two channels claiming the same speaker — refuse rather
  // than emit an ambiguous file.
  if (new Set(bits).size !== bits.length) {
    return { order: layout.channels.slice(), mask: 0, standard: false };
  }

  const order = layout.channels
    .slice()
    .sort((a, b) => SPEAKERS[a].wavMaskBit - SPEAKERS[b].wavMaskBit);
  const mask = bits.reduce((m, b) => m | b, 0) >>> 0;
  return { order, mask, standard: true };
}

/**
 * Plain-text channel map for any layout, for delivery alongside the audio.
 * @param {string} layoutId
 * @param {object} [meta]
 */
export function channelMapText(layoutId, meta = {}) {
  const layout = LAYOUTS[layoutId];
  if (!layout) return '';
  const { order, mask, standard } = wavChannelOrder(layoutId);
  const lines = [];
  lines.push(`${layout.name.toUpperCase()} — CHANNEL MAP`);
  lines.push(layout.description);
  lines.push('');
  lines.push('Azimuth (ADM)  : degrees, POSITIVE = LEFT   [ITU-R BS.2076]');
  lines.push('Azimuth (HRTF) : degrees, POSITIVE = RIGHT  [Web Audio PannerNode]');
  lines.push('Elevation      : degrees, POSITIVE = UP');
  lines.push('');
  if (meta.sourceName) lines.push(`Source      : ${meta.sourceName}`);
  if (meta.sampleRate) lines.push(`Sample rate : ${meta.sampleRate} Hz`);
  if (meta.engineVersion) lines.push(`Engine      : Signal Rot ${meta.engineVersion}`);
  lines.push(
    `Mask        : ${standard ? `0x${mask.toString(16).toUpperCase()}` : '0 (non-standard layout)'}`,
  );
  lines.push('');
  lines.push('CH  ID     AZ(ADM)  AZ(HRTF)   EL   ADM LABEL             DESCRIPTION');
  lines.push('--  -----  -------  --------  ----  --------------------  -------------------');
  order.forEach((k, i) => {
    const s = SPEAKERS[k];
    lines.push(
      [
        String(i + 1).padStart(2),
        s.id.padEnd(5),
        s.azimuthAdm.toFixed(1).padStart(7),
        s.azimuthHrtf.toFixed(1).padStart(8),
        s.elevation.toFixed(0).padStart(4),
        s.admSpeakerLabel.padEnd(20),
        s.description,
      ].join('  '),
    );
  });
  lines.push('');
  lines.push(layout.notes);
  return lines.join('\n');
}

/** Machine-readable channel map for any layout. */
export function channelMapJson(layoutId, meta = {}) {
  const layout = LAYOUTS[layoutId];
  if (!layout) return null;
  const { order, mask, standard } = wavChannelOrder(layoutId);
  return {
    layout: layout.id,
    name: layout.name,
    channelCount: order.length,
    channelMask: standard ? mask : 0,
    standardMask: standard,
    conventions: {
      azimuthAdm: 'degrees, positive = left (ITU-R BS.2076)',
      azimuthHrtf: 'degrees, positive = right (Web Audio PannerNode)',
      elevation: 'degrees, positive = up',
    },
    ...meta,
    channels: order.map((k, i) => {
      const s = SPEAKERS[k];
      return {
        channel: i + 1,
        id: s.id,
        azimuthAdm: s.azimuthAdm,
        azimuthHrtf: s.azimuthHrtf,
        elevation: s.elevation,
        lfe: !!s.lfe,
        admSpeakerLabel: s.admSpeakerLabel,
        wavMaskBit: s.wavMaskBit,
        description: s.description,
      };
    }),
    notes: layout.notes,
  };
}
