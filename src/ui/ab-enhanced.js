/**
 * A/B listening — central comparison strip enhancements.
 *
 * Provides: ORIGINAL / MASTERED / LOUDNESS-MATCHED toggle,
 *           blind mode, dim, and keyboard hints.
 * Wires to store.ui.abMode, store.ui.matchLoudness.
 */

import { $ } from './dom.js';

export function initAbEnhanced(opts) {
  const { store, pushParameters } = opts;
  const abA = $('#abAenh') || $('#abA');
  const abB = $('#abBenh') || $('#abB');
  const blindBtn = $('#abBlindenh');
  const matchChip = $('#abMatchChip') || $('#matchLoudBtn');
  const dimChip = $('#abDimChip');
  const hint = $('#abHint');
  if (!abA || !abB) return { sync: () => {} };

  // Use enhanced buttons if present, else fall back to transport seg
  const transportA = $('#abA');
  const transportB = $('#abB');

  let blind = false;
  let blindChoices = ['A', 'B'];
  let blindIndex = 0;
  let dim = false;

  const sync = () => {
    const { abMode, matchLoudness } = store.getState().ui;

    for (const btn of [abA, transportA]) if (btn) btn.setAttribute('aria-pressed', String(abMode === 'A'));
    for (const btn of [abB, transportB]) if (btn) btn.setAttribute('aria-pressed', String(abMode === 'B'));
    if (blindBtn) {
      blindBtn.setAttribute('aria-pressed', String(blind));
      blindBtn.textContent = blind ? '● Blind A/B' : 'Blind';
      blindBtn.title = blind ? 'Blind mode — labels hide which is which (press H to exit)' : 'Blind A/B — hide which is which (H)';
    }
    if (matchChip) matchChip.setAttribute('aria-pressed', String(!!matchLoudness));
    if (dimChip) dimChip.setAttribute('aria-pressed', String(dim));
    if (hint) {
      if (blind) hint.textContent = `◈ Blind ${blindIndex === 0 ? 'A' : 'B'} · press X to flip, H to exit`;
      else hint.textContent = `${abMode === 'A' ? 'A · Original' : 'B · Mastered'}${matchLoudness ? ' · matched' : ''}${dim ? ' · −12 dB dim' : ''}`;
    }
    // Dim: reduce monitor gain by 12 dB via live graph if available
    if (opts.getLiveGraph) {
      const live = opts.getLiveGraph();
      if (live && live.monitor) live.monitor.gain.value = dim ? 0.251 : 1; // -12 dB
    }
  };

  const setAb = (mode) => {
    if (blind) {
      // In blind mode, X flips the hidden choice but UI stays "Blind"
      blindIndex = 1 - blindIndex;
      // Also flip store so audio actually switches
      const nextHidden = blindChoices[blindIndex];
      store.setUi({ abMode: nextHidden });
      if (pushParameters) pushParameters();
      sync();
      return;
    }
    store.setUi({ abMode: mode });
    if (pushParameters) pushParameters();
    sync();
  };

  abA.addEventListener('click', () => setAb('A'));
  abB.addEventListener('click', () => setAb('B'));
  transportA?.addEventListener('click', () => setAb('A'));
  transportB?.addEventListener('click', () => setAb('B'));

  if (blindBtn) {
    blindBtn.addEventListener('click', () => {
      blind = !blind;
      if (blind) {
        blindChoices = [Math.random() > 0.5 ? 'A' : 'B', Math.random() > 0.5 ? 'A' : 'B'];
        // Ensure they differ occasionally but blind means we hide; randomize index
        blindIndex = 0;
        // Set hidden mode randomly
        store.setUi({ abMode: blindChoices[blindIndex] });
        if (pushParameters) pushParameters();
      } else {
        // Exit blind: reveal which was which
        store.setUi({ abMode: blindChoices[blindIndex] });
        if (pushParameters) pushParameters();
      }
      sync();
    });
  }

  const toggleMatch = () => {
    const next = !store.getState().ui.matchLoudness;
    store.setUi({ matchLoudness: next });
    const btn = $('#matchLoudBtn');
    if (btn) btn.setAttribute('aria-pressed', String(next));
    if (pushParameters) pushParameters();
    sync();
  };
  matchChip?.addEventListener('click', toggleMatch);
  $('#matchLoudBtn')?.addEventListener('click', toggleMatch);

  dimChip?.addEventListener('click', () => {
    dim = !dim;
    sync();
  });

  // Keyboard shortcuts for A/B
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.metaKey || e.ctrlKey) return;
    if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      setAb('A');
    } else if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      setAb('B');
    } else if (e.key === 'x' || e.key === 'X') {
      e.preventDefault();
      const cur = store.getState().ui.abMode;
      setAb(cur === 'A' ? 'B' : 'A');
    } else if (e.key === 'm' || e.key === 'M') {
      // Only if not typing in workspace switch — handled there too but allow match toggling
      // Require not in spatialLab? We'll allow both; workspace also uses M
      // Prefer match toggle when focus not on body?
      // We'll not hijack M globally if workspace would; but match is also M — choose toggle.
      // To avoid conflict, only toggle match when audio is loaded
      if (store.getState().source.buffer) {
        // Don't also switch workspace: stop propagation if audio loaded
        e.stopImmediatePropagation?.();
        toggleMatch();
      }
    } else if (e.key === 'h' || e.key === 'H') {
      e.preventDefault();
      blindBtn?.click();
    }
  });

  store.subscribe((_s, changed) => {
    if (changed.has('ui')) sync();
  });
  sync();
  return { sync, setAb, toggleMatch, get blind() { return blind; } };
}
