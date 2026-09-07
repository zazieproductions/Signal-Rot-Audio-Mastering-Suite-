/**
 * Export summary — concise professional delivery card before final export.
 * Shows format, sample rate, bit depth, layout, loudness, true peak,
 * delivery profile, includes (channel map, report, manifest).
 * Derives from actual state, no invented capabilities.
 */

import { el, replaceChildren } from './dom.js';
import { LAYOUTS } from '../audio/immersive/layouts.js';

export function initExportSummary(opts) {
  const { store } = opts;
  const host = document.querySelector('#exportSummary');
  // If no dedicated host, create one inside export panel
  let container = host;
  if (!container) {
    const exportPanel = document.querySelector('.tpanel[data-tab="export"]');
    if (!exportPanel) return { sync: () => {} };
    container = el('div', { id: 'exportSummary', class: 'export-summary', style: 'margin-top:16px' });
    // Insert after export button
    const prog = exportPanel.querySelector('#exportNotice');
    if (prog) prog.parentElement.insertBefore(container, prog);
    else exportPanel.append(container);
  }

  const sync = () => {
    const state = store.getState();
    const p = store.getParameters();
    const hasFile = !!state.source.buffer;
    if (!hasFile) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    const fmt = state.ui.exportFormat || 'wav24';
    const srSel = document.querySelector('#srSelect');
    const sr = Number(srSel?.value) || state.source.sampleRate || 48000;
    const bitDepth = fmt.includes('32') ? 32 : fmt.includes('16') ? 16 : 24;
    const layoutId = state.immersive.layout;
    const layout = LAYOUTS[layoutId];
    const isImmersive = layoutId !== 'off';
    const channelCount = isImmersive ? (layout ? layout.channels.length : 0) : 2;
    const target = state.immersive.target;

    const stats = state.analysis.processed;
    const integrated = stats?.integrated;
    const tp = stats?.peaks?.truePeakDb;

    const formatLabel = fmt === 'wav24' ? 'WAV' : fmt === 'wav16' ? 'WAV' : fmt === 'wav32' ? 'WAV float' : fmt.toUpperCase();
    const layoutLabel = isImmersive ? layout.name : 'Stereo';
    const admStatus = target === 'adm' ? 'ADM BWF DirectSpeakers' : target === 'binaural' ? 'Binaural fold-down' : isImmersive ? 'Multichannel WAV' : 'Stereo WAV';
    const includes = [];
    if (isImmersive && !layout.standardMask) includes.push('✓ channel map');
    includes.push('✓ render report');
    if (target === 'adm') includes.push('✓ manifest');

    replaceChildren(container,
      el('div', { class: 'export-summary-hd' }, [
        el('div', { class: 'icon', text: isImmersive ? '◈' : '◐' }),
        el('div', {}, [
          el('div', { class: 'title', text: `${layoutLabel} ${bitDepth}-bit · ${admStatus}` }),
          el('div', { class: 'sub', text: `${channelCount} channels · ${(sr/1000).toFixed(1)} kHz · ${isImmersive ? 'immersive bed' : 'stereo master'}` }),
        ]),
        el('span', { class: 'badge', text: p.normalize ? `${p.targetLUFS.toFixed(1)} LUFS tgt` : 'no norm', style: 'margin-left:auto; font:600 9px var(--mono); background: var(--panel); border:1px solid var(--line2); padding:3px 8px; border-radius:999px; color:var(--faint)' }),
      ]),
      el('div', { class: 'export-kv' }, [
        el('div', { class: 'kv' }, [el('div', { class: 'k', text: 'Format' }), el('div', { class: 'v', text: formatLabel })]),
        el('div', { class: 'kv' }, [el('div', { class: 'k', text: 'Sample rate' }), el('div', { class: 'v', text: `${(sr/1000).toFixed(1)} kHz` })]),
        el('div', { class: 'kv' }, [el('div', { class: 'k', text: 'Bit depth' }), el('div', { class: 'v', text: `${bitDepth}-bit` })]),
        el('div', { class: 'kv' }, [el('div', { class: 'k', text: 'Integrated' }), el('div', { class: 'v', text: Number.isFinite(integrated) ? `${integrated.toFixed(1)} LUFS` : '—' })]),
        el('div', { class: 'kv' }, [el('div', { class: 'k', text: 'True peak' }), el('div', { class: 'v', text: Number.isFinite(tp) ? `${tp.toFixed(1)} dBTP` : '—' })]),
        el('div', { class: 'kv' }, [el('div', { class: 'k', text: 'Ceiling' }), el('div', { class: 'v', text: `${p.ceiling.toFixed(1)} dBTP` })]),
      ]),
      includes.length ? el('div', { class: 'includes' }, includes.map((t) => el('span', { text: t }))) : null,
      isImmersive ? el('div', { class: 'hint', text: 'Synthetic height channels — not an Atmos-certified master. Height is decorrelated ambience, not recovered information.' }) : el('div', { class: 'hint', text: 'Every export is followed by a verification pass. The render report records whether the ceiling actually held.' }),
    );
  };

  store.subscribe((_s, changed) => {
    if (changed.has('analysis') || changed.has('ui') || changed.has('parameters') || changed.has('immersive') || changed.has('source')) sync();
  });
  // Watch format selects
  document.querySelector('#fmtSelect')?.addEventListener('change', sync);
  document.querySelector('#srSelect')?.addEventListener('change', sync);
  sync();
  return { sync };
}
