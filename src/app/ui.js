/**
 * Signal Rot — UI layer.
 * All DOM wiring: tabs, controls, meters, scopes, waveform, presets, immersive, export, batch.
 * Communicates with the audio engine and the canonical state; never computes DSP directly.
 */
import {
  state, subscribe, setParam, setPreset, setAB, setIM, replaceState,
  undo, redo, canUndo, canRedo, loadSession, serializeSession, tryRestoreAutosave,
} from './state.js';
import { engine } from './engine.js';
import { toast, downloadJSON } from '../lib/notify.js';
import { PRESET_GROUPS } from '../lib/presets.js';
import { catalogToState, defaultState } from '../lib/params.js';
import { clamp, gainToDb, fmtTime } from '../lib/math.js';
import { MATCH_FREQS, truePeakBlock, measureLUFS } from '../lib/dsp.js';
import { LAYOUTS, SP } from '../lib/layouts.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let wavePeaks = null;
let loopRegion = null;
let dragStart = null;
let energyMom = [];
let energyST = [];
let lastReport = null;

const TAU = Math.PI * 2;

/* ---------------- tabs ---------------- */
function wireTabs() {
  $$('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.remove('on'));
      $$('.tpanel').forEach((x) => x.classList.remove('on'));
      t.classList.add('on');
      const p = document.querySelector('.tpanel[data-tab="' + t.dataset.tab + '"]');
      if (p) p.classList.add('on');
    }),
  );
}

/* ---------------- preset catalog ---------------- */
function buildPresetCards() {
  for (const g of PRESET_GROUPS) {
    const c = $(`#${g.id}Presets`);
    if (!c) continue;
    c.innerHTML = '';
    for (const pr of g.list) {
      const b = document.createElement('button');
      b.className = 'preset';
      b.dataset.name = pr.n;
      const tag = pr.t || g.tag;
      b.innerHTML = `<div class="pt">${tag}</div><div class="pn">${pr.n}</div><div class="pd">${pr.d}</div>`;
      b.onclick = () => applyPreset(pr.p, pr.n);
      c.appendChild(b);
    }
  }
}

function markPresetUI() {
  $$('.preset').forEach((b) => b.classList.toggle('on', b.dataset.name === state.preset));
}

function applyPreset(p, name) {
  const flat = defaultState();
  // Keep loudness + reference-match + texture seed unless the preset overrides them.
  flat.targetLUFS = state.P.targetLUFS;
  flat.ceiling = state.P.ceiling;
  flat.normalize = state.P.normalize;
  flat.matchGains = [...state.P.matchGains];
  flat.matchStrength = state.P.matchStrength;
  flat.textureSeed = state.P.textureSeed;
  flat.dither = state.P.dither;
  const q = catalogToState(p);
  replaceState({ ...flat, ...q }, name);
  engine.applyParams();
  scheduleAnalyze();
  toast(name);
}

/* ---------------- control sync ---------------- */
function syncControls() {
  const P = state.P;
  $('#rTarget').value = P.targetLUFS; $('#vTarget').textContent = P.targetLUFS.toFixed(1) + ' LUFS';
  $('#ceiling').value = String(P.ceiling);
  $('#rDrive').value = P.drive; $('#vDrive').textContent = P.drive.toFixed(1) + ' dB';
  $('#rWidth').value = Math.round(P.width * 100); $('#vWidth').textContent = Math.round(P.width * 100) + '%';
  $('#rMS').value = Math.round(P.ms * 100); $('#vMS').textContent = Math.round(P.ms * 100);
  $('#rBass').value = P.bassMono; $('#vBass').textContent = P.bassMono > 0 ? P.bassMono + ' Hz' : 'off';
  $('#rHaas').value = P.haas; $('#vHaas').textContent = P.haas.toFixed(1) + ' ms';
  $('#haasSide').value = String(P.haasSide);
  $('#rCF').value = Math.round(P.crossfeed * 100); $('#vCF').textContent = Math.round(P.crossfeed * 100) + '%';
  $('#rPR').value = Math.round(P.phaseRot * 100); $('#vPR').textContent = Math.round(P.phaseRot * 100) + '%';
  $('#rSpread').value = Math.round(P.spread * 100); $('#vSpread').textContent = Math.round(P.spread * 100) + '%';
  $('#rSub').value = P.sub; $('#vSub').textContent = P.sub.toFixed(1) + ' dB';
  $('#rWarm').value = P.warm; $('#vWarm').textContent = P.warm.toFixed(1) + ' dB';
  $('#rBody').value = P.body; $('#vBody').textContent = P.body.toFixed(1) + ' dB';
  $('#rHarsh').value = P.harsh; $('#vHarsh').textContent = P.harsh.toFixed(1) + ' dB';
  $('#rClar').value = P.clarity; $('#vClar').textContent = P.clarity.toFixed(1) + ' dB';
  $('#rAir').value = P.air; $('#vAir').textContent = P.air.toFixed(1) + ' dB';
  $('#rTilt').value = P.tilt; $('#vTilt').textContent = P.tilt.toFixed(1) + ' dB';
  $('#rSat').value = P.sat; $('#vSat').textContent = Math.round(P.sat) + '%';
  $('#rMbLow').value = P.mbLow; $('#vMbLow').textContent = Math.round(P.mbLow);
  $('#rMbMid').value = P.mbMid; $('#vMbMid').textContent = Math.round(P.mbMid);
  $('#rMbHigh').value = P.mbHigh; $('#vMbHigh').textContent = Math.round(P.mbHigh);
  $('#rMbMix').value = P.mbMix; $('#vMbMix').textContent = Math.round(P.mbMix) + '%';
  $('#mbSpeed').value = P.mbSpeed;
  $('#rTrA').value = P.transAttack; $('#vTrA').textContent = (P.transAttack > 0 ? '+' : '') + Math.round(P.transAttack);
  $('#rTrS').value = P.transSustain; $('#vTrS').textContent = (P.transSustain > 0 ? '+' : '') + Math.round(P.transSustain);
  $('#rWLow').value = Math.round(P.widthLow * 100); $('#vWLow').textContent = Math.round(P.widthLow * 100) + '%';
  $('#rWMid').value = Math.round(P.widthMid * 100); $('#vWMid').textContent = Math.round(P.widthMid * 100) + '%';
  $('#rWHigh').value = Math.round(P.widthHigh * 100); $('#vWHigh').textContent = Math.round(P.widthHigh * 100) + '%';
  $('#rDepth').value = P.depth; $('#vDepth').textContent = Math.round(P.depth) + '%';
  $('#depthSize').value = P.depthSize;
  $('#rTape').value = P.tape; $('#vTape').textContent = Math.round(P.tape) + '%';
  $('#rHiss').value = P.hiss; $('#vHiss').textContent = Math.round(P.hiss) + '%';
  $('#rVinyl').value = P.vinyl; $('#vVinyl').textContent = Math.round(P.vinyl) + '%';
  $('#rMatch').value = P.matchStrength; $('#vMatch').textContent = Math.round(P.matchStrength) + '%';
  $('#dither').value = P.dither;
  $('#seedVal').textContent = P.textureSeed ? String(P.textureSeed) : 'auto';
  $$('.tog[data-bind]').forEach((t) => t.classList.toggle('on', !!P[t.dataset.bind]));
  $$('#monStereo, #monMono, #monSide').forEach((b) => b.classList.toggle('on', b.dataset.m === P.monitorMode));
  $$('.solobtn').forEach((b) => b.classList.toggle('on', Number(b.dataset.solo) === P.mbSolo));
  drawMatchViz();
  updateAnalysisUI();
  updateFlow();
  updateUndoButtons();
}

function bindRange(id, key, xform, disp) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('input', () => {
    setParam(key, xform(parseFloat(el.value)));
    setPreset('Custom');
    markPresetUI();
    $(disp.el).textContent = disp.fn(state.P[key]);
    engine.applyParams();
    scheduleAnalyze();
  });
}

/* ---------------- flow view ---------------- */
const FLOW_MODULES = [
  { key: 'bypassEq', label: 'Mastering EQ', desc: 'sub · warmth · body · harshness · clarity · air · tilt' },
  { key: 'bypassMatch', label: 'Reference Match EQ', desc: '8-band tonal correction curve' },
  { key: 'bypassMB', label: 'Multiband Compressor', desc: 'LR4 @ 140 Hz / 3.2 kHz, parallel mix' },
  { key: 'bypassStereo', label: 'Stereo Field', desc: 'width · M/S · bass mono · Haas · crossfeed · phase · per-band width' },
  { key: 'bypassChar', label: 'Analog Character', desc: 'tape wow/flutter · hiss · vinyl crackle/rumble' },
  { key: 'bypassDepth', label: 'Depth Engine', desc: 'filtered early reflections' },
  { key: 'bypassSat', label: 'Saturation', desc: 'waveshaper + pre-backoff / post-makeup gain staging' },
  { key: 'bypassLimiter', label: 'True-peak Limiter', desc: 'export look-ahead limiter (preview = safety limiter)' },
];

function buildFlowView() {
  const c = $('#flowModules');
  if (!c) return;
  c.innerHTML = '';
  FLOW_MODULES.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'flowrow';
    row.innerHTML = `<div class="fidx">${i + 1}</div>
      <div class="fbody"><div class="fname">${m.label}</div><div class="fdesc">${m.desc}</div></div>
      <span class="tog on" data-bind="${m.key}" title="Bypass ${m.label}"></span>`;
    c.appendChild(row);
  });
}

function updateFlow() {
  const w = $('#flowWarnings');
  if (!w) return;
  const P = state.P;
  const items = [];
  if (P.width > 1.7 || P.widthHigh > 1.7) items.push('Extreme width — check mono compatibility.');
  if (P.haas >= 12) items.push('Large Haas delay — comb filtering / localization risk.');
  if (P.phaseRot > 0.6) items.push('Heavy side phase rotation — watch the correlation meter.');
  if (P.targetLUFS > -8) items.push('Very loud target — expect audible limiting.');
  if (P.ceiling >= -0.3) items.push('Tight ceiling — lossy encoders may overshoot on playback.');
  if (P.normalize && P.bassMono === 0) items.push('Bass mono is off — check low-frequency stereo width.');
  w.innerHTML = items.map((t) => `<div class="warn">⚠ ${t}</div>`).join('');
}

/* ---------------- meters / scopes / waveform ---------------- */
function updateUndoButtons() {
  $('#undoBtn').disabled = !canUndo();
  $('#redoBtn').disabled = !canRedo();
}

function updateTime() {
  if (!engine.srcBuffer) return;
  $('#timeLabel').textContent = fmtTime(engine.currentPos()) + ' / ' + fmtTime(engine.srcBuffer.duration);
  if (engine.playing && loopRegion && engine.currentPos() >= loopRegion[1]) {
    engine.startPlayback(loopRegion[0]);
  }
}

function computePeaks(buf, buckets) {
  const ch = buf.numberOfChannels;
  const len = buf.length;
  const step = Math.floor(len / buckets) || 1;
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  const peaks = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    let mx = 0;
    const s = b * step;
    const e = Math.min(len, s + step);
    for (let i = s; i < e; i++) {
      let v = 0;
      for (let c = 0; c < ch; c++) v = Math.max(v, Math.abs(data[c][i]));
      if (v > mx) mx = v;
    }
    peaks[b] = mx;
  }
  return peaks;
}

function drawWaveOverview() {
  const cv = $('#wave');
  const dpr = devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = 120;
  cv.width = w * dpr;
  cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  if (!engine.srcBuffer) return;
  if (!wavePeaks || wavePeaks._w !== w) {
    wavePeaks = computePeaks(engine.srcBuffer, w);
    wavePeaks._w = w;
  }
  const css = getComputedStyle(document.documentElement);
  const mid = h / 2;
  g.strokeStyle = css.getPropertyValue('--grid');
  g.beginPath();
  g.moveTo(0, mid);
  g.lineTo(w, mid);
  g.stroke();
  const col = state.abMode === 'A' ? css.getPropertyValue('--orig') : css.getPropertyValue('--proc');
  g.fillStyle = col;
  for (let x = 0; x < w; x++) {
    const p = wavePeaks[x] || 0;
    const ph = p * (h * 0.46);
    g.fillRect(x, mid - ph, 1, ph * 2);
  }
  if (loopRegion) {
    const a = (loopRegion[0] / engine.srcBuffer.duration) * w;
    const b = (loopRegion[1] / engine.srcBuffer.duration) * w;
    g.fillStyle = col.trim() + '22';
    g.fillRect(Math.min(a, b), 0, Math.abs(b - a), h);
  }
  const px = (engine.currentPos() / engine.srcBuffer.duration) * w;
  g.strokeStyle = css.getPropertyValue('--text');
  g.globalAlpha = 0.8;
  g.beginPath();
  g.moveTo(px, 0);
  g.lineTo(px, h);
  g.stroke();
  g.globalAlpha = 1;
}

function wireWaveform() {
  const cv = $('#wave');
  cv.addEventListener('mousedown', (e) => {
    if (!engine.srcBuffer) return;
    const r = e.currentTarget.getBoundingClientRect();
    dragStart = ((e.clientX - r.left) / r.width) * engine.srcBuffer.duration;
  });
  cv.addEventListener('mousemove', (e) => {
    if (dragStart == null || !engine.srcBuffer) return;
    const r = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * engine.srcBuffer.duration;
    if (Math.abs(t - dragStart) > 0.15) loopRegion = [dragStart, t];
  });
  window.addEventListener('mouseup', (e) => {
    if (dragStart == null) return;
    const cv2 = $('#wave');
    const r = cv2.getBoundingClientRect();
    const t = clamp((e.clientX - r.left) / r.width, 0, 1) * engine.srcBuffer.duration;
    if (loopRegion && Math.abs(loopRegion[1] - loopRegion[0]) > 0.15) {
      loopRegion = [Math.min(...loopRegion), Math.max(...loopRegion)];
    } else {
      loopRegion = null;
      engine.offsetAt = t;
      if (engine.playing) engine.startPlayback(t);
    }
    dragStart = null;
  });
}

function drawSpectrum() {
  const cv = $('#spectrum');
  const dpr = devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = 190;
  if (cv.width !== w * dpr) {
    cv.width = w * dpr;
    cv.height = h * dpr;
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  g.strokeStyle = css.getPropertyValue('--grid');
  g.lineWidth = 1;
  [0.25, 0.5, 0.75].forEach((f) => {
    g.beginPath();
    g.moveTo(0, h * f);
    g.lineTo(w, h * f);
    g.stroke();
  });
  const a = engine.nodes.anaPost;
  const N = a.frequencyBinCount;
  const fd = new Uint8Array(N);
  a.getByteFrequencyData(fd);
  const nyq = engine.AC.sampleRate / 2;
  const fmin = 20;
  const fmax = Math.min(nyq, 22000);
  const col = state.abMode === 'A' ? css.getPropertyValue('--orig') : css.getPropertyValue('--proc');
  const lx = Math.log10(fmin);
  const rx = Math.log10(fmax);
  g.beginPath();
  for (let x = 0; x <= w; x++) {
    const fr = Math.pow(10, lx + ((rx - lx) * x) / w);
    const bin = Math.round((fr / nyq) * N);
    const v = (fd[clamp(bin, 0, N - 1)] || 0) / 255;
    const y = h - v * h * 0.96;
    if (x === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.lineTo(w, h);
  g.lineTo(0, h);
  g.closePath();
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, col.trim() + 'cc');
  grad.addColorStop(1, col.trim() + '10');
  g.fillStyle = grad;
  g.fill();
  g.strokeStyle = col;
  g.lineWidth = 1.4;
  g.stroke();
  g.fillStyle = css.getPropertyValue('--faint');
  g.font = '9px ui-monospace';
  [100, 1000, 10000].forEach((f) => {
    const x = ((Math.log10(f) - lx) / (rx - lx)) * w;
    g.fillText(f >= 1000 ? f / 1000 + 'k' : f, x + 2, h - 4);
  });
}

function drawGonio() {
  const cv = $('#gonio');
  const dpr = devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = 190;
  if (cv.width !== w * dpr) {
    cv.width = w * dpr;
    cv.height = h * dpr;
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = 'rgba(6,8,10,.34)';
  g.fillRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * 0.42;
  g.strokeStyle = css.getPropertyValue('--grid');
  g.lineWidth = 1;
  g.beginPath();
  g.arc(cx, cy, R, 0, TAU);
  g.moveTo(cx - R, cy);
  g.lineTo(cx + R, cy);
  g.moveTo(cx, cy - R);
  g.lineTo(cx, cy + R);
  g.stroke();
  g.save();
  g.translate(cx, cy);
  g.rotate(-Math.PI / 4);
  g.strokeStyle = css.getPropertyValue('--line2');
  g.beginPath();
  g.moveTo(-R, 0);
  g.lineTo(R, 0);
  g.moveTo(0, -R);
  g.lineTo(0, R);
  g.stroke();
  g.restore();
  const dL = new Float32Array(engine.nodes.anaL.fftSize);
  const dR = new Float32Array(engine.nodes.anaR.fftSize);
  engine.nodes.anaL.getFloatTimeDomainData(dL);
  engine.nodes.anaR.getFloatTimeDomainData(dR);
  const col = state.abMode === 'A' ? css.getPropertyValue('--orig') : css.getPropertyValue('--proc');
  g.fillStyle = col.trim() + 'aa';
  const step = 4;
  for (let i = 0; i < dL.length; i += step) {
    const m = (dL[i] + dR[i]) * 0.5;
    const s = (dL[i] - dR[i]) * 0.5;
    const x = cx + s * R * 1.4;
    const y = cy - m * R * 1.4;
    g.fillRect(x, y, 1.4, 1.4);
  }
}

function setBar(sel, frac) {
  const i = $(sel);
  if (i) i.style.width = clamp(frac * 100, 0, 100) + '%';
}

function updateMeters() {
  if (!engine.nodes.anaK) return;
  const dK = new Float32Array(engine.nodes.anaK.fftSize);
  engine.nodes.anaK.getFloatTimeDomainData(dK);
  let ms = 0;
  for (let i = 0; i < dK.length; i++) ms += dK[i] * dK[i];
  ms /= dK.length;
  energyMom.push(ms);
  if (energyMom.length > 10) energyMom.shift();
  energyST.push(ms);
  if (energyST.length > 75) energyST.shift();
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
  const mom = -0.691 + 10 * Math.log10(Math.max(1e-12, avg(energyMom)));
  const st = -0.691 + 10 * Math.log10(Math.max(1e-12, avg(energyST)));
  $('#mMom').textContent = Number.isFinite(mom) ? mom.toFixed(1) : '—';
  $('#mST').textContent = Number.isFinite(st) ? st.toFixed(1) : '—';
  setBar('#barST', (st + 40) / 40);

  const dL = new Float32Array(engine.nodes.anaL.fftSize);
  const dR = new Float32Array(engine.nodes.anaR.fftSize);
  engine.nodes.anaL.getFloatTimeDomainData(dL);
  engine.nodes.anaR.getFloatTimeDomainData(dR);
  const tp = Math.max(truePeakBlock(dL), truePeakBlock(dR));
  const tpdb = gainToDb(tp);
  $('#mTP').textContent = Number.isFinite(tpdb) ? (tpdb > 0 ? '+' : '') + tpdb.toFixed(1) : '—';
  $('#mTP').style.color = tpdb > state.P.ceiling ? 'var(--hot)' : 'var(--text)';
  setBar('#barTP', (tpdb + 12) / 12);

  let sLR = 0;
  let sLL = 0;
  let sRR = 0;
  for (let i = 0; i < dL.length; i++) {
    sLR += dL[i] * dR[i];
    sLL += dL[i] * dL[i];
    sRR += dR[i] * dR[i];
  }
  const corr = sLR / Math.max(1e-9, Math.sqrt(sLL * sRR));
  $('#mCorr').textContent = Number.isFinite(corr) ? corr.toFixed(2) : '—';
  $('#mCorr').style.color = corr < 0 ? 'var(--hot)' : corr < 0.3 ? 'var(--proc)' : 'var(--text)';
  $('#mCorrTxt').textContent = corr < 0 ? '⚠ phase risk' : corr > 0.85 ? 'near mono' : 'wide';
  setBar('#barCorr', (corr + 1) / 2);

  let rms = 0;
  for (let i = 0; i < dL.length; i++) rms += (dL[i] * dL[i] + dR[i] * dR[i]) * 0.5;
  rms = Math.sqrt(rms / dL.length);
  $('#mRMS').textContent = Number.isFinite(gainToDb(rms)) ? gainToDb(rms).toFixed(0) : '—';
}

function updateGR() {
  if (!engine.nodes.compLo) return;
  const rd = (n) => (n && n.reduction ? -n.reduction.value : 0);
  $('#grLow').textContent = 'GR −' + rd(engine.nodes.compLo).toFixed(1) + ' dB';
  $('#grMid').textContent = 'GR −' + rd(engine.nodes.compMid).toFixed(1) + ' dB';
  $('#grHigh').textContent = 'GR −' + rd(engine.nodes.compHi).toFixed(1) + ' dB';
}

function updateAnalysisUI() {
  const a = state.abMode === 'A' ? engine.analysis.orig : engine.analysis.proc;
  if (a) {
    $('#mLUFS').textContent = Number.isFinite(a.lufs) ? a.lufs.toFixed(1) : '—';
    $('#mLRA').textContent = Number.isFinite(a.lra) ? a.lra.toFixed(1) : '—';
    setBar('#barLUFS', (a.lufs + 40) / 40);
    setBar('#barLRA', a.lra / 20);
  }
  $('#mLUFSsub').textContent = state.P.normalize ? 'target ' + state.P.targetLUFS.toFixed(1) : 'no norm';
  $('#mTPsub').textContent = 'ceiling ' + state.P.ceiling.toFixed(1) + ' dBTP';
  const css = getComputedStyle(document.documentElement);
  $('#mLUFS').style.color =
    state.abMode === 'A' ? css.getPropertyValue('--orig') : css.getPropertyValue('--proc');
}

function drawMatchViz() {
  const cv = $('#matchViz');
  if (!cv || !cv.clientWidth) return;
  const dpr = devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight || 120;
  if (cv.width !== w * dpr) {
    cv.width = w * dpr;
    cv.height = h * dpr;
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const proc = css.getPropertyValue('--proc').trim();
  const line = css.getPropertyValue('--line2').trim();
  const faint = css.getPropertyValue('--faint').trim();
  g.strokeStyle = line;
  g.beginPath();
  g.moveTo(0, h / 2);
  g.lineTo(w, h / 2);
  g.stroke();
  const bw = w / MATCH_FREQS.length;
  g.font = '9px ui-monospace';
  g.fillStyle = faint;
  MATCH_FREQS.forEach((f, i) => {
    const gv = (state.P.matchGains[i] || 0) * (state.P.matchStrength / 100);
    const bh = (-gv / 8) * (h / 2 - 14);
    g.fillStyle = proc;
    g.globalAlpha = 0.75;
    g.fillRect(i * bw + bw * 0.2, Math.min(h / 2, h / 2 + bh), bw * 0.6, Math.abs(bh));
    g.globalAlpha = 1;
    g.fillStyle = faint;
    const lab = f >= 1000 ? f / 1000 + 'k' : f;
    g.fillText(lab, i * bw + bw / 2 - g.measureText(String(lab)).width / 2, h - 4);
  });
}

function scheduleAnalyze(immediate) {
  engine.scheduleAnalyze(immediate);
}

/* ---------------- speaker map ---------------- */
function drawSpeakerMap() {
  const cv = $('#spkmap');
  if (!cv) return;
  const dpr = devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = 210;
  if (cv.width !== w * dpr) {
    cv.width = w * dpr;
    cv.height = h * dpr;
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * 0.4;
  g.strokeStyle = css.getPropertyValue('--line2');
  g.lineWidth = 1;
  g.beginPath();
  g.arc(cx, cy, R, 0, TAU);
  g.stroke();
  g.beginPath();
  g.arc(cx, cy, R * 0.5, 0, TAU);
  g.setLineDash([3, 4]);
  g.strokeStyle = css.getPropertyValue('--grid');
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = css.getPropertyValue('--faint');
  g.beginPath();
  g.arc(cx, cy, 3, 0, TAU);
  g.fill();
  g.font = '9px ui-monospace';
  g.fillText('▲', cx - 3, cy - 6);

  let lvlL = 0;
  let lvlR = 0;
  let lvlS = 0;
  let lvlM = 0;
  if (engine.nodes.anaL) {
    const dL = new Float32Array(engine.nodes.anaL.fftSize);
    const dR = new Float32Array(engine.nodes.anaR.fftSize);
    engine.nodes.anaL.getFloatTimeDomainData(dL);
    engine.nodes.anaR.getFloatTimeDomainData(dR);
    for (let i = 0; i < dL.length; i++) {
      lvlL += dL[i] * dL[i];
      lvlR += dR[i] * dR[i];
      const s = (dL[i] - dR[i]) * 0.5;
      const m = (dL[i] + dR[i]) * 0.5;
      lvlS += s * s;
      lvlM += m * m;
    }
    const n = dL.length;
    lvlL = Math.sqrt(lvlL / n);
    lvlR = Math.sqrt(lvlR / n);
    lvlS = Math.sqrt(lvlS / n);
    lvlM = Math.sqrt(lvlM / n);
  }
  const dbToGainUI = (db) => Math.pow(10, db / 20);
  const IM = state.IM;
  const lvlFor = (k) => {
    const sp = SP[k];
    if (sp.lfe) return lvlM * dbToGainUI(IM.lfeLevel);
    if (k === 'C') return lvlM * IM.centerExtract;
    if (k === 'L' || k === 'SL1') return lvlL;
    if (k === 'R' || k === 'SL2') return lvlR;
    if (sp.el > 0) return lvlS * dbToGainUI(IM.heightLevel);
    return lvlS * dbToGainUI(IM.surrLevel);
  };
  const proc = css.getPropertyValue('--proc').trim();
  const orig = css.getPropertyValue('--orig').trim();
  LAYOUTS[IM.layout].forEach((k) => {
    const sp = SP[k];
    const a = (sp.az * Math.PI) / 180;
    const rr = sp.el > 0 ? R * 0.55 : k === 'Lw' || k === 'Rw' ? R * 0.9 : R;
    const x = cx + Math.sin(a) * rr;
    const y = cy - Math.cos(a) * rr * 0.82;
    const lv = clamp(lvlFor(k) * 6, 0, 1);
    const col = sp.el > 0 ? orig : proc;
    g.beginPath();
    g.fillStyle = col;
    g.globalAlpha = 0.22 + lv * 0.78;
    g.arc(x, y, sp.lfe ? 5 : 6.5, 0, TAU);
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = col;
    g.globalAlpha = 0.5;
    g.beginPath();
    g.arc(x, y, 6.5, 0, TAU);
    g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = css.getPropertyValue('--muted');
    g.font = '8px ui-monospace';
    g.fillText(k, x - g.measureText(k).width / 2, y + 15);
  });
  g.fillStyle = css.getPropertyValue('--faint');
  g.font = '9px ui-monospace';
  g.fillText(
    IM.layout + '  ·  ' + LAYOUTS[IM.layout].length + 'ch  ·  ' + (IM.target === 'adm' ? 'ADM BWF' : IM.target === 'binaural' ? 'binaural' : 'WAV'),
    8,
    h - 7,
  );
  g.fillStyle = orig;
  g.fillText('● height', w - 66, 14);
  g.fillStyle = proc;
  g.fillText('● bed', w - 66, 26);
}

/* ---------------- render report ---------------- */
function showReport(report, name) {
  lastReport = report;
  const box = $('#reportBox');
  if (!box) return;
  const lines = [
    `${report.engine} v${report.engineVersion} — ${report.timestamp}`,
    `file: ${name}`,
    `preset: ${report.preset}`,
    `source: ${report.source.name} @ ${report.source.sampleRate} Hz (${report.source.durationSeconds}s)`,
    `LUFS before → after: ${fmtDb(report.analysisBefore.lufs)} → ${fmtDb(report.analysisAfter.lufs)}`,
    `true peak before → after: ${fmtDb(report.analysisBefore.truePeakDbtp)} → ${fmtDb(report.analysisAfter.truePeakDbtp)} dBTP`,
    `normalization gain: ${report.normalizationGainDb.toFixed(2)} dB`,
    `max gain reduction: ${report.maximumGainReductionDb.toFixed(2)} dB`,
    `ceiling: ${report.requestedCeilingDbtp} dBTP (measured ${report.measuredTruePeakDbtp.toFixed(2)} dBTP)`,
    report.ceilingExceeded ? '⚠ ceiling EXCEEDED' : '✓ ceiling respected',
    `seed: ${report.textureSeed} · dither: ${report.dither} · render ${report.renderSeconds}s`,
  ];
  box.textContent = lines.join('\n');
}

function fmtDb(v) {
  return Number.isFinite(v) ? v.toFixed(1) : '−∞';
}

function runDiagnostics() {
  const d = engine.diagnostics();
  const lines = [
    `engine v${d.engineVersion}`,
    `AudioContext: ${d.audioContext ? 'yes' : 'no'}`,
    `OfflineAudioContext: ${d.offlineAudioContext ? 'yes' : 'no'}`,
    `Web Worker: ${d.webWorker ? 'yes' : 'no'}`,
    `context sample rate: ${d.contextSampleRate || 'n/a'}`,
    `offline rates supported: ${d.supportedSampleRates.map((s) => s / 1000 + 'k').join(', ') || 'n/a'}`,
    `device memory: ${d.deviceMemory ?? '?'} GB · cores: ${d.hardwareConcurrency ?? '?'}`,
    `UA: ${d.userAgent}`,
  ];
  $('#diag').textContent = lines.join('\n');
}

/* ---------------- export / batch / immersive wiring ---------------- */
async function doExport(fmtSel, srSel) {
  if (!engine.srcBuffer) {
    toast('Load a file first');
    return;
  }
  const prog = $('#exProg');
  prog.classList.add('on');
  prog.querySelector('i').style.width = '8%';
  $('#exportBtn').disabled = true;
  try {
    await new Promise((r) => setTimeout(r, 30));
    prog.querySelector('i').style.width = '45%';
    const report = await engine.doExport(fmtSel, srSel, showReport);
    prog.querySelector('i').style.width = '100%';
    if (report) {
      toast('Exported ' + report.format.container + ' · ' + (report.format.sampleRate / 1000) + 'kHz');
      if (report.ceilingExceeded) {
        toast('⚠ Ceiling exceeded in final file — see report');
      }
    }
  } catch (e) {
    toast('Export failed: ' + e.message);
    console.error(e);
  }
  $('#exportBtn').disabled = false;
  setTimeout(() => prog.classList.remove('on'), 600);
}

function renderBatch() {
  const c = $('#batchList');
  c.innerHTML = '';
  engine.batch.files.forEach((it, idx) => {
    const r = document.createElement('div');
    r.className = 'brow';
    r.innerHTML = `<span class="nm">${it.name}</span><span class="lu">${it.lufs != null ? it.lufs.toFixed(1) + ' LUFS' : '…'}</span><span class="x">✕</span>`;
    r.querySelector('.x').onclick = () => {
      engine.batch.files.splice(idx, 1);
      renderBatch();
    };
    c.appendChild(r);
  });
  $('#batchRun').disabled = engine.batch.files.length === 0;
}

async function analyzeBatch() {
  for (const it of engine.batch.files) {
    if (it.lufs == null) {
      const winLen = Math.min(it.buf.length, it.buf.sampleRate * 90);
      const view = {
        numberOfChannels: it.buf.numberOfChannels,
        sampleRate: it.buf.sampleRate,
        length: winLen,
        getChannelData: (c) => it.buf.getChannelData(c).subarray(0, winLen),
      };
      it.lufs = measureLUFS(view).lufs;
      renderBatch();
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

async function batchRun() {
  if (!engine.batch.files.length) return;
  const fmt = $('#fmt').value;
  const srSel = parseInt($('#srOut').value) || 0;
  const prog = $('#batchProg');
  prog.classList.add('on');
  $('#batchRun').disabled = true;
  await engine.batchRun(
    fmt,
    srSel,
    (i, total, name) => {
      prog.querySelector('i').style.width = (i / total) * 100 + '%';
      toast(`Rendering ${i + 1}/${total}: ${name}`);
    },
    (reports) => {
      prog.querySelector('i').style.width = '100%';
      if (reports && reports.length) showReport(reports[reports.length - 1], 'batch (last)');
      toast('Batch complete · ' + engine.batch.files.length + ' tracks @ ' + state.P.targetLUFS + ' LUFS');
      $('#batchRun').disabled = false;
      setTimeout(() => prog.classList.remove('on'), 800);
    },
  );
}

function imRefreshNote() {
  const t = state.IM.target;
  const base = $('#imNote').dataset.base || $('#imNote').innerHTML;
  $('#imNote').dataset.base = base;
  const extra =
    t === 'adm'
      ? ' ADM BWF here is an uncompressed BS.2076-style interchange bed; the licensed Atmos/360RA/MPEG-H final encode runs in those platform tools, not the browser.'
      : t === 'binaural'
        ? ' Binaural here is a fixed HRTF fold-down of the bed — not a head-tracked renderer.'
        : '';
  $('#imNote').innerHTML = base + extra;
}

function imBind(id, key, fn, disp) {
  $(id).addEventListener('input', (e) => {
    setIM(key, fn(parseFloat(e.target.value)));
    $(disp.el).textContent = disp.fn(state.IM[key]);
    if (state.IM.binPreview) engine.buildPreview();
  });
}

async function renderImmersive() {
  if (!engine.srcBuffer) {
    toast('Load a file first');
    return;
  }
  const prog = $('#imProg');
  prog.classList.add('on');
  prog.querySelector('i').style.width = '8%';
  $('#imExport').disabled = true;
  try {
    await new Promise((r) => setTimeout(r, 30));
    const res = await engine.renderImmersive($('#fmt').value, parseInt($('#srOut').value) || 0);
    prog.querySelector('i').style.width = '100%';
    if (res) toast('Rendered ' + res.layout + ' · ' + res.target);
  } catch (e) {
    toast('Immersive render failed: ' + e.message);
    console.error(e);
  }
  $('#imExport').disabled = false;
  setTimeout(() => prog.classList.remove('on'), 700);
}

/* ---------------- main animation loop ---------------- */
function loop() {
  requestAnimationFrame(loop);
  if (!engine.nodes.anaPost) return;
  drawSpectrum();
  drawGonio();
  drawWaveOverview();
  updateMeters();
  updateGR();
  updateTime();
  if (state.IM.layout !== 'off') drawSpeakerMap();
}

/* ---------------- boot ---------------- */
export function boot() {
  // Engine → UI callbacks.
  engine._onPlayState = () => {
    $('#playBtn').textContent = engine.playing ? '❚❚' : '▶';
  };
  engine.onAnalysis(() => {
    updateAnalysisUI();
    engine.applyParams();
  });
  engine.initWorkerHandlers();

  wireTabs();
  buildPresetCards();
  buildFlowView();
  wireWaveform();
  syncControls();
  markPresetUI();
  updateUndoButtons();

  // Restore autosaved session (after initial sync so a fresh load is also consistent).
  if (tryRestoreAutosave()) {
    syncControls();
    engine.applyParams();
    toast('Session restored');
  }

  // Transport.
  $('#playBtn').onclick = engine.togglePlay;
  $('#stopBtn').onclick = engine.stopPlayback;
  $('#reanalyze').onclick = () => {
    toast('Re-analyzing…');
    engine.runAnalyze();
  };
  $('#abA').onclick = () => setABMode('A');
  $('#abB').onclick = () => setABMode('B');
  function setABMode(m) {
    setAB(m);
    $('#abA').classList.toggle('on', m === 'A');
    $('#abB').classList.toggle('on', m === 'B');
    engine.applyParams();
    updateAnalysisUI();
  }
  $('#matchTog').onclick = () => {
    state.matchLoud = !state.matchLoud;
    $('#matchTog').classList.toggle('on', state.matchLoud);
    engine.applyParams();
  };

  // Monitor matrix.
  $$('#monStereo, #monMono, #monSide').forEach((b) =>
    b.addEventListener('click', () => {
      setParam('monitorMode', b.dataset.m);
      setPreset('Custom');
      engine.applyParams();
    }),
  );

  // Undo / redo.
  $('#undoBtn').onclick = () => {
    if (undo()) {
      syncControls();
      markPresetUI();
      engine.applyParams();
      scheduleAnalyze();
    }
  };
  $('#redoBtn').onclick = () => {
    if (redo()) {
      syncControls();
      markPresetUI();
      engine.applyParams();
      scheduleAnalyze();
    }
  };

  // Import.
  $('#importBtn').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (e) => {
    if (e.target.files[0]) importFile(e.target.files[0]);
  };
  $('#dropzone').onclick = () => $('#fileInput').click();
  const dz = $('#dropzone');
  ['dragover', 'dragenter'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add('hot');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove('hot');
    }),
  );
  dz.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f) importFile(f);
  });
  window.addEventListener('drop', (e) => e.preventDefault());
  window.addEventListener('dragover', (e) => e.preventDefault());

  // Range bindings.
  bindRange('#rTarget', 'targetLUFS', (v) => v, { el: '#vTarget', fn: (v) => v.toFixed(1) + ' LUFS' });
  bindRange('#rDrive', 'drive', (v) => v, { el: '#vDrive', fn: (v) => v.toFixed(1) + ' dB' });
  bindRange('#rWidth', 'width', (v) => v / 100, { el: '#vWidth', fn: (v) => Math.round(v * 100) + '%' });
  bindRange('#rMS', 'ms', (v) => v / 100, { el: '#vMS', fn: (v) => Math.round(v * 100) });
  bindRange('#rBass', 'bassMono', (v) => v, { el: '#vBass', fn: (v) => (v > 0 ? v + ' Hz' : 'off') });
  bindRange('#rHaas', 'haas', (v) => v, { el: '#vHaas', fn: (v) => v.toFixed(1) + ' ms' });
  bindRange('#rCF', 'crossfeed', (v) => v / 100, { el: '#vCF', fn: (v) => Math.round(v * 100) + '%' });
  bindRange('#rPR', 'phaseRot', (v) => v / 100, { el: '#vPR', fn: (v) => Math.round(v * 100) + '%' });
  bindRange('#rSpread', 'spread', (v) => v / 100, { el: '#vSpread', fn: (v) => Math.round(v * 100) + '%' });
  bindRange('#rSub', 'sub', (v) => v, { el: '#vSub', fn: (v) => v.toFixed(1) + ' dB' });
  bindRange('#rWarm', 'warm', (v) => v, { el: '#vWarm', fn: (v) => v.toFixed(1) + ' dB' });
  bindRange('#rBody', 'body', (v) => v, { el: '#vBody', fn: (v) => v.toFixed(1) + ' dB' });
  bindRange('#rHarsh', 'harsh', (v) => v, { el: '#vHarsh', fn: (v) => v.toFixed(1) + ' dB' });
  bindRange('#rClar', 'clarity', (v) => v, { el: '#vClar', fn: (v) => v.toFixed(1) + ' dB' });
  bindRange('#rAir', 'air', (v) => v, { el: '#vAir', fn: (v) => v.toFixed(1) + ' dB' });
  bindRange('#rTilt', 'tilt', (v) => v, { el: '#vTilt', fn: (v) => v.toFixed(1) + ' dB' });
  bindRange('#rSat', 'sat', (v) => v, { el: '#vSat', fn: (v) => Math.round(v) + '%' });
  bindRange('#rMbLow', 'mbLow', (v) => v, { el: '#vMbLow', fn: (v) => Math.round(v) });
  bindRange('#rMbMid', 'mbMid', (v) => v, { el: '#vMbMid', fn: (v) => Math.round(v) });
  bindRange('#rMbHigh', 'mbHigh', (v) => v, { el: '#vMbHigh', fn: (v) => Math.round(v) });
  bindRange('#rMbMix', 'mbMix', (v) => v, { el: '#vMbMix', fn: (v) => Math.round(v) + '%' });
  bindRange('#rTrA', 'transAttack', (v) => v, { el: '#vTrA', fn: (v) => (v > 0 ? '+' : '') + Math.round(v) });
  bindRange('#rTrS', 'transSustain', (v) => v, { el: '#vTrS', fn: (v) => (v > 0 ? '+' : '') + Math.round(v) });
  bindRange('#rWLow', 'widthLow', (v) => v / 100, { el: '#vWLow', fn: (v) => Math.round(v * 100) + '%' });
  bindRange('#rWMid', 'widthMid', (v) => v / 100, { el: '#vWMid', fn: (v) => Math.round(v * 100) + '%' });
  bindRange('#rWHigh', 'widthHigh', (v) => v / 100, { el: '#vWHigh', fn: (v) => Math.round(v * 100) + '%' });
  bindRange('#rDepth', 'depth', (v) => v, { el: '#vDepth', fn: (v) => Math.round(v) + '%' });
  bindRange('#rTape', 'tape', (v) => v, { el: '#vTape', fn: (v) => Math.round(v) + '%' });
  bindRange('#rHiss', 'hiss', (v) => v, { el: '#vHiss', fn: (v) => Math.round(v) + '%' });
  bindRange('#rVinyl', 'vinyl', (v) => v, { el: '#vVinyl', fn: (v) => Math.round(v) + '%' });
  bindRange('#rMatch', 'matchStrength', (v) => v, { el: '#vMatch', fn: (v) => Math.round(v) + '%' });

  // Selects.
  $('#mbSpeed').addEventListener('change', (e) => {
    setParam('mbSpeed', e.target.value);
    setPreset('Custom');
    engine.applyParams();
    scheduleAnalyze();
  });
  $('#depthSize').addEventListener('change', (e) => {
    setParam('depthSize', e.target.value);
    setPreset('Custom');
    engine.applyParams();
    scheduleAnalyze();
  });
  $('#ceiling').addEventListener('change', (e) => {
    setParam('ceiling', parseFloat(e.target.value));
    engine.applyParams();
    updateAnalysisUI();
  });
  $('#haasSide').addEventListener('change', (e) => {
    setParam('haasSide', parseInt(e.target.value));
    engine.applyParams();
  });
  $('#dither').addEventListener('change', (e) => {
    setParam('dither', e.target.value);
    engine.applyParams();
  });

  // Generic data-bind toggles (normalize, binaural, mb band bypass).
  $$('.tog[data-bind]').forEach((t) =>
    t.addEventListener('click', () => {
      setParam(t.dataset.bind, !state.P[t.dataset.bind]);
      setPreset('Custom');
      markPresetUI();
      engine.applyParams();
      scheduleAnalyze();
    }),
  );

  // Solo buttons.
  $$('.solobtn').forEach((b) =>
    b.addEventListener('click', () => {
      setParam('mbSolo', Number(b.dataset.solo));
      setPreset('Custom');
      engine.applyParams();
      scheduleAnalyze();
    }),
  );

  // Texture seed.
  $('#seedDice').onclick = () => {
    engine.rollSeed();
    setPreset('Custom');
    syncControls();
    scheduleAnalyze();
    toast('New texture seed: ' + state.P.textureSeed);
  };

  // Reference match.
  $('#refLoad').onclick = () => $('#refInput').click();
  $('#refInput').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (!engine.AC) {
      try {
        engine.AC = engine.createAudioContext();
      } catch (err) {
        toast('Web Audio unavailable');
        return;
      }
    }
    try {
      const ab = await f.arrayBuffer();
      engine.refBuffer = await engine.AC.decodeAudioData(ab.slice(0));
      engine.refName = f.name;
      $('#refName').textContent = 'Reference: ' + f.name + ' · ' + engine.refBuffer.duration.toFixed(1) + 's';
      toast('Reference loaded');
    } catch (err) {
      toast("Couldn't decode reference");
    }
  };
  $('#matchBtn').onclick = () => {
    if (!engine.computeMatch()) return;
    $('#rMatch').value = state.P.matchStrength;
    $('#vMatch').textContent = Math.round(state.P.matchStrength) + '%';
    engine.applyParams();
    scheduleAnalyze();
    drawMatchViz();
    toast('Matched — curve: ' + state.P.matchGains.map((g) => (g > 0 ? '+' : '') + g).join(', ') + ' dB');
  };

  // Reset.
  $('#resetParams').onclick = () => applyPreset({}, 'Transparent');

  // Preset save/load.
  $('#savePreset').onclick = () => {
    downloadJSON(serializeSession(), baseNameSafe() + '_signalrot.json');
    toast('Session saved');
  };
  $('#loadPreset').onclick = () => $('#presetInput').click();
  $('#presetInput').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const res = loadSession(j);
      if (!res.ok) {
        toast(res.message);
        return;
      }
      syncControls();
      markPresetUI();
      engine.applyParams();
      scheduleAnalyze();
      toast('Session loaded');
    } catch (err) {
      toast('Bad session file');
    }
  };

  // Theme.
  $('#theme').onclick = () => {
    const r = document.documentElement;
    r.dataset.theme = r.dataset.theme === 'dark' ? 'light' : 'dark';
  };

  // Export.
  $$('.expbtn').forEach((b) =>
    b.addEventListener('click', () => {
      $('#fmt').value = b.dataset.fmt;
      $('#srOut').value = b.dataset.sr;
      doExport(b.dataset.fmt, parseInt(b.dataset.sr) || 0);
    }),
  );
  $('#exportBtn').onclick = () => doExport($('#fmt').value, parseInt($('#srOut').value) || 0);
  $('#reportJson').onclick = () => {
    if (lastReport) downloadJSON(lastReport, baseNameSafe() + '_report.json');
    else toast('No render yet');
  };
  $('#diagBtn').onclick = runDiagnostics;

  // Batch.
  $('#batchAdd').onclick = () => $('#batchInput').click();
  $('#batchInput').onchange = async (e) => {
    if (!e.target.files.length) return;
    await engine.batchAddFiles([...e.target.files]);
    renderBatch();
    analyzeBatch();
  };
  $('#batchRun').onclick = batchRun;

  // Immersive.
  $('#imLayout').addEventListener('change', (e) => {
    setIM('layout', e.target.value);
    if (state.IM.layout === 'off') {
      engine.teardownImmersivePreview();
      $('#imPrevTog').classList.remove('on');
      setIM('binPreview', false);
    } else if (state.IM.binPreview) {
      engine.buildPreview();
    }
  });
  $('#imTarget').addEventListener('change', (e) => {
    setIM('target', e.target.value);
    imRefreshNote();
  });
  imBind('#rImC', 'centerExtract', (v) => v / 100, { el: '#vImC', fn: (v) => Math.round(v * 100) + '%' });
  imBind('#rImS', 'surrLevel', (v) => v, { el: '#vImS', fn: (v) => v.toFixed(1) + ' dB' });
  imBind('#rImSd', 'surrDelay', (v) => v, { el: '#vImSd', fn: (v) => Math.round(v) + ' ms' });
  imBind('#rImH', 'heightLevel', (v) => v, { el: '#vImH', fn: (v) => v.toFixed(1) + ' dB' });
  imBind('#rImHd', 'heightDecorr', (v) => v / 100, { el: '#vImHd', fn: (v) => Math.round(v * 100) + '%' });
  imBind('#rImLf', 'lfeFreq', (v) => v, { el: '#vImLf', fn: (v) => Math.round(v) + ' Hz' });
  imBind('#rImLl', 'lfeLevel', (v) => v, { el: '#vImLl', fn: (v) => Math.round(v) + ' dB' });
  imBind('#rImFr', 'frontRear', (v) => v / 100, { el: '#vImFr', fn: (v) => (v < 0.45 ? 'front' : v > 0.55 ? 'surround' : 'center') });
  $('#imPrevTog').addEventListener('click', () => {
    if (state.IM.layout === 'off') {
      toast('Pick a layout first');
      return;
    }
    setIM('binPreview', !state.IM.binPreview);
    $('#imPrevTog').classList.toggle('on', state.IM.binPreview);
    if (!engine.AC) {
      toast('Load a file first');
      setIM('binPreview', false);
      $('#imPrevTog').classList.remove('on');
      return;
    }
    engine.buildPreview();
    toast(state.IM.binPreview ? 'Binaural monitor on' : 'Stereo monitor');
  });
  $('#imExport').addEventListener('click', renderImmersive);
  $('#chanIdExport').onclick = engine.exportChannelId;
  $('#chanMapExport').onclick = engine.exportChannelMap;
  imRefreshNote();

  // Keyboard.
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') {
      // Allow Ctrl+Z even inside inputs.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) {
        redo();
      } else {
        undo();
      }
      syncControls();
      engine.applyParams();
      scheduleAnalyze();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      engine.togglePlay();
    }
    if (e.key === 'x' || e.key === 'X') {
      setABMode(state.abMode === 'A' ? 'B' : 'A');
    }
  });

  // State → UI subscription.
  subscribe(() => {
    syncControls();
    markPresetUI();
    engine.applyParams();
  });

  // Resize → invalidate waveform cache.
  window.addEventListener('resize', () => {
    wavePeaks = null;
  });

  // Global error surfacing.
  window.addEventListener('error', (e) => {
    toast('Error: ' + (e.message || 'see console'));
  });
  window.addEventListener('unhandledrejection', (e) => {
    toast('Error: ' + ((e.reason && e.reason.message) || 'see console'));
  });

  loop();
}

function baseNameSafe() {
  return engine.fileLabel
    ? engine.fileLabel.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_')
    : 'master';
}

async function importFile(file) {
  if (!file) {
    toast('No file received');
    return;
  }
  let ab;
  try {
    ab = await file.arrayBuffer();
  } catch (e) {
    toast('Import failed: ' + e.message);
    return;
  }
  const buf = await engine.loadArrayBuffer(ab, file.name);
  if (!buf) return;
  wavePeaks = null;
  $('#transportEmpty').style.display = 'none';
  $('#transportFull').style.display = 'flex';
  $('#waveCard').style.display = 'block';
  $('#scopesRow').style.display = 'grid';
  $('#metersRow').style.display = 'grid';
  $('#analyzeHint').style.display = 'block';
  $('#fileName').textContent = `${file.name}  ·  ${buf.numberOfChannels}ch · ${(buf.sampleRate / 1000).toFixed(1)}kHz · ${fmtTime(buf.duration)}`;
  $('#srlabel').textContent = (buf.sampleRate / 1000).toFixed(1) + ' kHz';
  drawWaveOverview();
  toast('Loaded — analyzing loudness…');
  scheduleAnalyze(true);
}
