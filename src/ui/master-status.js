/**
 * Mastering status — compact delivery health strip.
 *
 * Shows: Integrated LUFS, True Peak, LRA, Crest factor, Limiter reduction.
 * Uses hierarchy: SAFE / NEAR LIMIT / CREST-BUDGET LIMITED / TRUE-PEAK WARNING
 * and an honest budget note when the engine delivered below request.
 */

import { $, el, replaceChildren } from './dom.js';

function levelState(value, thresholds) {
  if (value == null || !Number.isFinite(value)) return 'idle';
  if (value >= thresholds.warn) return 'warn';
  if (value >= thresholds.near) return 'near';
  return 'safe';
}

export function initMasterStatus(opts) {
  const { store } = opts;
  const host = $('#masterStatusCard');
  const grid = $('#masterStatusGrid');
  const budgetHost = $('#masterStatusBudget');
  if (!host || !grid) return { sync: () => {} };

  const sync = () => {
    const state = store.getState();
    const p = store.getParameters();
    const hasFile = !!state.source.buffer;
    host.hidden = !hasFile;
    if (!hasFile) return;

    const stats = state.ui.abMode === 'A' ? state.analysis.original : state.analysis.processed;
    const integrated = stats?.integrated;
    const lra = stats?.lra;
    const peaks = stats?.peaks;
    const tp = peaks?.truePeakDb ?? peaks?.peakDb;
    const crest = Number.isFinite(integrated) && Number.isFinite(tp) ? tp - integrated : null;
    // limiter reduction: try to read from chain via state? Fallback to 0
    const reduction = state.ui.limiterReduction ?? 0;

    const target = p.normalize ? p.targetLUFS : null;
    const budgetLimited = target != null && Number.isFinite(integrated) && integrated < target - 0.6;

    const tpState = levelState(tp, { near: p.ceiling - 0.6, warn: p.ceiling - 0.1 });
    const lufsState = budgetLimited ? 'warn' : (Number.isFinite(integrated) && target != null && Math.abs(integrated - target) < 0.4 ? 'safe' : 'near');
    const crestState = crest != null && crest < 6 ? 'warn' : crest != null && crest < 9 ? 'near' : 'safe';

    const cards = [
      {
        key: 'lufs',
        label: 'Integrated',
        value: Number.isFinite(integrated) ? integrated.toFixed(1) : '—',
        unit: 'LUFS',
        sub: target != null ? `target ${target.toFixed(1)}` : 'no target',
        frac: Number.isFinite(integrated) ? (integrated + 40) / 40 : 0,
        state: lufsState,
      },
      {
        key: 'tp',
        label: 'True peak',
        value: Number.isFinite(tp) ? `${tp > 0 ? '+' : ''}${tp.toFixed(1)}` : '—',
        unit: 'dBTP',
        sub: `ceiling ${p.ceiling.toFixed(1)}`,
        frac: Number.isFinite(tp) ? (tp + 24) / 24 : 0,
        state: tpState,
      },
      {
        key: 'lra',
        label: 'Loudness range',
        value: Number.isFinite(lra) ? lra.toFixed(1) : '—',
        unit: 'LU',
        sub: 'EBU Tech 3342',
        frac: Number.isFinite(lra) ? lra / 20 : 0,
        state: Number.isFinite(lra) && lra > 12 ? 'near' : 'safe',
      },
      {
        key: 'crest',
        label: 'Crest',
        value: Number.isFinite(crest) ? crest.toFixed(1) : '—',
        unit: 'dB',
        sub: crest != null && crest < 6 ? 'limited — transients tight' : crest != null && crest < 9 ? 'moderate' : 'open',
        frac: Number.isFinite(crest) ? Math.min(1, Math.max(0, (crest - 3) / 14)) : 0,
        state: crestState,
      },
      {
        key: 'gr',
        label: 'Limiter',
        value: Number.isFinite(reduction) ? `${Math.abs(reduction).toFixed(1)}` : '0.0',
        unit: 'dB GR',
        sub: Math.abs(reduction) > 3 ? 'working' : Math.abs(reduction) > 0.4 ? 'kissing' : 'idle',
        frac: Number.isFinite(reduction) ? Math.min(1, Math.abs(reduction) / 8) : 0,
        state: Math.abs(reduction) > 4.5 ? 'warn' : Math.abs(reduction) > 2 ? 'near' : 'safe',
      },
    ];

    replaceChildren(
      grid,
      ...cards.map((c) =>
        el('div', { class: `ms-card ${c.state}` }, [
          el('div', { class: 'k', text: c.label }),
          el('div', { class: 'v', text: `${c.value} `, html: `${c.value} <span style="font-size:11px; color:var(--faint)">${c.unit}</span>` }),
          el('div', { class: 's', text: c.sub }),
          el('div', { class: 'bar' }, [el('i', { style: `width:${Math.round(c.frac * 100)}%` })]),
        ]),
      ),
    );

    // Budget note
    if (budgetHost) {
      if (budgetLimited) {
        replaceChildren(
          budgetHost,
          el('div', { class: 'budget-note warn' }, [
            el('span', { text: '⚠' }),
            el('div', {}, [
              el('strong', { text: 'Clean loudness limit reached. ' }),
              document.createTextNode(`Requested ${target.toFixed(1)} LUFS · Delivered ${integrated.toFixed(1)} LUFS — the engine protected the master from over-limiting.`),
            ]),
          ]),
        );
      } else if (Number.isFinite(tp) && tp > p.ceiling - 0.2) {
        replaceChildren(
          budgetHost,
          el('div', { class: 'budget-note warn' }, [
            el('span', { text: '⚠' }),
            el('div', { text: `True peak ${tp.toFixed(1)} dBTP is within 0.2 dB of the ${p.ceiling.toFixed(1)} dBTP ceiling — consider a 0.3 dB safety margin for lossy codecs.` }),
          ]),
        );
      } else if (Number.isFinite(integrated) && target != null && Math.abs(integrated - target) < 0.5) {
        replaceChildren(budgetHost, el('div', { class: 'budget-note ok' }, [el('span', { text: '✓' }), el('div', { text: `Loudness on target — ${integrated.toFixed(1)} LUFS · True peak ${Number.isFinite(tp) ? tp.toFixed(1) : '—'} dBTP` })]));
      } else {
        replaceChildren(budgetHost, el('div', { class: 'budget-note info' }, [el('span', { text: 'ℹ' }), el('div', { text: 'Live meters are frame-rate estimates. Integrated and LRA come from the gated offline pass.' })]));
      }
    }
  };

  store.subscribe((_s, changed) => {
    if (changed.has('analysis') || changed.has('parameters') || changed.has('ui')) sync();
  });
  sync();
  return { sync };
}
