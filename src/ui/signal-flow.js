/**
 * Signal-flow view.
 *
 * A single row that shows the chain in order and lets any module be bypassed by clicking
 * it. This is the fastest way to answer "what is this preset actually doing?" and the
 * fastest way to A/B one stage rather than the whole chain.
 *
 * Modules that only exist in the offline render are marked with the cyan dot and cannot be
 * bypassed from here (they are controlled by their own parameters), which also makes the
 * real-time/offline boundary visible at a glance rather than buried in documentation.
 */

import { SIGNAL_FLOW } from '../app/constants.js';
import { el, replaceChildren, $ } from './dom.js';

/**
 * @param {object} opts
 * @param {import('../app/state.js').Store} opts.store
 * @param {() => void} [opts.onChange]
 */
export function initSignalFlow(opts) {
  const host = $('#signalFlow');
  if (!host) return { sync: () => {} };
  const { store } = opts;

  /** @type {Map<string, HTMLElement>} */
  const nodes = new Map();
  const children = [];

  children.push(el('span', { class: 'flow-node terminal', text: 'INPUT' }));

  for (const module of SIGNAL_FLOW) {
    children.push(el('span', { class: 'flow-arrow', text: '→', 'aria-hidden': 'true' }));
    if (module.exportOnly) {
      const node = el(
        'span',
        {
          class: 'flow-node terminal export-only',
          title: 'Runs during export only — the live monitor does not include this stage.',
        },
        [el('span', { class: 'dot' }), document.createTextNode(module.label)],
      );
      children.push(node);
      continue;
    }
    const button = el(
      'button',
      {
        type: 'button',
        class: 'flow-node',
        'aria-pressed': 'false',
        dataset: { module: module.id },
        title: `Bypass ${module.label}`,
        onclick: () => {
          store.toggleModuleBypass(module.id);
          if (opts.onChange) opts.onChange();
        },
      },
      [el('span', { class: 'dot' }), document.createTextNode(module.label)],
    );
    nodes.set(module.id, button);
    children.push(button);
  }

  children.push(el('span', { class: 'flow-arrow', text: '→', 'aria-hidden': 'true' }));
  children.push(el('span', { class: 'flow-node terminal', text: 'EXPORT' }));

  replaceChildren(host, ...children);

  const sync = () => {
    const bypass = store.getState().ui.moduleBypass;
    for (const [id, node] of nodes) {
      const off = !!bypass[id];
      node.setAttribute('aria-pressed', String(off));
      node.title = off ? `Enable ${node.textContent}` : `Bypass ${node.textContent}`;
    }
  };

  store.subscribe((_s, changed) => {
    if (changed.has('ui')) sync();
  });
  sync();

  return { sync };
}
