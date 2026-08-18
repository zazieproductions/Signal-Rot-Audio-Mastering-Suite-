/**
 * Stereo → immersive up-mixing: per-speaker feed construction.
 *
 * ── Be clear about what this is ──────────────────────────────────────────────────────
 * A stereo master contains two channels. It does not contain height information, it does
 * not contain discrete surround content, and no amount of processing can recover
 * information that was never encoded. What this module does is **synthesise** a plausible
 * immersive field from the stereo signal:
 *
 *   · **Centre** is matrix-derived: `C = (L+R)/2 · centerExtract`, with a compensating dip
 *     applied to the front pair so the phantom centre is not doubled.
 *   · **Surrounds** carry the *side* signal `(L−R)/2`, decorrelated by a short delay and
 *     an all-pass, with a small amount of same-side direct signal for anchoring.
 *   · **Heights** carry high-passed, more heavily decorrelated side content. There is no
 *     height information in the source; this is ambience placed above the listener
 *     because it sounds like space, not because it reconstructs anything.
 *   · **LFE / subwoofers** are a Linkwitz-Riley low-passed sum. Note that this is a *bass
 *     management* feed, not a `+10 dB` LFE effects channel — the ADM metadata declares it
 *     as low-passed and the channel map says so in words.
 *
 * ── Decorrelation ────────────────────────────────────────────────────────────────────
 * Delay + all-pass. Cheap, phase-safe against the front pair at the delays used (5–35 ms,
 * well past the Haas fusion window for the rear feeds), and it does not require an
 * impulse-response library. It is not a true decorrelation filter bank.
 *
 * ── Determinism ──────────────────────────────────────────────────────────────────────
 * Nothing here uses randomness, so an immersive render is reproducible provided the
 * upstream stereo master is (which the seeded character engines guarantee).
 */

import { dbToGain } from '../dsp/math.js';
import { LAYOUTS } from './layouts.js';
import { SONIC_LAB_SPEAKERS } from './sonic-lab.js';

/**
 * @typedef {object} UpmixParameters
 * @property {number} centerExtract 0..1
 * @property {number} surrLevelDb
 * @property {number} surrDelayMs
 * @property {number} heightLevelDb
 * @property {number} heightDecorr 0..1
 * @property {number} lfeFreqHz
 * @property {number} lfeLevelDb
 * @property {number} frontRear 0..1 (0 = front-weighted, 1 = surround-weighted)
 */

/** Cascade of two Butterworth sections = 4th-order Linkwitz-Riley. */
function lr4(ctx, type, freq) {
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
}

/**
 * Build one mono feed node per speaker from a two-channel source.
 *
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} source two-channel
 * @param {string} layoutId
 * @param {UpmixParameters} p
 * @returns {{feeds: Record<string, GainNode>, nodes: AudioNode[]}}
 *          `nodes` is every node created, for teardown.
 */
export function buildSpeakerFeeds(ctx, source, layoutId, p) {
  const layout = LAYOUTS[layoutId];
  if (!layout) throw new Error(`buildSpeakerFeeds: unknown layout "${layoutId}"`);

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

  const split = track(ctx.createChannelSplitter(2));
  source.connect(split);
  const L = gain();
  const R = gain();
  split.connect(L, 0);
  split.connect(R, 1);

  // Mid / side matrix.
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

  /** Delay + all-pass decorrelator tapped off a source node. */
  const decorr = (input, ms, freq, q = 0.6) => {
    const d = track(ctx.createDelay(0.25));
    d.delayTime.value = Math.min(0.24, ms / 1000);
    const ap = track(ctx.createBiquadFilter());
    ap.type = 'allpass';
    ap.frequency.value = freq;
    ap.Q.value = q;
    input.connect(d);
    d.connect(ap);
    return ap;
  };

  const frontG = 1 - Math.max(0, p.frontRear - 0.5) * 0.6;
  const rearG = 1 - Math.max(0, 0.5 - p.frontRear) * 0.6;
  const surrG = dbToGain(p.surrLevelDb) * rearG;
  const heightG = dbToGain(p.heightLevelDb) * rearG;
  const lfeG = dbToGain(p.lfeLevelDb);
  const hQ = p.heightDecorr * 2.2 + 0.3;

  /** @type {Record<string, GainNode>} */
  const feeds = {};

  /** Height feed: high-passed, doubly all-passed side content. */
  const heightFeed = (delayMs, freq, level) => {
    const a = decorr(side, delayMs, freq, hQ);
    const hp = track(ctx.createBiquadFilter());
    hp.type = 'highpass';
    hp.frequency.value = 700;
    hp.Q.value = 0.7;
    const ap2 = track(ctx.createBiquadFilter());
    ap2.type = 'allpass';
    ap2.frequency.value = freq * 1.7;
    ap2.Q.value = hQ;
    const g = gain(level);
    a.connect(hp);
    hp.connect(ap2);
    ap2.connect(g);
    return g;
  };

  if (layoutId === 'soniclab') {
    const D = p.surrDelayMs;

    // Ear ring 1–8: direct front pair, progressively decorrelated toward the rear.
    feeds.SL1 = gain(frontG);
    L.connect(feeds.SL1);
    feeds.SL2 = gain(frontG);
    R.connect(feeds.SL2);

    feeds.SL3 = gain(0.72 * frontG);
    L.connect(feeds.SL3);
    const w3 = gain(0.45);
    decorr(side, 5, 1250).connect(w3);
    w3.connect(feeds.SL3);

    feeds.SL4 = gain(0.72 * frontG);
    R.connect(feeds.SL4);
    const w4 = gain(0.45);
    decorr(side, 6, 1400).connect(w4);
    w4.connect(feeds.SL4);

    feeds.SL5 = gain(surrG);
    decorr(side, D, 900).connect(feeds.SL5);
    const b5 = gain(0.2 * surrG);
    L.connect(b5);
    b5.connect(feeds.SL5);

    feeds.SL6 = gain(surrG);
    decorr(side, D + 3, 1080).connect(feeds.SL6);
    const b6 = gain(0.2 * surrG);
    R.connect(b6);
    b6.connect(feeds.SL6);

    feeds.SL7 = gain(0.85 * surrG);
    decorr(side, D + 11, 700).connect(feeds.SL7);
    feeds.SL8 = gain(0.85 * surrG);
    decorr(side, D + 14, 800).connect(feeds.SL8);

    // Ground ring 9–12: darker, quieter floor wash.
    const ground = (ms, freq) => {
      const a = decorr(side, ms, freq);
      const lp = track(ctx.createBiquadFilter());
      lp.type = 'lowpass';
      lp.frequency.value = 3000;
      lp.Q.value = 0.7;
      const g = gain(surrG * 0.5);
      a.connect(lp);
      lp.connect(g);
      return g;
    };
    feeds.SL9 = ground(9, 650);
    feeds.SL10 = ground(12, 760);
    feeds.SL11 = ground(15, 540);
    feeds.SL12 = ground(18, 600);

    // High ring 13–16 and roof ring 17–20.
    feeds.SL13 = heightFeed(8, 1500, heightG * 0.9);
    feeds.SL14 = heightFeed(10, 1700, heightG * 0.9);
    feeds.SL15 = heightFeed(13, 1350, heightG * 0.8);
    feeds.SL16 = heightFeed(16, 1500, heightG * 0.8);
    feeds.SL17 = heightFeed(20, 1900, heightG);
    feeds.SL18 = heightFeed(23, 2100, heightG);
    feeds.SL19 = heightFeed(27, 1650, heightG * 0.9);
    feeds.SL20 = heightFeed(31, 1800, heightG * 0.9);

    // Subwoofers 21–24, all through identical LR4 low-passes so they stay phase-coherent.
    const subL = lr4(ctx, 'lowpass', p.lfeFreqHz);
    track(subL.in);
    track(subL.out);
    L.connect(subL.in);
    feeds.SL21 = gain(lfeG * 0.85);
    subL.out.connect(feeds.SL21);

    const subR = lr4(ctx, 'lowpass', p.lfeFreqHz);
    track(subR.in);
    track(subR.out);
    R.connect(subR.in);
    feeds.SL22 = gain(lfeG * 0.85);
    subR.out.connect(feeds.SL22);

    const subM = lr4(ctx, 'lowpass', p.lfeFreqHz);
    track(subM.in);
    track(subM.out);
    mid.connect(subM.in);
    feeds.SL23 = gain(lfeG);
    subM.out.connect(feeds.SL23);
    feeds.SL24 = gain(lfeG * 0.7);
    subM.out.connect(feeds.SL24);

    // Sanity: every declared channel must have a feed, or the export silently loses one.
    for (const s of SONIC_LAB_SPEAKERS) {
      if (!feeds[s.id]) throw new Error(`buildSpeakerFeeds: missing Sonic Lab feed ${s.id}`);
    }
    return { feeds, nodes: created };
  }

  const keys = layout.channels;
  const has = (k) => keys.includes(k);

  if (has('C')) {
    feeds.C = gain(p.centerExtract);
    mid.connect(feeds.C);
  }

  if (has('LFE')) {
    const lp = lr4(ctx, 'lowpass', p.lfeFreqHz);
    track(lp.in);
    track(lp.out);
    mid.connect(lp.in);
    feeds.LFE = gain(lfeG);
    lp.out.connect(feeds.LFE);
  }

  // Front pair, with a centre-compensating dip so extracting a centre does not leave the
  // phantom image doubled in level.
  feeds.L = gain(frontG);
  L.connect(feeds.L);
  feeds.R = gain(frontG);
  R.connect(feeds.R);
  if (feeds.C) {
    const dip = gain(-0.3 * p.centerExtract);
    mid.connect(dip);
    dip.connect(feeds.L);
    dip.connect(feeds.R);
  }

  if (has('Lw')) {
    feeds.Lw = gain(0.75 * frontG);
    L.connect(feeds.Lw);
    decorr(side, 6, 1200).connect(feeds.Lw);
    feeds.Rw = gain(0.75 * frontG);
    R.connect(feeds.Rw);
    decorr(side, 7, 1400).connect(feeds.Rw);
  }

  const sideSurround = (anchor, ms, freq) => {
    const g = gain(surrG);
    decorr(side, ms, freq).connect(g);
    const b = gain(0.25 * surrG);
    anchor.connect(b);
    b.connect(g);
    return g;
  };

  if (has('Ls')) {
    feeds.Ls = sideSurround(L, p.surrDelayMs, 900);
    feeds.Rs = sideSurround(R, p.surrDelayMs + 3, 1100);
  }
  if (has('Lss')) {
    feeds.Lss = sideSurround(L, p.surrDelayMs, 900);
    feeds.Rss = sideSurround(R, p.surrDelayMs + 3, 1100);
  }
  if (has('Lrs')) {
    feeds.Lrs = gain(surrG * 0.85);
    decorr(side, p.surrDelayMs + 11, 700).connect(feeds.Lrs);
    feeds.Rrs = gain(surrG * 0.85);
    decorr(side, p.surrDelayMs + 14, 800).connect(feeds.Rrs);
  }
  if (has('Ltf')) {
    feeds.Ltf = heightFeed(8, 1500, heightG);
    feeds.Rtf = heightFeed(10, 1700, heightG);
  }
  if (has('Ltm')) {
    feeds.Ltm = heightFeed(12, 1600, heightG);
    feeds.Rtm = heightFeed(14, 1750, heightG);
  }
  if (has('Ltr')) {
    feeds.Ltr = heightFeed(16, 1300, heightG);
    feeds.Rtr = heightFeed(18, 1450, heightG);
  }

  for (const k of keys) {
    if (!feeds[k]) throw new Error(`buildSpeakerFeeds: missing feed for ${k} in ${layoutId}`);
  }

  return { feeds, nodes: created };
}
