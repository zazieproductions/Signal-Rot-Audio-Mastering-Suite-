/**
 * Export summary — the delivery card under the export button.
 *
 * Contract: this card answers "WHAT WILL BE EXPORTED?" for the button in THIS panel. It
 * reads `ui.exportFormat` / `ui.exportSampleRate` from the store — the same values the
 * export controller consumes (the <select>s are kept in sync with the store by bootstrap,
 * so there is one truth, not two). It never describes an immersive bed as if the stereo
 * export button would produce one; when an immersive layout is armed, the card says where
 * that render actually happens.
 */

import { el, replaceChildren } from './dom.js';
import { LAYOUTS } from '../audio/immersive/layouts.js';
import { EXPORT_FORMATS } from '../app/export-controller.js';

export function initExportSummary(opts) {
  const { store } = opts;
  const host = document.querySelector('#exportSummary');
  // If no dedicated host, create one inside export panel
  let container = host;
  if (!container) {
    const exportPanel = document.querySelector('.tpanel[data-tab="export"]');
    if (!exportPanel) return { sync: () => {} };
    container = el('div', {
      id: 'exportSummary',
      class: 'export-summary',
      style: 'margin-top:16px',
    });
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

    const fmtKey = state.ui.exportFormat || 'wav24';
    const fmt = EXPORT_FORMATS[fmtKey] ?? EXPORT_FORMATS.wav24;
    const sr = state.ui.exportSampleRate || state.source.sampleRate || 48000;
    const isMp3 = fmt.container === 'mp3';
    const bitDepthText = isMp3 ? fmt.label.replace(/^MP3\s*/, '') : `${fmt.bitDepth}-bit`;

    const layoutId = state.immersive.layout;
    const layout = LAYOUTS[layoutId];
    const isImmersive = layoutId !== 'off' && !!layout;
    const targetLabel =
      state.immersive.target === 'adm'
        ? 'ADM BWF (BS.2076)'
        : state.immersive.target === 'binaural'
          ? 'binaural fold-down'
          : 'multichannel WAV';

    const stats = state.analysis.processed;
    const integrated = stats?.integrated;
    const tp = stats?.peaks?.truePeakDb;

    replaceChildren(
      container,
      el('div', { class: 'export-summary-hd' }, [
        el('div', { class: 'icon', text: isImmersive ? '◈' : '◐' }),
        el('div', {}, [
          el('div', { class: 'title', text: `This button exports: ${fmt.label} · stereo master` }),
          el('div', {
            class: 'sub',
            text: `2 channels · ${(sr / 1000).toFixed(1)} kHz · ${bitDepthText}${isMp3 ? '' : ' PCM'}`,
          }),
        ]),
        el('span', {
          class: 'badge',
          text: p.normalize ? `${p.targetLUFS.toFixed(1)} LUFS tgt` : 'no norm',
          style:
            'margin-left:auto; font:600 9px var(--mono); background: var(--panel); border:1px solid var(--line2); padding:3px 8px; border-radius:999px; color:var(--faint)',
        }),
      ]),
      isImmersive
        ? el(
            'div',
            {
              class: 'notice caution',
              style: 'margin:8px 0 0',
            },
            [
              el('strong', {
                text: `Immersive is armed: ${layout.name} · ${layout.channels.length} ch · ${targetLabel}. `,
              }),
              document.createTextNode(
                'The button above still renders the stereo master only — the multichannel, ADM and ' +
                  'binaural deliverables are rendered from the Immersive tab.',
              ),
            ],
          )
        : null,
      el('div', { class: 'export-kv' }, [
        el('div', { class: 'kv' }, [
          el('div', { class: 'k', text: 'Format' }),
          el('div', { class: 'v', text: fmt.label }),
        ]),
        el('div', { class: 'kv' }, [
          el('div', { class: 'k', text: 'Sample rate' }),
          el('div', {
            class: 'v',
            text: state.ui.exportSampleRate
              ? `${(sr / 1000).toFixed(1)} kHz`
              : `${(sr / 1000).toFixed(1)} kHz (source rate)`,
          }),
        ]),
        el('div', { class: 'kv' }, [
          el('div', { class: 'k', text: isMp3 ? 'Encoding' : 'Bit depth' }),
          el('div', { class: 'v', text: bitDepthText }),
        ]),
        el('div', { class: 'kv' }, [
          el('div', { class: 'k', text: 'Integrated' }),
          el('div', {
            class: 'v',
            text: Number.isFinite(integrated) ? `${integrated.toFixed(1)} LUFS` : 'not analysed',
          }),
        ]),
        el('div', { class: 'kv' }, [
          el('div', { class: 'k', text: 'True peak' }),
          el('div', {
            class: 'v',
            text: Number.isFinite(tp) ? `${tp.toFixed(1)} dBTP` : 'not analysed',
          }),
        ]),
        el('div', { class: 'kv' }, [
          el('div', { class: 'k', text: 'Ceiling' }),
          el('div', { class: 'v', text: `${p.ceiling.toFixed(1)} dBTP` }),
        ]),
      ]),
      el('div', { class: 'includes' }, [
        el('span', { text: '✓ render report' }),
        isImmersive ? el('span', { text: 'immersive deliverables: Immersive tab' }) : null,
      ]),
      el('div', {
        class: 'hint',
        text: 'Every export is followed by a verification pass. The render report records whether the ceiling actually held. Until “Integrated” shows a number here, the loudness figures on screen are from the previous render pass.',
      }),
    );
  };

  store.subscribe((_s, changed) => {
    if (
      changed.has('analysis') ||
      changed.has('ui') ||
      changed.has('parameters') ||
      changed.has('immersive') ||
      changed.has('source')
    ) {
      sync();
    }
  });
  sync();
  return { sync };
}
