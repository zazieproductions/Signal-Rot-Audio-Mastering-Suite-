/**
 * Heavy project warnings — when the working set exceeds safe browser memory.
 *
 * Reads the channel count from `LAYOUTS` (one source of truth with the renderer, so a new
 * layout can never be silently estimated as stereo) and the export sample rate from the
 * store (the same value the exporter will use). The suggested remedy can only ever LOWER
 * the estimate — the previous version hard-coded "→ 96 kHz", which on a 44.1 kHz source
 * would have *doubled* the memory the warning was warning about.
 */

import { el, replaceChildren, formatBytes } from './dom.js';
import { LIMITS } from '../app/constants.js';
import { LAYOUTS } from '../audio/immersive/layouts.js';

const RATE_LADDER = [192000, 96000, 48000, 44100];

export function initHeavyWarning(opts) {
  const { store } = opts;
  const host = document.createElement('div');
  host.id = 'heavyWarning';
  host.hidden = true;
  const hero = document.querySelector('#sourceHero');
  if (hero) hero.after(host);
  else document.querySelector('.main')?.prepend(host);
  let dismissedFor = null;
  let lastSig = null;

  const sync = () => {
    const { source, immersive, ui } = store.getState();
    if (!source.buffer) {
      host.hidden = true;
      lastSig = 'none';
      return;
    }
    const sr = ui.exportSampleRate || source.sampleRate || source.buffer.sampleRate;
    const channels =
      immersive.layout === 'off' ? 2 : (LAYOUTS[immersive.layout]?.channels.length ?? 2);
    const totalSamples =
      source.buffer.length * Math.max(1, Math.round(sr / source.sampleRate)) * channels;
    // Cheap guard: unrelated ui writes (undo buttons, status telemetry) arrive here too —
    // only rebuild the card when the numbers that matter actually changed.
    const sig = `${totalSamples}|${channels}|${sr}|${source.buffer.length}`;
    if (sig === lastSig) return;
    lastSig = sig;
    const estimateBytes = totalSamples * 4 * 3; // ~3 copies during render
    const warn =
      totalSamples > LIMITS.WARN_TOTAL_SAMPLES ||
      estimateBytes > 1.5 * 1024 * 1024 * 1024 ||
      source.durationSeconds > LIMITS.WARN_DURATION_S;

    if (!warn) {
      host.hidden = true;
      dismissedFor = null;
      return;
    }

    // Once dismissed for THIS exact configuration, stay quiet — re-arming the warning on
    // the same numbers is alarm fatigue, the classic source of ignored warnings.
    if (dismissedFor === sig) {
      host.hidden = true;
      return;
    }

    host.hidden = false;
    host.className = 'notice danger';
    host.style.margin = '0';
    const layoutName =
      immersive.layout === 'off'
        ? 'Stereo export'
        : (LAYOUTS[immersive.layout]?.name ?? immersive.layout);
    const est = formatBytes(estimateBytes);
    const lowerRate = RATE_LADDER.find((r) => r < sr);

    replaceChildren(
      host,
      el('strong', {
        text: `Heavy project — ${layoutName} at ${(sr / 1000).toFixed(1)} kHz · ${Math.floor(source.durationSeconds / 60)}:${String(Math.floor(source.durationSeconds % 60)).padStart(2, '0')}`,
      }),
      el('div', {
        text: `Estimated peak working memory ~${est} (channels × samples × intermediates). This render may exceed typical browser limits (2–4 GB). Immersive beds are rendered from the Immersive tab; the stereo export below uses its own (smaller) footprint.`,
      }),
      el('div', { style: 'display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;' }, [
        lowerRate && sr > 44100
          ? el('button', {
              class: 'btn tiny ghost',
              text: `→ export at ${(lowerRate / 1000).toFixed(lowerRate % 1000 ? 1 : 0)} kHz`,
              title: 'Lowers the EXPORT rate only — the source file is untouched',
              onclick: () => {
                const sel = document.querySelector('#srSelect');
                if (sel) {
                  sel.value = String(lowerRate);
                  sel.dispatchEvent(new Event('change'));
                }
              },
            })
          : null,
        el('button', {
          class: 'btn tiny ghost',
          text: '→ Stereo export',
          onclick: () => {
            store.setImmersive({ layout: 'off' });
          },
        }),
        el('button', {
          class: 'btn tiny',
          text: 'Continue anyway',
          onclick: () => {
            dismissedFor = sig;
            host.hidden = true;
          },
        }),
      ]),
      el('div', {
        class: 'hint',
        text: 'Not an error — the engine is protecting you from an OOM that would crash the tab. A shorter loop region or a lower export rate solves it.',
      }),
    );
  };

  store.subscribe((_s, changed) => {
    if (changed.has('source') || changed.has('immersive') || changed.has('ui')) sync();
  });
  sync();
  return { sync };
}
