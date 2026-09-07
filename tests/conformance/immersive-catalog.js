/**
 * Immersive layout verification catalog — channel maps, roles, expected feeds.
 * No production code is modified; this is a read-only view of `layouts.js`.
 */

import {
  LAYOUTS,
  LAYOUT_IDS,
  SPEAKERS,
  wavChannelOrder,
  lfeChannelIndices,
} from '../../src/audio/immersive/layouts.js';

/**
 * Spatial classification of a speaker from its ADM azimuth / elevation.
 * Positive ADM azimuth is LEFT. Elevation ≥ 20 is treated as height/roof.
 */
export function classifySpeaker(sp) {
  const roles = [];
  if (sp.lfe) {
    roles.push('sub');
    return roles;
  }
  if (sp.elevation >= 20) roles.push('height');
  else if (sp.elevation > 4) roles.push('high');
  else if (sp.elevation < -4) roles.push('ground');
  else roles.push('ear');

  const az = sp.azimuthAdm;
  const abs = Math.abs(az);
  if (abs <= 20) roles.push('front-center');
  else if (abs <= 50) roles.push(az > 0 ? 'front-left' : 'front-right');
  else if (abs <= 80) roles.push(az > 0 ? 'wide-left' : 'wide-right');
  else if (abs < 110) roles.push(az > 0 ? 'side-left' : 'side-right');
  else roles.push(az > 0 ? 'rear-left' : 'rear-right');
  roles.push(az > 0 ? 'left' : az < 0 ? 'right' : 'center');
  return roles;
}

export function layoutReport(id) {
  const layout = LAYOUTS[id];
  const { order, mask, standard } = wavChannelOrder(id);
  const channels = order.map((key, index) => {
    const sp = SPEAKERS[key];
    return {
      index,
      wavChannel: index + 1,
      id: key,
      description: sp.description,
      azimuthAdm: sp.azimuthAdm,
      azimuthHrtf: sp.azimuthHrtf,
      elevation: sp.elevation,
      lfe: !!sp.lfe,
      ring: sp.ring,
      admSpeakerLabel: sp.admSpeakerLabel,
      wavMaskBit: sp.wavMaskBit,
      roles: classifySpeaker(sp),
    };
  });
  return {
    id,
    name: layout.name,
    description: layout.description,
    channelCount: channels.length,
    standardMask: standard,
    mask,
    lfeIndices: lfeChannelIndices(id, order),
    expectedFeeds: layout.channels.slice(),
    deliveryOrder: order,
    channels,
    notes: layout.notes,
  };
}

export function allLayoutReports() {
  return Object.fromEntries(LAYOUT_IDS.map((id) => [id, layoutReport(id)]));
}
