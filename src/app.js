/**
 * SIGNAL ROT // MASTER — application shell.
 *
 * Pure DSP, encoding and layout logic lives in the modules imported below and
 * is covered by the unit tests in tests/. What remains here is the browser
 * layer: DOM wiring, the live Web Audio graph, canvas visualisation and the
 * offline render orchestration.
 */

import { clamp, dbToGain, gainToDb, formatTime as fmtTime } from './dsp/units.js';
import { measureLUFS } from './dsp/loudness.js';
import { truePeakLimit, truePeakChannel, truePeakDb } from './dsp/true-peak.js';
import { transientShape } from './dsp/transient.js';
import { spectrumFingerprint, matchCurve, MATCH_FREQS } from './dsp/reference-match.js';
import { encodeWav, encodeAiff } from './export/wav.js';
import { SPEAKERS as SP, LAYOUTS, getWavOrder } from './immersive/layouts.js';

/* TAB SWITCHING */
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
  document.querySelectorAll('.tpanel').forEach(x=>x.classList.remove('on'));
  t.classList.add('on');
  document.querySelector('.tpanel[data-tab="'+t.dataset.tab+'"]').classList.add('on');
}));

/* ====================================================================
   SIGNAL ROT // MASTER  — engine
   ==================================================================== */
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
function toast(m,ms=1900){const t=$('#toast');t.textContent=m;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),ms);}

/* ---------- parameter state ---------- */
const P={
  normalize:true, targetLUFS:-14, ceiling:-0.1, drive:0,
  width:1.0, ms:0, bassMono:0, haas:0, haasSide:1, crossfeed:0, phaseRot:0,
  binaural:false, spread:0,
  sub:0, warm:0, body:0, harsh:0, clarity:0, air:0, tilt:0, sat:0,
  /* — multiband compressor (3-band, LR4 crossovers, parallel mix) — */
  mbLow:0, mbMid:0, mbHigh:0,      // per-band amount 0-100 (maps to thresh/ratio)
  mbMix:100,                        // wet mix % (parallel / NY compression below 100)
  mbSpeed:'med',                    // fast | med | slow ballistics
  /* — per-band stereo width (multi-dimensional imaging) — */
  widthLow:1.0, widthMid:1.0, widthHigh:1.0,   // ratios, crossovers 250Hz / 4kHz
  /* — analog character — */
  tape:0,      // 0-100: wow+flutter depth + head bump
  hiss:0,      // 0-100: tape hiss bed
  vinyl:0,     // 0-100: crackle + rumble + gentle HF roll
  /* — depth engine (early-reflection bloom) — */
  depth:0,     // 0-100 ER level
  depthSize:'med',  // small | med | large (reflection spacing)
  /* — transient shaper (sample-accurate, applied at export) — */
  transAttack:0,   // -100..+100 (% attack emphasis)
  transSustain:0,  // -100..+100 (% sustain emphasis)
  /* — reference match EQ — */
  matchStrength:0,  // 0-100 applied strength
  matchGains:[0,0,0,0,0,0,0,0]  // dB at 60,150,400,1k,2.5k,5k,8k,12k (set by analysis)
};
let refBuffer=null;
let preset='Flat';

/* ---------- audio context / graph ---------- */
let AC=null, srcBuffer=null, fileLabel='', baseSR=44100;
let nodes={};           // live graph nodes
let playing=false, startedAt=0, offsetAt=0, srcNode=null;
let abMode='B';         // 'A' original, 'B' processed
let matchLoud=false;
const analysis={orig:null, proc:null}; // {lufs, lra, tp}

/* ---------- native-node M/S chain (no AudioWorklet — works in any sandbox) ----------
   inGain -> mastering EQ (sub/warm/body/harsh/clarity/air/tilt) -> [M/S matrix: width,
   M/S balance, bass-mono, phase-blend, Haas, crossfeed] -> saturation -> outGain. */
const IDENTITY_CURVE=(()=>{const n=1024,c=new Float32Array(n);for(let i=0;i<n;i++)c[i]=i/(n-1)*2-1;return c;})();
/* Audiophile-grade saturation curve:
   - Gentler drive scaling (1..2.2 instead of 1..4) for cleaner harmonics
   - Quintic soft-clip blend (smoother than pure tanh at small signals)
   - DC-bias-free asymmetry: even harmonics without lifting the zero crossing
   - Curve length 4096 (2× previous) for less interpolation noise on the WaveShaper
   - Output normalized to peak 1.0 so saturation doesn't add gain — only character */
function makeSatCurve(amt){
  if(amt<=0)return IDENTITY_CURVE;
  const n=4096,c=new Float32Array(n);
  const k=1+amt*1.2;                       // drive 1..2.2 (was 1..4 — too hot)
  const asym=amt*0.06;                     // gentle even-harmonic asymmetry (was 0.10)
  let pk=0;
  for(let i=0;i<n;i++){
    const x=i/(n-1)*2-1;
    // bias-free asymmetric input: (x+a*(x²-x⁴)) keeps integral over [-1,1] near zero
    const xs=x+asym*(x*x-x*x*x*x);
    // quintic-blended soft-clip: smoother knee than tanh, less HF harmonic spray
    const t=Math.tanh(k*xs);
    const blend=1-(1-amt)*(1-amt);         // accelerating wetness for musical drive curve
    const y=(1-blend)*x+blend*t;
    // de-DC: subtract running mean (eliminates asymmetry-induced offset)
    c[i]=y;
    if(Math.abs(y)>pk)pk=Math.abs(y);
  }
  // remove any DC offset introduced by asymmetric shaping
  let sum=0; for(let i=0;i<n;i++)sum+=c[i]; const dc=sum/n;
  for(let i=0;i<n;i++)c[i]-=dc;
  // normalize to unity so saturation is character-only, never adds gain
  pk=0; for(let i=0;i<n;i++)if(Math.abs(c[i])>pk)pk=Math.abs(c[i]);
  if(pk>0&&pk!==1)for(let i=0;i<n;i++)c[i]/=pk;
  return c;
}
function buildChain(ctx){
  const inGain=ctx.createGain();
  // mastering EQ
  const sub =ctx.createBiquadFilter(); sub.type='lowshelf';   sub.frequency.value=55;
  const low =ctx.createBiquadFilter(); low.type='lowshelf';   low.frequency.value=120;     // warmth
  const body=ctx.createBiquadFilter(); body.type='peaking';   body.frequency.value=350; body.Q.value=0.7;
  const harsh=ctx.createBiquadFilter();harsh.type='peaking';  harsh.frequency.value=2800; harsh.Q.value=1.2;
  const pres=ctx.createBiquadFilter(); pres.type='peaking';   pres.frequency.value=5000; pres.Q.value=0.8; // clarity
  const high=ctx.createBiquadFilter(); high.type='highshelf'; high.frequency.value=12000;  // air
  const tiltLo=ctx.createBiquadFilter();tiltLo.type='lowshelf'; tiltLo.frequency.value=1000;
  const tiltHi=ctx.createBiquadFilter();tiltHi.type='highshelf';tiltHi.frequency.value=1000;
  const splitter=ctx.createChannelSplitter(2);
  // mid bus = 0.5L + 0.5R
  const gMidL=ctx.createGain(); gMidL.gain.value=0.5;
  const gMidR=ctx.createGain(); gMidR.gain.value=0.5;
  const midSum=ctx.createGain();
  const midGain=ctx.createGain();
  // side bus = 0.5L - 0.5R
  const gSideL=ctx.createGain(); gSideL.gain.value=0.5;
  const gSideR=ctx.createGain(); gSideR.gain.value=-0.5;
  const sideSum=ctx.createGain();
  const bassHP=ctx.createBiquadFilter(); bassHP.type='highpass'; bassHP.frequency.value=8; bassHP.Q.value=0.5;
  const sideWidth=ctx.createGain();
  const sideDirect=ctx.createGain(); sideDirect.gain.value=1;
  const sideAP=ctx.createBiquadFilter(); sideAP.type='allpass'; sideAP.frequency.value=800; sideAP.Q.value=0.7;
  const sideAPgain=ctx.createGain(); sideAPgain.gain.value=0;
  const sideMix=ctx.createGain();
  const mLg=ctx.createGain(); mLg.gain.value=1;
  const sLg=ctx.createGain(); sLg.gain.value=1;
  const mRg=ctx.createGain(); mRg.gain.value=1;
  const sRg=ctx.createGain(); sRg.gain.value=-1;
  const Lsum=ctx.createGain();
  const Rsum=ctx.createGain();
  const haasL=ctx.createDelay(0.1);
  const haasR=ctx.createDelay(0.1);
  const cfDLR=ctx.createDelay(0.02); cfDLR.delayTime.value=0.0003;
  const cfLPLR=ctx.createBiquadFilter(); cfLPLR.type='lowpass'; cfLPLR.frequency.value=700;
  const cfGLR=ctx.createGain(); cfGLR.gain.value=0;
  const cfDRL=ctx.createDelay(0.02); cfDRL.delayTime.value=0.0003;
  const cfLPRL=ctx.createBiquadFilter(); cfLPRL.type='lowpass'; cfLPRL.frequency.value=700;
  const cfGRL=ctx.createGain(); cfGRL.gain.value=0;
  const Lfinal=ctx.createGain();
  const Rfinal=ctx.createGain();
  const merger=ctx.createChannelMerger(2);
  // Audiophile chain additions:
  //   dcBlock: 5Hz highpass kills subsonic DC that asymmetric saturation could amplify
  //   preSat: gain stage that backs off into the shaper, then makeup at outGain — this is how
  //     analog mastering chains hit "saturation character without crunch"
  //   shaper: the actual waveshaper with 4x oversampling
  //   postLP: 18kHz lowpass tames any HF aliasing from the WaveShaper above Nyquist/4
  const dcBlock=ctx.createBiquadFilter(); dcBlock.type='highpass'; dcBlock.frequency.value=5; dcBlock.Q.value=0.5;
  const preSat=ctx.createGain(); preSat.gain.value=1;
  const shaper=ctx.createWaveShaper(); shaper.curve=IDENTITY_CURVE; shaper.oversample='4x';
  const postLP=ctx.createBiquadFilter(); postLP.type='lowpass'; postLP.frequency.value=22000; postLP.Q.value=0.5;
  const outGain=ctx.createGain();

  /* ===== REFERENCE MATCH EQ — 8 peaking bands, flat by default ===== */
  const matchBands=MATCH_FREQS.map(f=>{const b=ctx.createBiquadFilter();b.type='peaking';b.frequency.value=f;b.Q.value=1.0;b.gain.value=0;return b;});
  for(let i=0;i<matchBands.length-1;i++)matchBands[i].connect(matchBands[i+1]);
  const matchIn=matchBands[0], matchOut=matchBands[matchBands.length-1];

  /* ===== 3-BAND MULTIBAND COMPRESSOR — LR4 crossovers + parallel mix =====
     LR4 (two cascaded Butterworth biquads, Q=0.7071) sums flat in-phase. */
  const XLOW=140, XHIGH=3200;
  const lr=(type,f)=>{const a=ctx.createBiquadFilter();a.type=type;a.frequency.value=f;a.Q.value=0.7071;
    const b=ctx.createBiquadFilter();b.type=type;b.frequency.value=f;b.Q.value=0.7071;a.connect(b);return{in:a,out:b,a,b};};
  const mbIn=ctx.createGain();
  const loLP=lr('lowpass',XLOW);
  const midHP=lr('highpass',XLOW), midLP=lr('lowpass',XHIGH);
  const hiHP=lr('highpass',XHIGH);
  const compLo=ctx.createDynamicsCompressor(), compMid=ctx.createDynamicsCompressor(), compHi=ctx.createDynamicsCompressor();
  [compLo,compMid,compHi].forEach(c=>{c.threshold.value=0;c.ratio.value=1;c.knee.value=6;c.attack.value=0.01;c.release.value=0.25;});
  const mbWet=ctx.createGain(); mbWet.gain.value=0;
  const mbDry=ctx.createGain(); mbDry.gain.value=1;
  const mbOut=ctx.createGain();
  mbIn.connect(loLP.in); loLP.out.connect(compLo); compLo.connect(mbWet);
  mbIn.connect(midHP.in); midHP.out.connect(midLP.in); midLP.out.connect(compMid); compMid.connect(mbWet);
  mbIn.connect(hiHP.in); hiHP.out.connect(compHi); compHi.connect(mbWet);
  mbIn.connect(mbDry);
  mbWet.connect(mbOut); mbDry.connect(mbOut);

  /* ===== PER-BAND STEREO WIDTH — side channel split at 250Hz / 4kHz ===== */
  const swLoLP=lr('lowpass',250);
  const swMidHP=lr('highpass',250), swMidLP=lr('lowpass',4000);
  const swHiHP=lr('highpass',4000);
  const gWLow=ctx.createGain(), gWMid=ctx.createGain(), gWHigh=ctx.createGain();
  const swSum=ctx.createGain();
  // (wired below: bassHP → [3-band] → swSum → sideWidth)

  /* ===== ANALOG CHARACTER — tape wow/flutter, head bump, hiss, vinyl ===== */
  const charIn=ctx.createGain();
  const tapeDelay=ctx.createDelay(0.05); tapeDelay.delayTime.value=0.006; // fixed 6ms; modulation = character
  const wowLFO=ctx.createOscillator(); wowLFO.type='sine'; wowLFO.frequency.value=0.4;
  const wowDepth=ctx.createGain(); wowDepth.gain.value=0;
  const flutLFO=ctx.createOscillator(); flutLFO.type='sine'; flutLFO.frequency.value=6.7;
  const flutDepth=ctx.createGain(); flutDepth.gain.value=0;
  wowLFO.connect(wowDepth); wowDepth.connect(tapeDelay.delayTime);
  flutLFO.connect(flutDepth); flutDepth.connect(tapeDelay.delayTime);
  try{wowLFO.start();flutLFO.start();}catch(e){}
  const headBump=ctx.createBiquadFilter(); headBump.type='peaking'; headBump.frequency.value=60; headBump.Q.value=0.9; headBump.gain.value=0;
  const vinylLP=ctx.createBiquadFilter(); vinylLP.type='lowpass'; vinylLP.frequency.value=22000; vinylLP.Q.value=0.5;
  const charOut=ctx.createGain();
  // noise beds (hiss / crackle / rumble) — silent until gains raised
  const noiseLen=Math.max(1,Math.floor(ctx.sampleRate*2));
  const mkNoiseSrc=fill=>{const nb=ctx.createBuffer(1,noiseLen,ctx.sampleRate);fill(nb.getChannelData(0));
    const s=ctx.createBufferSource();s.buffer=nb;s.loop=true;try{s.start();}catch(e){}return s;};
  const hissSrc=mkNoiseSrc(d=>{for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*0.6;});
  const hissHS=ctx.createBiquadFilter(); hissHS.type='highpass'; hissHS.frequency.value=2500; hissHS.Q.value=0.5;
  const hissGain=ctx.createGain(); hissGain.gain.value=0;
  hissSrc.connect(hissHS); hissHS.connect(hissGain); hissGain.connect(charOut);
  const crackleSrc=mkNoiseSrc(d=>{d.fill(0);for(let i=0;i<d.length;i++){if(Math.random()<0.0004)d[i]=(Math.random()*2-1)*(0.3+Math.random()*0.7);}});
  const crackleBP=ctx.createBiquadFilter(); crackleBP.type='bandpass'; crackleBP.frequency.value=3200; crackleBP.Q.value=0.6;
  const crackleGain=ctx.createGain(); crackleGain.gain.value=0;
  crackleSrc.connect(crackleBP); crackleBP.connect(crackleGain); crackleGain.connect(charOut);
  const rumbleSrc=mkNoiseSrc(d=>{let y=0;for(let i=0;i<d.length;i++){y=y*0.995+(Math.random()*2-1)*0.05;d[i]=y*3;}});
  const rumbleLP=ctx.createBiquadFilter(); rumbleLP.type='lowpass'; rumbleLP.frequency.value=45; rumbleLP.Q.value=0.5;
  const rumbleGain=ctx.createGain(); rumbleGain.gain.value=0;
  rumbleSrc.connect(rumbleLP); rumbleLP.connect(rumbleGain); rumbleGain.connect(charOut);

  /* ===== DEPTH ENGINE — early-reflection bloom (dimension without reverb mud) ===== */
  const erD1=ctx.createDelay(0.2), erD2=ctx.createDelay(0.2);
  const erLP1=ctx.createBiquadFilter(); erLP1.type='lowpass'; erLP1.frequency.value=5200; erLP1.Q.value=0.5;
  const erLP2=ctx.createBiquadFilter(); erLP2.type='lowpass'; erLP2.frequency.value=4200; erLP2.Q.value=0.5;
  const erG1=ctx.createGain(); erG1.gain.value=0;
  const erG2=ctx.createGain(); erG2.gain.value=0;
  const depthOut=ctx.createGain();

  inGain.connect(matchIn); matchOut.connect(sub);
  sub.connect(low); low.connect(body); body.connect(harsh); harsh.connect(pres);
  pres.connect(high); high.connect(tiltLo); tiltLo.connect(tiltHi);
  tiltHi.connect(mbIn); mbOut.connect(splitter);
  splitter.connect(gMidL,0); splitter.connect(gMidR,1); gMidL.connect(midSum); gMidR.connect(midSum); midSum.connect(midGain);
  splitter.connect(gSideL,0); splitter.connect(gSideR,1); gSideL.connect(sideSum); gSideR.connect(sideSum);
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
  Lfinal.connect(merger,0,0); Rfinal.connect(merger,0,1);
  merger.connect(charIn);
  charIn.connect(tapeDelay); tapeDelay.connect(headBump); headBump.connect(vinylLP); vinylLP.connect(charOut);
  charOut.connect(depthOut);
  charOut.connect(erD1); erD1.connect(erLP1); erLP1.connect(erG1); erG1.connect(depthOut);
  charOut.connect(erD2); erD2.connect(erLP2); erLP2.connect(erG2); erG2.connect(depthOut);
  depthOut.connect(dcBlock); dcBlock.connect(preSat); preSat.connect(shaper); shaper.connect(postLP); postLP.connect(outGain);

  return {inGain,sub,low,body,harsh,pres,high,tiltLo,tiltHi,midGain,sideWidth,bassHP,sideDirect,sideAPgain,haasL,haasR,cfGLR,cfGRL,preSat,shaper,postLP,outGain,
    matchBands, mbWet,mbDry,compLo,compMid,compHi, gWLow,gWMid,gWHigh,
    tapeDelay,wowDepth,flutDepth,headBump,vinylLP,hissGain,crackleGain,rumbleGain,
    erD1,erD2,erG1,erG2, _sat:-1};
}
/* push current params onto a chain (live or offline). bypass = audition Original. */
function setChainParams(N,bypass){
  N.inGain.gain.value=dbToGain(bypass?0:P.drive);
  N.sub.gain.value  =bypass?0:P.sub;
  N.low.gain.value  =bypass?0:P.warm;
  N.body.gain.value =bypass?0:P.body;
  N.harsh.gain.value=bypass?0:P.harsh;
  N.pres.gain.value =bypass?0:P.clarity;
  N.high.gain.value =bypass?0:(P.air+(P.binaural?P.spread*1.5:0));
  N.tiltLo.gain.value=bypass?0:-P.tilt;
  N.tiltHi.gain.value=bypass?0: P.tilt;
  const satAmt=bypass?0:P.sat/100;
  if(N._sat!==satAmt){ N.shaper.curve=makeSatCurve(satAmt); N._sat=satAmt; }
  /* Analog-style gain staging: back off into the shaper proportional to sat,
     compensate at outGain. This is THE difference between studio saturation
     (warm density) and amateur saturation (clipping crunch). */
  const preBackoff = 1 - satAmt*0.35;       // up to 3.1 dB pad into shaper at sat=100%
  const postMakeup = 1 + satAmt*0.25;       // partial makeup (peaks already curtailed by tanh)
  N.preSat.gain.value = bypass?1:preBackoff;
  /* Tighten the post-saturation lowpass progressively to suppress aliasing artifacts
     that the WaveShaper's internal oversampler can't fully reject at high drive. */
  N.postLP.frequency.value = bypass?22000:(22000 - satAmt*4500);  // 22k → 17.5k at full sat
  const width=bypass?1:P.width*(1+P.spread*0.6);
  const bal=bypass?0:P.ms;
  N.midGain.gain.value=bal<0?1:1-bal*0.6;
  N.sideWidth.gain.value=width*(bal>0?1:1+bal*0.6);
  const bass=bypass?0:P.bassMono;
  N.bassHP.frequency.value=bass>0?bass:8;
  const pr=bypass?0:P.phaseRot;
  N.sideDirect.gain.value=1-pr;
  N.sideAPgain.gain.value=pr;
  const haas=bypass?0:P.haas/1000, hs=P.haasSide;
  N.haasR.delayTime.value=hs>=0?haas:0;
  N.haasL.delayTime.value=hs<0 ?haas:0;
  const cf=bypass?0:(P.binaural?Math.max(P.crossfeed,0.35):P.crossfeed);
  N.cfGLR.gain.value=cf*0.45; N.cfGRL.gain.value=cf*0.45;
  N.outGain.gain.value=bypass?1:postMakeup;
  N._makeup=bypass?1:postMakeup;   // remembered so the live path can compose with it

  /* ===== match EQ ===== */
  const mStr=bypass?0:P.matchStrength/100;
  N.matchBands.forEach((b,i)=>{ b.gain.value=(P.matchGains[i]||0)*mStr; });

  /* ===== multiband compressor ===== */
  const speeds={fast:[0.003,0.10], med:[0.010,0.25], slow:[0.030,0.40]};
  const [atk,rel]=speeds[P.mbSpeed]||speeds.med;
  const setComp=(c,amt)=>{ // amount 0-100 → transparent..deep
    c.threshold.value = -amt*0.36;          // 0 → 0dB (no action), 100 → -36dB
    c.ratio.value     = 1 + amt*0.04;       // 1..5
    c.knee.value      = 9;
    c.attack.value    = atk;
    c.release.value   = rel;
  };
  setComp(N.compLo, bypass?0:P.mbLow);
  setComp(N.compMid,bypass?0:P.mbMid);
  setComp(N.compHi, bypass?0:P.mbHigh);
  const anyMB=!bypass && (P.mbLow>0||P.mbMid>0||P.mbHigh>0);
  const mix=anyMB ? P.mbMix/100 : 0;
  N.mbWet.gain.value=mix;
  N.mbDry.gain.value=1-mix;

  /* ===== per-band stereo width (applied within the side chain, pre master width) ===== */
  N.gWLow.gain.value = bypass?1:P.widthLow;
  N.gWMid.gain.value = bypass?1:P.widthMid;
  N.gWHigh.gain.value= bypass?1:P.widthHigh;

  /* ===== analog character ===== */
  const tp=bypass?0:P.tape/100;
  N.wowDepth.gain.value  = tp*0.0012;       // ±1.2ms wow at full
  N.flutDepth.gain.value = tp*0.00018;      // ±0.18ms flutter at full
  N.headBump.gain.value  = tp*3.5;          // up to +3.5dB @60Hz
  const vn=bypass?0:P.vinyl/100;
  N.vinylLP.frequency.value = 22000 - vn*7000;   // roll to 15k at full vinyl
  N.crackleGain.gain.value  = vn*0.12;
  N.rumbleGain.gain.value   = vn*0.05;
  N.hissGain.gain.value     = (bypass?0:P.hiss/100)*0.02;

  /* ===== depth engine ===== */
  const dp=bypass?0:P.depth/100;
  const sizes={small:[0.011,0.019], med:[0.017,0.029], large:[0.027,0.047]};
  const [t1,t2]=sizes[P.depthSize]||sizes.med;
  N.erD1.delayTime.value=t1; N.erD2.delayTime.value=t2;
  N.erG1.gain.value=dp*0.28; N.erG2.gain.value=dp*0.22;
}

/* ---------- build the live processing graph ---------- */
function buildGraph(){
  if(!AC) AC=createAudioContext();
  const ctx=AC;
  const chain=buildChain(ctx);
  const lim=ctx.createDynamicsCompressor();
  lim.threshold.value=-1; lim.knee.value=0; lim.ratio.value=20; lim.attack.value=0.002; lim.release.value=0.12;
  const post=ctx.createGain();
  const monitor=ctx.createGain();
  chain.outGain.connect(lim); lim.connect(post); post.connect(monitor); monitor.connect(ctx.destination);
  // analysers
  const anaPost=ctx.createAnalyser(); anaPost.fftSize=4096; anaPost.smoothingTimeConstant=0.78;
  const splitPost=ctx.createChannelSplitter(2);
  const anaL=ctx.createAnalyser(); anaL.fftSize=2048; const anaR=ctx.createAnalyser(); anaR.fftSize=2048;
  const kHigh=ctx.createBiquadFilter(); kHigh.type='highshelf'; kHigh.frequency.value=1500; kHigh.gain.value=4;
  const kHP=ctx.createBiquadFilter(); kHP.type='highpass'; kHP.frequency.value=38; kHP.Q.value=0.5;
  const anaK=ctx.createAnalyser(); anaK.fftSize=8192; anaK.smoothingTimeConstant=0;
  post.connect(anaPost);
  post.connect(splitPost); splitPost.connect(anaL,0); splitPost.connect(anaR,1);
  post.connect(kHigh); kHigh.connect(kHP); kHP.connect(anaK);

  nodes=Object.assign({},chain,{lim,post,monitor,anaPost,anaL,anaR,anaK});
  applyParamsToGraph();
}
function applyParamsToGraph(){
  if(!nodes.inGain)return;
  const bypass = abMode==='A';   // original = neutral params (M/S identity)
  setChainParams(nodes,bypass);
  nodes.lim.threshold.value=bypass?0:P.ceiling-0.2;
  // loudness match trim
  let trim=1;
  if(matchLoud && analysis.orig && analysis.proc){
    const ref=analysis.proc.lufs;
    const cur=abMode==='A'?analysis.orig.lufs:analysis.proc.lufs;
    if(isFinite(ref)&&isFinite(cur)) trim=dbToGain(ref-cur);
  }
  // normalize gain (preview only; export applies the real normalization + limiter)
  let normG=1;
  if(P.normalize && !bypass && analysis.proc && isFinite(analysis.proc.lufs)){
    normG=dbToGain(P.targetLUFS-analysis.proc.lufs);
  }
  /* setChainParams() parks the saturation make-up gain on outGain. Overwriting
     it here (as this line used to) silently dropped up to 2 dB of make-up from
     the preview only, so what you auditioned was quieter than what you
     exported. Multiply instead of replace. */
  nodes.outGain.gain.value=nodes._makeup*trim*normG;
}

/* ============ AUDIO CONTEXT FACTORY (Safari/webkit compat) ============ */
function createAudioContext(){
  try{ return new (window.AudioContext||window.webkitAudioContext)(); }
  catch(e){ console.error('AudioContext failed:',e); throw e; }
}
function createOfflineAudioContext(ch,len,sr){
  try{ return new (window.OfflineAudioContext||window.webkitOfflineAudioContext)(ch,len,sr); }
  catch(e){ console.error('OfflineAudioContext failed:',e); throw e; }
}
async function loadArrayBuffer(ab,label){
  if(!AC){ try{AC=createAudioContext();}catch(e){toast('Web Audio not supported on this browser. Try Chrome/Firefox/Safari 14+.');return;} }
  if(AC.state==='suspended'){ try{await AC.resume();}catch(e){console.warn('AudioContext resume:', e);} }
  if(!nodes.inGain){ try{buildGraph();}catch(e){toast('Audio graph failed: '+e.message);console.error(e);return;} }
  let buf;
  try{ buf=await AC.decodeAudioData(ab.slice(0)); }
  catch(e){ toast("Couldn't decode "+label+" — try WAV, MP3, or FLAC (format support varies by browser)"); console.warn('decode error:',e); return; }
  srcBuffer=buf; baseSR=buf.sampleRate; fileLabel=label;
  stopPlayback(); wavePeaks=null;
  $('#transportEmpty').style.display='none';
  $('#transportFull').style.display='flex';
  $('#waveCard').style.display='block';
  $('#scopesRow').style.display='grid';
  $('#metersRow').style.display='grid';
  $('#analyzeHint').style.display='block';
  $('#fileName').textContent=`${label}  ·  ${buf.numberOfChannels}ch · ${(baseSR/1000).toFixed(1)}kHz · ${fmtTime(buf.duration)}`;
  drawWaveOverview();
  toast('Loaded — analyzing loudness…');
  scheduleAnalyze(true);
}
async function handleFiles(file){
  if(!file){toast('No file received');return;}
  try{ const ab=await file.arrayBuffer(); await loadArrayBuffer(ab,file.name); }
  catch(e){ toast('Import failed: '+e.message); console.error(e); }
}

/* ============ PLAYBACK ============ */
function startPlayback(at=null){
  if(!srcBuffer)return;
  if(AC.state==='suspended')AC.resume();
  stopSource();
  srcNode=AC.createBufferSource(); srcNode.buffer=srcBuffer;
  srcNode.connect(nodes.inGain);
  const pos=at!=null?at:offsetAt;
  startedAt=AC.currentTime - pos; 
  srcNode.start(0,clamp(pos,0,srcBuffer.duration));
  srcNode.onended=()=>{ if(playing){ playing=false; offsetAt=0; $('#playBtn').textContent='▶'; }};
  playing=true; $('#playBtn').textContent='❚❚';
}
function stopSource(){ if(srcNode){try{srcNode.onended=null;srcNode.stop()}catch(e){} srcNode.disconnect(); srcNode=null;} }
function pausePlayback(){ if(!playing)return; offsetAt=currentPos(); stopSource(); playing=false; $('#playBtn').textContent='▶'; }
function stopPlayback(){ stopSource(); playing=false; offsetAt=0; $('#playBtn').textContent='▶'; }
function currentPos(){ return playing?clamp(AC.currentTime-startedAt,0,srcBuffer?srcBuffer.duration:0):offsetAt; }
function togglePlay(){ if(!srcBuffer)return; playing?pausePlayback():startPlayback(); }

/* ============ WAVEFORM OVERVIEW ============ */
let wavePeaks=null;
function computePeaks(buf,buckets){
  const ch=buf.numberOfChannels, len=buf.length, step=Math.floor(len/buckets)||1;
  const data=[]; for(let c=0;c<ch;c++)data.push(buf.getChannelData(c));
  const peaks=new Float32Array(buckets);
  for(let b=0;b<buckets;b++){
    let mx=0; const s=b*step, e=Math.min(len,s+step);
    for(let i=s;i<e;i++){ let v=0; for(let c=0;c<ch;c++)v=Math.max(v,Math.abs(data[c][i])); if(v>mx)mx=v; }
    peaks[b]=mx;
  }
  return peaks;
}
function drawWaveOverview(){
  const cv=$('#wave'); const dpr=devicePixelRatio||1;
  const w=cv.clientWidth, h=120; cv.width=w*dpr; cv.height=h*dpr;
  const g=cv.getContext('2d'); g.scale(dpr,dpr); g.clearRect(0,0,w,h);
  if(!srcBuffer)return;
  if(!wavePeaks||wavePeaks._w!==w){ wavePeaks=computePeaks(srcBuffer,w); wavePeaks._w=w; }
  const css=getComputedStyle(document.documentElement);
  const mid=h/2;
  g.strokeStyle=css.getPropertyValue('--grid'); g.beginPath(); g.moveTo(0,mid); g.lineTo(w,mid); g.stroke();
  const col=abMode==='A'?css.getPropertyValue('--orig'):css.getPropertyValue('--proc');
  g.fillStyle=col;
  for(let x=0;x<w;x++){ const p=wavePeaks[x]||0; const ph=p*(h*0.46); g.fillRect(x,mid-ph,1,ph*2); }
  // loop region
  if(loopRegion){ g.fillStyle='color-mix(in srgb,'+col+' 18%,transparent)';
    const a=loopRegion[0]/srcBuffer.duration*w, b=loopRegion[1]/srcBuffer.duration*w;
    g.fillStyle=col.trim()+'22'; g.fillRect(Math.min(a,b),0,Math.abs(b-a),h); }
  // playhead
  const px=currentPos()/srcBuffer.duration*w;
  g.strokeStyle=css.getPropertyValue('--text'); g.globalAlpha=.8; g.beginPath(); g.moveTo(px,0); g.lineTo(px,h); g.stroke(); g.globalAlpha=1;
}
let loopRegion=null, dragStart=null;
$('#wave').addEventListener('mousedown',e=>{ if(!srcBuffer)return; const r=e.currentTarget.getBoundingClientRect(); dragStart=(e.clientX-r.left)/r.width*srcBuffer.duration; });
$('#wave').addEventListener('mousemove',e=>{ if(dragStart==null||!srcBuffer)return; const r=e.currentTarget.getBoundingClientRect(); const t=(e.clientX-r.left)/r.width*srcBuffer.duration; if(Math.abs(t-dragStart)>0.15)loopRegion=[dragStart,t]; });
window.addEventListener('mouseup',e=>{ if(dragStart==null)return; const cv=$('#wave'); const r=cv.getBoundingClientRect();
  const t=clamp((e.clientX-r.left)/r.width,0,1)*srcBuffer.duration;
  if(loopRegion&&Math.abs(loopRegion[1]-loopRegion[0])>0.15){loopRegion=[Math.min(...loopRegion),Math.max(...loopRegion)];}
  else { loopRegion=null; offsetAt=t; if(playing)startPlayback(t); }
  dragStart=null; });

/* ============ METERS / SCOPES ============ */
const TAU=Math.PI*2;
const energyMom=[], energyST=[];  // ring of {t, msL, msR}
function loop(){
  requestAnimationFrame(loop);
  if(!nodes.anaPost)return;
  drawSpectrum(); drawGonio(); drawWaveOverview(); updateMeters(); updateTime();
  if(IM.layout!=='off') drawSpeakerMap();
}
function updateTime(){ if(!srcBuffer)return; $('#timeLabel').textContent=fmtTime(currentPos())+' / '+fmtTime(srcBuffer.duration);
  if(playing&&loopRegion&&currentPos()>=loopRegion[1])startPlayback(loopRegion[0]); }

function drawSpectrum(){
  const cv=$('#spectrum'),dpr=devicePixelRatio||1,w=cv.clientWidth,h=190;
  if(cv.width!==w*dpr){cv.width=w*dpr;cv.height=h*dpr;}
  const g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);
  const css=getComputedStyle(document.documentElement);
  g.strokeStyle=css.getPropertyValue('--grid');g.lineWidth=1;
  [0.25,0.5,0.75].forEach(f=>{g.beginPath();g.moveTo(0,h*f);g.lineTo(w,h*f);g.stroke();});
  const a=nodes.anaPost,N=a.frequencyBinCount,fd=new Uint8Array(N);a.getByteFrequencyData(fd);
  const nyq=AC.sampleRate/2, fmin=20, fmax=Math.min(nyq,22000);
  const col=abMode==='A'?css.getPropertyValue('--orig'):css.getPropertyValue('--proc');
  g.beginPath();
  const lx=Math.log10(fmin),rx=Math.log10(fmax);
  for(let x=0;x<=w;x++){
    const fr=Math.pow(10,lx+(rx-lx)*x/w); const bin=Math.round(fr/nyq*N);
    const v=(fd[clamp(bin,0,N-1)]||0)/255; const y=h-v*h*0.96;
    x===0?g.moveTo(x,y):g.lineTo(x,y);
  }
  g.lineTo(w,h);g.lineTo(0,h);g.closePath();
  const grad=g.createLinearGradient(0,0,0,h); grad.addColorStop(0,col.trim()+'cc');grad.addColorStop(1,col.trim()+'10');
  g.fillStyle=grad;g.fill(); g.strokeStyle=col;g.lineWidth=1.4;
  g.beginPath();
  for(let x=0;x<=w;x++){const fr=Math.pow(10,lx+(rx-lx)*x/w);const bin=Math.round(fr/nyq*N);const v=(fd[clamp(bin,0,N-1)]||0)/255;const y=h-v*h*0.96;x===0?g.moveTo(x,y):g.lineTo(x,y);}
  g.stroke();
  // freq labels
  g.fillStyle=css.getPropertyValue('--faint');g.font='9px ui-monospace';
  [100,1000,10000].forEach(f=>{const x=(Math.log10(f)-lx)/(rx-lx)*w;g.fillText(f>=1000?(f/1000)+'k':f,x+2,h-4);});
}

function drawGonio(){
  const cv=$('#gonio'),dpr=devicePixelRatio||1,w=cv.clientWidth,h=190;
  if(cv.width!==w*dpr){cv.width=w*dpr;cv.height=h*dpr;}
  const g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);
  g.fillStyle='rgba(6,8,10,.34)';g.fillRect(0,0,w,h);
  const css=getComputedStyle(document.documentElement);
  const cx=w/2,cy=h/2,R=Math.min(w,h)*0.42;
  g.strokeStyle=css.getPropertyValue('--grid');g.lineWidth=1;
  g.beginPath();g.arc(cx,cy,R,0,TAU);g.moveTo(cx-R,cy);g.lineTo(cx+R,cy);g.moveTo(cx,cy-R);g.lineTo(cx,cy+R);g.stroke();
  g.save();g.translate(cx,cy);g.rotate(-Math.PI/4);
  g.strokeStyle=css.getPropertyValue('--line2');g.beginPath();g.moveTo(-R,0);g.lineTo(R,0);g.moveTo(0,-R);g.lineTo(0,R);g.stroke();g.restore();
  const dL=new Float32Array(nodes.anaL.fftSize),dR=new Float32Array(nodes.anaR.fftSize);
  nodes.anaL.getFloatTimeDomainData(dL);nodes.anaR.getFloatTimeDomainData(dR);
  const col=abMode==='A'?css.getPropertyValue('--orig'):css.getPropertyValue('--proc');
  g.fillStyle=col.trim()+'aa';
  const step=4;
  for(let i=0;i<dL.length;i+=step){
    const m=(dL[i]+dR[i])*0.5, s=(dL[i]-dR[i])*0.5;   // mid up, side right
    const x=cx+s*R*1.4, y=cy-m*R*1.4;
    g.fillRect(x,y,1.4,1.4);
  }
}

function updateMeters(){
  const dK=new Float32Array(nodes.anaK.fftSize); nodes.anaK.getFloatTimeDomainData(dK);
  // mean square of K-weighted post signal (mono sum approximated post-stereo)
  let ms=0; for(let i=0;i<dK.length;i++)ms+=dK[i]*dK[i]; ms/=dK.length;
  energyMom.push(ms); if(energyMom.length>10)energyMom.shift();      // ~ momentary (400ms@~40ms frames)
  energyST.push(ms); if(energyST.length>75)energyST.shift();         // ~ short-term (3s)
  const avg=arr=>arr.reduce((a,b)=>a+b,0)/Math.max(1,arr.length);
  const mom=-0.691+10*Math.log10(Math.max(1e-12,avg(energyMom)));
  const st =-0.691+10*Math.log10(Math.max(1e-12,avg(energyST)));
  $('#mMom').textContent=isFinite(mom)?mom.toFixed(1):'—';
  $('#mST').textContent =isFinite(st)?st.toFixed(1):'—';
  setBar('#barST', (st+40)/40);
  // true peak (per channel, 4x cubic oversample on current frame)
  const dL=new Float32Array(nodes.anaL.fftSize),dR=new Float32Array(nodes.anaR.fftSize);
  nodes.anaL.getFloatTimeDomainData(dL);nodes.anaR.getFloatTimeDomainData(dR);
  const tp=Math.max(truePeakBlock(dL),truePeakBlock(dR));
  const tpdb=gainToDb(tp);
  $('#mTP').textContent=isFinite(tpdb)?(tpdb>0?'+':'')+tpdb.toFixed(1):'—';
  $('#mTP').style.color=tpdb>P.ceiling?'var(--hot)':'var(--text)';
  setBar('#barTP',(tpdb+12)/12);
  // correlation
  let sLR=0,sLL=0,sRR=0; for(let i=0;i<dL.length;i++){sLR+=dL[i]*dR[i];sLL+=dL[i]*dL[i];sRR+=dR[i]*dR[i];}
  const corr=sLR/Math.max(1e-9,Math.sqrt(sLL*sRR));
  $('#mCorr').textContent=isFinite(corr)?corr.toFixed(2):'—';
  $('#mCorr').style.color=corr<0?'var(--hot)':corr<0.3?'var(--proc)':'var(--text)';
  $('#mCorrTxt').textContent=corr<0?'⚠ phase risk':corr>0.85?'near mono':'wide';
  setBar('#barCorr',(corr+1)/2);
  // rms
  let rms=0;for(let i=0;i<dL.length;i++)rms+=(dL[i]*dL[i]+dR[i]*dR[i])*0.5; rms=Math.sqrt(rms/dL.length);
  $('#mRMS').textContent=isFinite(gainToDb(rms))?gainToDb(rms).toFixed(0):'—';
}
/* True-peak metering now uses the BS.1770-4 polyphase filter (src/dsp/true-peak.js)
   instead of the cubic estimator that used to live here, which under-read by
   over a dB at frequencies where sampling is degenerate. */
const truePeakBlock = truePeakChannel;
function setBar(sel,frac){const i=$(sel);if(i)i.style.width=clamp(frac*100,0,100)+'%';}

/* ============ OFFLINE: integrated LUFS + LRA (BS.1770 gated) ============ */
/** Longest span the interactive analyser will render, in seconds. */
const ANALYSIS_WINDOW_S=90;

/**
 * Render srcBuffer through the mastering chain offline.
 * @param {number} targetSR 0 to keep the source rate
 * @param {boolean} withProcessing
 * @param {number} [maxSeconds] cap the render length (used by the analyser)
 */
async function renderOffline(targetSR,withProcessing,maxSeconds){
  const sr=targetSR||srcBuffer.sampleRate;
  const dur=maxSeconds?Math.min(srcBuffer.duration,maxSeconds):srcBuffer.duration;
  const oac=createOfflineAudioContext(2,Math.max(1,Math.ceil(dur*sr)),sr);
  const src=oac.createBufferSource(); src.buffer=srcBuffer;
  if(!withProcessing){ src.connect(oac.destination); src.start(); return await oac.startRendering(); }
  const chain=buildChain(oac);
  setChainParams(chain,false);
  src.connect(chain.inGain);
  chain.outGain.connect(oac.destination);
  src.start();
  return await oac.startRendering();
}
/* Integrated loudness / LRA are provided by src/dsp/loudness.js, which is
   verified against the EBU Tech 3341 and 3342 compliance signals. */

let analyzeTimer=null, analyzing=false;
function scheduleAnalyze(immediate){
  clearTimeout(analyzeTimer);
  analyzeTimer=setTimeout(runAnalyze, immediate?60:480);
}
async function runAnalyze(){
  if(!srcBuffer||analyzing)return; analyzing=true;
  try{
    /* Cap the interactive analysis window. This comment used to claim a 90 s
       cap that was never actually applied, so every parameter tweak re-rendered
       and re-measured the entire track — on an album-length file that is tens
       of seconds of blocked main thread per slider move. */
    const procBuf=await renderOffline(0,true,ANALYSIS_WINDOW_S);
    analysis.proc=measureLUFS(procBuf);
    analysis.orig=measureLUFS(analysisSourceView());
    analysis.proc.tp=truePeakDb(procBuf);
    updateAnalysisUI();
    applyParamsToGraph();
  }catch(e){ console.warn(e); }
  analyzing=false;
}
/**
 * A view of the source buffer limited to the analysis window, so the A and B
 * loudness figures are measured over the same span and are comparable.
 */
function analysisSourceView(){
  const maxLen=Math.min(srcBuffer.length, Math.ceil(srcBuffer.sampleRate*ANALYSIS_WINDOW_S));
  if(maxLen>=srcBuffer.length) return srcBuffer;
  const views=[];
  for(let c=0;c<srcBuffer.numberOfChannels;c++) views.push(srcBuffer.getChannelData(c).subarray(0,maxLen));
  return {
    sampleRate:srcBuffer.sampleRate,
    length:maxLen,
    numberOfChannels:srcBuffer.numberOfChannels,
    duration:maxLen/srcBuffer.sampleRate,
    getChannelData:i=>views[i],
  };
}
function updateAnalysisUI(){
  const css=getComputedStyle(document.documentElement);
  const a=abMode==='A'?analysis.orig:analysis.proc;
  if(a){ $('#mLUFS').textContent=isFinite(a.lufs)?a.lufs.toFixed(1):'—';
    $('#mLRA').textContent=isFinite(a.lra)?a.lra.toFixed(1):'—';
    setBar('#barLUFS',(a.lufs+40)/40); setBar('#barLRA',a.lra/20);
  }
  $('#mLUFSsub').textContent=P.normalize?('target '+P.targetLUFS.toFixed(1)):'no norm';
  /* Surface the rendered true peak next to the ceiling, so the headroom
     situation is visible before committing to an export. */
  const rtp=analysis.proc&&isFinite(analysis.proc.tp)?analysis.proc.tp:null;
  $('#mTPsub').textContent=rtp!==null
    ? 'render '+rtp.toFixed(1)+' · ceiling '+P.ceiling.toFixed(1)+' dBTP'
    : 'ceiling '+P.ceiling.toFixed(1)+' dBTP';
  $('#mLUFS').style.color=abMode==='A'?css.getPropertyValue('--orig'):css.getPropertyValue('--proc');
}

/* ============ EXPORT: offline render + look-ahead true-peak limiter + encode ============ */
/* Look-ahead true-peak limiting lives in src/dsp/true-peak.js. */
/* ===== REFERENCE MATCH EQ — spectral fingerprint comparison =====
   FFT both tracks (hann-windowed 8192 frames averaged across the file),
   measure energy at 8 log-spaced mastering bands, derive correction curve. */
function computeMatchEQ(){
  if(!srcBuffer){toast('Load your track first');return false;}
  if(!refBuffer){toast('Load a reference track first');return false;}
  const cur=spectrumFingerprint(srcBuffer), ref=spectrumFingerprint(refBuffer);
  if(!cur||!ref){toast('Analysis failed — tracks too short?');return false;}
  const curve=matchCurve(cur,ref);
  if(!curve){toast('Analysis failed');return false;}
  P.matchGains=curve;
  return true;
}

/* ===== TRANSIENT SHAPER — sample-accurate differential-envelope processor.
   Runs on the rendered buffer at export (needs per-sample control impossible
   with native Web Audio nodes in a sandboxed page). Channel-linked envelope
   prevents stereo image wander. ===== */
/* Transient shaping lives in src/dsp/transient.js. */

async function renderMaster(targetSR){
  const sr=targetSR||srcBuffer.sampleRate;
  const buf=await renderOffline(sr,true);
  // transient shaping BEFORE normalization so level compensation accounts for it
  if(P.transAttack||P.transSustain) transientShape(buf,P.transAttack,P.transSustain);
  // normalization to target LUFS (measure on rendered, apply gain)
  if(P.normalize){
    const m=measureLUFS(buf);
    if(isFinite(m.lufs)){ const g=dbToGain(P.targetLUFS-m.lufs);
      for(let c=0;c<buf.numberOfChannels;c++){const d=buf.getChannelData(c);for(let i=0;i<d.length;i++)d[i]*=g;} }
  }
  truePeakLimit(buf,P.ceiling);
  return buf;
}

/* ---------- encoders ---------- */
/* Encoders live in src/export/wav.js (RIFF/AIFF chunk layout, dither,
   symmetric quantisation). These wrappers just add the Blob container. */
function writeWAV(buf,bitDepth,mask){
  return new Blob([encodeWav(buf,bitDepth,{dither:ditherMode(),channelMask:mask})],{type:'audio/wav'});
}
function writeAIFF(buf){
  return new Blob([encodeAiff(buf,{dither:ditherMode()})],{type:'audio/aiff'});
}
function writeWAVMultiExt(buf,bitDepth,mask){ return writeWAV(buf,bitDepth,mask); }
/* Dither is user-selectable; default to TPDF at 16-bit and none above. */
function ditherMode(){ const el=$('#dither'); return el?el.value:undefined; }
function encodeMP3(buf){
  if(typeof lamejs==='undefined')throw new Error('MP3 encoder failed to load (offline?)');
  const ch=Math.min(2,buf.numberOfChannels),sr=buf.sampleRate;
  const enc=new lamejs.Mp3Encoder(ch,sr,320);
  const L=buf.getChannelData(0),R=ch>1?buf.getChannelData(1):L;
  const li=new Int16Array(L.length),ri=new Int16Array(L.length);
  for(let i=0;i<L.length;i++){li[i]=clamp(L[i],-1,1)*32767;ri[i]=clamp(R[i],-1,1)*32767;}
  const blk=1152,out=[];
  for(let i=0;i<li.length;i+=blk){const lc=li.subarray(i,i+blk),rc=ri.subarray(i,i+blk);
    const mp3=ch>1?enc.encodeBuffer(lc,rc):enc.encodeBuffer(lc);if(mp3.length)out.push(mp3);}
  const end=enc.flush();if(end.length)out.push(end);
  return new Blob(out,{type:'audio/mpeg'});
}
function download(blob,name){
  try{
    // Method 1: try blob URL (standard, works in most contexts)
    const url=URL.createObjectURL(blob);
    const a=$('#dlAnchor');
    a.href=url;
    a.download=name;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(url),2000);
    return;
  }catch(e1){
    // Method 2: if blob URL fails, try reading blob as array buffer and creating data URL
    try{
      const reader=new FileReader();
      reader.onload=()=>{
        const dataUrl=reader.result;
        const a=$('#dlAnchor');
        a.href=dataUrl;
        a.download=name;
        a.click();
      };
      reader.onerror=()=>{ toast('Download failed (read error) — try a smaller file'); console.error('read fail'); };
      reader.readAsDataURL(blob);
      return;
    }catch(e2){
      // Method 3: last resort — notify the user to save manually or use a different approach
      toast('Download not working in this browser — file is ready but couldn\'t auto-save. Try another device.');
      console.error('download methods exhausted:',e1,e2);
    }
  }
}
function baseName(){return (fileLabel||'master').replace(/\.[^.]+$/,'');}

async function doExport(){
  if(!srcBuffer)return;
  const fmt=$('#fmt').value, srSel=parseInt($('#srOut').value)||0;
  const prog=$('#exProg'); prog.classList.add('on'); prog.querySelector('i').style.width='10%';
  $('#exportBtn').disabled=true;
  try{
    await new Promise(r=>setTimeout(r,30));
    prog.querySelector('i').style.width='45%';
    const buf=await renderMaster(srSel);
    prog.querySelector('i').style.width='75%';
    let blob,ext;
    if(fmt==='wav16'){blob=writeWAV(buf,16);ext='wav';}
    else if(fmt==='wav24'){blob=writeWAV(buf,24);ext='wav';}
    else if(fmt==='wav32'){blob=writeWAV(buf,32);ext='wav';}
    else if(fmt==='aif24'){blob=writeAIFF(buf);ext='aif';}
    else if(fmt==='mp3'){blob=encodeMP3(buf);ext='mp3';}
    prog.querySelector('i').style.width='100%';
    download(blob,`${baseName()}_master_${(buf.sampleRate/1000)}k.${ext}`);
    toast('Exported '+ext.toUpperCase()+' · '+(buf.sampleRate/1000)+'kHz');
  }catch(e){ toast('Export failed: '+e.message); console.error(e); }
  $('#exportBtn').disabled=false; setTimeout(()=>prog.classList.remove('on'),600);
}

/* ============ BATCH ============ */
const batchFiles=[]; // {file, name, buf, lufs}
async function batchAddFiles(list){
  for(const f of list){
    try{ const ab=await f.arrayBuffer(); const buf=await AC.decodeAudioData(ab.slice(0));
      const item={file:f,name:f.name,buf,lufs:null}; batchFiles.push(item);
    }catch(e){ toast('Skipped '+f.name+' (decode)'); }
  }
  renderBatch(); analyzeBatch();
}
function renderBatch(){
  const c=$('#batchList'); c.innerHTML='';
  batchFiles.forEach((it,idx)=>{
    const r=document.createElement('div');r.className='brow';
    r.innerHTML=`<span class="nm">${it.name}</span><span class="lu">${it.lufs!=null?it.lufs.toFixed(1)+' LUFS':'…'}</span><span class="x">✕</span>`;
    r.querySelector('.x').onclick=()=>{batchFiles.splice(idx,1);renderBatch();};
    c.appendChild(r);
  });
  $('#batchRun').disabled=batchFiles.length===0;
}
async function analyzeBatch(){
  for(const it of batchFiles){ if(it.lufs==null){ it.lufs=measureLUFS(it.buf).lufs; renderBatch(); await new Promise(r=>setTimeout(r,5)); } }
}
async function batchRun(){
  if(!batchFiles.length)return;
  const fmt=$('#fmt').value, srSel=parseInt($('#srOut').value)||0;
  const prog=$('#batchProg'); prog.classList.add('on');
  $('#batchRun').disabled=true;
  const saved=srcBuffer;
  for(let i=0;i<batchFiles.length;i++){
    const it=batchFiles[i];
    srcBuffer=it.buf; wavePeaks=null;
    prog.querySelector('i').style.width=((i)/batchFiles.length*100)+'%';
    await new Promise(r=>setTimeout(r,20));
    try{
      const sr=srSel||it.buf.sampleRate;
      /* Use the same render path as a single export. The batch path used to
         inline its own copy that omitted transient shaping, so batching a
         preset with attack/sustain produced different audio than exporting the
         same track on its own. */
      const buf=await renderMaster(sr);
      let blob,ext;
      if(fmt==='wav16'){blob=writeWAV(buf,16);ext='wav';}
      else if(fmt==='wav24'){blob=writeWAV(buf,24);ext='wav';}
      else if(fmt==='wav32'){blob=writeWAV(buf,32);ext='wav';}
      else if(fmt==='aif24'){blob=writeAIFF(buf);ext='aif';}
      else{blob=encodeMP3(buf);ext='mp3';}
      const nm=it.name.replace(/\.[^.]+$/,'');
      download(blob,`${String(i+1).padStart(2,'0')}_${nm}_master.${ext}`);
      await new Promise(r=>setTimeout(r,400));
    }catch(e){ toast('Batch error on '+it.name); }
  }
  prog.querySelector('i').style.width='100%';
  srcBuffer=saved; wavePeaks=null;
  toast('Batch complete · '+batchFiles.length+' tracks @ '+P.targetLUFS+' LUFS');
  $('#batchRun').disabled=false; setTimeout(()=>prog.classList.remove('on'),800);
}

/* ============ PRESETS ============ */
const DIMENSION=[
  {n:'Analog Womb',d:'Tape-warmed multiband glue, head bump, enveloping depth. The expensive-console sound.',p:{targetLUFS:-14,ceiling:-1.0,tape:35,mbLow:30,mbMid:20,mbHigh:15,mbMix:60,warm:1.6,sub:1.2,depth:20,sat:8,width:1.05}},
  {n:'Crystal Palace',d:'Ultra-wide crystalline highs over anchored bass. Pristine, dimensional, hi-fi.',p:{targetLUFS:-13,ceiling:-1.0,widthHigh:1.6,widthLow:0.7,air:2.5,clarity:1.2,mbHigh:20,mbMix:70,depth:15,sat:3}},
  {n:'Fourth Dimension',d:'Full spatial engagement — depth bloom, binaural field, per-band imaging.',p:{targetLUFS:-14,ceiling:-1.0,depth:45,depthSize:'large',binaural:true,crossfeed:40,widthMid:1.3,widthHigh:1.5,spread:35,air:1.5,sat:4}},
  {n:'Tape Ghost',d:'Heavy wow/flutter, hiss bed, dark and haunted. Signal rot as mastering aesthetic.',p:{targetLUFS:-16,ceiling:-1.0,tape:70,hiss:25,tilt:-1.5,air:-1.5,mbMix:40,mbLow:25,sat:12,width:1.15}},
  {n:'Vinyl Séance',d:'Crackle, rumble, narrowed low end. A record that remembers being played.',p:{targetLUFS:-15,ceiling:-1.0,vinyl:45,warm:2,widthLow:0.5,bassMono:100,harsh:-1,sat:10,depth:12}},
  {n:'Hyperreal',d:'Multiband punch, transient attack, wide sparkle. More vivid than reality.',p:{targetLUFS:-11,ceiling:-1.0,transAttack:35,mbLow:35,mbMid:25,mbHigh:30,mbMix:70,widthHigh:1.4,clarity:1.5,air:2,sat:6}}
];
const GENRE=[
  {n:'Transparent',t:'flat',d:'No coloration. Just safe true-peak ceiling.',p:{}},
  {n:'Streaming -14',t:'loud',d:'Spotify/Apple target, gentle glue.',p:{targetLUFS:-14,ceiling:-1.0,drive:1.2,clarity:0.6,air:0.8,sat:4}},
  {n:'Club / EDM',t:'loud',d:'Loud, tight low end mono, bright top.',p:{targetLUFS:-9,ceiling:-0.5,drive:3,bassMono:120,air:1.8,clarity:1,width:1.1,sat:10}},
  {n:'Hip-Hop',t:'warm',d:'Thick lows, controlled width, present mids.',p:{targetLUFS:-10,ceiling:-0.5,drive:2.5,warm:1.6,bassMono:90,clarity:1.0,sat:8}},
  {n:'Ambient / Drone',t:'open',d:'Wide, airy, untouched dynamics.',p:{targetLUFS:-18,ceiling:-1.0,width:1.35,air:1.5,warm:0.8,normalize:true,sat:3}},
  {n:'Acoustic / Folk',t:'natural',d:'Light touch, natural stereo, no pump.',p:{targetLUFS:-16,ceiling:-1.0,drive:0.5,clarity:0.5,warm:0.5,sat:2}},
  {n:'Industrial',t:'harsh',d:'Aggressive, mid-forward, hard ceiling.',p:{targetLUFS:-9,ceiling:-0.5,drive:3,ms:-10,clarity:1.5,bassMono:140,sat:14}},
  {n:'Classical',t:'pure',d:'Preserve dynamics, only protect peaks.',p:{targetLUFS:-20,ceiling:-1.0,normalize:false,drive:0,sat:0}}
];
const SPATIAL=[
  {n:'Cathedral',d:'Natural tail bloom on the sides + air, no added reverb.',p:{targetLUFS:-15,ceiling:-1.0,width:1.3,ms:18,air:2.0,warm:0.6,bassMono:80,sat:3}},
  {n:'Binaural Deep',d:'3D headphone optimization — crossfeed + HRTF depth.',p:{targetLUFS:-14,ceiling:-1.0,binaural:true,crossfeed:55,spread:45,width:1.2,haas:4,air:1.0,sat:4}},
  {n:'Inverse Phase',d:'Creative side phase manipulation — surreal imaging.',p:{targetLUFS:-14,ceiling:-1.0,phaseRot:65,width:1.4,ms:25,sat:5}},
  {n:'Holographic',d:'Extreme mid/side separation, 3D soundstage.',p:{targetLUFS:-13,ceiling:-1.0,width:2.1,ms:40,bassMono:110,air:1.4,sat:5}},
  {n:'Tunnel Vision',d:'Focused mono center, atmospheric wide edges.',p:{targetLUFS:-14,ceiling:-1.0,ms:-30,width:1.6,bassMono:160,haas:8,air:0.8,sat:4}},
  {n:'Panoramic',d:'180°→360° widefield — Haas + decorrelated sides.',p:{targetLUFS:-13,ceiling:-1.0,width:2.4,haas:14,spread:70,crossfeed:20,bassMono:120,sat:5}}
];
const CINEMATIC=[
  {n:'Psychological Horror',d:'HD/Hollywood-grade: weighted lows, scooped mud, tamed harshness, extended ASMR air. Dynamics preserved for tension.',p:{targetLUFS:-16,ceiling:-1.0,drive:1,sub:3.0,warm:0.8,body:-2.0,harsh:-3.5,clarity:1.3,air:3.0,sat:8,width:1.25,bassMono:90}},
  {n:'Synthwave',d:'Neon and saturated — punchy sub, wide, bright analog top.',p:{targetLUFS:-11,ceiling:-1.0,drive:2,sub:1.8,warm:1.6,clarity:1.5,air:2.5,tilt:0.6,sat:18,width:1.3,bassMono:110}},
  {n:'Electronic Experimental',d:'Open and detailed, transient-preserving, minimal coloration.',p:{targetLUFS:-14,ceiling:-1.0,drive:1.0,clarity:0.8,air:1.6,sat:5,width:1.4,bassMono:80}},
  {n:'Sound Design / Foley',d:'Maximum detail and dynamics. Transparent, full-range, no loudness war.',p:{targetLUFS:-23,ceiling:-1.0,normalize:false,drive:0,clarity:1.5,air:1.5,width:1.1,sat:0}},
  {n:'Cinematic Trailer',d:'Huge and weighted — deep sub, scooped mud, wide and punchy.',p:{targetLUFS:-13,ceiling:-1.0,drive:2,sub:3.2,warm:0.8,body:-2.4,clarity:0.8,air:2.4,sat:7,width:1.4,bassMono:100}},
  {n:'Dark Ambient Score',d:'Deep, wide, subdued highs, heavy lows. Slow and dynamic.',p:{targetLUFS:-18,ceiling:-1.0,sub:3,warm:1.6,tilt:-2.5,air:-1.5,sat:5,width:1.5,bassMono:70}},
  {n:'Drone / Doom',d:'Dense and heavy — saturated low-mid weight, dark, narrowed for mass.',p:{targetLUFS:-15,ceiling:-1.0,drive:1.5,sub:2.4,body:1.6,tilt:-1.6,sat:14,width:0.9,bassMono:120}},
  {n:'Noise / Harsh Wall',d:'Saturated, dense, gritty top, loud and centered.',p:{targetLUFS:-11,ceiling:-0.5,drive:3,sat:22,harsh:1.8,tilt:0.8,clarity:0.8,width:1.0,bassMono:140}}
];
const MOOD=[
  {n:'Melancholic Sunset',d:'Warm low-mids, rolled-off air, nostalgic compression.',p:{targetLUFS:-15,ceiling:-1.0,drive:1.5,warm:2.0,body:2.4,harsh:-1.6,air:-3,tilt:-1.6,sat:10,width:1.1,bassMono:80}},
  {n:'Anxious Energy',d:'Tense mid-range, controlled harshness, dynamic instability.',p:{targetLUFS:-14,ceiling:-1.0,drive:1,body:1.6,harsh:1.6,clarity:1.8,tilt:0.8,sat:6,width:1.15,bassMono:90,normalize:false}},
  {n:'Euphoric Peak',d:'Bright, open, expansive, uplifting frequency curve.',p:{targetLUFS:-11,ceiling:-1.0,drive:1.5,sub:0.8,clarity:1.6,air:3.5,tilt:1.8,sat:6,width:1.5,spread:30,bassMono:100}},
  {n:'Dark Meditation',d:'Deep lows, subdued highs, centered focus.',p:{targetLUFS:-18,ceiling:-1.0,drive:0.3,sub:4,warm:1.6,air:-3,tilt:-2.4,ms:-25,width:0.85,bassMono:70,sat:3}},
  {n:'Manic Joy',d:'Saturated, bright, slightly chaotic harmonic enhancement.',p:{targetLUFS:-11,ceiling:-1.0,drive:2,clarity:1.6,air:2.4,tilt:1.4,sat:24,phaseRot:15,width:1.4,bassMono:110}},
  {n:'Empty Void',d:'Stark, minimal, spacious — uncomfortable silences preserved.',p:{targetLUFS:-20,ceiling:-1.0,normalize:false,drive:0,sub:0.8,air:0.8,tilt:-0.8,width:1.6,spread:40,sat:0}}
];
const COLOR=[
  {n:'Crimson',d:'Warm saturation, deep fundamental emphasis.',p:{targetLUFS:-13,ceiling:-1.0,drive:1.5,sub:4,warm:2.4,body:0.8,tilt:-0.8,sat:16,width:1.1,bassMono:100}},
  {n:'Cobalt',d:'Cool, clean, precise, slightly clinical.',p:{targetLUFS:-14,ceiling:-1.0,drive:0.8,clarity:1.6,air:1.6,harsh:-0.8,tilt:1.6,sat:0,width:1.1}},
  {n:'Gold',d:'Vintage warmth, harmonic richness, expensive sound.',p:{targetLUFS:-13,ceiling:-1.0,drive:1.5,warm:2.4,body:0.8,harsh:-1.6,air:1.6,tilt:-0.4,sat:14,width:1.2,bassMono:90}},
  {n:'Obsidian',d:'Dark, dense, mysterious low-mid emphasis.',p:{targetLUFS:-14,ceiling:-1.0,drive:1.5,sub:1.6,body:3.2,harsh:-0.8,air:-2.4,tilt:-2.4,sat:12,width:1.0,bassMono:100}},
  {n:'Pearl',d:'Shimmering highs, elegant, refined.',p:{targetLUFS:-14,ceiling:-1.0,drive:0.8,clarity:1.6,air:3.6,harsh:-1.6,tilt:1.6,sat:3,width:1.25,bassMono:70}},
  {n:'Rust',d:'Degraded, oxidized, beautifully broken.',p:{targetLUFS:-12,ceiling:-0.5,drive:2,body:1.6,harsh:1.6,air:-2.4,tilt:-0.8,sat:32,width:1.1,bassMono:120}}
];
function applyPreset(obj,name){
  // start from flat for spatial+genre consistency, keep loudness unless preset sets it
  const keepLoud={targetLUFS:P.targetLUFS,ceiling:P.ceiling,normalize:P.normalize};
  const keepMatch={matchGains:P.matchGains,matchStrength:P.matchStrength}; // match survives preset changes
  Object.assign(P,{width:1,ms:0,bassMono:0,haas:0,haasSide:1,crossfeed:0,phaseRot:0,binaural:false,spread:0,sub:0,warm:0,body:0,harsh:0,clarity:0,air:0,tilt:0,sat:0,drive:0,
    mbLow:0,mbMid:0,mbHigh:0,mbMix:100,mbSpeed:'med',
    widthLow:1,widthMid:1,widthHigh:1,
    tape:0,hiss:0,vinyl:0,depth:0,depthSize:'med',
    transAttack:0,transSustain:0},keepLoud,keepMatch);
  // normalize unit conversions: width% etc are stored as ratios where noted
  const q={...obj};
  if(q.width!=null)P.width=q.width;
  if(q.ms!=null)P.ms=q.ms/100;
  if(q.bassMono!=null)P.bassMono=q.bassMono;
  if(q.haas!=null)P.haas=q.haas;
  if(q.haasSide!=null)P.haasSide=q.haasSide;
  if(q.crossfeed!=null)P.crossfeed=q.crossfeed/100;
  if(q.phaseRot!=null)P.phaseRot=q.phaseRot/100;
  if(q.spread!=null)P.spread=q.spread/100;
  if(q.binaural!=null)P.binaural=q.binaural;
  if(q.drive!=null)P.drive=q.drive;
  if(q.sub!=null)P.sub=q.sub;
  if(q.warm!=null)P.warm=q.warm;
  if(q.body!=null)P.body=q.body;
  if(q.harsh!=null)P.harsh=q.harsh;
  if(q.clarity!=null)P.clarity=q.clarity;
  if(q.air!=null)P.air=q.air;
  if(q.tilt!=null)P.tilt=q.tilt;
  if(q.sat!=null)P.sat=q.sat;
  if(q.targetLUFS!=null)P.targetLUFS=q.targetLUFS;
  if(q.ceiling!=null)P.ceiling=q.ceiling;
  if(q.normalize!=null)P.normalize=q.normalize;
  // new engines
  if(q.mbLow!=null)P.mbLow=q.mbLow;
  if(q.mbMid!=null)P.mbMid=q.mbMid;
  if(q.mbHigh!=null)P.mbHigh=q.mbHigh;
  if(q.mbMix!=null)P.mbMix=q.mbMix;
  if(q.mbSpeed!=null)P.mbSpeed=q.mbSpeed;
  if(q.widthLow!=null)P.widthLow=q.widthLow;
  if(q.widthMid!=null)P.widthMid=q.widthMid;
  if(q.widthHigh!=null)P.widthHigh=q.widthHigh;
  if(q.tape!=null)P.tape=q.tape;
  if(q.hiss!=null)P.hiss=q.hiss;
  if(q.vinyl!=null)P.vinyl=q.vinyl;
  if(q.depth!=null)P.depth=q.depth;
  if(q.depthSize!=null)P.depthSize=q.depthSize;
  if(q.transAttack!=null)P.transAttack=q.transAttack;
  if(q.transSustain!=null)P.transSustain=q.transSustain;
  preset=name; syncControls(); applyParamsToGraph(); scheduleAnalyze(); markPresetUI();
}
function renderGroup(arr,id,tag){
  const c=$(id); if(!c)return; c.innerHTML='';
  arr.forEach(pr=>{const b=document.createElement('button');b.className='preset';b.dataset.name=pr.n;
    const t=tag||pr.t||'';
    b.innerHTML=`<div class="pt">${t}</div><div class="pn">${pr.n}</div><div class="pd">${pr.d}</div>`;
    b.onclick=()=>applyPreset(pr.p,pr.n); c.appendChild(b);});
}
function buildPresetCards(){
  renderGroup(DIMENSION,'#dimensionPresets','dimension');
  renderGroup(GENRE,'#genrePresets',null);
  renderGroup(CINEMATIC,'#cinematicPresets','cinema');
  renderGroup(MOOD,'#moodPresets','mood');
  renderGroup(COLOR,'#colorPresets','color');
  renderGroup(SPATIAL,'#spatialPresets','spatial');
}
function markPresetUI(){$$('.preset').forEach(b=>b.classList.toggle('on',b.dataset.name===preset));}

/* ============ CONTROL WIRING ============ */
function syncControls(){
  $('#rTarget').value=P.targetLUFS; $('#vTarget').textContent=P.targetLUFS.toFixed(1)+' LUFS';
  $('#ceiling').value=P.ceiling.toString();
  $('#rDrive').value=P.drive; $('#vDrive').textContent=P.drive.toFixed(1)+' dB';
  $('#rWidth').value=Math.round(P.width*100); $('#vWidth').textContent=Math.round(P.width*100)+'%';
  $('#rMS').value=Math.round(P.ms*100); $('#vMS').textContent=Math.round(P.ms*100);
  $('#rBass').value=P.bassMono; $('#vBass').textContent=P.bassMono>0?P.bassMono+' Hz':'off';
  $('#rHaas').value=P.haas; $('#vHaas').textContent=P.haas.toFixed(1)+' ms';
  $('#haasSide').value=String(P.haasSide);
  $('#rCF').value=Math.round(P.crossfeed*100); $('#vCF').textContent=Math.round(P.crossfeed*100)+'%';
  $('#rPR').value=Math.round(P.phaseRot*100); $('#vPR').textContent=Math.round(P.phaseRot*100)+'%';
  $('#rSpread').value=Math.round(P.spread*100); $('#vSpread').textContent=Math.round(P.spread*100)+'%';
  $('#rSub').value=P.sub; $('#vSub').textContent=P.sub.toFixed(1)+' dB';
  $('#rWarm').value=P.warm; $('#vWarm').textContent=P.warm.toFixed(1)+' dB';
  $('#rBody').value=P.body; $('#vBody').textContent=P.body.toFixed(1)+' dB';
  $('#rHarsh').value=P.harsh; $('#vHarsh').textContent=P.harsh.toFixed(1)+' dB';
  $('#rClar').value=P.clarity; $('#vClar').textContent=P.clarity.toFixed(1)+' dB';
  $('#rAir').value=P.air; $('#vAir').textContent=P.air.toFixed(1)+' dB';
  $('#rTilt').value=P.tilt; $('#vTilt').textContent=P.tilt.toFixed(1)+' dB';
  $('#rSat').value=P.sat; $('#vSat').textContent=Math.round(P.sat)+'%';
  /* new engines */
  $('#rMbLow').value=P.mbLow; $('#vMbLow').textContent=Math.round(P.mbLow);
  $('#rMbMid').value=P.mbMid; $('#vMbMid').textContent=Math.round(P.mbMid);
  $('#rMbHigh').value=P.mbHigh; $('#vMbHigh').textContent=Math.round(P.mbHigh);
  $('#rMbMix').value=P.mbMix; $('#vMbMix').textContent=Math.round(P.mbMix)+'%';
  $('#mbSpeed').value=P.mbSpeed;
  $('#rTrA').value=P.transAttack; $('#vTrA').textContent=(P.transAttack>0?'+':'')+Math.round(P.transAttack);
  $('#rTrS').value=P.transSustain; $('#vTrS').textContent=(P.transSustain>0?'+':'')+Math.round(P.transSustain);
  $('#rWLow').value=Math.round(P.widthLow*100); $('#vWLow').textContent=Math.round(P.widthLow*100)+'%';
  $('#rWMid').value=Math.round(P.widthMid*100); $('#vWMid').textContent=Math.round(P.widthMid*100)+'%';
  $('#rWHigh').value=Math.round(P.widthHigh*100); $('#vWHigh').textContent=Math.round(P.widthHigh*100)+'%';
  $('#rDepth').value=P.depth; $('#vDepth').textContent=Math.round(P.depth)+'%';
  $('#depthSize').value=P.depthSize;
  $('#rTape').value=P.tape; $('#vTape').textContent=Math.round(P.tape)+'%';
  $('#rHiss').value=P.hiss; $('#vHiss').textContent=Math.round(P.hiss)+'%';
  $('#rVinyl').value=P.vinyl; $('#vVinyl').textContent=Math.round(P.vinyl)+'%';
  $('#rMatch').value=P.matchStrength; $('#vMatch').textContent=Math.round(P.matchStrength)+'%';
  if(typeof drawMatchViz==='function')try{drawMatchViz();}catch(e){}
  $$('.tog[data-bind]').forEach(t=>t.classList.toggle('on',!!P[t.dataset.bind]));
  updateAnalysisUI();
}
function bindRange(id,key,xform,disp){
  $(id).addEventListener('input',e=>{ P[key]=xform(parseFloat(e.target.value)); preset='Custom'; markPresetUI();
    $(disp.el).textContent=disp.fn(P[key]); applyParamsToGraph(); scheduleAnalyze(); });
}
bindRange('#rTarget','targetLUFS',v=>v,{el:'#vTarget',fn:v=>v.toFixed(1)+' LUFS'});
bindRange('#rDrive','drive',v=>v,{el:'#vDrive',fn:v=>v.toFixed(1)+' dB'});
bindRange('#rWidth','width',v=>v/100,{el:'#vWidth',fn:v=>Math.round(v*100)+'%'});
bindRange('#rMS','ms',v=>v/100,{el:'#vMS',fn:v=>Math.round(v*100)});
bindRange('#rBass','bassMono',v=>v,{el:'#vBass',fn:v=>v>0?v+' Hz':'off'});
bindRange('#rHaas','haas',v=>v,{el:'#vHaas',fn:v=>v.toFixed(1)+' ms'});
bindRange('#rCF','crossfeed',v=>v/100,{el:'#vCF',fn:v=>Math.round(v*100)+'%'});
bindRange('#rPR','phaseRot',v=>v/100,{el:'#vPR',fn:v=>Math.round(v*100)+'%'});
bindRange('#rSpread','spread',v=>v/100,{el:'#vSpread',fn:v=>Math.round(v*100)+'%'});
bindRange('#rSub','sub',v=>v,{el:'#vSub',fn:v=>v.toFixed(1)+' dB'});
bindRange('#rWarm','warm',v=>v,{el:'#vWarm',fn:v=>v.toFixed(1)+' dB'});
bindRange('#rBody','body',v=>v,{el:'#vBody',fn:v=>v.toFixed(1)+' dB'});
bindRange('#rHarsh','harsh',v=>v,{el:'#vHarsh',fn:v=>v.toFixed(1)+' dB'});
bindRange('#rClar','clarity',v=>v,{el:'#vClar',fn:v=>v.toFixed(1)+' dB'});
bindRange('#rAir','air',v=>v,{el:'#vAir',fn:v=>v.toFixed(1)+' dB'});
bindRange('#rTilt','tilt',v=>v,{el:'#vTilt',fn:v=>v.toFixed(1)+' dB'});
bindRange('#rSat','sat',v=>v,{el:'#vSat',fn:v=>Math.round(v)+'%'});
/* — new engines — */
bindRange('#rMbLow','mbLow',v=>v,{el:'#vMbLow',fn:v=>Math.round(v)});
bindRange('#rMbMid','mbMid',v=>v,{el:'#vMbMid',fn:v=>Math.round(v)});
bindRange('#rMbHigh','mbHigh',v=>v,{el:'#vMbHigh',fn:v=>Math.round(v)});
bindRange('#rMbMix','mbMix',v=>v,{el:'#vMbMix',fn:v=>Math.round(v)+'%'});
bindRange('#rTrA','transAttack',v=>v,{el:'#vTrA',fn:v=>(v>0?'+':'')+Math.round(v)});
bindRange('#rTrS','transSustain',v=>v,{el:'#vTrS',fn:v=>(v>0?'+':'')+Math.round(v)});
bindRange('#rWLow','widthLow',v=>v/100,{el:'#vWLow',fn:v=>Math.round(v*100)+'%'});
bindRange('#rWMid','widthMid',v=>v/100,{el:'#vWMid',fn:v=>Math.round(v*100)+'%'});
bindRange('#rWHigh','widthHigh',v=>v/100,{el:'#vWHigh',fn:v=>Math.round(v*100)+'%'});
bindRange('#rDepth','depth',v=>v,{el:'#vDepth',fn:v=>Math.round(v)+'%'});
bindRange('#rTape','tape',v=>v,{el:'#vTape',fn:v=>Math.round(v)+'%'});
bindRange('#rHiss','hiss',v=>v,{el:'#vHiss',fn:v=>Math.round(v)+'%'});
bindRange('#rVinyl','vinyl',v=>v,{el:'#vVinyl',fn:v=>Math.round(v)+'%'});
bindRange('#rMatch','matchStrength',v=>v,{el:'#vMatch',fn:v=>Math.round(v)+'%'});
$('#mbSpeed').addEventListener('change',e=>{P.mbSpeed=e.target.value;preset='Custom';markPresetUI();applyParamsToGraph();scheduleAnalyze();});
$('#depthSize').addEventListener('change',e=>{P.depthSize=e.target.value;preset='Custom';markPresetUI();applyParamsToGraph();scheduleAnalyze();});
/* — reference match — */
$('#refLoad').onclick=()=>$('#refInput').click();
$('#refInput').onchange=async e=>{
  const f=e.target.files[0]; if(!f)return;
  if(!AC){ try{AC=createAudioContext();}catch(err){toast('Web Audio unavailable');return;} }
  try{
    const ab=await f.arrayBuffer();
    refBuffer=await AC.decodeAudioData(ab.slice(0));
    $('#refName').textContent='Reference: '+f.name+' · '+(refBuffer.duration).toFixed(1)+'s';
    toast('Reference loaded');
  }catch(err){ toast("Couldn't decode reference"); }
};
$('#matchBtn').onclick=()=>{
  if(!computeMatchEQ())return;
  if(P.matchStrength===0){ P.matchStrength=70; $('#rMatch').value=70; $('#vMatch').textContent='70%'; }
  preset='Custom'; markPresetUI(); applyParamsToGraph(); scheduleAnalyze(); drawMatchViz();
  toast('Matched — curve: '+P.matchGains.map(g=>(g>0?'+':'')+g).join(', ')+' dB');
};
function drawMatchViz(){
  const cv=$('#matchViz'); if(!cv)return;
  const dpr=devicePixelRatio||1, w=cv.clientWidth, h=cv.clientHeight||120;
  if(cv.width!==w*dpr){cv.width=w*dpr;cv.height=h*dpr;}
  const g=cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0); g.clearRect(0,0,w,h);
  const css=getComputedStyle(document.documentElement);
  const proc=css.getPropertyValue('--proc').trim(), line=css.getPropertyValue('--line2').trim(), faint=css.getPropertyValue('--faint').trim();
  g.strokeStyle=line; g.beginPath(); g.moveTo(0,h/2); g.lineTo(w,h/2); g.stroke();
  const bw=w/MATCH_FREQS.length;
  g.font='9px ui-monospace'; g.fillStyle=faint;
  MATCH_FREQS.forEach((f,i)=>{
    const gv=(P.matchGains[i]||0)*(P.matchStrength/100);
    const bh=-gv/8*(h/2-14);
    g.fillStyle=proc; g.globalAlpha=0.75;
    g.fillRect(i*bw+bw*0.2, Math.min(h/2,h/2+bh), bw*0.6, Math.abs(bh));
    g.globalAlpha=1; g.fillStyle=faint;
    const lab=f>=1000?(f/1000)+'k':f;
    g.fillText(lab, i*bw+bw/2-g.measureText(String(lab)).width/2, h-4);
  });
}
$('#ceiling').addEventListener('change',e=>{P.ceiling=parseFloat(e.target.value);applyParamsToGraph();updateAnalysisUI();});
$('#haasSide').addEventListener('change',e=>{P.haasSide=parseInt(e.target.value);applyParamsToGraph();});
$$('.tog[data-bind]').forEach(t=>t.addEventListener('click',()=>{P[t.dataset.bind]=!P[t.dataset.bind];t.classList.toggle('on');preset='Custom';markPresetUI();applyParamsToGraph();scheduleAnalyze();}));
$('#resetParams').onclick=()=>applyPreset({},'Transparent');

/* section collapse */
$$('.sec>.sh').forEach(h=>h.addEventListener('click',()=>h.parentElement.classList.toggle('collapsed')));

/* AB + match */
$('#abA').onclick=()=>setAB('A'); $('#abB').onclick=()=>setAB('B');
function setAB(m){abMode=m;$('#abA').classList.toggle('on',m==='A');$('#abB').classList.toggle('on',m==='B');applyParamsToGraph();updateAnalysisUI();}
$('#matchTog').onclick=()=>{matchLoud=!matchLoud;$('#matchTog').classList.toggle('on',matchLoud);applyParamsToGraph();};

/* transport */
$('#playBtn').onclick=togglePlay; $('#stopBtn').onclick=stopPlayback;
$('#reanalyze').onclick=()=>{toast('Re-analyzing…');runAnalyze();};

/* import */
$('#importBtn').onclick=()=>$('#fileInput').click();
$('#fileInput').onchange=e=>{if(e.target.files[0])handleFiles(e.target.files[0]);};
$('#dropzone').onclick=()=>$('#fileInput').click();
const dz=$('#dropzone');
['dragover','dragenter'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('hot');}));
['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('hot');}));
dz.addEventListener('drop',e=>{const f=e.dataTransfer.files[0];if(f)handleFiles(f);});
window.addEventListener('drop',e=>e.preventDefault());window.addEventListener('dragover',e=>e.preventDefault());

/* export + batch */
$$('.expbtn').forEach(b=>b.addEventListener('click',()=>{
  $('#fmt').value=b.dataset.fmt; $('#srOut').value=b.dataset.sr;
  doExport(); }));
$('#exportBtn').onclick=doExport;
$('#batchAdd').onclick=()=>$('#batchInput').click();
$('#batchInput').onchange=async e=>{
  if(!e.target.files.length)return;
  if(!AC){ try{AC=createAudioContext();}catch(err){toast('Web Audio unavailable');return;} }
  if(!nodes.inGain){ try{buildGraph();}catch(err){} }
  batchAddFiles([...e.target.files]);
};
$('#batchRun').onclick=batchRun;

/* presets save/load */
$('#savePreset').onclick=()=>{const blob=new Blob([JSON.stringify({preset,P},null,2)],{type:'application/json'});download(blob,(baseName()||'preset')+'_signalrot.json');toast('Preset saved');};
$('#loadPreset').onclick=()=>$('#presetInput').click();
$('#presetInput').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{const j=JSON.parse(await f.text());Object.assign(P,j.P||{});preset=j.preset||'Custom';if(!nodes.stereo&&AC)await buildGraph();syncControls();applyParamsToGraph();scheduleAnalyze();markPresetUI();toast('Preset loaded');}catch(err){toast('Bad preset file');}};

/* theme */
$('#theme').onclick=()=>{const r=document.documentElement;r.dataset.theme=r.dataset.theme==='dark'?'light':'dark';};

/* keyboard */
window.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT')return;
  if(e.code==='Space'){e.preventDefault();togglePlay();}
  if(e.key==='x'||e.key==='X')setAB(abMode==='A'?'B':'A');
});

/* ====================================================================
   IMMERSIVE AUDIO MODULE — stereo upmix -> 5.1 .. 9.1.6, ADM BWF, binaural
   ==================================================================== */
const IM={ layout:'off', target:'wavmc', centerExtract:0.5, surrLevel:-3, surrDelay:12,
  heightLevel:-6, heightDecorr:0.5, lfeFreq:120, lfeLevel:-3, frontRear:0.5, binPreview:false };

/* Speaker table, layouts and WAVE channel-mask derivation are imported from
   src/immersive/layouts.js. */

/* build per-speaker mono feed nodes from a 2-ch source node */
function buildSpeakerFeeds(ctx,src2,layout){
  const keys=LAYOUTS[layout];
  const split=ctx.createChannelSplitter(2); src2.connect(split);
  const L=ctx.createGain(), R=ctx.createGain(); split.connect(L,0); split.connect(R,1);
  const mid=ctx.createGain(), side=ctx.createGain();
  const lM=ctx.createGain(); lM.gain.value=0.5; const rM=ctx.createGain(); rM.gain.value=0.5;
  L.connect(lM); R.connect(rM); lM.connect(mid); rM.connect(mid);
  const lS=ctx.createGain(); lS.gain.value=0.5; const rS=ctx.createGain(); rS.gain.value=-0.5;
  L.connect(lS); R.connect(rS); lS.connect(side); rS.connect(side);
  const decorr=(inp,ms,f,q)=>{ const d=ctx.createDelay(0.2); d.delayTime.value=ms/1000;
    const ap=ctx.createBiquadFilter(); ap.type='allpass'; ap.frequency.value=f; ap.Q.value=q||0.6;
    inp.connect(d); d.connect(ap); return ap; };
  const fr=IM.frontRear, frontG=1-Math.max(0,fr-0.5)*0.6, rearG=1-Math.max(0,0.5-fr)*0.6;
  const cE=IM.centerExtract, surrG=dbToGain(IM.surrLevel)*rearG, hG=dbToGain(IM.heightLevel)*rearG;
  const feed=()=>ctx.createGain();
  const F={};

  /* ===== SONIC LAB 20.4 — ring-aware periphonic distribution =====
     Ear ring: direct image front pair → progressively decorrelated toward the rear.
     Ground ring: subtle low-tilted floor wash. High ring: HP'd height ambience.
     Roof ring: airiest, deepest decorrelation. Subs: L/R-weighted sides + mono front/rear
     (all four derived through identical LR crossover filters — phase-coherent). */
  if(layout==='soniclab'){
    const D=IM.surrDelay;
    // — ear ring 1-8 —
    { const f1=feed(); f1.gain.value=frontG; L.connect(f1); F.SL1=f1;                       // front L (+30°)
      const f2=feed(); f2.gain.value=frontG; R.connect(f2); F.SL2=f2; }                     // front R (−27°)
    { const f3=feed(); f3.gain.value=0.72*frontG; L.connect(f3); const d=feed(); d.gain.value=0.45; decorr(side,5,1250).connect(d); d.connect(f3); F.SL3=f3;   // wide L
      const f4=feed(); f4.gain.value=0.72*frontG; R.connect(f4); const e=feed(); e.gain.value=0.45; decorr(side,6,1400).connect(e); e.connect(f4); F.SL4=f4; } // wide R
    { const s5=feed(); s5.gain.value=surrG; decorr(side,D,900).connect(s5);   const b5=feed(); b5.gain.value=0.20*surrG; L.connect(b5); b5.connect(s5); F.SL5=s5;   // side-rear L
      const s6=feed(); s6.gain.value=surrG; decorr(side,D+3,1080).connect(s6); const b6=feed(); b6.gain.value=0.20*surrG; R.connect(b6); b6.connect(s6); F.SL6=s6; } // side-rear R
    { const r7=feed(); r7.gain.value=0.85*surrG; decorr(side,D+11,700).connect(r7); F.SL7=r7;   // rear L
      const r8=feed(); r8.gain.value=0.85*surrG; decorr(side,D+14,800).connect(r8); F.SL8=r8; } // rear R
    // — ground ring 9-12 — floor wash, darker + quieter than ear ring
    const ground=(d,f)=>{ const a=decorr(side,d,f); const lp=ctx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=3000; lp.Q.value=0.5;
      const g=feed(); g.gain.value=surrG*0.5; a.connect(lp); lp.connect(g); return g; };
    F.SL9=ground(9,650); F.SL10=ground(12,760); F.SL11=ground(15,540); F.SL12=ground(18,600);
    // — high ring 13-16 — synthesized height ambience
    const hQ=IM.heightDecorr*2.2+0.3;
    const ring=(d,f,hp,g)=>{ const a=decorr(side,d,f,hQ); const h=ctx.createBiquadFilter(); h.type='highpass'; h.frequency.value=hp; h.Q.value=0.5;
      const ap2=ctx.createBiquadFilter(); ap2.type='allpass'; ap2.frequency.value=f*1.7; ap2.Q.value=hQ;
      const o=feed(); o.gain.value=g; a.connect(h); h.connect(ap2); ap2.connect(o); return o; };
    F.SL13=ring(8,1500,600,hG*0.9);  F.SL14=ring(10,1700,600,hG*0.9);
    F.SL15=ring(13,1350,600,hG*0.8); F.SL16=ring(16,1500,600,hG*0.8);
    // — roof ring 17-20 — airiest layer, deepest decorrelation
    F.SL17=ring(20,1900,1000,hG);    F.SL18=ring(23,2100,1000,hG);
    F.SL19=ring(27,1650,1000,hG*0.9);F.SL20=ring(31,1800,1000,hG*0.9);
    // — subwoofers 21-24 — intelligent distribution through matched crossovers
    const subLP=fq=>{const a=ctx.createBiquadFilter();a.type='lowpass';a.frequency.value=IM.lfeFreq;a.Q.value=0.7071;
      const b=ctx.createBiquadFilter();b.type='lowpass';b.frequency.value=IM.lfeFreq;b.Q.value=0.7071;a.connect(b);return{in:a,out:b};};
    const lfeG=dbToGain(IM.lfeLevel);
    const lpL=subLP(); L.connect(lpL.in);   const g21=feed(); g21.gain.value=lfeG*0.85; lpL.out.connect(g21); F.SL21=g21;  // left sub: L-weighted bass
    const lpR=subLP(); R.connect(lpR.in);   const g22=feed(); g22.gain.value=lfeG*0.85; lpR.out.connect(g22); F.SL22=g22;  // right sub: R-weighted bass
    const lpM=subLP(); mid.connect(lpM.in); const g23=feed(); g23.gain.value=lfeG;      lpM.out.connect(g23); F.SL23=g23;  // front sub: mono anchor
    const g24=feed(); g24.gain.value=lfeG*0.7; lpM.out.connect(g24); F.SL24=g24;                                            // rear sub: mono, −3dB
    return F;
  }

  // center
  if(keys.includes('C')){ const c=feed(); c.gain.value=cE; mid.connect(c); F.C=c; }
  // lfe
  if(keys.includes('LFE')){ const lp=ctx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=IM.lfeFreq; lp.Q.value=0.7;
    const g=feed(); g.gain.value=dbToGain(IM.lfeLevel); mid.connect(lp); lp.connect(g); F.LFE=g; }
  // front L/R (pull out center content to avoid phantom doubling)
  const cDip=feed(); cDip.gain.value=-0.3*cE; if(F.C) mid.connect(cDip);
  { const fl=feed(); fl.gain.value=frontG; L.connect(fl); if(F.C)cDip.connect(fl); F.L=fl;
    const frr=feed(); frr.gain.value=frontG; R.connect(frr); if(F.C)cDip.connect(frr); F.R=frr; }
  // wides
  if(keys.includes('Lw')){ const lw=feed(); lw.gain.value=0.75*frontG; L.connect(lw); decorr(side,6,1200).connect(lw); F.Lw=lw;
    const rw=feed(); rw.gain.value=0.75*frontG; R.connect(rw); decorr(side,7,1400).connect(rw); F.Rw=rw; }
  // side surrounds
  const sSurr=(neg,d,f)=>{ const g=feed(); g.gain.value=surrG; decorr(side,d,f).connect(g);
    const b=feed(); b.gain.value=0.25*surrG; (neg?R:L).connect(b); b.connect(g); return g; };
  if(keys.includes('Ls')){ F.Ls=sSurr(false,IM.surrDelay,900); F.Rs=sSurr(true,IM.surrDelay+3,1100); }
  if(keys.includes('Lss')){ F.Lss=sSurr(false,IM.surrDelay,900); F.Rss=sSurr(true,IM.surrDelay+3,1100); }
  // rear surrounds
  if(keys.includes('Lrs')){ const gl=feed(); gl.gain.value=surrG*0.85; decorr(side,IM.surrDelay+11,700).connect(gl); F.Lrs=gl;
    const gr=feed(); gr.gain.value=surrG*0.85; decorr(side,IM.surrDelay+14,800).connect(gr); F.Rrs=gr; }
  // heights (synthesized: hi-passed decorrelated ambience)
  const hQ=IM.heightDecorr*2.2+0.3;
  const hgt=(d,f)=>{ const a=decorr(side,d,f,hQ); const hp=ctx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=700;
    const ap2=ctx.createBiquadFilter(); ap2.type='allpass'; ap2.frequency.value=f*1.7; ap2.Q.value=hQ;
    const g=feed(); g.gain.value=hG; a.connect(hp); hp.connect(ap2); ap2.connect(g); return g; };
  if(keys.includes('Ltf')){ F.Ltf=hgt(8,1500); F.Rtf=hgt(10,1700); }
  if(keys.includes('Ltm')){ F.Ltm=hgt(12,1600); F.Rtm=hgt(14,1750); }
  if(keys.includes('Ltr')){ F.Ltr=hgt(16,1300); F.Rtr=hgt(18,1450); }
  return F;
}
function placePanner(ctx,az,el){ const p=ctx.createPanner(); p.panningModel='HRTF'; p.distanceModel='linear'; p.maxDistance=2;
  const a=az*Math.PI/180, e=el*Math.PI/180;
  p.positionX.value=Math.sin(a)*Math.cos(e); p.positionY.value=Math.sin(e); p.positionZ.value=-Math.cos(a)*Math.cos(e);
  return p; }
/* ---- ADM BWF (ITU-R BS.2076) : bext + fmt + data + chna + axml ---- */
function buildADMxml(layout,sr,bitDepth){
  const keys=LAYOUTS[layout]; const hx=n=>n.toString(16).toUpperCase().padStart(4,'0');
  let chFmt='',strFmt='',trFmt='',trUID='',packRefs='',objUID='';
  keys.forEach((k,i)=>{ const idx=i+1, sp=SP[k];
    const AC='AC_0003'+hx(0x1000+idx), AT='AT_0003'+hx(0x1000+idx)+'_01', AS='AS_0003'+hx(0x1000+idx), ATU='ATU_'+(idx).toString(16).toUpperCase().padStart(8,'0');
    const freq=sp.lfe?'\n      <frequency typeDefinition="lowPass">120</frequency>':'';
    chFmt+=`    <audioChannelFormat audioChannelFormatID="${AC}" audioChannelFormatName="${sp.adm}" typeLabel="0003" typeDefinition="DirectSpeakers">
      <audioBlockFormat audioBlockFormatID="AB_0003${hx(0x1000+idx)}_00000001">
        <speakerLabel>${sp.adm}</speakerLabel>
        <position coordinate="azimuth">${sp.aAz.toFixed(1)}</position>
        <position coordinate="elevation">${sp.el.toFixed(1)}</position>
        <position coordinate="distance">1.0</position>${freq}
      </audioBlockFormat>
    </audioChannelFormat>\n`;
    strFmt+=`    <audioStreamFormat audioStreamFormatID="${AS}" audioStreamFormatName="PCM_${sp.adm}" formatLabel="0001" formatDefinition="PCM">
      <audioChannelFormatIDRef>${AC}</audioChannelFormatIDRef>
      <audioTrackFormatIDRef>${AT}</audioTrackFormatIDRef>
    </audioStreamFormat>\n`;
    trFmt+=`    <audioTrackFormat audioTrackFormatID="${AT}" audioTrackFormatName="PCM_${sp.adm}" formatLabel="0001" formatDefinition="PCM">
      <audioStreamFormatIDRef>${AS}</audioStreamFormatIDRef>
    </audioTrackFormat>\n`;
    trUID+=`    <audioTrackUID UID="${ATU}" sampleRate="${sr}" bitDepth="${bitDepth}">
      <audioTrackFormatIDRef>${AT}</audioTrackFormatIDRef>
      <audioPackFormatIDRef>AP_00031001</audioPackFormatIDRef>
    </audioTrackUID>\n`;
    packRefs+=`      <audioChannelFormatIDRef>${AC}</audioChannelFormatIDRef>\n`;
    objUID+=`      <audioTrackUIDRef>${ATU}</audioTrackUIDRef>\n`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<ebuCoreMain xmlns="urn:ebu:metadata-schema:ebuCore_2016">
 <coreMetadata><format><audioFormatExtended version="ITU-R_BS.2076-2">
    <audioProgramme audioProgrammeID="APR_1001" audioProgrammeName="Immersive Master"><audioContentIDRef>ACO_1001</audioContentIDRef></audioProgramme>
    <audioContent audioContentID="ACO_1001" audioContentName="Bed ${layout}"><audioObjectIDRef>AO_1001</audioObjectIDRef></audioContent>
    <audioObject audioObjectID="AO_1001" audioObjectName="Bed ${layout}">
      <audioPackFormatIDRef>AP_00031001</audioPackFormatIDRef>
${objUID}    </audioObject>
    <audioPackFormat audioPackFormatID="AP_00031001" audioPackFormatName="${layout}" typeLabel="0003" typeDefinition="DirectSpeakers">
${packRefs}    </audioPackFormat>
${chFmt}${strFmt}${trFmt}${trUID} </audioFormatExtended></format></coreMetadata>
</ebuCoreMain>`;
}
function writeADMBWF(buf,layout,bitDepth){
  const ch=buf.numberOfChannels,sr=buf.sampleRate,n=buf.length,bps=bitDepth/8,blockAlign=ch*bps,dataLen=n*blockAlign;
  const keys=LAYOUTS[layout];
  const xml=buildADMxml(layout,sr,bitDepth); const xmlBytes=new TextEncoder().encode(xml);
  const axmlLen=xmlBytes.length+(xmlBytes.length%2);
  // chna: 4 + 40*numUIDs
  const numUIDs=keys.length, chnaLen=4+40*numUIDs;
  const bextLen=602;
  const fmtLen=40;
  const total=4+(8+bextLen)+(8+fmtLen)+(8+dataLen)+(8+chnaLen)+(8+axmlLen);
  const ab=new ArrayBuffer(8+total),v=new DataView(ab); let o=0;
  const ws=s=>{for(let i=0;i<s.length;i++)v.setUint8(o++,s.charCodeAt(i));};
  const u32=x=>{v.setUint32(o,x,true);o+=4;}, u16=x=>{v.setUint16(o,x,true);o+=2;};
  const writeStr=(s,len)=>{for(let i=0;i<len;i++)v.setUint8(o++, i<s.length?s.charCodeAt(i):0);};
  ws('RIFF'); u32(total); ws('WAVE');
  // bext (BWF — ArrayBuffer is zero-initialised, so only write description + version)
  ws('bext'); u32(bextLen); { const bstart=o; writeStr('SIGNAL ROT // MASTER — ADM BWF '+layout,256);
    o=bstart+346; v.setUint16(o,1,true); o=bstart+bextLen; }
  // fmt (extensible, mask 0 — ADM self-describes routing via chna)
  ws('fmt '); u32(fmtLen); u16(0xFFFE); u16(ch); u32(sr); u32(sr*blockAlign); u16(blockAlign); u16(bitDepth);
  u16(22); u16(bitDepth); u32(0); [0x01,0,0,0,0,0,0x10,0,0x80,0,0,0xAA,0,0x38,0x9B,0x71].forEach(b=>v.setUint8(o++,b));
  // data
  ws('data'); u32(dataLen); { const data=[]; for(let c=0;c<ch;c++)data.push(buf.getChannelData(c));
    for(let i=0;i<n;i++)for(let c=0;c<ch;c++){ const s=clamp(data[c][i],-1,1); const iv=Math.round(s<0?s*0x800000:s*0x7FFFFF);
      v.setUint8(o++,iv&255); v.setUint8(o++,(iv>>8)&255); v.setUint8(o++,(iv>>16)&255); } }
  // chna
  ws('chna'); u32(chnaLen); u16(numUIDs); u16(numUIDs);
  keys.forEach((k,i)=>{ const idx=i+1; const hx=n=>n.toString(16).toUpperCase().padStart(4,'0');
    u16(idx);
    writeStr('ATU_'+idx.toString(16).toUpperCase().padStart(8,'0'),12);
    writeStr('AT_0003'+hx(0x1000+idx)+'_01',14);
    writeStr('AP_00031001',11);
    v.setUint8(o++,0); });
  // axml
  ws('axml'); u32(axmlLen); for(let i=0;i<xmlBytes.length;i++)v.setUint8(o++,xmlBytes[i]); if(axmlLen>xmlBytes.length)v.setUint8(o++,0);
  return new Blob([ab],{type:'audio/wav'});
}

/* ---- offline immersive render ---- */
async function renderImmersive(){
  if(!srcBuffer){toast('Load a file first');return;}
  if(IM.layout==='off'){toast('Pick an output layout');return;}
  const prog=$('#imProg'); prog.classList.add('on'); prog.querySelector('i').style.width='8%'; $('#imExport').disabled=true;
  try{
    const srSel=parseInt($('#srOut').value)||0;
    await new Promise(r=>setTimeout(r,30));
    const master=await renderMaster(srSel);          // stereo, normalized + limited
    prog.querySelector('i').style.width='40%';
    const sr=master.sampleRate, len=master.length;
    const bit=parseInt($('#fmt').value.match(/32/)?'32':'24',10);
    let outBuf, blob, name;
    if(IM.target==='binaural'){
      const oac=createOfflineAudioContext(2,len,sr);
      const src=oac.createBufferSource(); src.buffer=master;
      const F=buildSpeakerFeeds(oac,src,IM.layout);
      const sum=oac.createGain(); sum.connect(oac.destination);
      for(const k in F){ const sp=SP[k];
        if(sp.lfe){ const g=oac.createGain(); g.gain.value=0.7; F[k].connect(g); g.connect(sum); }
        else{ const p=placePanner(oac,sp.az,sp.el); F[k].connect(p); p.connect(sum); } }
      src.start(); outBuf=await oac.startRendering();
      truePeakLimit(outBuf,P.ceiling);
      blob=writeWAV(outBuf,bit); name=`${baseName()}_${IM.layout==="soniclab"?"SonicLab20.4":IM.layout}_binaural.wav`;
    } else {
      const N=LAYOUTS[IM.layout].length;
      const oac=createOfflineAudioContext(N,len,sr);
      const src=oac.createBufferSource(); src.buffer=master;
      const F=buildSpeakerFeeds(oac,src,IM.layout);
      const merger=oac.createChannelMerger(N);
      const ord = IM.target==='wavmc'? getWavOrder(IM.layout).order : LAYOUTS[IM.layout];
      ord.forEach((k,i)=>{ if(F[k]) F[k].connect(merger,0,i); });
      merger.connect(oac.destination);
      src.start(); outBuf=await oac.startRendering();
      truePeakLimit(outBuf,P.ceiling);
      prog.querySelector('i').style.width='80%';
      if(IM.target==='adm'){ blob=writeADMBWF(outBuf,IM.layout,24); name=`${baseName()}_${IM.layout==="soniclab"?"SonicLab20.4":IM.layout}_ADM.wav`; }
      else { const {mask}=getWavOrder(IM.layout); blob=writeWAVMultiExt(outBuf,bit,mask); name=`${baseName()}_${IM.layout==="soniclab"?"SonicLab20.4":IM.layout}.wav`; }
    }
    prog.querySelector('i').style.width='100%';
    download(blob,name);
    toast('Rendered '+IM.layout+' · '+(IM.target==='adm'?'ADM BWF':IM.target==='binaural'?'binaural':'multichannel WAV'));
  }catch(e){ toast('Immersive render failed: '+e.message); console.error(e); }
  $('#imExport').disabled=false; setTimeout(()=>prog.classList.remove('on'),700);
}

/* ---- live binaural preview ---- */
function teardownPreview(){
  if(nodes._prevTap){ try{nodes.post.disconnect(nodes._prevTap);}catch(e){} try{nodes._prevTap.disconnect();}catch(e){} nodes._prevTap=null; }
  if(nodes._prev){ try{nodes._prev.forEach(n=>{try{n.disconnect();}catch(e){}});}catch(e){} nodes._prev=null; }
}
function buildPreview(){
  teardownPreview();
  if(!IM.binPreview || IM.layout==='off' || !nodes.post){ if(nodes.monitor)nodes.monitor.gain.value=1; return; }
  const ctx=AC, created=[];
  const tap=ctx.createGain(); nodes.post.connect(tap); nodes._prevTap=tap;  // single severable tap
  const F=buildSpeakerFeeds(ctx,tap,IM.layout);
  const sum=ctx.createGain(); sum.connect(ctx.destination); created.push(sum);
  for(const k in F){ const sp=SP[k];
    if(sp.lfe){ const g=ctx.createGain(); g.gain.value=0.7; F[k].connect(g); g.connect(sum); created.push(g); }
    else{ const p=placePanner(ctx,sp.az,sp.el); F[k].connect(p); p.connect(sum); created.push(p); } }
  for(const k in F)created.push(F[k]);
  nodes._prev=created;
  nodes.monitor.gain.value=0;   // mute direct stereo; monitor via binaural fold-down
}

/* ---- speaker map visualization ---- */
function drawSpeakerMap(){
  const cv=$('#spkmap'); if(!cv)return; const dpr=devicePixelRatio||1,w=cv.clientWidth,h=210;
  if(cv.width!==w*dpr){cv.width=w*dpr;cv.height=h*dpr;}
  const g=cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0); g.clearRect(0,0,w,h);
  const css=getComputedStyle(document.documentElement), cx=w/2, cy=h/2, R=Math.min(w,h)*0.40;
  g.strokeStyle=css.getPropertyValue('--line2'); g.lineWidth=1;
  g.beginPath(); g.arc(cx,cy,R,0,TAU); g.stroke();
  g.beginPath(); g.arc(cx,cy,R*0.5,0,TAU); g.setLineDash([3,4]); g.strokeStyle=css.getPropertyValue('--grid'); g.stroke(); g.setLineDash([]);
  // listener
  g.fillStyle=css.getPropertyValue('--faint'); g.beginPath(); g.arc(cx,cy,3,0,TAU); g.fill();
  g.font='9px ui-monospace'; g.fillText('▲',cx-3,cy-6);
  // live level proxy from L/R + side
  let lvlL=0,lvlR=0,lvlS=0,lvlM=0;
  if(nodes.anaL){ const dL=new Float32Array(nodes.anaL.fftSize),dR=new Float32Array(nodes.anaR.fftSize);
    nodes.anaL.getFloatTimeDomainData(dL); nodes.anaR.getFloatTimeDomainData(dR);
    for(let i=0;i<dL.length;i++){ lvlL+=dL[i]*dL[i]; lvlR+=dR[i]*dR[i]; const s=(dL[i]-dR[i])*0.5,m=(dL[i]+dR[i])*0.5; lvlS+=s*s; lvlM+=m*m; }
    const n=dL.length; lvlL=Math.sqrt(lvlL/n); lvlR=Math.sqrt(lvlR/n); lvlS=Math.sqrt(lvlS/n); lvlM=Math.sqrt(lvlM/n);
  }
  const lvlFor=k=>{ const sp=SP[k]; if(sp.lfe)return lvlM*dbToGain(IM.lfeLevel);
    if(k==='C')return lvlM*IM.centerExtract; if(k==='L'||k==='SL1')return lvlL; if(k==='R'||k==='SL2')return lvlR;
    if(sp.el>0)return lvlS*dbToGain(IM.heightLevel); return lvlS*dbToGain(IM.surrLevel); };
  const proc=css.getPropertyValue('--proc').trim(), orig=css.getPropertyValue('--orig').trim();
  LAYOUTS[IM.layout].forEach(k=>{ const sp=SP[k];
    const a=sp.az*Math.PI/180; const rr = sp.el>0 ? R*0.55 : (k==='Lw'||k==='Rw'?R*0.9:R);
    const x=cx+Math.sin(a)*rr, y=cy-Math.cos(a)*rr*0.82;
    const lv=clamp(lvlFor(k)*6,0,1);
    const col = sp.el>0?orig:proc;
    g.beginPath(); g.fillStyle=col; g.globalAlpha=0.22+lv*0.78; g.arc(x,y,sp.lfe?5:6.5,0,TAU); g.fill(); g.globalAlpha=1;
    g.strokeStyle=col; g.globalAlpha=0.5; g.beginPath(); g.arc(x,y,6.5,0,TAU); g.stroke(); g.globalAlpha=1;
    g.fillStyle=css.getPropertyValue('--muted'); g.font='8px ui-monospace';
    g.fillText(k,x-g.measureText(k).width/2,y+15);
  });
  g.fillStyle=css.getPropertyValue('--faint'); g.font='9px ui-monospace';
  g.fillText(IM.layout+'  ·  '+LAYOUTS[IM.layout].length+'ch  ·  '+(IM.target==='adm'?'ADM BWF':IM.target==='binaural'?'binaural':'WAV'),8,h-7);
  g.fillStyle=orig; g.fillText('● height',w-66,14); g.fillStyle=proc; g.fillText('● bed',w-66,26);
}

/* ---- immersive UI wiring ---- */
function imRefreshNote(){ const t=IM.target;
  const extra=t==='adm'?' Atmos Master / 360RA / MPEG-H all import this ADM; their licensed final encode runs in the platform tools, not the browser.':
    t==='binaural'?' Dolby Atmos for Headphones / Apple Spatial are head-tracked playback renderers — this is a fixed HRTF binaural fold-down of the same bed.':'';
  $('#imNote').innerHTML=$('#imNote').dataset.base||($('#imNote').dataset.base=$('#imNote').innerHTML); $('#imNote').innerHTML=$('#imNote').dataset.base+extra; }
function imBind(id,key,fn,disp){ $(id).addEventListener('input',e=>{ IM[key]=fn(parseFloat(e.target.value)); $(disp.el).textContent=disp.fn(IM[key]);
  if(IM.binPreview)buildPreview(); }); }
$('#imLayout').addEventListener('change',e=>{ IM.layout=e.target.value;
  if(IM.layout==='off'){ teardownPreview(); if(nodes.monitor)nodes.monitor.gain.value=1; $('#imPrevTog').classList.remove('on'); IM.binPreview=false; }
  else if(IM.binPreview)buildPreview(); });
$('#imTarget').addEventListener('change',e=>{ IM.target=e.target.value; imRefreshNote(); });
imBind('#rImC','centerExtract',v=>v/100,{el:'#vImC',fn:v=>Math.round(v*100)+'%'});
imBind('#rImS','surrLevel',v=>v,{el:'#vImS',fn:v=>v.toFixed(1)+' dB'});
imBind('#rImSd','surrDelay',v=>v,{el:'#vImSd',fn:v=>Math.round(v)+' ms'});
imBind('#rImH','heightLevel',v=>v,{el:'#vImH',fn:v=>v.toFixed(1)+' dB'});
imBind('#rImHd','heightDecorr',v=>v/100,{el:'#vImHd',fn:v=>Math.round(v*100)+'%'});
imBind('#rImLf','lfeFreq',v=>v,{el:'#vImLf',fn:v=>Math.round(v)+' Hz'});
imBind('#rImLl','lfeLevel',v=>v,{el:'#vImLl',fn:v=>Math.round(v)+' dB'});
imBind('#rImFr','frontRear',v=>v/100,{el:'#vImFr',fn:v=>v<0.45?'front':v>0.55?'surround':'center'});
$('#imPrevTog').addEventListener('click',()=>{ if(IM.layout==='off'){toast('Pick a layout first');return;}
  IM.binPreview=!IM.binPreview; $('#imPrevTog').classList.toggle('on',IM.binPreview);
  if(!AC){toast('Load a file first');IM.binPreview=false;$('#imPrevTog').classList.remove('on');return;}
  buildPreview(); toast(IM.binPreview?'Binaural monitor on':'Stereo monitor'); });
$('#imExport').addEventListener('click',renderImmersive);

/* boot */
window.addEventListener('error',e=>{ toast('Error: '+(e.message||'see console')); });
window.addEventListener('unhandledrejection',e=>{ toast('Error: '+((e.reason&&e.reason.message)||'see console')); });
buildPresetCards(); syncControls(); markPresetUI(); loop();
window.addEventListener('resize',()=>{wavePeaks=null;});
if(typeof lamejs==='undefined') console.warn('lamejs not loaded yet — MP3 export will retry from CDN at runtime');
