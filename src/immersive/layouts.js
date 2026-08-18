/**
 * Immersive speaker layouts, WAVE channel masks and ADM (BS.2076) labels.
 *
 * Channel-mask corrections over the original table. The Microsoft
 * `dwChannelMask` bit assignments (KSAUDIO_SPEAKER_*) are fixed by the
 * WAVEFORMATEXTENSIBLE spec, and three entries were mapped to the wrong bit:
 *
 *   - `Rtf` (top front right) used 0x2000, which is TOP_FRONT_**CENTRE**.
 *     0x4000 is TOP_FRONT_RIGHT.
 *   - `Rtr` (top rear right) used 0x10000, which is TOP_BACK_**CENTRE**.
 *     0x20000 is TOP_BACK_RIGHT.
 *   - `Lw`/`Rw` (front wides) carried no bit at all; FRONT_LEFT_OF_CENTER
 *     (0x40) and FRONT_RIGHT_OF_CENTER (0x80) are the conventional mapping.
 *
 * The practical effect of the first two was that a 7.1.4 export declared its
 * height channels as centre channels, so a conforming renderer placed the
 * right-hand height content in the middle of the room.
 */

/** Microsoft WAVEFORMATEXTENSIBLE speaker position bits. */
export const SPEAKER = Object.freeze({
  FRONT_LEFT: 0x1,
  FRONT_RIGHT: 0x2,
  FRONT_CENTER: 0x4,
  LOW_FREQUENCY: 0x8,
  BACK_LEFT: 0x10,
  BACK_RIGHT: 0x20,
  FRONT_LEFT_OF_CENTER: 0x40,
  FRONT_RIGHT_OF_CENTER: 0x80,
  BACK_CENTER: 0x100,
  SIDE_LEFT: 0x200,
  SIDE_RIGHT: 0x400,
  TOP_CENTER: 0x800,
  TOP_FRONT_LEFT: 0x1000,
  TOP_FRONT_CENTER: 0x2000,
  TOP_FRONT_RIGHT: 0x4000,
  TOP_BACK_LEFT: 0x8000,
  TOP_BACK_CENTER: 0x10000,
  TOP_BACK_RIGHT: 0x20000,
});

/**
 * Speaker table.
 *
 * `az`/`el` are degrees in the renderer's convention (+azimuth = right), used
 * to place HRTF panners. `aAz` is the ADM/BS.2051 convention (+azimuth =
 * left). `bit` is the WAVE channel-mask bit, or 0 where no standard bit
 * exists for that position.
 */
export const SPEAKERS = Object.freeze({
  L: { az: -30, el: 0, adm: 'M+030', aAz: 30, bit: SPEAKER.FRONT_LEFT },
  R: { az: 30, el: 0, adm: 'M-030', aAz: -30, bit: SPEAKER.FRONT_RIGHT },
  C: { az: 0, el: 0, adm: 'M+000', aAz: 0, bit: SPEAKER.FRONT_CENTER },
  LFE: { az: 0, el: -15, adm: 'LFE1', aAz: 0, bit: SPEAKER.LOW_FREQUENCY, lfe: true },
  Ls: { az: -110, el: 0, adm: 'M+110', aAz: 110, bit: SPEAKER.BACK_LEFT },
  Rs: { az: 110, el: 0, adm: 'M-110', aAz: -110, bit: SPEAKER.BACK_RIGHT },
  Lss: { az: -90, el: 0, adm: 'M+090', aAz: 90, bit: SPEAKER.SIDE_LEFT },
  Rss: { az: 90, el: 0, adm: 'M-090', aAz: -90, bit: SPEAKER.SIDE_RIGHT },
  // ITU-R BS.2051 systems C/D place the rear surrounds at +/-135 deg, which is
  // what the ADM label declares. The original table rendered them at +/-150,
  // so the binaural preview disagreed with the exported metadata by 15 deg.
  Lrs: { az: -135, el: 0, adm: 'M+135', aAz: 135, bit: SPEAKER.BACK_LEFT },
  Rrs: { az: 135, el: 0, adm: 'M-135', aAz: -135, bit: SPEAKER.BACK_RIGHT },
  Lw: { az: -60, el: 0, adm: 'M+060', aAz: 60, bit: SPEAKER.FRONT_LEFT_OF_CENTER },
  Rw: { az: 60, el: 0, adm: 'M-060', aAz: -60, bit: SPEAKER.FRONT_RIGHT_OF_CENTER },
  Ltf: { az: -45, el: 45, adm: 'U+045', aAz: 45, bit: SPEAKER.TOP_FRONT_LEFT },
  Rtf: { az: 45, el: 45, adm: 'U-045', aAz: -45, bit: SPEAKER.TOP_FRONT_RIGHT },
  Ltr: { az: -135, el: 45, adm: 'U+135', aAz: 135, bit: SPEAKER.TOP_BACK_LEFT },
  Rtr: { az: 135, el: 45, adm: 'U-135', aAz: -135, bit: SPEAKER.TOP_BACK_RIGHT },
  // No standard mask bit exists for a left/right pair directly overhead;
  // TOP_CENTER is a single channel. Layouts using these fall back to mask 0.
  Ltm: { az: -90, el: 60, adm: 'U+090', aAz: 90, bit: 0 },
  Rtm: { az: 90, el: 60, adm: 'U-090', aAz: -90, bit: 0 },

  /* Sonic Lab — Anton Bruckner Privatuniversität, Linz. 20.4 periphonic rig.
     Venue documentation uses +azimuth = left (the ADM convention), so `az` is
     negated for the HRTF panner. Ear ring 1-8 (el 0) · ground ring 9-12
     (el -8) · high ring 13-16 (el 13) · roof ring 17-20 (el 33-35) ·
     subwoofers 21-24 (el -8, floor standing). No WAVE mask bits apply. */
  SL1: { az: -30, el: 0, adm: 'SL_01', aAz: 30, bit: 0 },
  SL2: { az: 27, el: 0, adm: 'SL_02', aAz: -27, bit: 0 },
  SL3: { az: -67, el: 0, adm: 'SL_03', aAz: 67, bit: 0 },
  SL4: { az: 61, el: 0, adm: 'SL_04', aAz: -61, bit: 0 },
  SL5: { az: -112.5, el: 0, adm: 'SL_05', aAz: 112.5, bit: 0 },
  SL6: { az: 115, el: 0, adm: 'SL_06', aAz: -115, bit: 0 },
  SL7: { az: -153, el: 0, adm: 'SL_07', aAz: 153, bit: 0 },
  SL8: { az: 155, el: 0, adm: 'SL_08', aAz: -155, bit: 0 },
  SL9: { az: -43.5, el: -8, adm: 'SL_09', aAz: 43.5, bit: 0 },
  SL10: { az: 40, el: -8, adm: 'SL_10', aAz: -40, bit: 0 },
  SL11: { az: -134, el: -8, adm: 'SL_11', aAz: 134, bit: 0 },
  SL12: { az: 136, el: -8, adm: 'SL_12', aAz: -136, bit: 0 },
  SL13: { az: -43.5, el: 13, adm: 'SL_13', aAz: 43.5, bit: 0 },
  SL14: { az: 40, el: 13, adm: 'SL_14', aAz: -40, bit: 0 },
  SL15: { az: -134, el: 13, adm: 'SL_15', aAz: 134, bit: 0 },
  SL16: { az: 136, el: 13, adm: 'SL_16', aAz: -136, bit: 0 },
  SL17: { az: -44, el: 33, adm: 'SL_17', aAz: 44, bit: 0 },
  SL18: { az: 41.5, el: 35, adm: 'SL_18', aAz: -41.5, bit: 0 },
  SL19: { az: -131, el: 34, adm: 'SL_19', aAz: 131, bit: 0 },
  SL20: { az: 130, el: 35, adm: 'SL_20', aAz: -130, bit: 0 },
  SL21: { az: -90, el: -8, adm: 'SL_SUB_L', aAz: 90, bit: 0, lfe: true },
  SL22: { az: 90, el: -8, adm: 'SL_SUB_R', aAz: -90, bit: 0, lfe: true },
  SL23: { az: 0, el: -8, adm: 'SL_SUB_F', aAz: 0, bit: 0, lfe: true },
  SL24: { az: 180, el: -8, adm: 'SL_SUB_B', aAz: 180, bit: 0, lfe: true },
});

/** Channel orders for each supported output layout. */
export const LAYOUTS = Object.freeze({
  '5.1': ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'],
  '7.1': ['L', 'R', 'C', 'LFE', 'Lss', 'Rss', 'Lrs', 'Rrs'],
  '7.1.2': ['L', 'R', 'C', 'LFE', 'Lss', 'Rss', 'Lrs', 'Rrs', 'Ltf', 'Rtf'],
  '7.1.4': ['L', 'R', 'C', 'LFE', 'Lss', 'Rss', 'Lrs', 'Rrs', 'Ltf', 'Rtf', 'Ltr', 'Rtr'],
  '9.1.6': [
    'L', 'R', 'C', 'LFE', 'Lss', 'Rss', 'Lrs', 'Rrs',
    'Lw', 'Rw', 'Ltf', 'Rtf', 'Ltm', 'Rtm', 'Ltr', 'Rtr',
  ],
  soniclab: [
    'SL1', 'SL2', 'SL3', 'SL4', 'SL5', 'SL6', 'SL7', 'SL8',
    'SL9', 'SL10', 'SL11', 'SL12', 'SL13', 'SL14', 'SL15', 'SL16',
    'SL17', 'SL18', 'SL19', 'SL20', 'SL21', 'SL22', 'SL23', 'SL24',
  ],
});

/** Human-readable channel count, e.g. '7.1.4' -> 12. */
export const channelCount = (layout) => (LAYOUTS[layout] ? LAYOUTS[layout].length : 0);

/**
 * Determine the interleaved channel order and WAVE channel mask for a layout.
 *
 * WAVEFORMATEXTENSIBLE requires channels to appear in ascending mask-bit
 * order. When a layout contains any speaker without a standard mask bit the
 * mask is meaningless, so we emit 0 and keep the layout's natural order —
 * the ADM metadata then carries the routing instead.
 *
 * @param {string} layout
 * @returns {{order:string[], mask:number, maskable:boolean}}
 */
export function getWavOrder(layout) {
  const keys = LAYOUTS[layout];
  if (!keys) throw new RangeError(`Unknown layout: ${layout}`);

  const maskable = keys.every((k) => SPEAKERS[k].bit > 0);
  if (!maskable) return { order: keys.slice(), mask: 0, maskable: false };

  // Duplicate bits would make the mask ambiguous (two channels claiming the
  // same speaker position), so treat that as unmaskable too.
  const bits = keys.map((k) => SPEAKERS[k].bit);
  if (new Set(bits).size !== bits.length) {
    return { order: keys.slice(), mask: 0, maskable: false };
  }

  const order = keys.slice().sort((a, b) => SPEAKERS[a].bit - SPEAKERS[b].bit);
  const mask = bits.reduce((m, b) => m | b, 0);
  return { order, mask, maskable: true };
}

/**
 * Map a layout's natural channel order onto the WAVE interleave order.
 * @param {string} layout
 * @returns {number[]} index into the layout array for each output channel
 */
export function wavChannelPermutation(layout) {
  const keys = LAYOUTS[layout];
  const { order } = getWavOrder(layout);
  return order.map((k) => keys.indexOf(k));
}
