/**
 * Workspace switcher — Master vs Spatial Lab.
 *
 * Two product modes share the same source/master state. They are not separate
 * applications; they are lenses onto the same engine. Master is calm and
 * reference-focused; Spatial Lab is technical and spatial.
 *
 * The switch persists in store.ui.workspace and in the body attribute
 * `data-workspace` so CSS can theme subtly.
 */

import { $ } from './dom.js';

const WORKSPACE_KEY = 'workspace';
const VALID = new Set(['master', 'spatial']);

export function initWorkspace(opts) {
  const { store } = opts;
  const sw = $('#workspaceSwitch');
  if (!sw) return { set: () => {} };

  const buttons = [...sw.querySelectorAll('[data-ws]')];

  const apply = (ws, { persist = true } = {}) => {
    const next = VALID.has(ws) ? ws : 'master';
    document.body.setAttribute('data-workspace', next);
    document.documentElement.setAttribute('data-workspace', next);
    for (const b of buttons) {
      const active = b.dataset.ws === next;
      b.setAttribute('aria-selected', String(active));
      b.tabIndex = active ? 0 : -1;
    }
    // Show/hide cards that belong to a workspace.
    const masterCards = ['#sourceHero', '#masterStatusCard', '#sonicSummaryCard', '#macroCard'];
    // Master workspace: show mastering hierarchy
    // Spatial workspace: keep sourceHero + show spatial lab, hide macro? Keep both but emphasize spatial
    const isSpatial = next === 'spatial';
    for (const sel of masterCards) {
      const n = document.querySelector(sel);
      if (n && !isSpatial) {
        // keep hidden state managed elsewhere, but ensure the lab-card toggle works
        // Master cards remain as they were (hidden until data available)
      } else if (n && isSpatial) {
        // In spatial mode, keep macros but add spatial accent
      }
    }
    const lab = document.querySelector('#spatialLabCard');
    if (lab) lab.hidden = !isSpatial;

    // Tabs: highlight appropriate ones but never hide — all remain accessible
    for (const tab of document.querySelectorAll('.tab')) {
      const id = tab.dataset.tab;
      const masterTabs = new Set(['presets', 'loudness', 'tone', 'dynamics', 'stereo', 'export']);
      const spatialTabs = new Set(['immersive', 'spatial', 'character', 'match']);
      tab.style.opacity = '';
      if (isSpatial && masterTabs.has(id)) tab.style.opacity = '0.7';
      if (!isSpatial && spatialTabs.has(id)) tab.style.opacity = '0.75';
      tab.style.fontWeight = (isSpatial && id === 'immersive') || (!isSpatial && id === 'presets') ? '800' : '';
    }

    if (persist) store.setUi({ [WORKSPACE_KEY]: next });
    announceWorkspace(next);
  };

  const announceWorkspace = (ws) => {
    const hint = $('#wsHint');
    if (hint) hint.textContent = ws === 'spatial' ? 'Spatial Lab · immersive · 7.1.4 · 20.4' : 'M → Master · L → Lab';
  };

  sw.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ws]');
    if (!btn) return;
    apply(btn.dataset.ws);
  });

  // Keyboard: M and L from anywhere except inputs
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'm' || e.key === 'M') {
      apply('master');
    } else if (e.key === 'l' || e.key === 'L') {
      apply('spatial');
    }
  });

  // Initialize from store or default
  const initial = store.getState().ui[WORKSPACE_KEY] || 'master';
  apply(initial, { persist: false });
  store.subscribe((state, changed) => {
    if (changed.has('ui') && state.ui[WORKSPACE_KEY] && state.ui[WORKSPACE_KEY] !== document.body.getAttribute('data-workspace')) {
      apply(state.ui[WORKSPACE_KEY], { persist: false });
    }
  });

  return { set: apply };
}
