/**
 * Source-aware per-band spatial up-mixer — Web Audio realisation of a scene
 * (`planSpatialScene` in `spatial-engine.js`).
 *
 * ── What the graph does ───────────────────────────────────────────────────────────────
 *   1. Mid/side matrix from the stereo source.
 *   2. A Linkwitz-Riley crossover tree splits M and S into the six engine bands
 *      (sub/low/low-mid/mid/presence/air at 100/300/900/3k/8k).
 *   3. Per band, mid drives the front pair (image retention) and the centre (per-band
 *      affinity × the user's centreExtract, with the same centre-compensating dip the
 *      basic engine uses); side drives the front pair at its per-band width, and a
 *      decorrelation chain (pre-delay → shared all-pass → per-ear all-pass +
 *      micro-delays, then per-ring extra delays) produces the L/R pair that feeds the
 *      surround, rear, height and (Sonic Lab) ground rings at per-band gains.
 *   4. Ring buses (front L/R, centre, side L/R, rear L/R, height L/R, ground L/R,
 *      LFE) carry the sums; each speaker feed taps its ring.
 *
 * ── Determinism ───────────────────────────────────────────────────────────────────────
 * Same contract as `buildSpeakerFeeds`: fixed delays, fixed all-pass frequencies, no
 * randomness. The only difference is that the side material is split per band and each
 * destination ring gets its own micro-delays, so the delivered feeds are reproducible
 * render-to-render.
 *
 * ── Speaker fan-out law ───────────────────────────────────────────────────────────────
 * Each speaker taps one bus. Ear-ring speakers are grouped by azimuth magnitude:
 *   ≤ 70°  → front pair (L/R at full level, wides and Sonic Lab SL3/4 at reduced level)
 *   70–130°→ side ring (side surrounds, 5.1 surrounds, Sonic Lab SL5/6)
 *   > 130° → rear ring (rear surrounds, Sonic Lab SL7/8)
 * Centre taps the centre bus, subwoofers tap the LFE bus, elevated speakers tap the
 * height bus (Sonic Lab high ring ×0.9, roof ring ×1.05…0.95) and Sonic Lab ground
 * speakers tap the ground bus.
 *
 * ── Safety by construction ────────────────────────────────────────────────────────────
 *   · Only the sub band may feed LFE, always mid through an LR4 at the crossover.
 *   · The scene rows keep sub/low side energy off every ring (bass anchor).
 *   · Centre and the front-pair dip derive from the same mid taps.
 *   · Front, centre and LFE buses are never part of a motion path.
 */

import { dbToGain } from '../dsp/math.js';
import { LAYOUTS, SPEAKERS } from './layouts.js';
import { ENGINE_BANDS, ENGINE_XOVERS, RINGS, auditionGroupOf } from './spatial-engine.js';

/** Decorrelation design per band (only bands with ring content need entries):
 * pre-delay ms, shared all-pass frequency, per-ear all-pass ×1.4/×0.65 and micro-delay
 * ms base. */
export const BAND_DECORR = Object.freeze({
  lowmid: { preDelayMs: 7, apHz: 950, earMs: 1.4 },
  mid: { preDelayMs: 6.2, apHz: 1500, earMs: 1.7 },
  pres: { preDelayMs: 5.4, apHz: 2400, earMs: 2.1 },
  air: { preDelayMs: 4.6, apHz: 3600, earMs: 2.6 },
});

/** Ring extra delays (ms, per side) after the shared decorrelator, so each ring's
 * material lands at its own distance and no two destinations share an identical copy
 * of the side signal. */
export const RING_EXTRA_MS = Object.freeze({
  side: [0, 0],
  rear: [4.6, 5.3],
  height: [9.4, 10.6],
  ground: [2.8, 3.4],
});

/** Which band ids may feed which rings (the scene rows and this table must agree). */
export const RING_BANDS = Object.freeze({
  side: ['lowmid', 'mid', 'pres', 'air'],
  rear: ['mid', 'pres', 'air'],
  height: ['mid', 'pres', 'air'],
  ground: ['lowmid', 'mid', 'pres'],
});

/** Per-speaker extra feed gain, after the bus level (mirrors the basic engine's
 * per-speaker constants: wides 0.75, Sonic Lab SL3/4 0.72, high ring 0.9/0.8, roof
 * 1.05/0.95, subs 0.85/0.7). Anything absent defaults to 1. */
export const SPEAKER_FEED_GAIN = Object.freeze({
  Lw: 0.75,
  Rw: 0.75,
  SL3: 0.72,
  SL4: 0.72,
  SL13: 0.9,
  SL14: 0.9,
  SL15: 0.8,
  SL16: 0.8,
  SL17: 1.05,
  SL18: 1.05,
  SL19: 0.95,
  SL20: 0.95,
  SL21: 0.85,
  SL22: 0.85,
  SL24: 0.7,
});

const lr4 = (ctx, type, freq) => {
  const a = ctx.createBiquadFilter();
  a.type = type;
  a.frequency.value = freq;
  a.Q.value = Math.SQRT1_2;
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = freq;
  b.Q.value = Math.SQRT1_2;
  a.connect(b);
  return { in: a, out: b };
};

/** Which bus a speaker taps, and whether it is ground-fed (goes through the ground
 * low-pass before the bus). */
function speakerBusOf(sp) {
  if (sp.lfe) return { bus: 'lfe', lp: false };
  if (sp.ring === 'ground') return { bus: sp.azimuthAdm > 0 ? 'groundL' : 'groundR', lp: true };
  if (sp.ring !== 'ear') return { bus: sp.azimuthAdm > 0 ? 'heightL' : 'heightR', lp: false };
  const az = Math.abs(sp.azimuthAdm);
  const side = sp.azimuthAdm > 0 ? 'L' : 'R';
  if (sp.id === 'C' || az <= 8) return { bus: 'centre', lp: false };
  if (az <= 70) return { bus: `front${side}`, lp: false };
  if (az <= 130) return { bus: `side${side}`, lp: false };
  return { bus: `rear${side}`, lp: false };
}

/**
 * Build per-speaker feeds for the advanced engine.
 *
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} source two-channel
 * @param {string} layoutId
 * @param {object} im immersive state (`mode`, `spatialPreset`, knobs, `frontRear`…)
 * @param {object} scene from `planSpatialScene`
 * @returns {{feeds: Record<string, GainNode>, buses: Record<string, GainNode>,
 *            nodes: AudioNode[]}}
 */
export function buildSpatialFeeds(ctx, source, layoutId, im, scene) {
  const layout = LAYOUTS[layoutId];
  if (!layout) throw new Error(`buildSpatialFeeds: unknown layout "${layoutId}"`);

  /** @type {AudioNode[]} */
  const created = [];
  const track = (n) => {
    created.push(n);
    return n;
  };
  const gain = (value = 1) => {
    const g = ctx.createGain();
    g.gain.value = value;
    return track(g);
  };

  // ── 1. Mid / side matrix ──
  const split = track(ctx.createChannelSplitter(2));
  source.connect(split);
  const L = gain();
  const R = gain();
  split.connect(L, 0);
  split.connect(R, 1);
  const mid = gain();
  const side = gain();
  const lM = gain(0.5);
  const rM = gain(0.5);
  L.connect(lM);
  R.connect(rM);
  lM.connect(mid);
  rM.connect(mid);
  const lS = gain(0.5);
  const rS = gain(-0.5);
  L.connect(lS);
  R.connect(rS);
  lS.connect(side);
  rS.connect(side);

  // ── 2. Crossover trees on M and S ──
  /** Split `input` at ENGINE_XOVERS into six mono band output nodes (LR4 edges). */
  const splitTree = (input) => {
    const outs = [];
    let cursor = input;
    for (const freq of ENGINE_XOVERS) {
      const lp = lr4(ctx, 'lowpass', freq);
      const hp = lr4(ctx, 'highpass', freq);
      track(lp.in);
      track(lp.out);
      track(hp.in);
      track(hp.out);
      cursor.connect(lp.in);
      cursor.connect(hp.in);
      outs.push(lp.out);
      cursor = hp.out;
    }
    outs.push(cursor); // air band
    return outs;
  };
  const mBands = splitTree(mid);
  const sBands = splitTree(side);

  // ── 3. User balance → bus levels (mirrors the basic engine's gain law) ──
  const frontG = 1 - Math.max(0, (im.frontRear ?? 0.5) - 0.5) * 0.6;
  const rearG = 1 - Math.max(0, 0.5 - (im.frontRear ?? 0.5)) * 0.6;
  const lfeG = dbToGain(im.lfeLevelDb ?? -3);

  /** @type {Record<string, GainNode>} */
  const buses = {};
  for (const key of [
    'frontL',
    'frontR',
    'centre',
    'sideL',
    'sideR',
    'rearL',
    'rearR',
    'heightL',
    'heightR',
    'groundL',
    'groundR',
    'lfe',
  ]) {
    buses[key] = gain(key === 'lfe' ? lfeG : 1);
  }
  buses.frontL.gain.value = frontG;
  buses.frontR.gain.value = frontG;
  const sideBusGain = dbToGain(im.surrLevelDb ?? -3) * rearG;
  buses.sideL.gain.value = sideBusGain * scene.levels.side;
  buses.sideR.gain.value = sideBusGain * scene.levels.side;
  buses.rearL.gain.value = sideBusGain * scene.levels.rear;
  buses.rearR.gain.value = sideBusGain * scene.levels.rear;
  const heightBusGain = dbToGain(im.heightLevelDb ?? -6) * rearG;
  buses.heightL.gain.value = heightBusGain * scene.levels.height;
  buses.heightR.gain.value = heightBusGain * scene.levels.height;
  const groundBusGain = sideBusGain * scene.levels.ground;
  if (layoutId === 'soniclab') {
    buses.groundL.gain.value = groundBusGain;
    buses.groundR.gain.value = groundBusGain;
  }
  // Ground feeds pass a low-pass so the floor wash stays dark (basic engine does the
  // same at 3 kHz).
  const groundLp = { L: null, R: null };
  if (layoutId === 'soniclab') {
    for (const side of ['L', 'R']) {
      const lp = track(ctx.createBiquadFilter());
      lp.type = 'lowpass';
      lp.frequency.value = 3000;
      lp.Q.value = 0.7;
      lp.connect(buses[`ground${side}`]);
      groundLp[side] = lp;
    }
  }

  // ── 4. Per-band routing ──
  const hasLfe = layout.channels.some((k) => SPEAKERS[k]?.lfe);
  const centreExtract = im.centerExtract ?? 0.5;

  // LFE path: full-band mid through an LR4 at the crossover (identical shape to the
  // basic engine's bass management), gated by the sub row's lfeM.
  if (hasLfe && scene.rows.sub.lfeM > 0) {
    const lp = lr4(ctx, 'lowpass', im.lfeFreqHz ?? 120);
    track(lp.in);
    track(lp.out);
    mid.connect(lp.in);
    const g = gain(scene.rows.sub.lfeM);
    lp.out.connect(g);
    g.connect(buses.lfe);
  }

  const ringDest = (id, r, isSoniclab) =>
    RINGS.filter((ring) => {
      if (!RING_BANDS[ring].includes(id)) return false;
      if (ring === 'ground' && !isSoniclab) return false;
      return (ring === 'ground' ? r.sideS : r[`${ring}S`] ?? 0) > 0;
    });

  for (let bi = 0; bi < ENGINE_BANDS.length; bi++) {
    const id = ENGINE_BANDS[bi];
    const r = scene.rows[id];
    const mOut = mBands[bi];
    const sOut = sBands[bi];

    // Mid → front pair (with the centre-compensating dip when a centre exists).
    let dip = 0;
    if (layout.channels.includes('C') && centreExtract > 0 && r.centreM > 0) {
      const c = r.centreM * centreExtract;
      dip = 0.3 * c;
      const gC = gain(c);
      mOut.connect(gC);
      gC.connect(buses.centre);
    }
    const gFLm = gain(Math.max(0, r.frontM - dip));
    const gFRm = gain(Math.max(0, r.frontM - dip));
    mOut.connect(gFLm);
    mOut.connect(gFRm);
    gFLm.connect(buses.frontL);
    gFRm.connect(buses.frontR);

    // Side → front pair (per-band width retention; sign-flipped right side keeps the
    // image facing forward).
    if (r.frontS > 0) {
      const gFLs = gain(r.frontS);
      const gFRs = gain(-r.frontS);
      sOut.connect(gFLs);
      sOut.connect(gFRs);
      gFLs.connect(buses.frontL);
      gFRs.connect(buses.frontR);
    }

    // Decorrelated rings for this band.
    const destinations = ringDest(id, r, layoutId === 'soniclab');
    if (destinations.length) {
      const cfg = BAND_DECORR[id] ?? { preDelayMs: 8, apHz: 900, earMs: 1.2 };
      const depth = Math.max(0, Math.min(1, scene.decorr[id] ?? 0.5));
      // Shared pre-delay + all-pass.
      const d0 = track(ctx.createDelay(0.25));
      d0.delayTime.value = Math.min(0.24, (cfg.preDelayMs * (0.4 + 0.6 * depth)) / 1000);
      const ap0 = track(ctx.createBiquadFilter());
      ap0.type = 'allpass';
      ap0.frequency.value = cfg.apHz;
      ap0.Q.value = 0.55;
      sOut.connect(d0);
      d0.connect(ap0);
      // Per-ear all-passes + micro-delays: the two ears of every ring differ in phase
      // and arrival, which is what makes the ring *wider than the front*.
      const ear = ['L', 'R'].map((s, i) => {
        const ap = track(ctx.createBiquadFilter());
        ap.type = 'allpass';
        ap.frequency.value = i === 0 ? cfg.apHz * 1.4 : cfg.apHz * 0.65;
        ap.Q.value = i === 0 ? 0.45 : 0.6;
        const dl = track(ctx.createDelay(0.25));
        dl.delayTime.value =
          Math.min(0.24, (cfg.earMs * (i === 0 ? 1 : 1.7) * depth) / 1000);
        ap0.connect(ap);
        ap.connect(dl);
        return dl;
      });
      for (const ring of destinations) {
        const gRow = ring === 'ground' ? r.sideS : r[`${ring}S`] ?? 0;
        const [extraL, extraR] = RING_EXTRA_MS[ring];
        for (const [i, s] of ['L', 'R'].entries()) {
          let out = ear[i];
          const extra = i === 0 ? extraL : extraR;
          if (extra > 0) {
            const dRing = track(ctx.createDelay(0.25));
            dRing.delayTime.value = extra / 1000;
            out.connect(dRing);
            out = dRing;
          }
          const gRing = gain(gRow);
          out.connect(gRing);
          if (ring === 'ground' && groundLp[s]) gRing.connect(groundLp[s]);
          else gRing.connect(buses[`${ring}${s}`]);
        }
      }
    }
  }

  // ── 5. Speaker fan-out ──
  /** @type {Record<string, GainNode>} */
  const feeds = {};
  for (const key of layout.channels) {
    const sp = SPEAKERS[key];
    if (!sp) throw new Error(`buildSpatialFeeds: no speaker definition for ${key}`);
    const { bus } = speakerBusOf(sp);
    const feed = gain(SPEAKER_FEED_GAIN[key] ?? 1);
    buses[bus].connect(feed);
    feeds[key] = feed;
  }

  // Extra gain for the LFE key beyond SPEAKER_FEED_GAIN (standard layouts use full lfeG).
  for (const k of Object.keys(feeds)) {
    if (!Number.isFinite(feeds[k].gain.value)) {
      throw new Error(`buildSpatialFeeds: bad gain for ${k}`);
    }
  }

  return { feeds, buses, nodes: created };
}

/** Monitoring-group gain summary over the buses (front/side/rear/height/sub), used by
 * the live audition solo/mute chips and the render report. */
export function groupBusKeys() {
  return {
    front: ['frontL', 'frontR', 'centre'],
    side: ['sideL', 'sideR', 'groundL', 'groundR'],
    rear: ['rearL', 'rearR'],
    height: ['heightL', 'heightR'],
    sub: ['lfe'],
  };
}

/** Re-exported so UI/tests can label speakers consistently. */
export { auditionGroupOf };
