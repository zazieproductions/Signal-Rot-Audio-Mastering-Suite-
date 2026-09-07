/**
 * Sonic change summary — human-readable, derived from actual parameters.
 *
 * Groups: TONAL / DYNAMICS / STEREO / LOUDNESS
 * No AI claims. Every line traces to a measurable parameter.
 */

import { $, el, replaceChildren } from './dom.js';

function describeTonal(p) {
  const lines = [];
  const toneMap = [
    { key: 'sub', label: 'sub' },
    { key: 'warm', label: 'warmth' },
    { key: 'body', label: 'body' },
    { key: 'harsh', label: 'harshness' },
    { key: 'clarity', label: 'clarity' },
    { key: 'air', label: 'air' },
  ];
  for (const { key, label } of toneMap) {
    const v = p[key];
    if (Math.abs(v) < 0.35) continue;
    if (v > 0) lines.push(`+ ${label} ${v > 3 ? 'strong' : v > 1.2 ? 'moderate' : 'slight'} (+${v.toFixed(1)} dB)`);
    else lines.push(`− ${label} ${Math.abs(v) > 3 ? 'strong cut' : Math.abs(v) > 1.2 ? 'moderate cut' : 'gentle cut'} (${v.toFixed(1)} dB)`);
  }
  if (Math.abs(p.tilt) >= 0.4) lines.push(p.tilt > 0 ? `tilt → bright (${p.tilt.toFixed(1)} dB)` : `tilt → dark (${p.tilt.toFixed(1)} dB)`);
  if (Math.abs(p.drive) >= 0.8) lines.push(`drive ${p.drive > 0 ? '+' : ''}${p.drive.toFixed(1)} dB — saturation ${p.sat}%`);
  else if (p.sat > 6) lines.push(`saturation ${p.sat}% — harmonics without level lift`);
  if (!lines.length) lines.push('tonal — transparent (no EQ / drive)');
  return lines;
}

function describeDynamics(p) {
  const lines = [];
  const bands = [
    { k: 'mbLow', n: 'low' },
    { k: 'mbMid', n: 'mid' },
    { k: 'mbHigh', n: 'high' },
  ];
  const active = bands.filter((b) => p[b.k] > 4);
  if (!active.length) lines.push('dynamics — open (no multiband)');
  else {
    for (const b of active) {
      const v = p[b.k];
      lines.push(`${b.n} ${v > 50 ? 'firm' : v > 22 ? 'gentle' : 'light'} control (${Math.round(v)}%)`);
    }
    if (p.mbMix < 85) lines.push(`parallel mix ${Math.round(p.mbMix)}% — dry retains transients`);
  }
  if (p.mbBypassLow || p.mbBypassMid || p.mbBypassHigh) lines.push(`bypassed ${  ['low', 'mid', 'high'].filter((_, i) => [p.mbBypassLow, p.mbBypassMid, p.mbBypassHigh][i]).join('/')  } band`);
  if (p.transAttack > 8 || p.transSustain > 8) lines.push(`transient — attack ${Math.round(p.transAttack)} / sustain ${Math.round(p.transSustain)} (export only)`);
  else if (p.transAttack > 0 || p.transSustain > 0) lines.push('transient — subtle (export only)');
  if (p.mbSolo && p.mbSolo !== 'off') lines.push(`solo: ${p.mbSolo} band`);
  return lines;
}

function describeStereo(p) {
  const lines = [];
  if (Math.abs(p.width - 1) < 0.06 && Math.abs(p.ms) < 0.06 && p.bassMono < 1 && p.haas < 0.5 && p.phaseRot < 0.05) {
    lines.push('stereo — centred, mono-compatible');
    return lines;
  }
  if (p.width > 1.12) lines.push(`widened ${Math.round((p.width - 1) * 100)}% — ${p.width > 1.6 ? 'extreme' : p.width > 1.3 ? 'moderate' : 'gentle'}`);
  else if (p.width < 0.92) lines.push(`narrowed ${Math.round((1 - p.width) * 100)}%`);
  if (Math.abs(p.ms) >= 0.08) lines.push(p.ms > 0 ? `side +${Math.round(p.ms * 100)} — airy` : `mid +${Math.round(Math.abs(p.ms) * 100)} — focused`);
  if (p.bassMono > 0) lines.push(`low anchored below ${Math.round(p.bassMono)} Hz (LR4 side HPF)`);
  if (p.haas >= 0.5) lines.push(`Haas ${p.haas.toFixed(1)} ms ${p.haasSide === -1 ? 'left' : 'right'} — ${p.haas > 8 ? '⚠ mono risk' : 'inside fusion'}`);
  if (p.crossfeed > 0.08) lines.push(`crossfeed ${Math.round(p.crossfeed * 100)}% — headphone glue`);
  if (p.phaseRot > 0.1) lines.push(`side comb ${Math.round(p.phaseRot * 100)}% — surreal width`);
  // per-band
  const widths = [];
  if (p.widthHigh > 1.25) widths.push(`high ×${p.widthHigh.toFixed(2)}`);
  if (p.widthMid > 1.2) widths.push(`mid ×${p.widthMid.toFixed(2)}`);
  if (p.widthLow < 0.85) widths.push(`low narrowed ×${p.widthLow.toFixed(2)}`);
  if (widths.length) lines.push(`per-band: ${  widths.join(' · ')}`);
  if (p.depth > 6) lines.push(`depth ${Math.round(p.depth)}% (${p.depthSize}) — early reflections, no tail`);
  if (p.binaural) lines.push(`binaural — crossfeed + delay + spread ${Math.round(p.spread * 100)}% (fixed HRTF)`);
  return lines;
}

function describeLoudness(p, stats) {
  const lines = [];
  if (!stats || !Number.isFinite(stats.integrated)) {
    lines.push(p.normalize ? `target ${p.targetLUFS.toFixed(1)} LUFS · ceiling ${p.ceiling.toFixed(1)} dBTP` : `no normalisation · ceiling ${p.ceiling.toFixed(1)} dBTP`);
    return lines;
  }
  lines.push(`${stats.integrated.toFixed(1)} LUFS integrated · ${stats.peaks ? stats.peaks.truePeakDb.toFixed(1) : '—'} dBTP peak`);
  if (Number.isFinite(stats.lra)) lines.push(`LRA ${stats.lra.toFixed(1)} LU — ${stats.lra > 11 ? 'dynamic' : stats.lra > 7 ? 'moderate' : 'dense'}`);
  else lines.push(`ceiling ${p.ceiling.toFixed(1)} dBTP · delivery headroom ${(p.ceiling - (stats.peaks?.truePeakDb ?? p.ceiling)).toFixed(1)} dB`);
  if (p.normalize && Number.isFinite(stats.integrated)) {
    const delta = stats.integrated - p.targetLUFS;
    if (Math.abs(delta) > 0.6) lines.push(delta < 0 ? `↓ ${Math.abs(delta).toFixed(1)} dB below target — budget protected` : `↑ ${delta.toFixed(1)} dB above target`);
  }
  return lines;
}

export function initSonicSummary(opts) {
  const { store } = opts;
  const host = $('#sonicSummaryCard');
  const grid = $('#sonicSummaryGrid');
  const hint = $('#sonicSummaryHint');
  if (!host || !grid) return { sync: () => {} };

  const sync = () => {
    const p = store.getParameters();
    const hasFile = !!store.getState().source.buffer;
    host.hidden = !hasFile;
    if (!hasFile) return;
    const stats = store.getState().ui.abMode === 'A' ? store.getState().analysis.original : store.getState().analysis.processed;

    const groups = [
      { title: 'Tonal', color: 'var(--proc)', lines: describeTonal(p) },
      { title: 'Dynamics', color: 'var(--ok)', lines: describeDynamics(p) },
      { title: 'Stereo', color: 'var(--orig)', lines: describeStereo(p) },
      { title: 'Loudness', color: 'var(--warn)', lines: describeLoudness(p, stats) },
    ];

    replaceChildren(
      grid,
      ...groups.map((g) =>
        el('div', { class: 'ss-group' }, [
          el('div', { class: 'gh', text: g.title }),
          ...g.lines.map((line) =>
            el('div', { class: 'ss-line' }, [
              el('span', { class: 'ss-dot', style: `background:${g.color}` }),
              el('span', { text: line }),
            ]),
          ),
        ]),
      ),
    );
    if (hint) hint.textContent = 'Tone bands: sub 55 · warm 120 · body 350 · harsh 2.8k · clarity 5k · air 12k · tilt pivot 1k. Multiband LR4 at 140 Hz / 3.2 kHz.';
  };

  store.subscribe((_s, changed) => {
    if (changed.has('parameters') || changed.has('analysis') || changed.has('ui')) sync();
  });
  sync();
  return { sync };
}
