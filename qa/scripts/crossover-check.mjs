#!/usr/bin/env node
/**
 * Headless crossover conformance — the same assertions the browser lab makes, driven
 * through the headless Web Audio engine so they run anywhere (CI, sandbox).
 *
 * Covers BOTH sections that use LR4 splits (issue #19 hit both, and the stereo section
 * had no conformance test at all):
 *
 *   1. multiband wet path with inactive compressors: unity at every mix position
 *   2. stereo side path with unity width gains: unity (anti-phase probe)
 *   3. bass-mono corner: true LR4 24 dB/octave shape on the side channel
 *   4. dry/wet impulse alignment (the 6 ms look-ahead match)
 *
 * Usage:
 *   LD_LIBRARY_PATH=<alsa-stub> node qa/scripts/crossover-check.mjs [--sr 48000] [--strict]
 *
 * Exit 0 when every contract holds, 1 otherwise. `--strict` tightens the wet-path gate
 * to the ±0.1 dB design goal; the default gate is the 1.5 dB browser contract (#12).
 */
import { join } from 'node:path';
import { installWebAudio } from './engine.mjs';

const repoRoot = '/home/user/Signal-Rot-Audio-Mastering-Suite-';
installWebAudio();

const { buildMultiband, MB_COMPRESSOR_LOOKAHEAD_S, bandAmountToSettings, resolveDryDelay } =
  await import(join(repoRoot, 'src/audio/graph/multiband.js'));
const { buildStereo, applyStereo, setAudition } = await import(
  join(repoRoot, 'src/audio/graph/stereo.js')
);
const { dynamicsCompressorMakeupCompensation } = await import(
  join(repoRoot, 'src/audio/dsp/dynamics-compressor.js')
);
const { defaultParameters, validateParameters } = await import(
  join(repoRoot, 'src/app/parameters.js')
);
const { OfflineAudioContext } = globalThis;

const argv = process.argv.slice(2);
const arg = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const onlySr = arg('--sr', '');
const strict = argv.includes('--strict');
const CONTRACT_DB = 1.5; // the browser contract (#12) — never widen this
const GOAL_DB = 0.1; // the design goal
const gate = strict ? GOAL_DB : CONTRACT_DB;

const db = (x) => 20 * Math.log10(Math.max(1e-12, Math.abs(x)));
const failures = [];
const check = (name, valueDb, limitDb = gate) => {
  const ok = Math.abs(valueDb) < limitDb;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'} ${name}: ${valueDb >= 0 ? '+' : ''}${valueDb.toFixed(3)} dB (gate ±${limitDb})`,
  );
  if (!ok) failures.push(`${name}: ${valueDb.toFixed(3)} dB`);
};

function applyBand(comp, specMakeup, makeup, amount) {
  const s = bandAmountToSettings(amount);
  comp.threshold.value = s.thresholdDb;
  comp.ratio.value = s.ratio;
  comp.knee.value = s.kneeDb;
  specMakeup.gain.value = dynamicsCompressorMakeupCompensation(
    s.thresholdDb,
    s.kneeDb,
    s.ratio,
  );
  makeup.gain.value = 1;
}

async function renderMono(sr, seconds, fill, wire) {
  const n = Math.round(seconds * sr);
  const ctx = new OfflineAudioContext(1, n, sr);
  const src = ctx.createBufferSource();
  const buf = ctx.createBuffer(1, n, sr);
  fill(buf.getChannelData(0), sr);
  src.buffer = buf;
  wire(ctx, src);
  src.start(0);
  return ctx.startRendering();
}

async function renderStereo(sr, seconds, fillL, fillR, wire) {
  const n = Math.round(seconds * sr);
  const ctx = new OfflineAudioContext(2, n, sr);
  const src = ctx.createBufferSource();
  const buf = ctx.createBuffer(2, n, sr);
  fillL(buf.getChannelData(0), sr);
  fillR(buf.getChannelData(1), sr);
  src.buffer = buf;
  wire(ctx, src);
  src.start(0);
  return ctx.startRendering();
}

const sine = (freq, amp) => (d, sr) => {
  for (let i = 0; i < d.length; i++) d[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
};

function rmsSlice(ch, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += ch[i] * ch[i];
  return Math.sqrt(s / (to - from));
}

const params = validateParameters({ ...defaultParameters() }).parameters;

// ── 1. Multiband wet path ─────────────────────────────────────────────────────
async function multibandAt(sr) {
  // The same resolution production renders use — this checks the production path,
  // not a hand-tuned copy of it.
  const dry = await resolveDryDelay(sr);
  console.log(
    `multiband wet path @ ${sr} Hz (inactive compressors, dry delay ${(dry.seconds * 1000).toFixed(3)} ms ${dry.measured ? 'measured' : 'DEFAULT'})`,
  );
  const mixes = [0, 0.25, 0.5, 0.75, 1];
  const freqs = [50, 140, 400, 1000, 3200, 8000].filter((f) => f < sr / 2);
  let worst = 0;
  let worstAt = '';
  for (const mix of mixes) {
    const row = [];
    for (const freq of freqs) {
      const seconds = 0.5;
      const rendered = await renderMono(sr, seconds, sine(freq, 0.4), (ctx, src) => {
        const mb = buildMultiband(ctx, { dryDelaySeconds: dry.seconds });
        applyBand(mb.compLow, mb.specMakeupLow, mb.lowMakeup, 0);
        applyBand(mb.compMid, mb.specMakeupMid, mb.midMakeup, 0);
        applyBand(mb.compHigh, mb.specMakeupHigh, mb.highMakeup, 0);
        mb.wet.gain.value = mix;
        mb.dry.gain.value = 1 - mix;
        src.connect(mb.input);
        mb.output.connect(ctx.destination);
      });
      const ch = rendered.getChannelData(0);
      const g = db(rmsSlice(ch, Math.round(0.15 * sr), Math.round(0.4 * sr))) - db(0.4 / Math.SQRT2);
      row.push(`${freq}:${g >= 0 ? '+' : ''}${g.toFixed(2)}`);
      if (Math.abs(g) > Math.abs(worst)) {
        worst = g;
        worstAt = `mix ${mix} @ ${freq} Hz`;
      }
    }
    console.log(`  mix ${String(mix).padEnd(4)} ${row.join('  ')}`);
  }
  check(`SR ${sr} worst (${worstAt})`, worst);
  return worst;
}

// ── 2. Stereo side path at unity ──────────────────────────────────────────────
async function stereoSideAt(sr) {
  console.log(`stereo side path @ ${sr} Hz (unity width, bass-mono off)`);
  const freqs = [40, 150, 250, 1000, 2000, 4000, 10000].filter((f) => f < sr / 2);
  let worst = 0;
  let worstAt = '';
  const row = [];
  for (const freq of freqs) {
    const seconds = 0.6;
    // Anti-phase probe: mid = 0, side = s. Output side = (L−R)/2 = processed s.
    const rendered = await renderStereo(
      sr,
      seconds,
      sine(freq, 0.4),
      sine(freq, -0.4),
      (ctx, src) => {
        const st = buildStereo(ctx);
        applyStereo(st, { ...params, width: 1, widthLow: 1, widthMid: 1, widthHigh: 1, bassMono: 0 });
        setAudition(st, 'stereo');
        src.connect(st.input);
        st.output.connect(ctx.destination);
      },
    );
    const L = rendered.getChannelData(0);
    const R = rendered.getChannelData(1);
    const a = Math.round(0.2 * sr);
    const b = Math.round(0.5 * sr);
    let s = 0;
    for (let i = a; i < b; i++) {
      const side = (L[i] - R[i]) / 2;
      s += side * side;
    }
    const g = db(Math.sqrt(s / (b - a))) - db(0.4 / Math.SQRT2);
    row.push(`${freq}:${g >= 0 ? '+' : ''}${g.toFixed(2)}`);
    if (Math.abs(g) > Math.abs(worst)) {
      worst = g;
      worstAt = `${freq} Hz`;
    }
  }
  console.log(`  side ${row.join('  ')}`);
  check(`SR ${sr} side worst (${worstAt})`, worst);
  return worst;
}

// ── 3. Bass-mono corner shape ─────────────────────────────────────────────────
async function bassMonoAt(sr) {
  console.log(`bass-mono LR4 shape @ ${sr} Hz (corner 80 Hz, side channel)`);
  const corner = 80;
  const probes = [
    { f: 40, expect: -24, tol: 3 }, // one octave below: −24 dB for LR4
    { f: 80, expect: -6, tol: 2 }, // at the corner: −6 dB
    { f: 320, expect: 0, tol: 1 }, // well above: unity
  ];
  for (const { f, expect, tol } of probes) {
    const seconds = 1.2;
    const rendered = await renderStereo(sr, seconds, sine(f, 0.4), sine(f, -0.4), (ctx, src) => {
      const st = buildStereo(ctx);
      applyStereo(st, { ...params, width: 1, bassMono: corner });
      setAudition(st, 'stereo');
      src.connect(st.input);
      st.output.connect(ctx.destination);
    });
    const L = rendered.getChannelData(0);
    const R = rendered.getChannelData(1);
    const a = Math.round(0.5 * sr);
    const b = Math.round(1.1 * sr);
    let s = 0;
    for (let i = a; i < b; i++) {
      const side = (L[i] - R[i]) / 2;
      s += side * side;
    }
    const g = db(Math.sqrt(s / (b - a))) - db(0.4 / Math.SQRT2);
    const ok = Math.abs(g - expect) <= tol;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'} ${f} Hz: ${g.toFixed(2)} dB (expect ${expect} ± ${tol})`,
    );
    if (!ok) failures.push(`bass-mono ${f} Hz: ${g.toFixed(2)} dB`);
  }
}

// ── 4. Dry/wet alignment ──────────────────────────────────────────────────────
async function alignmentAt(sr) {
  const at = 128;
  const seconds = 0.08;
  const dryInfo = await resolveDryDelay(sr);
  const imp = (d) => {
    d.fill(0);
    d[at] = 1;
  };
  const wet = await renderMono(sr, seconds, imp, (ctx, src) => {
    const mb = buildMultiband(ctx, { dryDelaySeconds: dryInfo.seconds });
    applyBand(mb.compLow, mb.specMakeupLow, mb.lowMakeup, 0);
    applyBand(mb.compMid, mb.specMakeupMid, mb.midMakeup, 0);
    applyBand(mb.compHigh, mb.specMakeupHigh, mb.highMakeup, 0);
    mb.wet.gain.value = 1;
    mb.dry.gain.value = 0;
    src.connect(mb.input);
    mb.output.connect(ctx.destination);
  });
  const dry = await renderMono(sr, seconds, imp, (ctx, src) => {
    const mb = buildMultiband(ctx, { dryDelaySeconds: dryInfo.seconds });
    applyBand(mb.compLow, mb.specMakeupLow, mb.lowMakeup, 0);
    applyBand(mb.compMid, mb.specMakeupMid, mb.midMakeup, 0);
    applyBand(mb.compHigh, mb.specMakeupHigh, mb.highMakeup, 0);
    mb.wet.gain.value = 0;
    mb.dry.gain.value = 1;
    src.connect(mb.input);
    mb.output.connect(ctx.destination);
  });
  const peak = (ch) => {
    let idx = 0;
    let v = 0;
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > v) {
        v = a;
        idx = i;
      }
    }
    return { idx, v };
  };
  const w = peak(wet.getChannelData(0));
  const d = peak(dry.getChannelData(0));
  const deltaMs = ((w.idx - d.idx) / sr) * 1000;
  const ok = Math.abs(deltaMs) < 1.5;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'} wet−dry alignment: ${deltaMs.toFixed(3)} ms (documented look-ahead ${MB_COMPRESSOR_LOOKAHEAD_S * 1000} ms; wet peak ${w.v.toFixed(4)}, dry peak ${d.v.toFixed(4)})`,
  );
  if (!ok) failures.push(`alignment ${deltaMs.toFixed(3)} ms`);
}

const rates = onlySr ? [Number(onlySr)] : [44100, 48000, 96000, 192000];
for (const sr of rates) {
  console.log(`\n=== ${sr} Hz ${strict ? '(strict ±0.1 dB)' : `(contract ±${CONTRACT_DB} dB)`} ===`);
  await multibandAt(sr);
  await stereoSideAt(sr);
  if (sr <= 48000) await bassMonoAt(sr);
  await alignmentAt(sr);
}

console.log(failures.length ? `\n${failures.length} FAILURES:\n- ${failures.join('\n- ')}` : '\nALL CROSSOVER CONTRACTS HOLD');
process.exit(failures.length ? 1 : 0);
