/**
 * Signal Rot — immersive speaker layouts and channel metadata.
 * Pure data + small pure helpers (unit-tested in tests/layouts.test.js).
 *
 * Azimuth conventions:
 *  - `az`  : +azimuth = RIGHT, used for the internal HRTF panner.
 *  - `aAz` : ADM azimuth, +azimuth = LEFT (matches BS.2076 / channel config).
 *  - `el`  : elevation in degrees.
 */

export const SP = {
  L: { az: -30, el: 0, adm: 'M+030', aAz: 30, bit: 0x1 },
  R: { az: 30, el: 0, adm: 'M-030', aAz: -30, bit: 0x2 },
  C: { az: 0, el: 0, adm: 'M+000', aAz: 0, bit: 0x4 },
  LFE: { az: 0, el: -15, adm: 'LFE1', aAz: 0, bit: 0x8, lfe: true },
  Ls: { az: -110, el: 0, adm: 'M+110', aAz: 110, bit: 0x10 },
  Rs: { az: 110, el: 0, adm: 'M-110', aAz: -110, bit: 0x20 },
  Lss: { az: -90, el: 0, adm: 'M+090', aAz: 90, bit: 0x200 },
  Rss: { az: 90, el: 0, adm: 'M-090', aAz: -90, bit: 0x400 },
  Lrs: { az: -150, el: 0, adm: 'M+135', aAz: 135, bit: 0x10 },
  Rrs: { az: 150, el: 0, adm: 'M-135', aAz: -135, bit: 0x20 },
  Lw: { az: -60, el: 0, adm: 'M+060', aAz: 60, bit: 0 },
  Rw: { az: 60, el: 0, adm: 'M-060', aAz: -60, bit: 0 },
  Ltf: { az: -45, el: 45, adm: 'U+045', aAz: 45, bit: 0x1000 },
  Rtf: { az: 45, el: 45, adm: 'U-045', aAz: -45, bit: 0x2000 },
  Ltr: { az: -135, el: 45, adm: 'U+135', aAz: 135, bit: 0x8000 },
  Rtr: { az: 135, el: 45, adm: 'U-135', aAz: -135, bit: 0x10000 },
  Ltm: { az: -90, el: 60, adm: 'U+090', aAz: 90, bit: 0 },
  Rtm: { az: 90, el: 60, adm: 'U-090', aAz: -90, bit: 0 },
  /* Sonic Lab — Anton Bruckner Privatuniversität Linz. 20.4 periphonic dome.
     Ear ring 1-8 (el 0) · Ground ring 9-12 (el -8) · High ring 13-16 (el 13)
     · Roof ring 17-20 (el 33-35) · Subwoofers 21-24 (el -8). */
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
};

export const LAYOUTS = {
  '5.1': ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'],
  '7.1': ['L', 'R', 'C', 'LFE', 'Lss', 'Rss', 'Lrs', 'Rrs'],
  '7.1.2': ['L', 'R', 'C', 'LFE', 'Lss', 'Rss', 'Lrs', 'Rrs', 'Ltf', 'Rtf'],
  '7.1.4': ['L', 'R', 'C', 'LFE', 'Lss', 'Rss', 'Lrs', 'Rrs', 'Ltf', 'Rtf', 'Ltr', 'Rtr'],
  '9.1.6': ['L', 'R', 'C', 'LFE', 'Lss', 'Rss', 'Lrs', 'Rrs', 'Lw', 'Rw', 'Ltf', 'Rtf', 'Ltm', 'Rtm', 'Ltr', 'Rtr'],
  soniclab: [
    'SL1', 'SL2', 'SL3', 'SL4', 'SL5', 'SL6', 'SL7', 'SL8', 'SL9', 'SL10', 'SL11', 'SL12',
    'SL13', 'SL14', 'SL15', 'SL16', 'SL17', 'SL18', 'SL19', 'SL20', 'SL21', 'SL22', 'SL23', 'SL24',
  ],
};

export const LAYOUT_LABELS = {
  '5.1': '5.1 Surround',
  '7.1': '7.1 Surround',
  '7.1.2': '7.1.2 Atmos bed',
  '7.1.4': '7.1.4 Atmos bed',
  '9.1.6': '9.1.6 Atmos bed',
  soniclab: 'Sonic Lab 20.4',
};

/**
 * WAVE-extensible channel order + mask for a layout.
 * Falls back to the layout's natural order with mask 0 when bits are ambiguous.
 */
export function getWavOrder(layout) {
  const keys = LAYOUTS[layout];
  const allBits = keys.every((k) => SP[k].bit > 0);
  if (!allBits) return { order: keys.slice(), mask: 0 };
  const ord = keys.slice().sort((a, b) => SP[a].bit - SP[b].bit);
  const mask = keys.reduce((m, k) => m | SP[k].bit, 0);
  return { order: ord, mask };
}

/**
 * Machine-readable channel map for a layout (as required by the immersive subsystem).
 * ADM azimuth (`azimuth`) uses + = left; `hrtfAzimuth` is the internal panner value (+ = right).
 */
export function buildChannelMap(layout) {
  const keys = LAYOUTS[layout];
  return {
    layout: layout,
    layoutName: LAYOUT_LABELS[layout] || layout,
    channelCount: keys.length,
    channels: keys.map((k, i) => {
      const sp = SP[k];
      return {
        index: i + 1,
        label: k,
        admLabel: sp.adm,
        azimuth: sp.aAz,
        hrtfAzimuth: sp.az,
        elevation: sp.el,
        lfe: !!sp.lfe,
      };
    }),
  };
}

/** Ordered channel metadata list (SP entries) for a layout — used by the encoders. */
export function channelsOf(layout) {
  return LAYOUTS[layout].map((k) => SP[k]);
}
