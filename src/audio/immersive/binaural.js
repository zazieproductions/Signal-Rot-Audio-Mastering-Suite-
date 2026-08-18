/**
 * Binaural monitoring and binaural fold-down.
 *
 * ── What this is ─────────────────────────────────────────────────────────────────────
 * Each synthesised speaker feed is placed at its physical azimuth and elevation on a
 * `PannerNode` in `HRTF` mode and the results are summed. That gives a **fixed binaural
 * render of a virtual loudspeaker array** — the same thing you would get by putting a
 * dummy head in the room and not letting it move.
 *
 * ── What this is not ─────────────────────────────────────────────────────────────────
 *  · It is **not head-tracked**. Dolby Atmos for Headphones and Apple Spatial Audio with
 *    head tracking re-render continuously against the listener's orientation. Nothing
 *    here moves when your head moves.
 *  · It is **not personalised**. Web Audio's `HRTF` panning uses the browser's built-in
 *    generic HRTF database (Chromium ships an IRCAM-derived set). Your ears are not that
 *    set, which is the usual reason a binaural render sounds "inside the head" or has a
 *    weak front image.
 *  · Browsers differ. The same project monitored in Chromium and in Safari will not sound
 *    identical, because the HRTF data and the panner implementation differ.
 *
 * It is genuinely useful for checking that surround and height content *exists* and is on
 * the correct side. It is not a substitute for the room.
 */

import { LAYOUTS, SPEAKERS } from './layouts.js';
import { buildSpeakerFeeds } from './speaker-feeds.js';

/**
 * Position a `PannerNode` from a speaker definition.
 *
 * Web Audio: +X right, +Y up, −Z forward (the listener faces −Z). The speaker table
 * stores `azimuthHrtf` in the panner's own convention (positive = right), so no sign
 * juggling happens here — that is the whole reason the two azimuths are stored separately.
 *
 * @param {BaseAudioContext} ctx
 * @param {import('./sonic-lab.js').SpeakerDefinition} sp
 */
export function placePanner(ctx, sp) {
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = 1;
  panner.maxDistance = 10;
  const az = (sp.azimuthHrtf * Math.PI) / 180;
  const el = (sp.elevation * Math.PI) / 180;
  const x = Math.sin(az) * Math.cos(el);
  const y = Math.sin(el);
  const z = -Math.cos(az) * Math.cos(el);
  if (panner.positionX) {
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
  } else {
    // Safari < 14.1 and older Chromium only expose the deprecated setter.
    panner.setPosition(x, y, z);
  }
  return panner;
}

/**
 * Build a complete binaural fold-down of a layout from a stereo source.
 *
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} source two-channel
 * @param {string} layoutId
 * @param {import('./speaker-feeds.js').UpmixParameters} params
 * @param {object} [opts]
 * @param {number} [opts.lfeGain] level at which non-positional sub feeds are folded in
 * @returns {{output: GainNode, nodes: AudioNode[]}}
 */
export function buildBinauralFold(ctx, source, layoutId, params, opts = {}) {
  const layout = LAYOUTS[layoutId];
  if (!layout) throw new Error(`buildBinauralFold: unknown layout "${layoutId}"`);

  const { feeds, nodes } = buildSpeakerFeeds(ctx, source, layoutId, params);
  const created = nodes.slice();
  const sum = ctx.createGain();
  created.push(sum);

  for (const key of Object.keys(feeds)) {
    const sp = SPEAKERS[key];
    if (!sp) continue;
    if (sp.lfe) {
      // Sub feeds are below the frequency range where HRTF cues exist. Panning them adds
      // nothing but comb filtering, so they are summed straight to both ears.
      const g = ctx.createGain();
      g.gain.value = opts.lfeGain ?? 0.7;
      feeds[key].connect(g);
      g.connect(sum);
      created.push(g);
    } else {
      const panner = placePanner(ctx, sp);
      feeds[key].connect(panner);
      panner.connect(sum);
      created.push(panner);
    }
  }

  return { output: sum, nodes: created };
}

export { SPEAKERS, buildSpeakerFeeds };
