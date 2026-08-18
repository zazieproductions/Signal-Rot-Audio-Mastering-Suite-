/**
 * Tab navigation.
 *
 * The audited version used `<div class="tab">` with a click handler: no roles, no
 * keyboard support, no focus ring. This is the WAI-ARIA Authoring Practices tab pattern —
 * arrow keys move between tabs, Home/End jump to the ends, and only the active tab is in
 * the tab order.
 */

import { $$ } from './dom.js';

/**
 * @param {object} opts
 * @param {(tabId:string)=>void} [opts.onChange]
 */
export function initTabs(opts = {}) {
  const tabs = $$('.tab');
  const panels = $$('.tpanel');
  if (!tabs.length) return { select: () => {} };

  const select = (id, { focus = false } = {}) => {
    let found = false;
    tabs.forEach((tab) => {
      const active = tab.dataset.tab === id;
      if (active) found = true;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    });
    if (!found) return;
    panels.forEach((panel) => {
      const active = panel.dataset.tab === id;
      panel.classList.toggle('on', active);
      panel.hidden = !active;
    });
    if (opts.onChange) opts.onChange(id);
  };

  tabs.forEach((tab, index) => {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `panel-${tab.dataset.tab}`);
    tab.id = `tab-${tab.dataset.tab}`;
    tab.addEventListener('click', () => select(tab.dataset.tab));
    tab.addEventListener('keydown', (event) => {
      const map = { ArrowRight: 1, ArrowLeft: -1 };
      if (event.key in map) {
        event.preventDefault();
        const next = (index + map[event.key] + tabs.length) % tabs.length;
        select(tabs[next].dataset.tab, { focus: true });
      } else if (event.key === 'Home') {
        event.preventDefault();
        select(tabs[0].dataset.tab, { focus: true });
      } else if (event.key === 'End') {
        event.preventDefault();
        select(tabs[tabs.length - 1].dataset.tab, { focus: true });
      }
    });
  });

  panels.forEach((panel) => {
    panel.setAttribute('role', 'tabpanel');
    panel.id = `panel-${panel.dataset.tab}`;
    panel.setAttribute('aria-labelledby', `tab-${panel.dataset.tab}`);
    panel.tabIndex = 0;
  });

  const initial = tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0];
  select(initial.dataset.tab);

  return { select };
}
