/**
 * Real-browser render of every immersive layout.
 *
 * Production `buildSpeakerFeeds` is used as-is. We do not change it. We check that
 * every declared channel exists, is connected, carries energy where the routing
 * contract says it should, and produces finite deterministic output.
 */

import {
  LAYOUTS,
  LAYOUT_IDS,
  SPEAKERS,
  wavChannelOrder,
} from '../../../src/audio/immersive/layouts.js';
import { buildSpeakerFeeds } from '../../../src/audio/immersive/speaker-feeds.js';
import { defaultImmersive } from '../../../src/app/state.js';
import { renderOffline, makeBuffer, peakOf, rmsOf, mean, db, ua } from './util.js';

const SR = 48000;

function toUpmix(im) {
  return {
    centerExtract: im.centerExtract,
    surrLevelDb: im.surrLevelDb,
    surrDelayMs: im.surrDelayMs,
    heightLevelDb: im.heightLevelDb,
    heightDecorr: im.heightDecorr,
    lfeFreqHz: im.lfeFreqHz,
    lfeLevelDb: im.lfeLevelDb,
    frontRear: im.frontRear,
  };
}

function programme(kind) {
  if (kind === 'left') {
    return (i, c) => (c === 0 ? 0.4 * Math.sin((2 * Math.PI * 700 * i) / SR) : 0);
  }
  if (kind === 'right') {
    return (i, c) => (c === 1 ? 0.4 * Math.sin((2 * Math.PI * 700 * i) / SR) : 0);
  }
  if (kind === 'bass') {
    return (i) => 0.5 * Math.sin((2 * Math.PI * 50 * i) / SR);
  }
  if (kind === 'correlated') {
    return (i) => 0.35 * Math.sin((2 * Math.PI * 1000 * i) / SR);
  }
  if (kind === 'side') {
    return (i, c) => (c === 0 ? 1 : -1) * 0.35 * Math.sin((2 * Math.PI * 800 * i) / SR);
  }
  // bright uncorrelated-ish
  return (i, c) => {
    const t = i / SR;
    return (
      0.2 * Math.sin(2 * Math.PI * (440 + c * 7) * t) +
      0.12 * Math.sin(2 * Math.PI * (2500 + c * 40) * t)
    );
  };
}

async function renderLayout(layoutId, fill, seconds = 0.5) {
  const { order } = wavChannelOrder(layoutId);
  const nCh = order.length;
  const length = Math.round(seconds * SR);
  const params = toUpmix(defaultImmersive());
  const rendered = await renderOffline(nCh, length, SR, (ctx) => {
    const src = ctx.createBufferSource();
    src.buffer = makeBuffer(ctx, 2, length, fill);
    const { feeds } = buildSpeakerFeeds(ctx, src, layoutId, params);
    const merger = ctx.createChannelMerger(nCh);
    order.forEach((key, index) => {
      if (!feeds[key]) throw new Error(`missing feed ${key} in ${layoutId}`);
      feeds[key].connect(merger, 0, index);
    });
    merger.connect(ctx.destination);
    src.start(0);
  });
  const skip = Math.round(0.08 * SR);
  const channels = order.map((key, index) => {
    const ch = rendered.getChannelData(index);
    const slice = ch.subarray(skip);
    const sp = SPEAKERS[key];
    return {
      index,
      id: key,
      lfe: !!sp.lfe,
      elevation: sp.elevation,
      azimuthAdm: sp.azimuthAdm,
      peak: peakOf(slice),
      peakDb: db(peakOf(slice)),
      rms: rmsOf(slice),
      rmsDb: db(rmsOf(slice) * Math.SQRT2),
      dc: mean(slice),
      silent: peakOf(slice) < 1e-5,
      finite: slice.every((v) => Number.isFinite(v)),
    };
  });
  return {
    layoutId,
    name: LAYOUTS[layoutId].name,
    order,
    channelCount: nCh,
    channels,
  };
}

function spatialEnergy(report) {
  const groups = {
    front: [],
    rear: [],
    left: [],
    right: [],
    height: [],
    sub: [],
  };
  for (const ch of report.channels) {
    if (ch.lfe) groups.sub.push(ch);
    if (ch.elevation >= 20) groups.height.push(ch);
    if (ch.azimuthAdm > 15) groups.left.push(ch);
    if (ch.azimuthAdm < -15) groups.right.push(ch);
    if (Math.abs(ch.azimuthAdm) <= 60 && ch.elevation < 20 && !ch.lfe) groups.front.push(ch);
    if (Math.abs(ch.azimuthAdm) >= 110 && !ch.lfe) groups.rear.push(ch);
  }
  const energy = (list) =>
    list.length ? list.reduce((s, c) => s + c.rms * c.rms, 0) / list.length : 0;
  return {
    front: energy(groups.front),
    rear: energy(groups.rear),
    left: energy(groups.left),
    right: energy(groups.right),
    height: energy(groups.height),
    sub: energy(groups.sub),
    counts: {
      front: groups.front.length,
      rear: groups.rear.length,
      left: groups.left.length,
      right: groups.right.length,
      height: groups.height.length,
      sub: groups.sub.length,
    },
  };
}

export async function runImmersiveSuite() {
  const browser = ua();
  const layouts = {};
  for (const id of LAYOUT_IDS) {
    const stereo = await renderLayout(id, programme('bright'));
    const left = await renderLayout(id, programme('left'), 0.35);
    const right = await renderLayout(id, programme('right'), 0.35);
    const bass = await renderLayout(id, programme('bass'), 0.4);
    const side = await renderLayout(id, programme('side'), 0.35);
    layouts[id] = {
      stereo: { ...stereo, spatial: spatialEnergy(stereo) },
      left,
      right,
      bass,
      side,
    };
  }
  return { browser, sampleRate: SR, layouts };
}

export { spatialEnergy, renderLayout };
