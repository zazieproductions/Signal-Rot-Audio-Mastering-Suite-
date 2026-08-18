/**
 * Preset panel rendering.
 *
 * Cards are built from the catalogue, never from HTML strings, and every description and
 * audit note comes from the preset data so the UI cannot drift from the settings.
 */

import { PRESET_GROUPS } from '../presets/index.js';
import { el, replaceChildren, $ } from './dom.js';

/**
 * @param {object} opts
 * @param {(preset: import('../presets/_shared.js').Preset) => void} opts.onApply
 * @param {() => string} opts.getActiveName
 */
export function initPresetPanel(opts) {
  const host = $('#presetGroups');
  const auditHost = $('#presetAudit');
  if (!host) return { sync: () => {} };

  /** @type {HTMLButtonElement[]} */
  const cards = [];
  const sections = [];

  for (const group of PRESET_GROUPS) {
    sections.push(el('div', { class: 'grouplab', text: group.label }));
    const grid = el('div', { class: 'presets', role: 'group', 'aria-label': group.label });
    for (const p of group.presets) {
      const card = el(
        'button',
        {
          type: 'button',
          class: 'preset',
          'aria-pressed': 'false',
          dataset: { preset: p.name },
          onclick: () => opts.onApply(p),
        },
        [
          el('div', { class: 'pt', text: p.tag }),
          el('div', { class: 'pn', text: p.name }),
          el('div', { class: 'pd', text: p.description }),
          p.risk !== 'safe'
            ? el('span', {
                class: `risk ${p.risk}`,
                text: p.risk === 'destructive' ? '✕' : '⚠',
                title: p.risk === 'destructive' ? 'Intentionally destructive' : 'Use with care',
              })
            : null,
        ],
      );
      cards.push(card);
      grid.append(card);
    }
    sections.push(grid);
  }

  replaceChildren(host, ...sections);

  const showAudit = (preset) => {
    if (!auditHost) return;
    if (!preset || !preset.audit) {
      auditHost.hidden = true;
      replaceChildren(auditHost);
      return;
    }
    auditHost.hidden = false;
    replaceChildren(
      auditHost,
      el('div', { class: `notice ${preset.risk === 'safe' ? 'info' : 'caution'}` }, [
        el('strong', { text: `${preset.name} — review notes` }),
        el('div', { text: preset.audit, style: 'margin-top:4px' }),
      ]),
    );
  };

  const sync = () => {
    const active = opts.getActiveName();
    for (const card of cards) {
      card.setAttribute('aria-pressed', String(card.dataset.preset === active));
    }
  };

  return { sync, showAudit };
}
