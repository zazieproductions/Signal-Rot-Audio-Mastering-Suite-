/**
 * Heavy project warnings — when estimate exceeds safe browser memory.
 * Consumes Agent D's memory estimate API if present, otherwise derives from
 * source duration × channels × sampleRate.
 */

import { el, replaceChildren, formatBytes } from './dom.js';
import { LIMITS } from '../app/constants.js';

export function initHeavyWarning(opts) {
  const { store } = opts;
  const host = document.createElement('div');
  host.id = 'heavyWarning';
  host.hidden = true;
  const hero = document.querySelector('#sourceHero');
  if (hero) hero.after(host);
  else document.querySelector('.main')?.prepend(host);

  const sync = () => {
    const { source, immersive } = store.getState();
    if (!source.buffer) { host.hidden = true; return; }
    const sr = source.sampleRate || source.buffer.sampleRate;
    const channels = immersive.layout === 'off' ? 2 : (() => {
      try {
        const layouts = { '5.1':6,'7.1':8,'7.1.2':10,'7.1.4':12,'9.1.6':16, 'soniclab':24 };
        return layouts[immersive.layout] || 2;
      } catch { return 2; }
    })();
    const totalSamples = source.buffer.length * channels;
    const estimateBytes = totalSamples * 4 * 3; // ~3 copies during render
    const warn = totalSamples > LIMITS.WARN_TOTAL_SAMPLES || estimateBytes > 1.5 * 1024 * 1024 * 1024 || source.durationSeconds > LIMITS.WARN_DURATION_S;

    if (!warn) { host.hidden = true; return; }

    const layoutName = immersive.layout === 'off' ? 'Stereo' : immersive.layout;
    const est = formatBytes(estimateBytes);
    host.hidden = false;
    host.className = 'notice danger';
    host.style.margin = '0';
    replaceChildren(host,
      el('strong', { text: `Heavy project — ${layoutName} · ${(sr/1000).toFixed(1)} kHz · ${Math.floor(source.durationSeconds/60)}:${String(Math.floor(source.durationSeconds%60)).padStart(2,'0')}` }),
      el('div', { text: `Estimated peak working memory ~${est} (channels × samples × intermediates). This render may exceed typical browser limits (2–4 GB).` }),
      el('div', { style: 'display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;' }, [
        el('button', { class: 'btn tiny ghost', text: '→ 96 kHz', onclick: () => { const sel=document.querySelector('#srSelect'); if(sel){ sel.value='96000'; sel.dispatchEvent(new Event('change')); } } }),
        el('button', { class: 'btn tiny ghost', text: '→ Stereo', onclick: () => { store.setImmersive({ layout:'off' }); } }),
        el('button', { class: 'btn tiny', text: 'Continue anyway', onclick: () => { host.hidden=true; } }),
      ]),
      el('div', { class: 'hint', text: 'Not an error — the engine is protecting you from an OOM that would crash the tab. Shorter region or lower rate solves it.' }),
    );
  };

  store.subscribe((_s, changed) => {
    if (changed.has('source') || changed.has('immersive') || changed.has('ui')) sync();
  });
  sync();
  return { sync };
}
