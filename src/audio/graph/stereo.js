/**
 * Mid/side stereo section: width, M/S balance, bass mono, per-band width, side all-pass
 * blend, Haas and crossfeed — plus the monitoring auditions (mono, mid-only, side-only).
 *
 * ── The matrix ───────────────────────────────────────────────────────────────────────
 *   M = (L + R) / 2      S = (L − R) / 2
 *   L' = M + S'          R' = M − S'
 *
 * Built from `ChannelSplitterNode` + `GainNode`s rather than an `AudioWorklet`, so it runs
 * in any browser and inside sandboxed iframes. The −0.5 gain on the right leg of the side
 * sum is the whole trick.
 *
 * ── Bass mono ────────────────────────────────────────────────────────────────────────
 * A high-pass on the *side* channel only: below the corner, side content is removed, so
 * L and R converge on M. The audited implementation used a single biquad at Q = 0.5,
 * a 12 dB/octave slope — at "mono below 100 Hz" the side channel is still only −6 dB at
 * 50 Hz. That is not mono. This uses a 4th-order Linkwitz-Riley high-pass (two cascaded
 * Butterworth sections), giving 24 dB/octave: −24 dB at half the corner frequency. The UI
 * label now says "mono below" and means it.
 *
 * ── Haas ─────────────────────────────────────────────────────────────────────────────
 * The delay is applied to one whole output channel, which means it delays *mid* content
 * as well as side. That is what a Haas widener does and it is genuinely a mono-
 * compatibility hazard: `analysis/correlation.js` raises a warning above 8 ms. It is not
 * a bug, it is a destructive tool that is now labelled as one.
 *
 * ── Side all-pass blend ("phase rotation") ───────────────────────────────────────────
 * Blending an all-passed copy of the side signal against the dry side signal is a comb
 * filter, not a phase rotation. Renamed in the UI to "Side comb / all-pass blend" and
 * documented as an intentionally destructive creative control.
 */

import { WIDTH_CROSSOVER_LOW, WIDTH_CROSSOVER_HIGH } from '../../app/constants.js';
import { clamp } from '../dsp/math.js';
import { BUTTERWORTH_Q_DB } from '../dsp/biquad.js';
import {
  sideWidthGain,
  midBalanceGain,
  capSideBandGain,
  crossfeedTapGain,
} from './spatial-laws.js';

/** @typedef {'stereo'|'mono'|'mid'|'side'|'left'|'right'} AuditionMode */

function lr4(ctx, type, freq) {
  // Node Q is resonance in dB for lowpass/highpass: Butterworth needs −3.0103, not
  // 0.7071 (which peaks +0.71 dB per section — issue #19 put +7.4 dB on this path).
  const a = ctx.createBiquadFilter();
  a.type = type;
  a.frequency.value = freq;
  a.Q.value = BUTTERWORTH_Q_DB;
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = freq;
  b.Q.value = BUTTERWORTH_Q_DB;
  a.connect(b);
  return { in: a, out: b };
}

/**
 * Build the stereo section.
 *
 * @param {BaseAudioContext} ctx
 * @returns {object} node bag
 */
export function buildStereo(ctx) {
  const input = ctx.createGain();
  const output = ctx.createGain();

  const splitter = ctx.createChannelSplitter(2);
  input.connect(splitter);

  // ── M/S encode ──
  const midL = ctx.createGain();
  midL.gain.value = 0.5;
  const midR = ctx.createGain();
  midR.gain.value = 0.5;
  const midSum = ctx.createGain();
  splitter.connect(midL, 0);
  splitter.connect(midR, 1);
  midL.connect(midSum);
  midR.connect(midSum);

  const sideL = ctx.createGain();
  sideL.gain.value = 0.5;
  const sideR = ctx.createGain();
  sideR.gain.value = -0.5;
  const sideSum = ctx.createGain();
  splitter.connect(sideL, 0);
  splitter.connect(sideR, 1);
  sideL.connect(sideSum);
  sideR.connect(sideSum);

  const midGain = ctx.createGain();
  midSum.connect(midGain);

  // ── Bass mono: LR4 high-pass on the side channel ──
  const bassHp = lr4(ctx, 'highpass', 8);
  sideSum.connect(bassHp.in);

  // ── Per-band width, on the side channel only, before the master width control ──
  const wLowLp = lr4(ctx, 'lowpass', WIDTH_CROSSOVER_LOW);
  const wMidHp = lr4(ctx, 'highpass', WIDTH_CROSSOVER_LOW);
  const wMidLp = lr4(ctx, 'lowpass', WIDTH_CROSSOVER_HIGH);
  const wHighHp = lr4(ctx, 'highpass', WIDTH_CROSSOVER_HIGH);
  const widthLow = ctx.createGain();
  const widthMid = ctx.createGain();
  const widthHigh = ctx.createGain();
  const widthSum = ctx.createGain();

  bassHp.out.connect(wLowLp.in);
  wLowLp.out.connect(widthLow);
  widthLow.connect(widthSum);
  bassHp.out.connect(wMidHp.in);
  wMidHp.out.connect(wMidLp.in);
  wMidLp.out.connect(widthMid);
  widthMid.connect(widthSum);
  bassHp.out.connect(wHighHp.in);
  wHighHp.out.connect(widthHigh);
  widthHigh.connect(widthSum);

  const sideWidth = ctx.createGain();
  widthSum.connect(sideWidth);

  // ── Side all-pass blend ──
  const sideDirect = ctx.createGain();
  sideDirect.gain.value = 1;
  const sideAllpass = ctx.createBiquadFilter();
  sideAllpass.type = 'allpass';
  sideAllpass.frequency.value = 800;
  sideAllpass.Q.value = 0.7; // linear — allpass Q is linear in the node
  const sideAllpassGain = ctx.createGain();
  sideAllpassGain.gain.value = 0;
  const sideMix = ctx.createGain();
  sideWidth.connect(sideDirect);
  sideDirect.connect(sideMix);
  sideWidth.connect(sideAllpass);
  sideAllpass.connect(sideAllpassGain);
  sideAllpassGain.connect(sideMix);

  // ── M/S decode ──
  const mToL = ctx.createGain();
  mToL.gain.value = 1;
  const sToL = ctx.createGain();
  sToL.gain.value = 1;
  const mToR = ctx.createGain();
  mToR.gain.value = 1;
  const sToR = ctx.createGain();
  sToR.gain.value = -1;
  const leftSum = ctx.createGain();
  const rightSum = ctx.createGain();
  midGain.connect(mToL);
  mToL.connect(leftSum);
  sideMix.connect(sToL);
  sToL.connect(leftSum);
  midGain.connect(mToR);
  mToR.connect(rightSum);
  sideMix.connect(sToR);
  sToR.connect(rightSum);

  // ── Haas ──
  const haasL = ctx.createDelay(0.1);
  const haasR = ctx.createDelay(0.1);
  leftSum.connect(haasL);
  rightSum.connect(haasR);

  // ── Crossfeed: delayed, low-passed bleed from each side to the other ──
  const leftFinal = ctx.createGain();
  const rightFinal = ctx.createGain();
  haasL.connect(leftFinal);
  haasR.connect(rightFinal);

  const cf = (from, to) => {
    // Frequency-conscious tap: a pair of LR4 high-passes at 120 Hz keeps bass out of
    // the crossfeed entirely — a bass signal delayed by 0.3 ms and mixed back into the
    // opposite channel is the fastest way to smear the low end and waste headroom.
    const hp1 = ctx.createBiquadFilter();
    hp1.type = 'highpass';
    hp1.frequency.value = 120;
    hp1.Q.value = Math.SQRT1_2;
    const hp2 = ctx.createBiquadFilter();
    hp2.type = 'highpass';
    hp2.frequency.value = 120;
    hp2.Q.value = Math.SQRT1_2;
    const d = ctx.createDelay(0.02);
    d.delayTime.value = 0.0003; // ~0.3 ms interaural delay
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    lp.Q.value = BUTTERWORTH_Q_DB;
    const g = ctx.createGain();
    g.gain.value = 0;
    from.connect(hp1);
    hp1.connect(hp2);
    hp2.connect(d);
    d.connect(lp);
    lp.connect(g);
    g.connect(to);
    return g;
  };
  const crossfeedLR = cf(haasL, rightFinal);
  const crossfeedRL = cf(haasR, leftFinal);

  const merger = ctx.createChannelMerger(2);
  leftFinal.connect(merger, 0, 0);
  rightFinal.connect(merger, 0, 1);

  // ── Audition matrix ────────────────────────────────────────────────────────────────
  // Taps the *final* stereo pair and re-encodes, so mono/mid/side auditions reflect
  // everything the chain did, including Haas and crossfeed. Only one path is unmuted.
  const auditionSplit = ctx.createChannelSplitter(2);
  merger.connect(auditionSplit);

  const stereoPath = ctx.createGain();
  merger.connect(stereoPath);
  stereoPath.connect(output);

  const aMidL = ctx.createGain();
  aMidL.gain.value = 0.5;
  const aMidR = ctx.createGain();
  aMidR.gain.value = 0.5;
  const monoPath = ctx.createGain();
  monoPath.gain.value = 0;
  auditionSplit.connect(aMidL, 0);
  auditionSplit.connect(aMidR, 1);
  aMidL.connect(monoPath);
  aMidR.connect(monoPath);
  monoPath.connect(output);

  const aSideL = ctx.createGain();
  aSideL.gain.value = 0.5;
  const aSideR = ctx.createGain();
  aSideR.gain.value = -0.5;
  const sidePath = ctx.createGain();
  sidePath.gain.value = 0;
  auditionSplit.connect(aSideL, 0);
  auditionSplit.connect(aSideR, 1);
  aSideL.connect(sidePath);
  aSideR.connect(sidePath);
  sidePath.connect(output);

  const leftPath = ctx.createGain();
  leftPath.gain.value = 0;
  const rightPath = ctx.createGain();
  rightPath.gain.value = 0;
  auditionSplit.connect(leftPath, 0);
  auditionSplit.connect(rightPath, 1);
  leftPath.connect(output);
  rightPath.connect(output);

  return {
    input,
    output,
    midGain,
    sideWidth,
    bassHp,
    sideDirect,
    sideAllpassGain,
    widthLow,
    widthMid,
    widthHigh,
    haasL,
    haasR,
    crossfeedLR,
    crossfeedRL,
    audition: { stereoPath, monoPath, sidePath, leftPath, rightPath },
  };
}

/**
 * Push stereo parameters onto a built section.
 *
 * @param {ReturnType<typeof buildStereo>} n
 * @param {object} p
 * @param {boolean} [p.bypass]
 */
export function applyStereo(n, p) {
  const bypass = !!p.bypass;

  // ── Level-safe width law (§2.9) ────────────────────────────────────────────────
  // The master side gain now goes through a bounded, soft-knee law that also folds in
  // the binaural spread factor and scales back when a Haas delay is engaged — so
  // width cannot grow without limit, and width + spread + Haas cannot stack into a
  // pathological image. The centre gain follows a dB-space curve that protects the
  // centre image (the old linear 1 − 0.6·b cut 1 dB of centre at b = 0.18).
  const balance = bypass ? 0 : p.ms; // −1 (mid-heavy) … +1 (side-heavy)
  n.midGain.gain.value = balance < 0 ? 1 : midBalanceGain(balance);
  const side = bypass ? 1 : sideWidthGain(p);
  n.sideWidth.gain.value = side;

  // Bass mono corner. 8 Hz is "effectively off" without needing to rewire the graph.
  const corner = bypass ? 0 : p.bassMono;
  const f = corner > 0 ? corner : 8;
  n.bassHp.in.frequency.value = f;
  n.bassHp.out.frequency.value = f;

  const combBlend = bypass ? 0 : clamp(p.phaseRot, 0, 1);
  n.sideDirect.gain.value = 1 - combBlend;
  n.sideAllpassGain.gain.value = combBlend;

  // Per-band widths: each band's *delivered* gain is individually capped (the low band
  // is the bass anchor — wide low end is a mono hazard and eats limiter headroom), so
  // the master side gain cannot push a band past its ceiling either. The band node
  // carries (capped product / master side gain) so that master × band equals the
  // capped delivered gain at every setting, including narrowing (side < 1).
  const bandNodeGain = (userGain, kind) =>
    bypass ? 1 : capSideBandGain(side * userGain, kind) / (side || 1);
  n.widthLow.gain.value = bandNodeGain(p.widthLow, 'low');
  n.widthMid.gain.value = bandNodeGain(p.widthMid, 'mid');
  n.widthHigh.gain.value = bandNodeGain(p.widthHigh, 'high');

  const haasSeconds = bypass ? 0 : p.haas / 1000;
  n.haasR.delayTime.value = p.haasSide >= 0 ? haasSeconds : 0;
  n.haasL.delayTime.value = p.haasSide < 0 ? haasSeconds : 0;

  // Crossfeed: bounded monotone tap law, plus the LR4@120 Hz high-pass built into the
  // taps. Binaural mode forces a minimum crossfeed — that is what the mode *is*.
  const crossfeed = bypass ? 0 : p.binaural ? Math.max(p.crossfeed, 0.35) : p.crossfeed;
  const tapGain = crossfeedTapGain(crossfeed);
  n.crossfeedLR.gain.value = tapGain;
  n.crossfeedRL.gain.value = tapGain;
}

/**
 * Select the monitoring path. Exactly one is audible at a time.
 * @param {ReturnType<typeof buildStereo>} n
 * @param {AuditionMode} mode
 */
export function setAudition(n, mode) {
  const a = n.audition;
  a.stereoPath.gain.value = mode === 'stereo' ? 1 : 0;
  a.monoPath.gain.value = mode === 'mono' ? 1 : 0;
  a.sidePath.gain.value = mode === 'side' ? 1 : 0;
  a.leftPath.gain.value = mode === 'left' ? 1 : 0;
  a.rightPath.gain.value = mode === 'right' ? 1 : 0;
  // "mid" is mono, by definition — kept as a separate label because engineers ask for it
  // by that name when they mean "show me the centre channel".
  if (mode === 'mid') a.monoPath.gain.value = 1;
}
