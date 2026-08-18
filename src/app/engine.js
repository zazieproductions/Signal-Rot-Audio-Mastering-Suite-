/**
 * Signal Rot — audio engine.
 * AudioContext lifecycle, live mastering graph, offline rendering, loudness analysis,
 * mastering/export pipeline, batch processing, and immersive rendering.
 *
 * Depends on the pure DSP/encode/layouts modules and the canonical state in state.js.
 * UI lives in ui.js; this module never touches the DOM except through notify.js.
 */
import { dbToGain, gainToDb, clamp, baseName, mulberry32, isFiniteNum } from '../lib/math.js';
import {
  MATCH_FREQS, IDENTITY_CURVE, makeSatCurve, truePeakBlock, transientShape,
  measureLUFS, spectrumFingerprint, computeMatchGains,
} from '../lib/dsp.js';
import { truePeakLimit, verifyTruePeak } from '../lib/limiter.js';
import {
  writeWAV, writeAIFF, encodeMP3, writeWAVMultiExt, writeADMBWF,
} from '../lib/encode.js';
import { SP, LAYOUTS, getWavOrder, buildChannelMap } from '../lib/layouts.js';
import { ENGINE_NAME, ENGINE_VERSION } from '../lib/version.js';
import { toast, download, downloadJSON } from '../lib/notify.js';
import {
  state, setParam, setPreset, ensureTextureSeed, rollTextureSeed,
} from './state.js';

export const ANALYSIS_WINDOW_SECONDS = 90; // live integrated-LUFS window (documented approximation)

export const engine = {
  AC: null,
  srcBuffer: null,
  fileLabel: '',
  baseSR: 44100,
  nodes: {},
  playing: false,
  startedAt: 0,
  offsetAt: 0,
  _srcNode: null,
  analysis: { orig: null, proc: null },
  refBuffer: null,
  refName: '',
  _worker: null,
  _analysisCallbacks: new Set(),
};

/* ---------------- audio context factory (Safari/webkit compat) ---------------- */

export function createAudioContext() {
  try {
    return new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) {
    console.error('AudioContext failed:', e);
    throw e;
  }
}

export function createOfflineAudioContext(ch, len, sr) {
  try {
    return new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(ch, len, sr);
  } catch (e) {
    console.error('OfflineAudioContext failed:', e);
    throw e;
  }
}

/* ---------------- deterministic texture (noise) generation ---------------- */

function buildNoiseBed(ctx, seed) {
  const rng = mulberry32(seed >>> 0);
  const noiseLen = Math.max(1, Math.floor(ctx.sampleRate * 2));
  const mkSrc = (fill) => {
    const nb = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    fill(nb.getChannelData(0));
    const s = ctx.createBufferSource();
    s.buffer = nb;
    s.loop = true;
    try {
      s.start();
    } catch (e) {
      /* ignore */
    }
    return s;
  };
  // Tape hiss — high-passed white noise.
  const hissSrc = mkSrc((d) => {
    for (let i = 0; i < d.length; i++) d[i] = (rng() * 2 - 1) * 0.6;
  });
  const hissHS = ctx.createBiquadFilter();
  hissHS.type = 'highpass';
  hissHS.frequency.value = 2500;
  hissHS.Q.value = 0.5;
  const hissGain = ctx.createGain();
  hissGain.gain.value = 0;
  hissSrc.connect(hissHS);
  hissHS.connect(hissGain);
  // Vinyl crackle — sparse impulses.
  const crackleSrc = mkSrc((d) => {
    d.fill(0);
    for (let i = 0; i < d.length; i++) {
      if (rng() < 0.0004) d[i] = (rng() * 2 - 1) * (0.3 + rng() * 0.7);
    }
  });
  const crackleBP = ctx.createBiquadFilter();
  crackleBP.type = 'bandpass';
  crackleBP.frequency.value = 3200;
  crackleBP.Q.value = 0.6;
  const crackleGain = ctx.createGain();
  crackleGain.gain.value = 0;
  crackleSrc.connect(crackleBP);
  crackleBP.connect(crackleGain);
  // Vinyl rumble — low-passed one-pole brown noise.
  const rumbleSrc = mkSrc((d) => {
    let y = 0;
    for (let i = 0; i < d.length; i++) {
      y = y * 0.995 + (rng() * 2 - 1) * 0.05;
      d[i] = y * 3;
    }
  });
  const rumbleLP = ctx.createBiquadFilter();
  rumbleLP.type = 'lowpass';
  rumbleLP.frequency.value = 45;
  rumbleLP.Q.value = 0.5;
  const rumbleGain = ctx.createGain();
  rumbleGain.gain.value = 0;
  rumbleSrc.connect(rumbleLP);
  rumbleLP.connect(rumbleGain);
  return { hissSrc, hissHS, hissGain, crackleSrc, crackleBP, crackleGain, rumbleSrc, rumbleLP, rumbleGain };
}

/* ---------------- mastering chain construction ---------------- */

function buildChain(ctx) {
  const inGain = ctx.createGain();
  // Mastering EQ
  const sub = ctx.createBiquadFilter(); sub.type = 'lowshelf'; sub.frequency.value = 55;
  const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 120;
  const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 350; body.Q.value = 0.7;
  const harsh = ctx.createBiquadFilter(); harsh.type = 'peaking'; harsh.frequency.value = 2800; harsh.Q.value = 1.2;
  const pres = ctx.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 5000; pres.Q.value = 0.8;
  const high = ctx.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 12000;
  const tiltLo = ctx.createBiquadFilter(); tiltLo.type = 'lowshelf'; tiltLo.frequency.value = 1000;
  const tiltHi = ctx.createBiquadFilter(); tiltHi.type = 'highshelf'; tiltHi.frequency.value = 1000;
  const splitter = ctx.createChannelSplitter(2);

  // Mid bus = 0.5L + 0.5R, side bus = 0.5L − 0.5R.
  const gMidL = ctx.createGain(); gMidL.gain.value = 0.5;
  const gMidR = ctx.createGain(); gMidR.gain.value = 0.5;
  const midSum = ctx.createGain();
  const midGain = ctx.createGain();
  const gSideL = ctx.createGain(); gSideL.gain.value = 0.5;
  const gSideR = ctx.createGain(); gSideR.gain.value = -0.5;
  const sideSum = ctx.createGain();
  const bassHP = ctx.createBiquadFilter(); bassHP.type = 'highpass'; bassHP.frequency.value = 8; bassHP.Q.value = 0.5;
  const sideWidth = ctx.createGain();
  const sideDirect = ctx.createGain(); sideDirect.gain.value = 1;
  const sideAP = ctx.createBiquadFilter(); sideAP.type = 'allpass'; sideAP.frequency.value = 800; sideAP.Q.value = 0.7;
  const sideAPgain = ctx.createGain(); sideAPgain.gain.value = 0;
  const sideMix = ctx.createGain();
  const mLg = ctx.createGain(); mLg.gain.value = 1;
  const sLg = ctx.createGain(); sLg.gain.value = 1;
  const mRg = ctx.createGain(); mRg.gain.value = 1;
  const sRg = ctx.createGain(); sRg.gain.value = -1;
  const Lsum = ctx.createGain();
  const Rsum = ctx.createGain();
  const haasL = ctx.createDelay(0.1);
  const haasR = ctx.createDelay(0.1);
  const cfDLR = ctx.createDelay(0.02); cfDLR.delayTime.value = 0.0003;
  const cfLPLR = ctx.createBiquadFilter(); cfLPLR.type = 'lowpass'; cfLPLR.frequency.value = 700;
  const cfGLR = ctx.createGain(); cfGLR.gain.value = 0;
  const cfDRL = ctx.createDelay(0.02); cfDRL.delayTime.value = 0.0003;
  const cfLPRL = ctx.createBiquadFilter(); cfLPRL.type = 'lowpass'; cfLPRL.frequency.value = 700;
  const cfGRL = ctx.createGain(); cfGRL.gain.value = 0;
  const Lfinal = ctx.createGain();
  const Rfinal = ctx.createGain();
  const merger = ctx.createChannelMerger(2);

  // Saturation gain staging.
  const dcBlock = ctx.createBiquadFilter(); dcBlock.type = 'highpass'; dcBlock.frequency.value = 5; dcBlock.Q.value = 0.5;
  const preSat = ctx.createGain(); preSat.gain.value = 1;
  const shaper = ctx.createWaveShaper(); shaper.curve = IDENTITY_CURVE; shaper.oversample = '4x';
  const postLP = ctx.createBiquadFilter(); postLP.type = 'lowpass'; postLP.frequency.value = 22000; postLP.Q.value = 0.5;
  const outGain = ctx.createGain();

  // Reference-match EQ (8 peaking bands, flat by default).
  const matchBands = MATCH_FREQS.map((f) => {
    const b = ctx.createBiquadFilter();
    b.type = 'peaking';
    b.frequency.value = f;
    b.Q.value = 1.0;
    b.gain.value = 0;
    return b;
  });
  for (let i = 0; i < matchBands.length - 1; i++) matchBands[i].connect(matchBands[i + 1]);
  const matchIn = matchBands[0];
  const matchOut = matchBands[matchBands.length - 1];

  // 3-band multiband compressor (LR4 crossovers, parallel mix).
  const XLOW = 140;
  const XHIGH = 3200;
  const lr = (type, f) => {
    const a = ctx.createBiquadFilter(); a.type = type; a.frequency.value = f; a.Q.value = 0.7071;
    const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = 0.7071;
    a.connect(b);
    return { in: a, out: b, a, b };
  };
  const mbIn = ctx.createGain();
  const loLP = lr('lowpass', XLOW);
  const midHP = lr('highpass', XLOW);
  const midLP = lr('lowpass', XHIGH);
  const hiHP = lr('highpass', XHIGH);
  const compLo = ctx.createDynamicsCompressor();
  const compMid = ctx.createDynamicsCompressor();
  const compHi = ctx.createDynamicsCompressor();
  [compLo, compMid, compHi].forEach((c) => {
    c.threshold.value = 0; c.ratio.value = 1; c.knee.value = 6; c.attack.value = 0.01; c.release.value = 0.25;
  });
  const mbWet = ctx.createGain(); mbWet.gain.value = 0;
  const mbDry = ctx.createGain(); mbDry.gain.value = 1;
  const mbOut = ctx.createGain();
  mbIn.connect(loLP.in); loLP.out.connect(compLo); compLo.connect(mbWet);
  mbIn.connect(midHP.in); midHP.out.connect(midLP.in); midLP.out.connect(compMid); compMid.connect(mbWet);
  mbIn.connect(hiHP.in); hiHP.out.connect(compHi); compHi.connect(mbWet);
  mbIn.connect(mbDry);
  mbWet.connect(mbOut); mbDry.connect(mbOut);

  // Per-band stereo width (side chain, 250 Hz / 4 kHz crossovers).
  const swLoLP = lr('lowpass', 250);
  const swMidHP = lr('highpass', 250);
  const swMidLP = lr('lowpass', 4000);
  const swHiHP = lr('highpass', 4000);
  const gWLow = ctx.createGain();
  const gWMid = ctx.createGain();
  const gWHigh = ctx.createGain();
  const swSum = ctx.createGain();

  // Analog character (tape wow/flutter, head bump, vinyl).
  const charIn = ctx.createGain();
  const tapeDelay = ctx.createDelay(0.05); tapeDelay.delayTime.value = 0.006;
  const wowLFO = ctx.createOscillator(); wowLFO.type = 'sine'; wowLFO.frequency.value = 0.4;
  const wowDepth = ctx.createGain(); wowDepth.gain.value = 0;
  const flutLFO = ctx.createOscillator(); flutLFO.type = 'sine'; flutLFO.frequency.value = 6.7;
  const flutDepth = ctx.createGain(); flutDepth.gain.value = 0;
  wowLFO.connect(wowDepth); wowDepth.connect(tapeDelay.delayTime);
  flutLFO.connect(flutDepth); flutDepth.connect(tapeDelay.delayTime);
  try { wowLFO.start(); flutLFO.start(); } catch (e) { /* ignore */ }
  const headBump = ctx.createBiquadFilter(); headBump.type = 'peaking'; headBump.frequency.value = 60; headBump.Q.value = 0.9; headBump.gain.value = 0;
  const vinylLP = ctx.createBiquadFilter(); vinylLP.type = 'lowpass'; vinylLP.frequency.value = 22000; vinylLP.Q.value = 0.5;
  const charOut = ctx.createGain();

  // Depth engine (early reflections).
  const erD1 = ctx.createDelay(0.2);
  const erD2 = ctx.createDelay(0.2);
  const erLP1 = ctx.createBiquadFilter(); erLP1.type = 'lowpass'; erLP1.frequency.value = 5200; erLP1.Q.value = 0.5;
  const erLP2 = ctx.createBiquadFilter(); erLP2.type = 'lowpass'; erLP2.frequency.value = 4200; erLP2.Q.value = 0.5;
  const erG1 = ctx.createGain(); erG1.gain.value = 0;
  const erG2 = ctx.createGain(); erG2.gain.value = 0;
  const depthOut = ctx.createGain();

  // Wiring (order matches the documented signal flow).
  inGain.connect(matchIn); matchOut.connect(sub);
  sub.connect(low); low.connect(body); body.connect(harsh); harsh.connect(pres);
  pres.connect(high); high.connect(tiltLo); tiltLo.connect(tiltHi);
  tiltHi.connect(mbIn); mbOut.connect(splitter);
  splitter.connect(gMidL, 0); splitter.connect(gMidR, 1); gMidL.connect(midSum); gMidR.connect(midSum); midSum.connect(midGain);
  splitter.connect(gSideL, 0); splitter.connect(gSideR, 1); gSideL.connect(sideSum); gSideR.connect(sideSum);
  sideSum.connect(bassHP);
  bassHP.connect(swLoLP.in); swLoLP.out.connect(gWLow); gWLow.connect(swSum);
  bassHP.connect(swMidHP.in); swMidHP.out.connect(swMidLP.in); swMidLP.out.connect(gWMid); gWMid.connect(swSum);
  bassHP.connect(swHiHP.in); swHiHP.out.connect(gWHigh); gWHigh.connect(swSum);
  swSum.connect(sideWidth);
  sideWidth.connect(sideDirect); sideDirect.connect(sideMix);
  sideWidth.connect(sideAP); sideAP.connect(sideAPgain); sideAPgain.connect(sideMix);
  midGain.connect(mLg); mLg.connect(Lsum); sideMix.connect(sLg); sLg.connect(Lsum);
  midGain.connect(mRg); mRg.connect(Rsum); sideMix.connect(sRg); sRg.connect(Rsum);
  Lsum.connect(haasL); Rsum.connect(haasR);
  haasL.connect(Lfinal); haasR.connect(Rfinal);
  haasL.connect(cfDLR); cfDLR.connect(cfLPLR); cfLPLR.connect(cfGLR); cfGLR.connect(Rfinal);
  haasR.connect(cfDRL); cfDRL.connect(cfLPRL); cfLPRL.connect(cfGRL); cfGRL.connect(Lfinal);
  Lfinal.connect(merger, 0, 0); Rfinal.connect(merger, 0, 1);
  merger.connect(charIn);
  charIn.connect(tapeDelay); tapeDelay.connect(headBump); headBump.connect(vinylLP); vinylLP.connect(charOut);
  charOut.connect(depthOut);
  charOut.connect(erD1); erD1.connect(erLP1); erLP1.connect(erG1); erG1.connect(depthOut);
  charOut.connect(erD2); erD2.connect(erLP2); erLP2.connect(erG2); erG2.connect(depthOut);
  depthOut.connect(dcBlock); dcBlock.connect(preSat); preSat.connect(shaper); shaper.connect(postLP); postLP.connect(outGain);

  return {
    inGain, sub, low, body, harsh, pres, high, tiltLo, tiltHi, midGain, sideWidth, bassHP,
    sideDirect, sideAPgain, haasL, haasR, cfGLR, cfGRL, preSat, shaper, postLP, outGain,
    matchBands, mbWet, mbDry, compLo, compMid, compHi, gWLow, gWMid, gWHigh,
    tapeDelay, wowDepth, flutDepth, headBump, vinylLP,
    erD1, erD2, erG1, erG2, _sat: -1, _makeup: 1,
  };
}

/**
 * Push current parameters onto a chain (live or offline).
 * `bypass === true` = audition Original (neutral processing, M/S identity).
 * Per-module bypass flags are honored so a single module can be auditioned in isolation.
 */
function setChainParams(N, bypass, noiseGains) {
  const P = state.P;
  const B = bypass;
  const eqOff = B || P.bypassEq;
  const mbOff = B || P.bypassMB;
  const stOff = B || P.bypassStereo;
  const chOff = B || P.bypassChar;
  const dpOff = B || P.bypassDepth;
  const satOff = B || P.bypassSat;
  const matchOff = B || P.bypassMatch;

  N.inGain.gain.value = dbToGain(B ? 0 : P.drive);
  N.sub.gain.value = eqOff ? 0 : P.sub;
  N.low.gain.value = eqOff ? 0 : P.warm;
  N.body.gain.value = eqOff ? 0 : P.body;
  N.harsh.gain.value = eqOff ? 0 : P.harsh;
  N.pres.gain.value = eqOff ? 0 : P.clarity;
  N.high.gain.value = eqOff ? 0 : P.air + (P.binaural && !stOff ? P.spread * 1.5 : 0);
  N.tiltLo.gain.value = eqOff ? 0 : -P.tilt;
  N.tiltHi.gain.value = eqOff ? 0 : P.tilt;

  const satAmt = satOff || B ? 0 : P.sat / 100;
  if (N._sat !== satAmt) {
    N.shaper.curve = makeSatCurve(satAmt);
    N._sat = satAmt;
  }
  const preBackoff = 1 - satAmt * 0.35;
  const postMakeup = B ? 1 : 1 + satAmt * 0.25;
  N._makeup = postMakeup;
  N.preSat.gain.value = B ? 1 : preBackoff;
  N.postLP.frequency.value = satOff || B ? 22000 : 22000 - satAmt * 4500;

  const width = stOff || B ? 1 : P.width * (1 + P.spread * 0.6);
  const bal = stOff || B ? 0 : P.ms;
  N.midGain.gain.value = bal < 0 ? 1 : 1 - bal * 0.6;
  N.sideWidth.gain.value = width * (bal > 0 ? 1 : 1 + bal * 0.6);
  const bass = stOff || B ? 0 : P.bassMono;
  N.bassHP.frequency.value = bass > 0 ? bass : 8;
  const pr = stOff || B ? 0 : P.phaseRot;
  N.sideDirect.gain.value = 1 - pr;
  N.sideAPgain.gain.value = pr;
  const haas = stOff || B ? 0 : P.haas / 1000;
  const hs = P.haasSide;
  N.haasR.delayTime.value = hs >= 0 ? haas : 0;
  N.haasL.delayTime.value = hs < 0 ? haas : 0;
  const cf = stOff || B ? 0 : P.binaural ? Math.max(P.crossfeed, 0.35) : P.crossfeed;
  N.cfGLR.gain.value = cf * 0.45;
  N.cfGRL.gain.value = cf * 0.45;
  N.outGain.gain.value = B ? 1 : postMakeup;

  // Reference-match EQ.
  const mStr = matchOff || B ? 0 : P.matchStrength / 100;
  N.matchBands.forEach((b, i) => {
    b.gain.value = (P.matchGains[i] || 0) * mStr;
  });

  // Multiband compressor (with per-band bypass and solo).
  const speeds = { fast: [0.003, 0.1], med: [0.01, 0.25], slow: [0.03, 0.4] };
  const [atk, rel] = speeds[P.mbSpeed] || speeds.med;
  const setComp = (c, amt) => {
    c.threshold.value = -amt * 0.36;
    c.ratio.value = 1 + amt * 0.04;
    c.knee.value = 9;
    c.attack.value = atk;
    c.release.value = rel;
  };
  const amtOf = (band) => {
    if (mbOff || B) return 0;
    const on = band === 'lo' ? P.mbLowOn : band === 'mid' ? P.mbMidOn : P.mbHighOn;
    if (!on) return 0;
    if (P.mbSolo && P.mbSolo !== (band === 'lo' ? 1 : band === 'mid' ? 2 : 3)) return 0;
    return band === 'lo' ? P.mbLow : band === 'mid' ? P.mbMid : P.mbHigh;
  };
  setComp(N.compLo, amtOf('lo'));
  setComp(N.compMid, amtOf('mid'));
  setComp(N.compHi, amtOf('hi'));
  const anyMB = !mbOff && !B && (amtOf('lo') > 0 || amtOf('mid') > 0 || amtOf('hi') > 0);
  const mix = anyMB ? P.mbMix / 100 : 0;
  N.mbWet.gain.value = mix;
  N.mbDry.gain.value = 1 - mix;

  // Per-band stereo width.
  N.gWLow.gain.value = stOff || B ? 1 : P.widthLow;
  N.gWMid.gain.value = stOff || B ? 1 : P.widthMid;
  N.gWHigh.gain.value = stOff || B ? 1 : P.widthHigh;

  // Analog character.
  const tp = chOff || B ? 0 : P.tape / 100;
  N.wowDepth.gain.value = tp * 0.0012;
  N.flutDepth.gain.value = tp * 0.00018;
  N.headBump.gain.value = tp * 3.5;
  const vn = chOff || B ? 0 : P.vinyl / 100;
  N.vinylLP.frequency.value = 22000 - vn * 7000;
  if (noiseGains) {
    noiseGains.crackleGain.gain.value = vn * 0.12;
    noiseGains.rumbleGain.gain.value = vn * 0.05;
    noiseGains.hissGain.gain.value = (chOff || B ? 0 : P.hiss / 100) * 0.02;
  }

  // Depth engine.
  const dp = dpOff || B ? 0 : P.depth / 100;
  const sizes = { small: [0.011, 0.019], med: [0.017, 0.029], large: [0.027, 0.047] };
  const [t1, t2] = sizes[P.depthSize] || sizes.med;
  N.erD1.delayTime.value = t1;
  N.erD2.delayTime.value = t2;
  N.erG1.gain.value = dp * 0.28;
  N.erG2.gain.value = dp * 0.22;
}

/* ---------------- live graph ---------------- */

function buildGraph() {
  if (!engine.AC) engine.AC = createAudioContext();
  const ctx = engine.AC;
  const chain = buildChain(ctx);
  const seed = ensureTextureSeed();
  const noise = buildNoiseBed(ctx, seed);
  noise.hissGain.connect(chain.outGain);
  noise.crackleGain.connect(chain.outGain);
  noise.rumbleGain.connect(chain.outGain);

  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -1; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.12;
  const post = ctx.createGain();
  const monitor = ctx.createGain();
  chain.outGain.connect(lim); lim.connect(post);

  // Audition matrix (stereo / mono / side) between `post` and `monitor`.
  const splitM = ctx.createChannelSplitter(2);
  post.connect(splitM);
  const mLL = ctx.createGain(); const mLR = ctx.createGain();
  const mRL = ctx.createGain(); const mRR = ctx.createGain();
  splitM.connect(mLL, 0); splitM.connect(mRL, 0);
  splitM.connect(mLR, 1); splitM.connect(mRR, 1);
  const mL = ctx.createGain(); const mR = ctx.createGain();
  mLL.connect(mL); mLR.connect(mL);
  mRL.connect(mR); mRR.connect(mR);
  mL.connect(monitor); mR.connect(monitor);
  monitor.connect(ctx.destination);

  // Analysers (post = processed stereo, before the audition matrix, so meters stay truthful).
  const anaPost = ctx.createAnalyser(); anaPost.fftSize = 4096; anaPost.smoothingTimeConstant = 0.78;
  const splitPost = ctx.createChannelSplitter(2);
  const anaL = ctx.createAnalyser(); anaL.fftSize = 2048;
  const anaR = ctx.createAnalyser(); anaR.fftSize = 2048;
  const kHigh = ctx.createBiquadFilter(); kHigh.type = 'highshelf'; kHigh.frequency.value = 1500; kHigh.gain.value = 4;
  const kHP = ctx.createBiquadFilter(); kHP.type = 'highpass'; kHP.frequency.value = 38; kHP.Q.value = 0.5;
  const anaK = ctx.createAnalyser(); anaK.fftSize = 8192; anaK.smoothingTimeConstant = 0;
  post.connect(anaPost);
  post.connect(splitPost); splitPost.connect(anaL, 0); splitPost.connect(anaR, 1);
  post.connect(kHigh); kHigh.connect(kHP); kHP.connect(anaK);

  engine.nodes = Object.assign({}, chain, {
    lim, post, monitor, anaPost, anaL, anaR, anaK,
    audition: { mLL, mLR, mRL, mRR },
    noise,
  });
  applyMonitorMode();
  applyParams();
}

function applyMonitorMode() {
  const m = engine.nodes.audition;
  if (!m) return;
  const mode = state.P.monitorMode;
  if (mode === 'mono') {
    m.mLL.gain.value = 0.5; m.mLR.gain.value = 0.5;
    m.mRL.gain.value = 0.5; m.mRR.gain.value = 0.5;
  } else if (mode === 'side') {
    m.mLL.gain.value = 0.5; m.mLR.gain.value = -0.5;
    m.mRL.gain.value = 0.5; m.mRR.gain.value = -0.5;
  } else {
    m.mLL.gain.value = 1; m.mLR.gain.value = 0;
    m.mRL.gain.value = 0; m.mRR.gain.value = 1;
  }
}

export function applyParams() {
  if (!engine.nodes.inGain) return;
  const bypass = state.abMode === 'A';
  setChainParams(engine.nodes, bypass, engine.nodes.noise);
  applyMonitorMode();
  engine.nodes.lim.threshold.value = bypass || state.P.bypassLimiter ? 0 : state.P.ceiling - 0.2;

  // Loudness-match trim (A/B level matching).
  let trim = 1;
  if (state.matchLoud && engine.analysis.orig && engine.analysis.proc) {
    const ref = engine.analysis.proc.lufs;
    const cur = state.abMode === 'A' ? engine.analysis.orig.lufs : engine.analysis.proc.lufs;
    if (isFiniteNum(ref) && isFiniteNum(cur)) trim = dbToGain(ref - cur);
  }
  // Preview-only normalization gain (export applies the real normalization + limiter).
  let normG = 1;
  if (state.P.normalize && !bypass && engine.analysis.proc && isFiniteNum(engine.analysis.proc.lufs)) {
    normG = dbToGain(state.P.targetLUFS - engine.analysis.proc.lufs);
  }
  // Saturation makeup is part of the chain gain budget (live + offline stay consistent).
  engine.nodes.outGain.gain.value = (engine.nodes._makeup || 1) * trim * normG;
}

/* ---------------- import / playback ---------------- */

export async function loadArrayBuffer(ab, label) {
  if (!engine.AC) {
    try {
      engine.AC = createAudioContext();
    } catch (e) {
      toast('Web Audio not supported on this browser. Try Chrome/Firefox/Safari 14+.');
      return;
    }
  }
  if (engine.AC.state === 'suspended') {
    try { await engine.AC.resume(); } catch (e) { console.warn('AudioContext resume:', e); }
  }
  if (!engine.nodes.inGain) {
    try { buildGraph(); } catch (e) { toast('Audio graph failed: ' + e.message); console.error(e); return; }
  }
  let buf;
  try {
    buf = await engine.AC.decodeAudioData(ab.slice(0));
  } catch (e) {
    toast("Couldn't decode " + label + ' — try WAV, MP3, or FLAC (format support varies by browser)');
    console.warn('decode error:', e);
    return;
  }
  engine.srcBuffer = buf;
  engine.baseSR = buf.sampleRate;
  engine.fileLabel = label;
  stopPlayback();
  return buf;
}

export async function handleFiles(file) {
  if (!file) {
    toast('No file received');
    return;
  }
  try {
    const ab = await file.arrayBuffer();
    await loadArrayBuffer(ab, file.name);
  } catch (e) {
    toast('Import failed: ' + e.message);
    console.error(e);
  }
}

export function startPlayback(at = null) {
  if (!engine.srcBuffer) return;
  if (engine.AC.state === 'suspended') engine.AC.resume();
  stopSource();
  const srcNode = engine.AC.createBufferSource();
  srcNode.buffer = engine.srcBuffer;
  srcNode.connect(engine.nodes.inGain);
  const pos = at != null ? at : engine.offsetAt;
  engine.startedAt = engine.AC.currentTime - pos;
  srcNode.start(0, clamp(pos, 0, engine.srcBuffer.duration));
  srcNode.onended = () => {
    if (engine.playing) {
      engine.playing = false;
      engine.offsetAt = 0;
      if (engine._onPlayState) engine._onPlayState();
    }
  };
  engine.playing = true;
  engine._srcNode = srcNode;
  if (engine._onPlayState) engine._onPlayState();
}

function stopSource() {
  if (engine._srcNode) {
    try { engine._srcNode.onended = null; engine._srcNode.stop(); } catch (e) { /* ignore */ }
    engine._srcNode.disconnect();
    engine._srcNode = null;
  }
}

export function pausePlayback() {
  if (!engine.playing) return;
  engine.offsetAt = currentPos();
  stopSource();
  engine.playing = false;
  if (engine._onPlayState) engine._onPlayState();
}

export function stopPlayback() {
  stopSource();
  engine.playing = false;
  engine.offsetAt = 0;
  if (engine._onPlayState) engine._onPlayState();
}

export function togglePlay() {
  if (!engine.srcBuffer) return;
  if (engine.playing) pausePlayback();
  else startPlayback();
}

export function currentPos() {
  return engine.playing
    ? clamp(engine.AC.currentTime - engine.startedAt, 0, engine.srcBuffer ? engine.srcBuffer.duration : 0)
    : engine.offsetAt;
}

/* ---------------- offline render + analysis ---------------- */

async function renderOffline(targetSR, withProcessing, maxSeconds = Infinity) {
  const dur = engine.srcBuffer.duration;
  const sr = targetSR || engine.srcBuffer.sampleRate;
  const len = Math.max(1, Math.ceil(Math.min(dur, maxSeconds) * sr));
  const oac = createOfflineAudioContext(2, len, sr);
  const src = oac.createBufferSource();
  src.buffer = engine.srcBuffer;
  if (!withProcessing) {
    src.connect(oac.destination);
    src.start();
    return await oac.startRendering();
  }
  const chain = buildChain(oac);
  const seed = ensureTextureSeed();
  const noise = buildNoiseBed(oac, seed);
  noise.hissGain.connect(chain.outGain);
  noise.crackleGain.connect(chain.outGain);
  noise.rumbleGain.connect(chain.outGain);
  setChainParams(chain, false, noise);
  src.connect(chain.inGain);
  chain.outGain.connect(oac.destination);
  src.start();
  return await oac.startRendering();
}

/* ---------------- worker-based loudness / true-peak ---------------- */

function getWorker() {
  if (!engine._worker) {
    engine._worker = new Worker(new URL('../workers/analysis.worker.js', import.meta.url), {
      type: 'module',
    });
  }
  return engine._worker;
}

const workerJobs = new Map();
let workerJobId = 0;

function workerRequest(kind, buf) {
  return new Promise((resolve, reject) => {
    const worker = getWorker();
    const id = ++workerJobId;
    workerJobs.set(id, { resolve, reject });
    const channels = [];
    for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
    worker.postMessage({ id, kind, sampleRate: buf.sampleRate, channels }, channels.map((c) => c.buffer));
  });
}

export function initWorkerHandlers() {
  const worker = getWorker();
  worker.onmessage = (e) => {
    const { id, result, error } = e.data;
    const job = workerJobs.get(id);
    if (!job) return;
    workerJobs.delete(id);
    if (error) job.reject(new Error(error));
    else job.resolve(result);
  };
}

export function onAnalysis(fn) {
  engine._analysisCallbacks.add(fn);
}

function emitAnalysis() {
  for (const fn of engine._analysisCallbacks) {
    try { fn(); } catch (e) { console.warn(e); }
  }
}

let analyzeTimer = null;
let analyzing = false;

export function scheduleAnalyze(immediate) {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(runAnalyze, immediate ? 60 : 480);
}

export async function runAnalyze() {
  if (!engine.srcBuffer || analyzing) return;
  analyzing = true;
  try {
    const procBuf = await renderOffline(0, true, ANALYSIS_WINDOW_SECONDS);
    const oBuf = engine.srcBuffer;
    // Orig analysis on the main thread over a zero-copy window view.
    const winLen = Math.min(oBuf.length, oBuf.sampleRate * ANALYSIS_WINDOW_SECONDS);
    const windowView = {
      numberOfChannels: oBuf.numberOfChannels,
      sampleRate: oBuf.sampleRate,
      length: winLen,
      getChannelData: (c) => oBuf.getChannelData(c).subarray(0, winLen),
    };
    const orig = measureLUFS(windowView);
    const proc = await workerRequest('both', procBuf);
    engine.analysis.orig = orig;
    engine.analysis.proc = { lufs: proc.lufs, lra: proc.lra, tp: proc.tp };
    emitAnalysis();
    applyParams();
  } catch (e) {
    console.warn('analysis failed', e);
  }
  analyzing = false;
}

/* ---------------- reference matching ---------------- */

export function computeMatch() {
  if (!engine.srcBuffer) {
    toast('Load your track first');
    return false;
  }
  if (!engine.refBuffer) {
    toast('Load a reference track first');
    return false;
  }
  const cur = spectrumFingerprint(engine.srcBuffer);
  const ref = spectrumFingerprint(engine.refBuffer);
  if (!cur || !ref) {
    toast('Analysis failed — tracks too short?');
    return false;
  }
  const gains = computeMatchGains(cur, ref);
  setParam('matchGains', gains, { record: true });
  if (state.P.matchStrength === 0) setParam('matchStrength', 70, { record: false });
  setPreset('Custom');
  return true;
}

/* ---------------- mastering render + report ---------------- */

function sourceMeta() {
  const b = engine.srcBuffer;
  return {
    name: engine.fileLabel || 'master',
    sampleRate: b.sampleRate,
    channels: b.numberOfChannels,
    durationSeconds: Number(b.duration.toFixed(3)),
    frames: b.length,
  };
}

function analysisSummary(buf) {
  const m = measureLUFS(buf);
  let tp = truePeakBlock(buf.getChannelData(0));
  for (let c = 1; c < buf.numberOfChannels; c++) {
    const v = truePeakBlock(buf.getChannelData(c));
    if (v > tp) tp = v;
  }
  return { lufs: m.lufs, lra: m.lra, truePeakDbtp: tp > 0 ? gainToDb(tp) : -Infinity };
}

/**
 * Full offline mastering render. Returns { buf, report }.
 * The report is the single source of truth for what happened to the audio.
 */
export async function renderMaster(targetSR) {
  const sr = targetSR || engine.srcBuffer.sampleRate;
  const P = state.P;
  const t0 = performance.now();
  const buf = await renderOffline(sr, true);

  if (P.transAttack || P.transSustain) transientShape(buf, P.transAttack, P.transSustain);

  let normalizationGainDb = 0;
  if (P.normalize) {
    const m = measureLUFS(buf);
    if (isFiniteNum(m.lufs)) {
      const g = dbToGain(P.targetLUFS - m.lufs);
      normalizationGainDb = gainToDb(g);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) d[i] *= g;
      }
    }
  }

  let limiter = { maxGainReductionDb: 0 };
  if (!P.bypassLimiter) limiter = truePeakLimit(buf, P.ceiling);

  const verify = verifyTruePeak(buf, P.ceiling);
  const afterLUFS = measureLUFS(buf);
  const renderSeconds = (performance.now() - t0) / 1000;

  const report = {
    engineVersion: ENGINE_VERSION,
    engine: ENGINE_NAME,
    source: sourceMeta(),
    preset: state.preset,
    parameters: { ...P, matchGains: [...P.matchGains] },
    analysisBefore: analysisSummary(engine.srcBuffer),
    analysisAfter: {
      lufs: afterLUFS.lufs,
      lra: afterLUFS.lra,
      truePeakDbtp: verify.measuredTruePeakDbtp,
    },
    normalizationGainDb: Number(normalizationGainDb.toFixed(3)),
    maximumGainReductionDb: Number(limiter.maxGainReductionDb.toFixed(3)),
    requestedCeilingDbtp: P.ceiling,
    measuredTruePeakDbtp: Number(verify.measuredTruePeakDbtp.toFixed(3)),
    ceilingExceeded: verify.exceeded,
    bypassLimiter: !!P.bypassLimiter,
    format: { sampleRate: buf.sampleRate, channels: buf.numberOfChannels },
    textureSeed: state.P.textureSeed,
    dither: P.dither,
    renderSeconds: Number(renderSeconds.toFixed(3)),
    timestamp: new Date().toISOString(),
  };
  return { buf, report };
}

/* ---------------- export orchestration ---------------- */

function formatFromSelection(fmtSel) {
  switch (fmtSel) {
    case 'wav16': return { enc: 'wav', bits: 16, ext: 'wav', label: 'WAV 16-bit' };
    case 'wav24': return { enc: 'wav', bits: 24, ext: 'wav', label: 'WAV 24-bit' };
    case 'wav32': return { enc: 'wav', bits: 32, ext: 'wav', label: 'WAV 32-bit float' };
    case 'aif24': return { enc: 'aif', bits: 24, ext: 'aif', label: 'AIFF 24-bit' };
    case 'mp3': return { enc: 'mp3', bits: 0, ext: 'mp3', label: 'MP3 320 kbps' };
    default: return { enc: 'wav', bits: 24, ext: 'wav', label: 'WAV 24-bit' };
  }
}

function encodeMaster(buf, fmt, rng) {
  const opts = { dither: state.P.dither === 'tpdf', rng };
  if (fmt.enc === 'wav') return writeWAV(buf, fmt.bits, opts);
  if (fmt.enc === 'aif') return writeAIFF(buf, opts);
  if (fmt.enc === 'mp3') return encodeMP3(buf, 320);
  throw new Error('Unknown encoder ' + fmt.enc);
}

export async function doExport(fmtSel, srSel, reportSink) {
  if (!engine.srcBuffer) return null;
  const fmt = formatFromSelection(fmtSel);
  const sr = srSel || 0;
  const rng = mulberry32(state.P.textureSeed >>> 0);
  const { buf, report } = await renderMaster(sr);
  report.format = { ...report.format, container: fmt.label, bitDepth: fmt.bits || null, dither: state.P.dither };
  const blob = encodeMaster(buf, fmt, rng);
  const rateLabel = buf.sampleRate >= 1000 ? `${(buf.sampleRate / 1000).toFixed(buf.sampleRate % 1000 ? 1 : 0)}k` : `${buf.sampleRate}Hz`;
  const name = `${baseName(engine.fileLabel)}_master_${rateLabel}.${fmt.ext}`;
  download(blob, name);
  if (reportSink) reportSink(report, name);
  return report;
}

/* ---------------- batch ---------------- */

export const batch = { files: [] };

export async function batchAddFiles(list) {
  if (!engine.AC) {
    try { engine.AC = createAudioContext(); } catch (e) { toast('Web Audio unavailable'); return; }
  }
  if (!engine.nodes.inGain) {
    try { buildGraph(); } catch (e) { /* ignore */ }
  }
  for (const f of list) {
    try {
      const ab = await f.arrayBuffer();
      const buf = await engine.AC.decodeAudioData(ab.slice(0));
      batch.files.push({ file: f, name: f.name, buf, lufs: null });
    } catch (e) {
      toast('Skipped ' + f.name + ' (decode)');
    }
  }
}

export async function batchRun(fmtSel, srSel, onProgress, onDone) {
  if (!batch.files.length) return;
  const fmt = formatFromSelection(fmtSel);
  const srOut = srSel || 0;
  const saved = engine.srcBuffer;
  const savedLabel = engine.fileLabel;
  const rng = mulberry32(state.P.textureSeed >>> 0);
  let reports = [];
  for (let i = 0; i < batch.files.length; i++) {
    const it = batch.files[i];
    engine.srcBuffer = it.buf;
    engine.fileLabel = it.name;
    if (onProgress) onProgress(i, batch.files.length, it.name);
    try {
      const sr = srOut || it.buf.sampleRate;
      const { buf, report } = await renderMaster(sr);
      const blob = encodeMaster(buf, fmt, rng);
      const nm = baseName(it.name);
      download(blob, `${String(i + 1).padStart(2, '0')}_${nm}_master.${fmt.ext}`);
      reports.push(report);
    } catch (e) {
      toast('Batch error on ' + it.name);
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  engine.srcBuffer = saved;
  engine.fileLabel = savedLabel;
  if (onDone) onDone(reports);
  return reports;
}

/* ---------------- immersive ---------------- */

const IM = state.IM;

function buildSpeakerFeeds(ctx, src2, layout) {
  const keys = LAYOUTS[layout];
  const split = ctx.createChannelSplitter(2);
  src2.connect(split);
  const L = ctx.createGain();
  const R = ctx.createGain();
  split.connect(L, 0);
  split.connect(R, 1);
  const mid = ctx.createGain();
  const side = ctx.createGain();
  const lM = ctx.createGain(); lM.gain.value = 0.5;
  const rM = ctx.createGain(); rM.gain.value = 0.5;
  L.connect(lM); R.connect(rM); lM.connect(mid); rM.connect(mid);
  const lS = ctx.createGain(); lS.gain.value = 0.5;
  const rS = ctx.createGain(); rS.gain.value = -0.5;
  L.connect(lS); R.connect(rS); lS.connect(side); rS.connect(side);

  const decorr = (inp, ms, f, q) => {
    const d = ctx.createDelay(0.2);
    d.delayTime.value = ms / 1000;
    const ap = ctx.createBiquadFilter();
    ap.type = 'allpass';
    ap.frequency.value = f;
    ap.Q.value = q || 0.6;
    inp.connect(d);
    d.connect(ap);
    return ap;
  };
  const fr = IM.frontRear;
  const frontG = 1 - Math.max(0, fr - 0.5) * 0.6;
  const rearG = 1 - Math.max(0, 0.5 - fr) * 0.6;
  const cE = IM.centerExtract;
  const surrG = dbToGain(IM.surrLevel) * rearG;
  const hG = dbToGain(IM.heightLevel) * rearG;
  const feed = () => ctx.createGain();
  const F = {};

  if (layout === 'soniclab') {
    const D = IM.surrDelay;
    const f1 = feed(); f1.gain.value = frontG; L.connect(f1); F.SL1 = f1;
    const f2 = feed(); f2.gain.value = frontG; R.connect(f2); F.SL2 = f2;
    {
      const f3 = feed(); f3.gain.value = 0.72 * frontG; L.connect(f3);
      const d = feed(); d.gain.value = 0.45; decorr(side, 5, 1250).connect(d); d.connect(f3); F.SL3 = f3;
      const f4 = feed(); f4.gain.value = 0.72 * frontG; R.connect(f4);
      const e = feed(); e.gain.value = 0.45; decorr(side, 6, 1400).connect(e); e.connect(f4); F.SL4 = f4;
    }
    {
      const s5 = feed(); s5.gain.value = surrG; decorr(side, D, 900).connect(s5);
      const b5 = feed(); b5.gain.value = 0.2 * surrG; L.connect(b5); b5.connect(s5); F.SL5 = s5;
      const s6 = feed(); s6.gain.value = surrG; decorr(side, D + 3, 1080).connect(s6);
      const b6 = feed(); b6.gain.value = 0.2 * surrG; R.connect(b6); b6.connect(s6); F.SL6 = s6;
    }
    {
      const r7 = feed(); r7.gain.value = 0.85 * surrG; decorr(side, D + 11, 700).connect(r7); F.SL7 = r7;
      const r8 = feed(); r8.gain.value = 0.85 * surrG; decorr(side, D + 14, 800).connect(r8); F.SL8 = r8;
    }
    const ground = (d, f) => {
      const a = decorr(side, d, f);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000; lp.Q.value = 0.5;
      const g = feed(); g.gain.value = surrG * 0.5;
      a.connect(lp); lp.connect(g);
      return g;
    };
    F.SL9 = ground(9, 650); F.SL10 = ground(12, 760); F.SL11 = ground(15, 540); F.SL12 = ground(18, 600);
    const hQ = IM.heightDecorr * 2.2 + 0.3;
    const ring = (d, f, hp, g) => {
      const a = decorr(side, d, f, hQ);
      const h = ctx.createBiquadFilter(); h.type = 'highpass'; h.frequency.value = hp; h.Q.value = 0.5;
      const ap2 = ctx.createBiquadFilter(); ap2.type = 'allpass'; ap2.frequency.value = f * 1.7; ap2.Q.value = hQ;
      const o = feed(); o.gain.value = g;
      a.connect(h); h.connect(ap2); ap2.connect(o);
      return o;
    };
    F.SL13 = ring(8, 1500, 600, hG * 0.9); F.SL14 = ring(10, 1700, 600, hG * 0.9);
    F.SL15 = ring(13, 1350, 600, hG * 0.8); F.SL16 = ring(16, 1500, 600, hG * 0.8);
    F.SL17 = ring(20, 1900, 1000, hG); F.SL18 = ring(23, 2100, 1000, hG);
    F.SL19 = ring(27, 1650, 1000, hG * 0.9); F.SL20 = ring(31, 1800, 1000, hG * 0.9);
    const subLP = () => {
      const a = ctx.createBiquadFilter(); a.type = 'lowpass'; a.frequency.value = IM.lfeFreq; a.Q.value = 0.7071;
      const b = ctx.createBiquadFilter(); b.type = 'lowpass'; b.frequency.value = IM.lfeFreq; b.Q.value = 0.7071;
      a.connect(b);
      return { in: a, out: b };
    };
    const lfeG = dbToGain(IM.lfeLevel);
    const lpL = subLP(); L.connect(lpL.in);
    const g21 = feed(); g21.gain.value = lfeG * 0.85; lpL.out.connect(g21); F.SL21 = g21;
    const lpR = subLP(); R.connect(lpR.in);
    const g22 = feed(); g22.gain.value = lfeG * 0.85; lpR.out.connect(g22); F.SL22 = g22;
    const lpM = subLP(); mid.connect(lpM.in);
    const g23 = feed(); g23.gain.value = lfeG; lpM.out.connect(g23); F.SL23 = g23;
    const g24 = feed(); g24.gain.value = lfeG * 0.7; lpM.out.connect(g24); F.SL24 = g24;
    return F;
  }

  if (keys.includes('C')) {
    const c = feed(); c.gain.value = cE; mid.connect(c); F.C = c;
  }
  if (keys.includes('LFE')) {
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = IM.lfeFreq; lp.Q.value = 0.7;
    const g = feed(); g.gain.value = dbToGain(IM.lfeLevel); mid.connect(lp); lp.connect(g); F.LFE = g;
  }
  const cDip = feed(); cDip.gain.value = -0.3 * cE; if (F.C) mid.connect(cDip);
  {
    const fl = feed(); fl.gain.value = frontG; L.connect(fl); if (F.C) cDip.connect(fl); F.L = fl;
    const frr = feed(); frr.gain.value = frontG; R.connect(frr); if (F.C) cDip.connect(frr); F.R = frr;
  }
  if (keys.includes('Lw')) {
    const lw = feed(); lw.gain.value = 0.75 * frontG; L.connect(lw); decorr(side, 6, 1200).connect(lw); F.Lw = lw;
    const rw = feed(); rw.gain.value = 0.75 * frontG; R.connect(rw); decorr(side, 7, 1400).connect(rw); F.Rw = rw;
  }
  const sSurr = (neg, d, f) => {
    const g = feed(); g.gain.value = surrG; decorr(side, d, f).connect(g);
    const b = feed(); b.gain.value = 0.25 * surrG; (neg ? R : L).connect(b); b.connect(g);
    return g;
  };
  if (keys.includes('Ls')) {
    F.Ls = sSurr(false, IM.surrDelay, 900); F.Rs = sSurr(true, IM.surrDelay + 3, 1100);
  }
  if (keys.includes('Lss')) {
    F.Lss = sSurr(false, IM.surrDelay, 900); F.Rss = sSurr(true, IM.surrDelay + 3, 1100);
  }
  if (keys.includes('Lrs')) {
    const gl = feed(); gl.gain.value = surrG * 0.85; decorr(side, IM.surrDelay + 11, 700).connect(gl); F.Lrs = gl;
    const gr = feed(); gr.gain.value = surrG * 0.85; decorr(side, IM.surrDelay + 14, 800).connect(gr); F.Rrs = gr;
  }
  const hQ = IM.heightDecorr * 2.2 + 0.3;
  const hgt = (d, f) => {
    const a = decorr(side, d, f, hQ);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 700;
    const ap2 = ctx.createBiquadFilter(); ap2.type = 'allpass'; ap2.frequency.value = f * 1.7; ap2.Q.value = hQ;
    const g = feed(); g.gain.value = hG;
    a.connect(hp); hp.connect(ap2); ap2.connect(g);
    return g;
  };
  if (keys.includes('Ltf')) { F.Ltf = hgt(8, 1500); F.Rtf = hgt(10, 1700); }
  if (keys.includes('Ltm')) { F.Ltm = hgt(12, 1600); F.Rtm = hgt(14, 1750); }
  if (keys.includes('Ltr')) { F.Ltr = hgt(16, 1300); F.Rtr = hgt(18, 1450); }
  return F;
}

function placePanner(ctx, az, el) {
  const p = ctx.createPanner();
  p.panningModel = 'HRTF';
  p.distanceModel = 'linear';
  p.maxDistance = 2;
  const a = (az * Math.PI) / 180;
  const e = (el * Math.PI) / 180;
  p.positionX.value = Math.sin(a) * Math.cos(e);
  p.positionY.value = Math.sin(e);
  p.positionZ.value = -Math.cos(a) * Math.cos(e);
  return p;
}

export async function renderImmersive(fmtSel, srSel) {
  if (!engine.srcBuffer) {
    toast('Load a file first');
    return null;
  }
  if (IM.layout === 'off') {
    toast('Pick an output layout');
    return null;
  }
  try {
    const master = await renderMaster(srSel || 0);
    const buf = master.buf;
    const sr = buf.sampleRate;
    const len = buf.length;
    const isFloat = /32/.test(fmtSel);
    const bit = isFloat ? 32 : 24;
    let outBuf;
    let blob;
    let name;
    const layoutLabel = IM.layout === 'soniclab' ? 'SonicLab20.4' : IM.layout;

    if (IM.target === 'binaural') {
      const oac = createOfflineAudioContext(2, len, sr);
      const src = oac.createBufferSource();
      src.buffer = buf;
      const F = buildSpeakerFeeds(oac, src, IM.layout);
      const sum = oac.createGain();
      sum.connect(oac.destination);
      for (const k in F) {
        const sp = SP[k];
        if (sp.lfe) {
          const g = oac.createGain(); g.gain.value = 0.7; F[k].connect(g); g.connect(sum);
        } else {
          const p = placePanner(oac, sp.az, sp.el); F[k].connect(p); p.connect(sum);
        }
      }
      src.start();
      outBuf = await oac.startRendering();
      truePeakLimit(outBuf, state.P.ceiling);
      blob = writeWAV(outBuf, bit);
      name = `${baseName(engine.fileLabel)}_${layoutLabel}_binaural.wav`;
    } else {
      const N = LAYOUTS[IM.layout].length;
      const oac = createOfflineAudioContext(N, len, sr);
      const src = oac.createBufferSource();
      src.buffer = buf;
      const F = buildSpeakerFeeds(oac, src, IM.layout);
      const merger = oac.createChannelMerger(N);
      const ord = IM.target === 'wavmc' ? getWavOrder(IM.layout).order : LAYOUTS[IM.layout];
      ord.forEach((k, i) => {
        if (F[k]) F[k].connect(merger, 0, i);
      });
      merger.connect(oac.destination);
      src.start();
      outBuf = await oac.startRendering();
      truePeakLimit(outBuf, state.P.ceiling);
      if (IM.target === 'adm') {
        blob = writeADMBWF(outBuf, IM.layout, LAYOUTS[IM.layout].map((k) => SP[k]), 24, {
          dither: state.P.dither === 'tpdf',
          rng: mulberry32(state.P.textureSeed >>> 0),
        });
        name = `${baseName(engine.fileLabel)}_${layoutLabel}_ADM.wav`;
      } else {
        const { mask } = getWavOrder(IM.layout);
        blob = writeWAVMultiExt(outBuf, bit, mask, {
          dither: state.P.dither === 'tpdf' && bit !== 32,
          rng: mulberry32(state.P.textureSeed >>> 0),
        });
        name = `${baseName(engine.fileLabel)}_${layoutLabel}.wav`;
      }
    }
    download(blob, name);
    return { name, layout: IM.layout, target: IM.target };
  } catch (e) {
    toast('Immersive render failed: ' + e.message);
    console.error(e);
    return null;
  }
}

/* ---------------- live binaural preview ---------------- */

function teardownPreview() {
  if (engine.nodes._prevTap) {
    try { engine.nodes.post.disconnect(engine.nodes._prevTap); } catch (e) { /* ignore */ }
    try { engine.nodes._prevTap.disconnect(); } catch (e) { /* ignore */ }
    engine.nodes._prevTap = null;
  }
  if (engine.nodes._prev) {
    for (const n of engine.nodes._prev) {
      try { n.disconnect(); } catch (e) { /* ignore */ }
    }
    engine.nodes._prev = null;
  }
}

export function buildPreview() {
  teardownPreview();
  if (!IM.binPreview || IM.layout === 'off' || !engine.nodes.post) {
    if (engine.nodes.monitor) engine.nodes.monitor.gain.value = 1;
    return;
  }
  const ctx = engine.AC;
  const created = [];
  const tap = ctx.createGain();
  engine.nodes.post.connect(tap);
  engine.nodes._prevTap = tap;
  const F = buildSpeakerFeeds(ctx, tap, IM.layout);
  const sum = ctx.createGain();
  sum.connect(ctx.destination);
  created.push(sum);
  for (const k in F) {
    const sp = SP[k];
    if (sp.lfe) {
      const g = ctx.createGain(); g.gain.value = 0.7; F[k].connect(g); g.connect(sum); created.push(g);
    } else {
      const p = placePanner(ctx, sp.az, sp.el); F[k].connect(p); p.connect(sum); created.push(p);
    }
  }
  for (const k in F) created.push(F[k]);
  engine.nodes._prev = created;
  engine.nodes.monitor.gain.value = 0;
}

export function teardownImmersivePreview() {
  teardownPreview();
  if (engine.nodes.monitor) engine.nodes.monitor.gain.value = 1;
}

/* ---------------- channel identification export ---------------- */

/**
 * Synthesize a channel-identification sequence: each channel emits a short beep in its
 * own time slot (channel 1 first), with a distinct rising pitch. Returns a buffer-like
 * object whose channels are in the same order as the multichannel WAV deliverable.
 */
function makeChannelIdBuffer(layout, order, sr = 48000) {
  const N = order.length;
  const slot = 1.0;
  const beepDur = 0.45;
  const total = N * slot + 0.5;
  const len = Math.ceil(total * sr);
  const channels = [];
  for (let c = 0; c < N; c++) {
    const d = new Float32Array(len);
    const sp = SP[order[c]];
    const freq = sp.lfe ? 60 : 500 * Math.pow(2, c / 12);
    const amp = sp.lfe ? 0.6 : 0.4;
    const start = Math.floor(c * slot * sr);
    const dur = Math.floor(beepDur * sr);
    const fade = Math.floor(0.006 * sr);
    for (let i = 0; i < dur && start + i < len; i++) {
      let env = 1;
      if (i < fade) env = i / fade;
      else if (i > dur - fade) env = (dur - i) / fade;
      d[start + i] = Math.sin((2 * Math.PI * freq * i) / sr) * amp * env;
    }
    channels.push(d);
  }
  return { numberOfChannels: N, sampleRate: sr, length: len, getChannelData: (c) => channels[c] };
}

export function exportChannelMap() {
  if (IM.layout === 'off') {
    toast('Pick an output layout first');
    return;
  }
  const { order } = getWavOrder(IM.layout);
  const map = buildChannelMap(IM.layout);
  map.wavChannelOrder = order;
  map.note =
    'Azimuth uses ADM convention (+ = left). For the multichannel WAV deliverable, channel index follows wavChannelOrder.';
  downloadJSON(map, `${IM.layout.replace(/\./g, '')}_channelMap.json`);
  toast('Channel map downloaded');
}

export function exportChannelId() {
  if (IM.layout === 'off') {
    toast('Pick an output layout first');
    return;
  }
  const { order, mask } = getWavOrder(IM.layout);
  const buf = makeChannelIdBuffer(IM.layout, order);
  const blob = writeWAVMultiExt(buf, 24, mask);
  const layoutLabel = IM.layout === 'soniclab' ? 'SonicLab20.4' : IM.layout;
  download(blob, `${layoutLabel}_channelID_${order.length}ch.wav`);
  toast(`Channel ID rendered · ${order.length}ch`);
}

/* ---------------- diagnostics ---------------- */

export function diagnostics() {
  const out = {
    engineVersion: ENGINE_VERSION,
    userAgent: navigator.userAgent,
    audioContext: !!(window.AudioContext || window.webkitAudioContext),
    offlineAudioContext: !!(window.OfflineAudioContext || window.webkitOfflineAudioContext),
    webWorker: typeof Worker !== 'undefined',
    structuredClone: typeof structuredClone !== 'undefined',
    deviceMemory: navigator.deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    contextSampleRate: engine.AC ? engine.AC.sampleRate : null,
    supportedSampleRates: [],
  };
  if (out.offlineAudioContext) {
    for (const sr of [44100, 48000, 96000, 192000, 384000]) {
      try {
        new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, sr);
        out.supportedSampleRates.push(sr);
      } catch (e) {
        /* not supported */
      }
    }
  }
  return out;
}

/* ---------------- texture seed control ---------------- */

export function setTextureSeed(seed) {
  setParam('textureSeed', seed >>> 0);
  rebuildNoise();
}

function rebuildNoise() {
  if (!engine.AC || !engine.nodes.noise) return;
  const ctx = engine.AC;
  const old = engine.nodes.noise;
  const seed = ensureTextureSeed();
  const noise = buildNoiseBed(ctx, seed);
  // Repoint charOut taps.
  try { old.hissGain.disconnect(); } catch (e) { /* ignore */ }
  try { old.crackleGain.disconnect(); } catch (e) { /* ignore */ }
  try { old.rumbleGain.disconnect(); } catch (e) { /* ignore */ }
  noise.hissGain.connect(engine.nodes.outGain);
  noise.crackleGain.connect(engine.nodes.outGain);
  noise.rumbleGain.connect(engine.nodes.outGain);
  engine.nodes.noise = noise;
  applyParams();
}

export function rollSeed() {
  rollTextureSeed();
  rebuildNoise();
}

/* ---------------- attach API surface for the UI ---------------- */
Object.assign(engine, {
  createAudioContext,
  createOfflineAudioContext,
  loadArrayBuffer,
  handleFiles,
  startPlayback,
  pausePlayback,
  stopPlayback,
  togglePlay,
  currentPos,
  applyParams,
  scheduleAnalyze,
  runAnalyze,
  initWorkerHandlers,
  onAnalysis,
  computeMatch,
  renderMaster,
  doExport,
  batchAddFiles,
  batchRun,
  renderImmersive,
  buildPreview,
  teardownImmersivePreview,
  exportChannelMap,
  exportChannelId,
  diagnostics,
  setTextureSeed,
  rollSeed,
  batch,
});
