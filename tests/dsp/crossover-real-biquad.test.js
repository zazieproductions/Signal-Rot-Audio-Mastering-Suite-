/**
 * Real-Web-Audio regression lock for the multiband and stereo-section crossovers.
 *
 * The dB-Q crossover fix (PR #26, issue #19) and the parallel-mix dry-path
 * compensation are arithmetic identities. `tests/dsp/multiband-crossover.test.js`
 * already exercises the analytical model — the same RBJ coefficients, in the same
 * node-Q convention. But that test cannot catch a regression where a contributor
 * re-introduces a linear Q on a `BiquadFilterNode` (the bug that put +7.4 dB at
 * every crossover corner on issue #19), because the analytical model would still
 * pass: it has no concept of a node.
 *
 * This test drives the actual `BiquadFilterNode` end-to-end through a real
 * Web Audio engine (`node-web-audio-api`, Blink semantics — see
 * `qa/findings/SON-3-lr4-crossover-q-unit-error.md` for the headless/Chromium
 * cross-check). It is non-skippable at the **0.5 dB hard contract** the browser
 * matrix enforces; if anyone re-introduces the dB-Q bug, the topology bug, or
 * the dry-delay mismatch, this test will fail before the matrix does.
 *
 * The test runs wherever the engine is loadable (CI's `ubuntu-latest` already
 * has `libasound2`; offline sandboxes need a stub on `LD_LIBRARY_PATH` — see
 * `qa/README.md`). If the engine cannot be loaded the test reports and exits
 * with a hard failure rather than silently passing — a missing real-Web-Audio
 * regression lock in CI is itself a defect, not a free pass.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildMultiband,
  resolveDryDelay,
  bandAmountToSettings,
} from '../../src/audio/graph/multiband.js';
import { buildStereo, applyStereo, setAudition } from '../../src/audio/graph/stereo.js';
import { dynamicsCompressorMakeupCompensation } from '../../src/audio/dsp/dynamics-compressor.js';
import { defaultParameters } from '../../src/app/parameters.js';

let OfflineAudioContextCtor = null;
let engineLoadError = null;
beforeAll(async () => {
  try {
    const mod = await import('node-web-audio-api');
    OfflineAudioContextCtor = mod.OfflineAudioContext;
    // `resolveDryDelay` calls `measureCompressorLatency`, which uses
    // `window.OfflineAudioContext` (not the imported one). Install the engine
    // on `globalThis.window` so the production code path picks it up; without
    // this, `resolveDryDelay` falls back to the documented 6 ms constant
    // and any engine with a different compressor latency fails the gate.
    if (typeof globalThis.window === 'undefined') {
      globalThis.window = globalThis;
    }
    globalThis.window.OfflineAudioContext = OfflineAudioContextCtor;
    globalThis.window.webkitOfflineAudioContext = OfflineAudioContextCtor;
    globalThis.OfflineAudioContext = OfflineAudioContextCtor;
    globalThis.webkitOfflineAudioContext = OfflineAudioContextCtor;
  } catch (err) {
    engineLoadError = err;
  }
});

const SR = 48000;
const dbOf = (x) => 20 * Math.log10(Math.max(1e-12, Math.abs(x)));

function sineFill(ctx, freq, amp, seconds = 0.5) {
  const length = Math.round(seconds * SR);
  const buf = ctx.createBuffer(1, length, SR);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < length; i++) ch[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return buf;
}

function antiPhaseFill(ctx, freq, amp, seconds = 0.6) {
  const length = Math.round(seconds * SR);
  const buf = ctx.createBuffer(2, length, SR);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  for (let i = 0; i < length; i++) {
    L[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
    R[i] = -L[i];
  }
  return buf;
}

function rmsSliceMonoDb(buffer, sr = SR) {
  const ch = buffer.getChannelData(0);
  const a = Math.round(0.15 * sr);
  const b = Math.round(0.4 * sr);
  let s = 0;
  for (let i = a; i < b; i++) s += ch[i] * ch[i];
  return dbOf(Math.sqrt(s / (b - a)));
}

function rmsSliceSideDb(buffer, sr = SR) {
  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);
  const a = Math.round(0.2 * sr);
  const b = Math.round(0.5 * sr);
  let s = 0;
  for (let i = a; i < b; i++) {
    const side = (L[i] - R[i]) / 2;
    s += side * side;
  }
  return dbOf(Math.sqrt(s / (b - a)));
}

const REF_DB = dbOf(0.4 / Math.SQRT2);

// The 0.5 dB hard contract — same as `tests/browser/multiband.spec.js` and
// `tests/browser/stereo-section.spec.js`. NEVER WIDEN. (issue #12, issue #29)
const HARD_GATE_DB = 0.5;
// The 0.35 dB sub-gate for mix=0 (the dry path is a straight wire and must
// be unity within ~3 % amplitude, which the matrix enforces on the dry row).
const DRY_GATE_DB = 0.35;

// A missing real-Web-Audio engine in CI is a setup defect, not a free pass.
// The suite always runs and inspects whether the engine loaded inside the
// `beforeAll` (which vitest runs before any `it`).
describe('real-BiquadFilterNode crossover (issue #29 regression lock)', () => {
  // The very first test is a self-check: did the engine actually load? If
  // not, the remaining tests have nothing to drive and would all be silently
  // green — that is exactly the failure mode this lock exists to prevent.
  it('loads node-web-audio-api', () => {
    if (!OfflineAudioContextCtor) {
      throw new Error(
        `node-web-audio-api is not loadable in this environment: ${engineLoadError?.message ?? 'unknown'}. ` +
          `This is the real-Web-Audio regression lock for the dB-Q crossover fix and the parallel-mix dry-path compensation. ` +
          `If you are running locally, see qa/README.md for the libasound2 / stub setup. ` +
          `If you are running in CI, the devDependency was not installed — see package.json.`,
      );
    }
  });

  function applyBand(comp, specMakeup, makeup, amount) {
    const s = bandAmountToSettings(amount);
    comp.threshold.value = s.thresholdDb;
    comp.ratio.value = s.ratio;
    comp.knee.value = s.kneeDb;
    specMakeup.gain.value = dynamicsCompressorMakeupCompensation(s.thresholdDb, s.kneeDb, s.ratio);
    makeup.gain.value = 1;
  }

  async function renderMultiband(freq, mix, dryDelaySeconds) {
    const seconds = 0.5;
    const length = Math.round(seconds * SR);
    const ctx = new OfflineAudioContextCtor(1, length, SR);
    const mb = buildMultiband(ctx, { dryDelaySeconds });
    applyBand(mb.compLow, mb.specMakeupLow, mb.lowMakeup, 0);
    applyBand(mb.compMid, mb.specMakeupMid, mb.midMakeup, 0);
    applyBand(mb.compHigh, mb.specMakeupHigh, mb.highMakeup, 0);
    mb.wet.gain.value = mix;
    mb.dry.gain.value = 1 - mix;
    const src = ctx.createBufferSource();
    src.buffer = sineFill(ctx, freq, 0.4, seconds);
    src.connect(mb.input);
    mb.output.connect(ctx.destination);
    src.start(0);
    return ctx.startRendering();
  }

  async function renderStereoSide(freq, params) {
    const seconds = 0.6;
    const length = Math.round(seconds * SR);
    const ctx = new OfflineAudioContextCtor(2, length, SR);
    const st = buildStereo(ctx);
    applyStereo(st, { ...defaultParameters(), width: 1, widthLow: 1, widthMid: 1, widthHigh: 1, bassMono: 0, ...params });
    setAudition(st, 'stereo');
    const src = ctx.createBufferSource();
    src.buffer = antiPhaseFill(ctx, freq, 0.4, seconds);
    src.connect(st.input);
    st.output.connect(ctx.destination);
    src.start(0);
    return ctx.startRendering();
  }

  it('multiband wet path is flat at every mix × frequency (0.5 dB hard contract, issue #12 / #29)', async () => {
    const dry = await resolveDryDelay(SR);
    const mixes = [0, 0.25, 0.5, 0.75, 1];
    const freqs = [50, 140, 400, 1000, 3200, 8000];
    const failures = [];
    for (const mix of mixes) {
      for (const freq of freqs) {
        const r = await renderMultiband(freq, mix, dry.seconds);
        const delta = rmsSliceMonoDb(r) - REF_DB;
        const gate = mix === 0 ? DRY_GATE_DB : HARD_GATE_DB;
        if (Math.abs(delta) >= gate) {
          failures.push({ mix, freq, delta, gate });
        }
      }
    }
    if (failures.length) {
      const msg = failures
        .map((f) => `  mix ${f.mix} @ ${f.freq} Hz: Δ=${f.delta.toFixed(3)} dB (gate ±${f.gate})`)
        .join('\n');
      throw new Error(`Multiband reconstruction failed the 0.5 dB hard contract:\n${msg}`);
    }
  });

  it('stereo side path is flat at unity width (0.5 dB hard contract, issue #29)', async () => {
    const freqs = [40, 150, 250, 1000, 2000, 4000, 10000];
    const failures = [];
    for (const freq of freqs) {
      const r = await renderStereoSide(freq, {});
      const delta = rmsSliceSideDb(r) - REF_DB;
      if (Math.abs(delta) >= HARD_GATE_DB) {
        failures.push({ freq, delta });
      }
    }
    if (failures.length) {
      const msg = failures.map((f) => `  side @ ${f.freq} Hz: Δ=${f.delta.toFixed(3)} dB`).join('\n');
      throw new Error(`Stereo side unity failed the 0.5 dB hard contract:\n${msg}`);
    }
  });

  it('dry/wet impulse alignment is within 4 ms (issue #29)', async () => {
    // The same contract `tests/browser/multiband.spec.js` enforces.
    const dry = await resolveDryDelay(SR);
    const at = 128;
    const seconds = 0.08;
    const imp = (d) => {
      d.fill(0);
      d[at] = 1;
    };
    const length = Math.round(seconds * SR);
    const wetCtx = new OfflineAudioContextCtor(1, length, SR);
    {
      const mb = buildMultiband(wetCtx, { dryDelaySeconds: dry.seconds });
      applyBand(mb.compLow, mb.specMakeupLow, mb.lowMakeup, 0);
      applyBand(mb.compMid, mb.specMakeupMid, mb.midMakeup, 0);
      applyBand(mb.compHigh, mb.specMakeupHigh, mb.highMakeup, 0);
      mb.wet.gain.value = 1;
      mb.dry.gain.value = 0;
      const src = wetCtx.createBufferSource();
      const buf = wetCtx.createBuffer(1, length, SR);
      imp(buf.getChannelData(0));
      src.buffer = buf;
      src.connect(mb.input);
      mb.output.connect(wetCtx.destination);
      src.start(0);
    }
    const dryCtx = new OfflineAudioContextCtor(1, length, SR);
    {
      const mb = buildMultiband(dryCtx, { dryDelaySeconds: dry.seconds });
      applyBand(mb.compLow, mb.specMakeupLow, mb.lowMakeup, 0);
      applyBand(mb.compMid, mb.specMakeupMid, mb.midMakeup, 0);
      applyBand(mb.compHigh, mb.specMakeupHigh, mb.highMakeup, 0);
      mb.wet.gain.value = 0;
      mb.dry.gain.value = 1;
      const src = dryCtx.createBufferSource();
      const buf = dryCtx.createBuffer(1, length, SR);
      imp(buf.getChannelData(0));
      src.buffer = buf;
      src.connect(mb.input);
      mb.output.connect(dryCtx.destination);
      src.start(0);
    }
    const [wet, dryBuf] = await Promise.all([wetCtx.startRendering(), dryCtx.startRendering()]);
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
      return idx;
    };
    const deltaMs = ((peak(wet.getChannelData(0)) - peak(dryBuf.getChannelData(0))) / SR) * 1000;
    expect(Math.abs(deltaMs)).toBeLessThan(4);
  });
});
